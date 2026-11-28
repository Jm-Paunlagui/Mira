/**
 * Stage 17 — A second service joins: the reporting job brings its own pool,
 * next to the simulation's appDb, on the same schema.
 *   - the connect-string builders produce the forms a deploy would hand it,
 *   - its config is read by fromEnv() from the job's own variables,
 *   - a typo in a hand-written config is caught by defineConfig before anything connects,
 *   - the job asks for the driver mode already running (initDriver / configureDriver),
 *     and a different one is refused, since the Oracle Client is process-wide,
 *   - its log lines go to the job's own logger (setLogger) while it runs,
 *   - it opens its pool up front and watches only its own pool's health, as a
 *     readiness probe would (open, stats, health.*),
 *   - it counts the day's sales on its own pool, which match the trading model, once
 *     through a collection and once inside a read-only transaction,
 *   - a failing statement reaches it as a MiraDbError that says what sort of failure it was
 *     (a statement, not a link) and that nothing is in doubt (outcomeUnknown false),
 *   - stats() reports no native work abandoned (a healthy run gives up on nothing), and the
 *     pool is open (not "opening") and was never replaced,
 *   - health.metrics() shows its breaker closed and the pool not saturated (busy, not down),
 *   - closing it leaves appDb, which every other stage uses, serving.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

export async function configStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, conn } = ctx;

  sim.eq("buildSimpleConnectString: Easy Connect form", api.buildSimpleConnectString("db.local", 1521, "RPT"), "db.local:1521/RPT");
  const tns = api.buildTNSConnectString("db.local", 1521, "RPT");
  sim.ok("buildTNSConnectString: a TNS descriptor naming the SID", tns.startsWith("(DESCRIPTION=") && tns.includes("(HOST=db.local)(PORT=1521)") && tns.includes("(SID=RPT)"), tns);
  const connectString = conn.connectString; // where the simulation schema really is

  // The job's environment, as its deploy would set it. Not process.env: nothing global changes.
  const env = { RPT_USER: conn.user, RPT_PASSWORD: conn.password, RPT_CONNECT_STRING: connectString, RPT_POOL_MIN: "0", RPT_POOL_MAX: "2" };
  const config = api.fromEnv({ env, pools: { reporting: "RPT" } });
  sim.eq("fromEnv: one pool, named by the job", [config.poolNames, config.defaultPool, config.pools.reporting.poolMax], [["reporting"], "reporting", 2]);

  let issues: readonly string[] = [];
  try {
    api.defineConfig({ pools: { reporting: { ...config.pools.reporting, poolmax: 2 } as never } });
  } catch (e) {
    issues = (e as InstanceType<typeof api.MiraConfigError>).issues ?? [];
  }
  sim.eq("defineConfig: a misspelt option is refused, by name", issues, ["pools.reporting.poolmax is not a pool option"]);

  const running = api.initDriver(); // already up: appDb opened it in stage 1
  sim.eq("initDriver: reports the mode the driver loaded in", running.mode, ctx.db.oracledb.oracleClientVersion ? "thick" : "thin");
  api.configureDriver({ mode: running.mode });
  sim.ok("configureDriver: the running mode is accepted", true);
  const other = running.mode === "thin" ? "thick" : "thin";
  let refused = "";
  try {
    api.configureDriver({ mode: other });
  } catch (e) {
    refused = (e as Error).message;
  }
  sim.ok("configureDriver: switching mode after start is refused", refused.includes(`already initialised as ${running.mode}`), refused);

  const lines: string[] = [];
  api.setLogger({ info: (m) => void lines.push(m), warn: (m) => void lines.push(m), error: (m) => void lines.push(m) });
  const mira = api.createMira(config);
  try {
    sim.eq("open(): the reporting pool opens up front", await mira.open(), [{ name: "reporting", success: true }]);
    sim.eq("stats(): only the reporting pool", Object.keys((await mira.stats()).pools), ["reporting"]);
    sim.eq("stats(): nothing abandoned on a healthy run", (await mira.stats()).abandoned, { calls: 0, pools: 0, zombies: 0 });
    const poolStats = (await mira.stats()).pools.reporting as { opening?: boolean; replacements?: number; zombieConnections?: number };
    sim.eq("stats(): the reporting pool is open, never replaced, with no stuck connection", [poolStats.opening, poolStats.replacements, poolStats.zombieConnections], [undefined, 0, 0]);
    const missing = await mira.db().withConnection((c) => c.execute('SELECT 1 FROM "MIRA_SIM_NO_SUCH_TABLE"')).catch((e: unknown) => e);
    sim.ok(
      "MiraDbError: a failing statement is a statement failure with nothing in doubt",
      missing instanceof api.MiraDbError && missing.kind === "statement" && missing.outcomeUnknown === false && missing.connectionName === "reporting" && String(missing.message).includes("ORA-00942"),
      missing,
    );
    const checks: Array<{ name: string; ok: boolean }> = [];
    const offCheck = mira.health.onCheck((c) => void checks.push(c));
    const offChange = mira.health.onChange(() => {});
    mira.health.watch(true);
    mira.health.recordProbeSuccess();
    mira.health.nudge();
    for (let i = 0; i < 100 && checks.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    sim.eq("health.onCheck(): a nudged check of the reporting pool passes", checks[0], { name: "reporting", ok: true });
    sim.ok("health: the reporting pool and the instance are healthy", mira.health.isHealthy() && mira.health.allHealthy());
    sim.eq("health.metrics(): only the reporting pool", Object.keys(mira.health.metrics()), ["reporting"]);
    const record = mira.health.metrics().reporting as { state?: string; saturated?: boolean };
    sim.eq("health.metrics(): the reporting breaker is closed and the pool is not saturated", [record.state, record.saturated], ["closed", false]);
    offCheck();
    offChange();
    mira.health.watch(false);

    const sales = await sim.mira(() => mira.collection(T.ORDERS).countDocuments());
    sim.eq("createMira: the reporting pool sees every sale", sales, state.model.orders.length);
    const inTx = await sim.mira(() => mira.transaction().withReadOnlyTransaction((s) => s.collection(T.ORDERS).countDocuments()));
    sim.eq("mira.transaction(): the same count in a read-only transaction", inTx, sales);
    sim.ok("mira.schema() / mira.dcl(): bound to the reporting pool", mira.schema() instanceof api.OracleSchema && mira.dcl() instanceof api.OracleDCL);
    const handle = mira.db();
    sim.eq("mira.db(): the handle names its pool", handle.connectionName, "reporting");
    await mira.close();
    sim.eq("close(): a kept handle reports unhealthy", handle.isHealthy(), false);
    let closedErr = "";
    await handle.withConnection(async () => 1).catch((e: Error) => void (closedErr = e.message));
    sim.ok("close(): a kept handle refuses work", closedErr.includes("This Mira instance is closed"), closedErr);
  } finally {
    api.setLogger(process.env.MIRA_LOGS ? console : false); // back to what the sim context set
  }
  sim.ok("setLogger: the job's logger saw its pool open and close", lines.some((l) => l.includes('"reporting"') && /ready/i.test(l)) && lines.some((l) => l.includes('Pool "reporting" closed')), lines);
  sim.eq("close(): the reporting instance is closed", mira.closed, true);
  sim.eq("close(): appDb keeps serving", await sim.mira(() => new api.OracleCollection(T.ORDERS, ctx.db).countDocuments()), state.model.orders.length);
}
