/**
 * Stage 7 — DBA work: optimizer statistics, execution plans and a sales
 * summary materialized view that is refreshed after a new sale.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

export async function performanceStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw, rawCount } = ctx;
  const { model } = state;
  const perf = api.createPerformance(db) as {
    explainPlan: (q: unknown) => Promise<Record<string, unknown>[]>;
    analyze: (t: string) => Promise<void>;
    createMaterializedView: (n: string, q: unknown, o?: Record<string, unknown>) => Promise<{ acknowledged: boolean }>;
    refreshMaterializedView: (n: string, m?: string) => Promise<void>;
    dropMaterializedView: (n: string) => Promise<{ acknowledged: boolean }>;
  };
  const orders = new api.OracleCollection(T.ORDERS, db);
  const lines = new api.OracleCollection(T.LINES, db);

  await perf.analyze(T.LINES);
  const [st] = await raw<{ NUM_ROWS: number; LAST_ANALYZED: Date | null }>("SELECT NUM_ROWS, LAST_ANALYZED FROM USER_TABLES WHERE TABLE_NAME = :t", { t: T.LINES });
  const lineCount = await rawCount(T.LINES);
  sim.eq("analyze: statistics gathered, NUM_ROWS equals the real row count", [Number(st.NUM_ROWS), st.LAST_ANALYZED != null], [lineCount, true]);
  sim.eq("estimatedDocumentCount: reads those statistics", await lines.estimatedDocumentCount(), lineCount);

  const plan = await perf.explainPlan(orders.find({ CUSTOMER_ID: model.customerIds[0] }));
  const planText = JSON.stringify(plan);
  sim.ok("explainPlan from a query: the plan reads the orders table", plan.length > 0 && planText.includes(T.ORDERS), plan);
  const planSql = await perf.explainPlan(`SELECT * FROM "${T.LINES}" WHERE ORDER_ID = 1`);
  sim.ok("explainPlan from SQL text", planSql.length > 0 && JSON.stringify(planSql).includes(T.LINES), planSql);

  const summarySql = `SELECT STORE_ID, COUNT(*) AS N, SUM(TOTAL) AS REVENUE FROM "${T.ORDERS}" GROUP BY STORE_ID`;
  await perf.createMaterializedView(T.MV_SALES, summarySql, { orReplace: true, refreshMode: "complete", refreshOn: "demand", buildMode: "deferred" });
  sim.eq("createMaterializedView BUILD DEFERRED: empty until refreshed", await rawCount(T.MV_SALES), 0);
  await perf.refreshMaterializedView(T.MV_SALES);
  const revenue = async () => (await raw<{ STORE_ID: number; N: number; REVENUE: string }>(`SELECT STORE_ID, N, REVENUE FROM "${T.MV_SALES}" ORDER BY STORE_ID`)).map((r) => [Number(r.STORE_ID), Number(r.N), cents(r.REVENUE)]);
  const expected = () =>
    [1, 2, 3]
      .map((s) => [s, model.orders.filter((o) => o.storeId === s).length, model.orders.filter((o) => o.storeId === s).reduce((a, o) => a + o.total, 0)])
      .filter((r) => r[1] > 0);
  sim.eq("refreshMaterializedView (complete): summary per branch", await revenue(), expected());

  // A late sale arrives; the summary is stale until refreshed.
  const late = await orders.insertOne({ RECEIPT_NO: 9999, CUSTOMER_ID: model.customerIds[1], STORE_ID: 1, QUARTER: "Q4", STATUS: "paid", TOTAL: 50 });
  const stale = await revenue();
  model.orders.push({ receipt: 9999, orderId: Number(late.insertedId), customerId: model.customerIds[1], storeId: 1, quarter: "Q4", total: 5000, lines: [] });
  sim.ok("materialized view is stale before the refresh", JSON.stringify(stale) !== JSON.stringify(expected()), stale);
  await perf.refreshMaterializedView(T.MV_SALES, "force");
  sim.eq("refreshMaterializedView (force): the late sale is counted", await revenue(), expected());

  // Same view from a query builder, built immediately.
  try {
    await perf.createMaterializedView(T.MV_SALES, orders.find({ STORE_ID: 1 }).project({ RECEIPT_NO: 1, TOTAL: 1 }), { orReplace: true });
    sim.eq("DEFECT: createMaterializedView from a filtered query (DDL cannot take bind values)", await rawCount(T.MV_SALES), model.orders.filter((o) => o.storeId === 1).length);
  } catch (e) {
    sim.ok("DEFECT: createMaterializedView from a filtered query (DDL cannot take bind values)", false, (e as Error).message.split("\n")[0]);
  }
  await perf.createMaterializedView(T.MV_SALES, orders.find({}).project({ RECEIPT_NO: 1, TOTAL: 1 }), { orReplace: true });
  sim.eq("createMaterializedView from an unfiltered query (OR REPLACE, built immediately)", await rawCount(T.MV_SALES), model.orders.length);
  sim.eq("dropMaterializedView", await perf.dropMaterializedView(T.MV_SALES), { acknowledged: true });
  sim.eq("dropMaterializedView: gone from USER_MVIEWS", await rawCount("USER_MVIEWS", "WHERE MVIEW_NAME = :m", { m: T.MV_SALES }), 0);
}
