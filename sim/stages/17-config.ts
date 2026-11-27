/**
 * Stage 17 — A second service joins: the reporting job brings its own pool,
 * defined the 2.2 way (createMira) instead of the env-driven appDb.
 *   - its connect string is built with buildTNSConnectString (the shape appDb uses),
 *   - its config is read by fromEnv() from the job's own variables,
 *   - a typo in a hand-written config is caught by defineConfig before anything connects,
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

  const mira = api.createMira(config);
  const sales = await sim.mira(() => mira.collection(T.ORDERS).countDocuments());
  sim.eq("createMira: the reporting pool sees every sale", sales, state.model.orders.length);
  await mira.close();
  sim.eq("close(): the reporting instance is closed", mira.closed, true);
  sim.eq("close(): appDb keeps serving", await sim.mira(() => new api.OracleCollection(T.ORDERS, ctx.db).countDocuments()), state.model.orders.length);
}
