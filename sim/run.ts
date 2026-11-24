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
 *   9 operations   pool stats, health, shutdown
 *
 * Then it proves every public Mira function was called by the simulation
 * (sim/lib/tracker.ts). Exit code 0 only when every check passed AND no public
 * function went unused.
 *
 * Env: MIRA_SIM_DB_USERNAME / MIRA_SIM_DB_PASSWORD (required),
 *      MIRA_SIM_DB_HOST / _PORT / _SID (default: the main DB_* values),
 *      MIRA_SIM_GRANTEE (default APP_DB_USERNAME), MIRA_SIM_KEEP=1 to leave the
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
await sim.stage("9 operations", async () => {
  sim.eq("isHealthy: the pool is up", ctx.db.isHealthy(), true);
  const stats = (await ctx.db.getPoolStats()) as { pools?: Record<string, unknown> | unknown[] };
  sim.ok("getPoolStats: reports the appDb pool", JSON.stringify(stats).includes("appDb"), stats);
  if (!process.env.MIRA_SIM_KEEP) {
    await cleanSlate();
    sim.eq("teardown: no SIM_* objects left", await ctx.rawCount("USER_OBJECTS", "WHERE OBJECT_NAME LIKE 'SIM\\_%' ESCAPE '\\'"), 0);
  }
  await ctx.db.closePool();
  sim.eq("DEFECT: isHealthy reports false after closePool", ctx.db.isHealthy(), false);
});

// ── Report ───────────────────────────────────────────────────────────────────
const surface = report();
const stages = sim.stageTimes.map(({ stage, ms }) => {
  const rs = sim.results.filter((r) => r.stage === stage);
  return { stage, checks: rs.length, passed: rs.filter((r) => r.ok).length, failed: rs.filter((r) => !r.ok).length, seconds: +(ms / 1000).toFixed(1) };
});
console.table(stages);

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

console.log(`\n  API surface: ${surface.used.length}/${surface.total} public Mira functions called by the simulation`);
if (surface.unused.length) {
  console.log("  NOT exercised:");
  for (const u of surface.unused) console.log(`   ✗ ${u}`);
}

const passed = sim.results.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${sim.results.length} checks passed${known.length ? `, ${known.length} open defect(s)` : ""}${unexpected.length ? `, ${unexpected.length} UNEXPECTED` : ""}. (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
console.log(sim.failed.length === 0 && surface.unused.length === 0 ? "  Results: PASSED\n" : "  Results: FAILED\n");
process.exit(sim.failed.length === 0 && surface.unused.length === 0 ? 0 : 1);
