#!/usr/bin/env node
/**
 * The `mira` command line.
 *
 *   mira generate types [--out <file>] [--tables A,B,SIM_%] [--import <module>] [--env <file>]
 *
 * Connects with the appDb credentials (DB_* / APP_DB_* in the environment, or
 * in the .env file given by --env, default ./.env when present), reads the
 * schema's catalogue and writes defineTable() code: to --out, or to stdout.
 */
import fs from "node:fs";
import path from "node:path";

const USAGE = `Usage:
  mira generate types [--out <file>] [--tables A,B,PREFIX_%] [--import <module>] [--env <file>] [--verbose]

Options:
  --out <file>       write the generated module here (default: stdout)
  --tables <list>    comma-separated table names; a name with % is a LIKE pattern (default: all tables)
  --import <module>  module the generated file imports from (default: @jm-paunlagui/mira)
  --env <file>       .env file to load (default: ./.env if it exists; existing variables win)
  --verbose          show Mira's log lines (they go to stdout)
`;

type Args = { command: string[]; flags: Record<string, string> };

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = "1";
    else if (a === "--verbose") flags.verbose = "1";
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value.`);
      flags[k] = v;
    } else command.push(a);
  }
  return { command, flags };
}

/** KEY=VALUE lines into process.env; variables already set are left alone. */
function loadEnv(file: string, required: boolean): void {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`env file not found: ${file}`);
    return;
  }
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (flags.help || command.join(" ") !== "generate types") {
    (flags.help ? process.stdout : process.stderr).write(USAGE);
    return flags.help ? 0 : 2;
  }
  loadEnv(path.resolve(flags.env ?? ".env"), flags.env !== undefined);
  // The logger writes to stdout, where the generated code may go: keep it quiet unless --verbose.
  process.env.ENABLE_CONSOLE_LOGS = flags.verbose ? "true" : "false";

  // Loaded after the environment is in place: the adapter reads it at load time.
  const { createDb, generateTableTypes } = require("../utils/oracle-mongo-wrapper") as typeof import("../utils/oracle-mongo-wrapper");
  const db = createDb("appDb");
  try {
    const tables = flags.tables?.split(",").map((s) => s.trim()).filter(Boolean);
    const code = await generateTableTypes(db, { tables, importFrom: flags.import });
    if (flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      fs.writeFileSync(flags.out, code);
      const n = (code.match(/^export const /gm) ?? []).length;
      process.stderr.write(`mira: wrote ${n} table definition(s) to ${flags.out}\n`);
    } else process.stdout.write(code);
    return 0;
  } finally {
    await db.closePool();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`mira: ${err.message}\n`);
    process.exit(1);
  },
);
