/**
 * bun test preload (see bunfig.toml). Hooks declared here are global: the
 * afterAll below runs once, after every test file.
 *
 * - Silences Mira's log sink unless MIRA_LOGS=1 (then everything goes to the console).
 * - Prints recorded metrics and persists them to MIRA_TEST_METRICS.
 * - Closes every pool last; closeAll() is one-way, so nothing runs after it.
 *
 * Per-test pass/fail rows go to MIRA_TEST_RESULTS via test/helpers/persistResults.ts,
 * which reads the JUnit report (bun test has no per-test hook context).
 * Set MIRA_SKIP_PERSIST=1 to skip writing run history.
 */
import { afterAll } from "bun:test";
import { metrics, RUN_ID, ensureHistoryTables, coll } from "./db";
import { setLogger } from "../../src/shared/log";
import { closeAll } from "../../src/driver/oracle";

process.env.NODE_ENV = "test";
// Tests provoke retries and failures on purpose; their warnings are noise. MIRA_LOGS=1 shows everything.
setLogger(process.env.MIRA_LOGS ? console : false);

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
  // Every pool, including the ones suites register directly (chaos_*, sec_* …).
  await closeAll();
});
