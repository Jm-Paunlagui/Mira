/**
 * Stage 17 — A second service joins: the reporting job brings its own pool,
 * defined the 2.2 way (createMira) instead of the env-driven appDb.
 *   - its connect string is built with buildTNSConnectString (the shape appDb uses),
 *   - its config is read by fromEnv() from the job's own variables,
 *   - a typo in a hand-written config is caught by defineConfig before anything connects,
 *   - the job asks for the driver mode already running (initDriver / configureDriver),
 *     and a different one is refused, since the Oracle Client is process-wide,
 *   - its log lines go to the job's own logger (setLogger) while it runs,
 *   - it counts the day's sales on its own pool, which match the trading model,
 *   - closing it leaves appDb, which every other stage uses, serving.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

export async function configStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, conn } = ctx;

  sim.eq("buildSimpleConnectString: Easy Connect form", api.buildSimpleConnectString(conn.host, conn.port, "SVC"), `${conn.host}:${conn.port}/SVC`);
  const connectString = api.buildTNSConnectString(conn.host, conn.port, conn.sid);
  sim.ok("buildTNSConnectString: a TNS descriptor naming the SID", connectString.startsWith("(DESCRIPTION=") && connectString.includes(`(SID=${conn.sid})`), connectString);

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
    const sales = await sim.mira(() => mira.collection(T.ORDERS).countDocuments());
    sim.eq("createMira: the reporting pool sees every sale", sales, state.model.orders.length);
    await mira.close();
  } finally {
    api.setLogger(process.env.MIRA_LOGS ? console : false); // back to what the sim context set
  }
  sim.ok("setLogger: the job's logger saw its pool open and close", lines.some((l) => l.includes('"reporting"') && /ready/i.test(l)) && lines.some((l) => l.includes('Pool "reporting" closed')), lines);
  sim.eq("close(): the reporting instance is closed", mira.closed, true);
  sim.eq("close(): appDb keeps serving", await sim.mira(() => new api.OracleCollection(T.ORDERS, ctx.db).countDocuments()), state.model.orders.length);
}
