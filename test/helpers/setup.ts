/**
 * bun test preload (see bunfig.toml). Hooks declared here are global: the
 * afterAll below runs once, after every test file.
 *
 * - Prints recorded metrics and persists them to MIRA_TEST_METRICS.
 * - Closes every pool last; closeAll() is one-way, so nothing runs after it.
 *
 * Per-test pass/fail rows go to MIRA_TEST_RESULTS via test/helpers/persistResults.ts,
 * which reads the JUnit report (bun test has no per-test hook context).
 * Set MIRA_SKIP_PERSIST=1 to skip writing run history.
 */
import { afterAll } from "bun:test";
import { db, metrics, RUN_ID, ensureHistoryTables, coll } from "./db";

process.env.NODE_ENV = "test";

afterAll(async () => {
  if (metrics.length) {
    console.log(`\n  ══ Metrics (run ${RUN_ID}) ══`);
    console.table(metrics.map((m) => ({ category: m.category, metric: m.metric, value: Number(m.value.toFixed(2)), unit: m.unit })));
    if (!process.env.MIRA_SKIP_PERSIST) {
      try {
        await ensureHistoryTables();
        await coll("MIRA_TEST_METRICS").insertMany(
          metrics.map((m) => ({
            RUN_ID,
            CATEGORY: m.category,
            METRIC: m.metric.slice(0, 200),
            VALUE: Number(m.value.toFixed(3)),
            UNIT: m.unit,
            NOTE: m.note ? m.note.slice(0, 400) : null,
          })),
          { returning: [] },
        );
        console.log(`  Metrics saved to MIRA_TEST_METRICS (RUN_ID='${RUN_ID}')`);
      } catch (e) {
        console.log(`  Could not persist metrics: ${(e as Error).message}`);
      }
    }
  }
  await db.closePool();
});
