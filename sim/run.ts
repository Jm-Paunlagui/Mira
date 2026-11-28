/**
 * Mira simulation: `bun run sim`
 *
 * Runs a three-branch canteen through Mira, end to end, in the simulation's
 * OWN Oracle schema (MIRA_SIM_DB_USERNAME; see sim/setup-schema.sql):
 *
 *   1 schema       OracleSchema DDL + OracleDCL grants, checked in USER_* views
 *   2 seed         inserts, batch errors, bulkWrite, indexes, views
 *   3 trading      36 till sales as transactions: locks, savepoints, check
 *                  constraints, payment; compared with an in-memory model
 *   4 back office  updates, upserts, MERGE, replace, find-and-modify, deletes,
 *                  UPDATE FROM JOIN, INSERT SELECT, PIVOT / UNPIVOT
 *   5 reports      QueryBuilder, filter operators, subqueries, every pipeline
 *                  stage, set operations, CTEs, CONNECT BY, flashback, SAMPLE
 *   6 builders     every standalone SQL builder, run and compared with the API
 *   7 performance  statistics, EXPLAIN PLAN, materialized views
 *   8 security     hostile input against every option that reaches SQL
 *   9 ledger       double-entry general ledger for the year: trial balance,
 *                  account-tree roll-up, cash ledger card, budget vs actual,
 *                  ROLLUP, quarterly P&L, month-on-month, year-end close
 *  10 receivables  corporate invoices and receipts, FIFO application, aging,
 *                  invoice-number gaps, duplicate supplier payments
 *  11 inventory    movement ledger reconciled to stock, weighted average and
 *                  FIFO cost, FEFO picking by two workers, ABC, reorder
 *                  alerts, stock-out runs, zero-sales days
 *  12 kitchen      multi-level recipes: explosion, where-used, MRP, cost roll-up
 *  13 finance      FX at the rate in force, loan and depreciation schedules vs
 *                  the ledger, CUBE / GROUPING SETS, allocation to the cent
 *  14 audit        Benford, orphan journals, split payments
 *  15 members      a typed model table: timestamps, soft delete, hooks, validation
 *  16 exports      keyset paging, for await, sql`…`, onQuery
 *  17 config       a second service's own pool: createMira, fromEnv, defineConfig
 *  18 operations   pool stats, health, shutdown
 *
 * Queries Mira's API cannot express run as hand-written SQL through an
 * untracked handle, are still checked against the model, and are listed as
 * coverage gaps at the end: a measured list of what Mira could support next.
 *
 * Then it proves every public Mira function was called by the simulation
 * (sim/lib/tracker.ts). Exit code 0 only when every check passed AND no public
 * function went unused.
 *
 * Env: MIRA_SIM_DB_USERNAME / MIRA_SIM_DB_PASSWORD (required),
 *      MIRA_SIM_DB_CONNECT_STRING or MIRA_SIM_DB_HOST / _PORT / _SID (default: the
 *      main MIRA_DB_* connection), MIRA_SIM_GRANTEE (default MIRA_DB_USER), MIRA_SIM_KEEP=1 to leave the
 *      SIM_* objects in place for inspection, MIRA_LOGS=1 for Mira's own logs.
 */
import { Sim } from "./lib/harness";
import { buildContext } from "./lib/context";
import { report } from "./lib/tracker";
import { Model, type State } from "./lib/data";
import { schemaStage } from "./stages/01-schema";
import { seedStage } from "./stages/02-seed";
import { tradingStage } from "./stages/03-trading";
import { backOfficeStage } from "./stages/04-backoffice";
import { reportsStage } from "./stages/05-reports";
import { buildersStage } from "./stages/06-builders";
import { performanceStage } from "./stages/07-performance";
import { securityStage } from "./stages/08-security";
import { ledgerStage } from "./stages/09-ledger";
import { receivablesStage } from "./stages/10-receivables";
import { inventoryStage } from "./stages/11-inventory";
import { kitchenStage } from "./stages/12-kitchen";
import { financeStage } from "./stages/13-finance";
import { auditStage } from "./stages/14-audit";
import { membersStage } from "./stages/15-members";
import { exportsStage } from "./stages/16-exports";
import { configStage } from "./stages/17-config";

const t0 = performance.now();
const ctx = await buildContext();
const sim = new Sim();
const state: State = { model: new Model(), createdAt: Date.now() };

/** Drop every SIM_* object in the simulation schema (and only those). */
async function cleanSlate() {
  const objs = await ctx.raw<{ T: string; N: string }>(
    `SELECT OBJECT_TYPE AS T, OBJECT_NAME AS N FROM USER_OBJECTS
      WHERE OBJECT_NAME LIKE 'SIM\\_%' ESCAPE '\\'
        AND OBJECT_TYPE IN ('MATERIALIZED VIEW','VIEW','SYNONYM','SEQUENCE','TABLE')`,
  );
  const order = ["MATERIALIZED VIEW", "VIEW", "SYNONYM", "SEQUENCE", "TABLE"];
  for (const type of order)
    for (const o of objs.filter((x) => x.T === type)) {
      const suffix = type === "TABLE" ? " CASCADE CONSTRAINTS PURGE" : "";
      try {
        await ctx.raw(`DROP ${type} "${o.N.replace(/"/g, '""')}"${suffix}`);
      } catch (e) {
        // A materialized view's container table goes with the view.
        if (!/ORA-00942|ORA-12083|ORA-04043/.test((e as Error).message)) throw e;
      }
    }
  return objs.length;
}

console.log(`\n  Mira simulation — schema ${ctx.schemaUser}`);
const removed = await cleanSlate();
if (removed) console.log(`  Clean slate: removed ${removed} SIM_* objects left by an earlier run`);

await sim.stage("1 schema", () => schemaStage(sim, ctx, state));
await sim.stage("2 seed", () => seedStage(sim, ctx, state));
await sim.stage("3 trading", () => tradingStage(sim, ctx, state));
await sim.stage("4 back office", () => backOfficeStage(sim, ctx, state));
await sim.stage("5 reports", () => reportsStage(sim, ctx, state));
await sim.stage("6 builders", () => buildersStage(sim, ctx, state));
await sim.stage("7 performance", () => performanceStage(sim, ctx, state));
await sim.stage("8 security", () => securityStage(sim, ctx, state));
await sim.stage("9 ledger", () => ledgerStage(sim, ctx, state));
await sim.stage("10 receivables", () => receivablesStage(sim, ctx, state));
await sim.stage("11 inventory", () => inventoryStage(sim, ctx, state));
await sim.stage("12 kitchen", () => kitchenStage(sim, ctx, state));
await sim.stage("13 finance", () => financeStage(sim, ctx, state));
await sim.stage("14 audit", () => auditStage(sim, ctx, state));
await sim.stage("15 members", () => membersStage(sim, ctx));
await sim.stage("16 exports", () => exportsStage(sim, ctx, state));
await sim.stage("17 config", () => configStage(sim, ctx, state));
await sim.stage("18 operations", async () => {
  sim.eq("isHealthy: the pool is up", ctx.db.isHealthy(), true);
  const stats = (await ctx.db.getPoolStats()) as { pools?: Record<string, unknown> | unknown[] };
  sim.ok("getPoolStats: reports the appDb pool", JSON.stringify(stats).includes("appDb"), stats);
  if (!process.env.MIRA_SIM_KEEP) {
    await cleanSlate();
    sim.eq("teardown: no SIM_* objects left", await ctx.rawCount("USER_OBJECTS", "WHERE OBJECT_NAME LIKE 'SIM\\_%' ESCAPE '\\'"), 0);
  }
  await ctx.db.closePool(); // closes the simulation's Mira instance
  sim.eq("isHealthy reports false after closePool", ctx.db.isHealthy(), false);
});

// ── Report ───────────────────────────────────────────────────────────────────
const surface = report();
const stages = sim.stageTimes.map(({ stage, ms, statements, dbMs }) => {
  const rs = sim.results.filter((r) => r.stage === stage);
  return { stage, checks: rs.length, passed: rs.filter((r) => r.ok).length, failed: rs.filter((r) => !r.ok).length, seconds: +(ms / 1000).toFixed(2), statements, dbSeconds: +(dbMs / 1000).toFixed(2) };
});
console.table(stages);
// Recorded with every run: coverage/sim-stages.json, and on CI the job summary. The sim is
// deterministic, so a stage's statement count only moves when the code (or the stage) does.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const out = path.join(__dirname, "..", "coverage", "sim-stages.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const driver = (await import("../src/driver/oracle")).initDriver();
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), driver: driver.mode, bun: Bun.version, platform: `${process.platform}-${process.arch}`, totalSeconds: +((performance.now() - t0) / 1000).toFixed(2), stages }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = stages.map((s) => `| ${s.stage} | ${s.passed}/${s.checks} | ${s.seconds} | ${s.statements} | ${s.dbSeconds} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Simulation stages (${driver.mode} mode)`, "", "| Stage | Checks | Seconds | Statements | In statements (s) |", "| --- | ---: | ---: | ---: | ---: |", ...rows, ""].join("\n"));
  }
}

const m = state.model;
console.log(`  Trading day: ${m.orders.filter((o) => o.receipt !== 9999).length} sales completed, ${m.rejected.filter((r) => r.reason === "stock").length} refused for stock, ${m.rejected.filter((r) => r.reason === "credit").length} for credit; add-ons kept ${m.addOnsKept}, rolled back ${m.addOnsRolledBack}`);

// Checks named "DEFECT:" assert the correct behaviour of a known open defect (same convention as test/run.ts).
const known = sim.failed.filter((f) => f.label.startsWith("DEFECT:"));
const unexpected = sim.failed.filter((f) => !f.label.startsWith("DEFECT:"));
const show = (f: (typeof sim.failed)[number]) => console.log(`   ✗ [${f.stage}] ${f.label}${f.detail ? `\n       ${f.detail.replace(/\n/g, "\n       ")}` : ""}`);
if (known.length) {
  console.log("\n  Open defects (checks that assert the fixed behaviour):");
  known.forEach(show);
}
if (unexpected.length) {
  console.log("\n  UNEXPECTED failures:");
  unexpected.forEach(show);
}

if (sim.gaps.length) {
  console.log(`\n  Coverage gaps: ${sim.gaps.length} business queries Mira's API cannot express (run as hand-written SQL, still checked):`);
  for (const g of sim.gaps) console.log(`   · [${g.stage}] ${g.label}\n       ${g.reason}`);
}
console.log(`\n  Query coverage: ${sim.viaMira} queries through Mira's API, ${sim.gaps.length} gaps (${((100 * sim.viaMira) / Math.max(1, sim.viaMira + sim.gaps.length)).toFixed(0)}% expressible)`);
console.log(`  API surface: ${surface.used.length}/${surface.total} public Mira functions called by the simulation`);
if (surface.unused.length) {
  console.log("  NOT exercised:");
  for (const u of surface.unused) console.log(`   ✗ ${u}`);
}

const passed = sim.results.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${sim.results.length} checks passed${known.length ? `, ${known.length} open defect(s)` : ""}${unexpected.length ? `, ${unexpected.length} UNEXPECTED` : ""}. (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
console.log(sim.failed.length === 0 && surface.unused.length === 0 ? "  Results: PASSED\n" : "  Results: FAILED\n");
process.exit(sim.failed.length === 0 && surface.unused.length === 0 ? 0 : 1);
