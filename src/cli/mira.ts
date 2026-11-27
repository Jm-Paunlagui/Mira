#!/usr/bin/env node
/**
 * The `mira` command line.
 *
 *   mira generate types [--out <file>] [--tables A,B,SIM_%] [--import <module>]
 *   mira migrate new <name> [--dir migrations]
 *   mira migrate status | up [--to <name>] [--dry-run] | down [--steps n | --to <name> | --all] [--dry-run]
 *
 * Commands that touch the database connect with the appDb credentials (DB_* /
 * APP_DB_* in the environment, or in the .env file given by --env, default
 * ./.env when present).
 */
import fs from "node:fs";
import path from "node:path";

const USAGE = `Usage:
  mira generate types [--out <file>] [--tables A,B,PREFIX_%] [--import <module>]
  mira migrate new <name> [--dir <dir>]
  mira migrate status [--dir <dir>]
  mira migrate up [--to <name>] [--dry-run] [--dir <dir>]
  mira migrate down [--steps <n> | --to <name> | --all] [--dry-run] [--dir <dir>]

Options:
  --out <file>       generate types: write the module here (default: stdout)
  --tables <list>    generate types: comma-separated table names; a name with % is a LIKE pattern
  --import <module>  module the generated files import from (default: @jm-paunlagui/mira)
  --dir <dir>        migration files (default: ./migrations)
  --to <name>        up: apply up to and including <name>; down: roll back every migration after <name>
  --steps <n>        down: how many migrations to roll back (default 1)
  --all              down: roll back every applied migration
  --dry-run          print the SQL each migration would run; change nothing
  --table <name>     migration history table (default MIRA_MIGRATIONS)
  --env <file>       .env file to load (default: ./.env if it exists; existing variables win)
  --verbose          show Mira's log lines (they go to stdout)
`;

type Args = { command: string[]; flags: Record<string, string> };
const BOOLEAN_FLAGS = new Set(["help", "verbose", "dry-run", "all"]);

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = "1";
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (BOOLEAN_FLAGS.has(k)) {
        flags[k] = "1";
        continue;
      }
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

type Api = typeof import("..");
const say = (text: string) => process.stdout.write(`${text}\n`);

/** Run `fn` with a db handle; the pool is closed afterwards. */
async function withDb(flags: Record<string, string>, fn: (api: Api, db: ReturnType<Api["createDb"]>) => Promise<number>): Promise<number> {
  loadEnv(path.resolve(flags.env ?? ".env"), flags.env !== undefined);
  // The logger writes to stdout, where generated code and reports go: quiet unless --verbose.
  process.env.ENABLE_CONSOLE_LOGS = flags.verbose ? "true" : "false";
  // Loaded after the environment is in place: the adapter reads it at load time.
  const api = require("..") as Api;
  const db = api.createDb("appDb");
  try {
    return await fn(api, db);
  } finally {
    await db.closePool();
  }
}

async function generateTypes(flags: Record<string, string>): Promise<number> {
  return withDb(flags, async (api, db) => {
    const tables = flags.tables?.split(",").map((s) => s.trim()).filter(Boolean);
    const code = await api.generateTableTypes(db, { tables, importFrom: flags.import });
    if (flags.out) {
      fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
      fs.writeFileSync(flags.out, code);
      const n = (code.match(/^export const /gm) ?? []).length;
      process.stderr.write(`mira: wrote ${n} table definition(s) to ${flags.out}\n`);
    } else process.stdout.write(code);
    return 0;
  });
}

async function migrate(sub: string, rest: string[], flags: Record<string, string>): Promise<number> {
  const dir = path.resolve(flags.dir ?? "migrations");
  if (sub === "new") {
    const { migrationFileName, migrationTemplate } = require("../migrate/migrator") as typeof import("../migrate/migrator");
    const file = path.join(dir, migrationFileName(rest.join(" ")));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, migrationTemplate(flags.import));
    say(`created ${path.relative(process.cwd(), file)}`);
    return 0;
  }
  return withDb(flags, async (api, db) => {
    const migrator = api.createMigrator(db, { dir, table: flags.table });
    const dryRun = flags["dry-run"] === "1";
    const print = (runs: Array<{ name: string; durationMs: number; sql: string[] }>, verb: string) => {
      if (runs.length === 0) say(`nothing to ${verb}.`);
      for (const r of runs) {
        say(`${dryRun ? "would " : ""}${verb} ${r.name}${dryRun ? "" : ` (${r.durationMs} ms)`}`);
        if (dryRun) for (const s of r.sql) say(`  ${s.replace(/\s+/g, " ")};`);
      }
    };
    if (sub === "status") {
      const rows = await migrator.status();
      if (rows.length === 0) say("no migrations.");
      for (const s of rows) say(`${s.state.padEnd(8)} ${s.name}${s.batch ? `  (batch ${s.batch})` : ""}`);
      return rows.some((s) => s.state === "changed" || s.state === "missing") ? 1 : 0;
    }
    if (sub === "up") {
      print(await migrator.up({ to: flags.to, dryRun }), "apply");
      return 0;
    }
    // down
    const steps = flags.steps === undefined ? undefined : Number(flags.steps);
    print(await migrator.down({ steps, to: flags.all ? null : flags.to, dryRun }), "roll back");
    return 0;
  });
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const [group, sub, ...rest] = command;
  if (!flags.help && group === "generate" && sub === "types" && rest.length === 0) return generateTypes(flags);
  if (!flags.help && group === "migrate" && (sub === "new" ? rest.length > 0 : ["status", "up", "down"].includes(sub) && rest.length === 0)) return migrate(sub, rest, flags);
  (flags.help ? process.stdout : process.stderr).write(USAGE);
  return flags.help ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`mira: ${err.message}\n`);
    process.exit(1);
  },
);
