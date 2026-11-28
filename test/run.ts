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

// Keep the runner's own DB writes quiet unless MIRA_LOGS=1 (the test preload does the same for the suite).
if (!process.env.MIRA_LOGS) (require("../src/shared/log") as typeof import("../src/shared/log")).setLogger(false);
const root = path.resolve(__dirname, "..");
const junit = path.join(root, "coverage", "junit.xml");
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${process.pid}`;
fs.mkdirSync(path.dirname(junit), { recursive: true });
fs.rmSync(junit, { force: true });

// macOS + Thick mode: Bun 1.4.5 intermittently segfaults when the whole suite runs in one
// process (see docs/ROADMAP-3.1.md, Reliability). Unless coverage or a file filter is asked
// for, the chaos suite then runs in a second process. MIRA_TEST_SPLIT=1 / 0 forces it on / off.
const args = process.argv.slice(2);
const wantsSplit = process.env.MIRA_TEST_SPLIT
  ? process.env.MIRA_TEST_SPLIT === "1"
  : process.platform === "darwin" && process.env.MIRA_DRIVER_MODE === "thick" && !args.some((a) => !a.startsWith("-") || a === "--coverage");
const runs: string[][] = wantsSplit
  ? [["./test/unit", "./test/integration", "./test/performance", "./test/reliability", "./test/security", ...args], ["./test/chaos", ...args]]
  : [args];
if (wantsSplit) console.log("Thick mode on macOS: the chaos suite runs in its own process (MIRA_TEST_SPLIT=0 to run everything in one).");

const reports: string[] = [];
let code = 0;
for (const [i, runArgs] of runs.entries()) {
  const out = runs.length === 1 ? junit : junit.replace(/\.xml$/, `.${i + 1}.xml`);
  fs.rmSync(out, { force: true });
  const child = Bun.spawn(["bun", "test", "--timeout", "180000", "--reporter=junit", `--reporter-outfile=${out}`, ...runArgs], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, MIRA_RUN_ID: runId },
  });
  code ||= await child.exited;
  if (!fs.existsSync(out)) {
    console.error("No JUnit report produced.");
    process.exit(code || 1);
  }
  reports.push(out);
}

type Row = { category: string; suite: string; title: string; state: "passed" | "failed" | "skipped"; ms: number; error: string | null; known: boolean };
const unescape = (s: string) => s.replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xml = reports.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const rows: Row[] = [];
const re = /<testcase name="([^"]*)" classname="([^"]*)" time="([^"]*)" file="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
for (const mt of xml.matchAll(re)) {
  const [, name, classname, time, file, , body = ""] = mt;
  const title = unescape(name);
  const failure = /<failure[^>]*message="([^"]*)"/.exec(body) ?? (/<failure/.test(body) ? ["", "failed"] : null);
  const skipped = /<skipped/.test(body);
  rows.push({
    // bun writes the path with the OS separator: test/unit/… on Linux, test\unit\… on Windows.
    category: file.split(/[\\/]/)[1] ?? "unknown",
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
