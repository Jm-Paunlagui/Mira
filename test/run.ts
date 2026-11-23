/**
 * Test runner: `bun test/run.ts [bun test args…]`
 *
 * 1. Runs `bun test` (args passed through, e.g. `--coverage` or `test/unit`)
 *    with a JUnit report at coverage/junit.xml.
 * 2. Prints a scorecard per category (the folder under test/: unit,
 *    integration, performance, chaos, security, reliability). Failures of tests
 *    named "DEFECT:" / "SECURITY:" are counted as known open defects; any other
 *    failure is "unexpected" and is what should block a merge.
 * 3. Writes one row per test to MIRA_TEST_RESULTS (metrics from the same run
 *    are written to MIRA_TEST_METRICS by test/helpers/setup.ts), keyed by RUN_ID.
 *    Set MIRA_SKIP_PERSIST=1 to skip.
 *
 * Exit code: bun test's own exit code.
 */
import fs from "node:fs";
import path from "node:path";

// Bun has already loaded .env (ENABLE_CONSOLE_LOGS=true there); keep the runner's
// own DB writes quiet unless MIRA_LOGS=1.
if (!process.env.MIRA_LOGS) process.env.ENABLE_CONSOLE_LOGS = "false";
const root = path.resolve(__dirname, "..");
const junit = path.join(root, "coverage", "junit.xml");
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${process.pid}`;
fs.mkdirSync(path.dirname(junit), { recursive: true });
fs.rmSync(junit, { force: true });

const child = Bun.spawn(["bun", "test", "--timeout", "180000", "--reporter=junit", `--reporter-outfile=${junit}`, ...process.argv.slice(2)], {
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, MIRA_RUN_ID: runId },
});
const code = await child.exited;

if (!fs.existsSync(junit)) {
  console.error("No JUnit report produced.");
  process.exit(code || 1);
}

type Row = { category: string; suite: string; title: string; state: "passed" | "failed" | "skipped"; ms: number; error: string | null; known: boolean };
const unescape = (s: string) => s.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xml = fs.readFileSync(junit, "utf8");
const rows: Row[] = [];
const re = /<testcase name="([^"]*)" classname="([^"]*)" time="([^"]*)" file="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
for (const mt of xml.matchAll(re)) {
  const [, name, classname, time, file, , body = ""] = mt;
  const title = unescape(name);
  const failure = /<failure[^>]*message="([^"]*)"/.exec(body) ?? (/<failure/.test(body) ? ["", "failed"] : null);
  const skipped = /<skipped/.test(body);
  rows.push({
    category: file.split("/")[1] ?? "unknown",
    suite: unescape(classname),
    title,
    state: failure ? "failed" : skipped ? "skipped" : "passed",
    ms: Number(time) * 1000,
    error: failure ? unescape(failure[1]).slice(0, 2000) : null,
    known: /^(DEFECT|SECURITY)\b/.test(title),
  });
}

const order = ["unit", "integration", "performance", "chaos", "security", "reliability"];
const cats = [...new Set(rows.map((r) => r.category))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
const card = cats.map((category) => {
  const rs = rows.filter((r) => r.category === category);
  const passed = rs.filter((r) => r.state === "passed").length;
  const knownDefects = rs.filter((r) => r.state === "failed" && r.known).length;
  const unexpected = rs.filter((r) => r.state === "failed" && !r.known).length;
  return { category, tests: rs.length, passed, knownDefects, unexpected, passRate: `${((100 * passed) / Math.max(1, rs.length)).toFixed(1)}%` };
});
console.log(`\n  ══ Mira scorecard (RUN_ID ${runId}) ══`);
console.table(card);
const open = rows.filter((r) => r.state === "failed" && r.known);
if (open.length) {
  console.log("  Open defects (tests that assert the fixed behaviour):");
  for (const r of open) console.log(`   ✗ [${r.category}] ${r.title}`);
}
const unexpected = rows.filter((r) => r.state === "failed" && !r.known);
if (unexpected.length) {
  console.log("  UNEXPECTED failures:");
  for (const r of unexpected) console.log(`   ✗ [${r.category}] ${r.suite} > ${r.title}\n       ${String(r.error).split("\n")[0]}`);
}

if (!process.env.MIRA_SKIP_PERSIST && rows.length) {
  try {
    const { coll, ensureHistoryTables, db } = await import("./helpers/db");
    await ensureHistoryTables();
    await coll("MIRA_TEST_RESULTS").insertMany(
      rows.map((r) => ({
        RUN_ID: runId,
        CATEGORY: r.category,
        SUITE: r.suite.slice(0, 300),
        TITLE: r.title.slice(0, 400),
        STATE: r.state,
        DURATION_MS: Math.round(r.ms),
        ERROR: r.error,
      })),
      { returning: [] },
    );
    console.log(`  Saved ${rows.length} rows to MIRA_TEST_RESULTS (RUN_ID='${runId}')`);
    await db.closePool();
  } catch (e) {
    console.log(`  Could not persist results: ${(e as Error).message}`);
  }
}
process.exit(code);
