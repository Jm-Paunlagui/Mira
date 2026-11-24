/**
 * Stage 8 — Hostile input. A table of secrets sits in the schema; every
 * attempt below tries to read it, widen a filter, or run extra SQL through a
 * Mira option. Each must be refused (or bound as plain data), and afterwards
 * the secrets table and the business data must be untouched.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

export async function securityStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, rawCount } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);
  const customers = coll(T.CUSTOMERS);
  const orders = coll(T.ORDERS);
  const secret = coll(T.SECRET);
  await secret.insertOne({ ID: 1, TOKEN: "TOP-SECRET-TOKEN" });
  const leaks = (v: unknown) => JSON.stringify(v ?? null).includes("TOP-SECRET");
  const customersBefore = await rawCount(T.CUSTOMERS);

  // Filter values are bound, never spliced.
  sim.eq("a filter value carrying SQL matches nothing", await customers.countDocuments({ NAME: "x' OR '1'='1" }), 0);
  sim.eq("a $like pattern carrying SQL matches nothing", await customers.countDocuments({ NAME: { $like: "%' OR 1=1 --" } }), 0);
  sim.eq("a $regex carrying SQL matches nothing", await customers.countDocuments({ NAME: { $regex: "x' OR '1'='1" } }), 0);
  await sim.rejects("a malformed $regex is rejected by Oracle as a pattern, not run as SQL (ORA-12725)", customers.countDocuments({ NAME: { $regex: "') OR 1=1 --" } }), /ORA-12725/);

  // Identifiers are quoted. Oracle refuses a quote inside a quoted name (ORA-03001), so the statement never runs.
  await sim.rejects("a table name carrying SQL is quoted, not executed (ORA-00942)", coll(`${T.CUSTOMERS}" WHERE 1=1 UNION SELECT TOKEN FROM "${T.SECRET}`).countDocuments(), /ORA-00942|ORA-00972|ORA-03001/);
  await sim.rejects("a column name carrying SQL is quoted, not executed", customers.find({ 'NAME" = NAME OR "1': 1 }).toArray(), /ORA-00904|ORA-00972|ORA-03001/);

  // Options that used to be spliced into SQL are validated (fixed in the TypeScript port).
  await sim.rejects("window frame carrying a subquery is refused", () => orders.aggregate([{ $project: { R: { $window: { fn: "SUM", field: "TOTAL", frame: `ROWS UNBOUNDED PRECEDING) FROM "${T.SECRET}" --` } } } }]), /Invalid frame/);
  await sim.rejects("window function outside the allow-list is refused", () => orders.aggregate([{ $project: { R: { $window: { fn: "DBMS_LOCK.SLEEP" } } } }]), /Unsupported window function/);
  await sim.rejects("NTILE bucket count carrying SQL is refused", () => api.buildWindowExpr({ fn: "NTILE", n: `4) FROM "${T.SECRET}" --` as never }), /positive integer/);
  await sim.rejects("correlated-subquery aggregate carrying SQL is refused", () => customers.find({ CREDIT: { $gt: { $subquery: { collection: T.SECRET, field: "ID", aggregate: "$MIN(0)-1+0*COUNT" } } } }).toArray(), /Unsupported aggregate/);
  await sim.rejects("pivot aggregate carrying SQL is refused", () => orders.pivot({ value: { [`$COUNT(*)) FROM "${T.SECRET}" --`]: "$TOTAL" }, pivotOn: "QUARTER", pivotValues: ["Q1"], groupBy: "STORE_ID" }), /Unsupported aggregate/);
  await sim.rejects("set-operation limit carrying SQL is refused", () => api.OracleCollection.union(customers.find({}).project({ NAME: 1 }), customers.find({}).project({ NAME: 1 })).limit(`1 UNION SELECT TOKEN FROM "${T.SECRET}"` as never).toArray(), /integer|number/i);
  await sim.rejects("query limit carrying SQL is refused", () => customers.find({}).limit("1; DROP TABLE X" as never), /integer|number/i);
  await sim.rejects("savepoint name carrying SQL is refused", new api.Transaction(db).withTransaction((s) => s.savepoint(`X; DELETE FROM "${T.SECRET}"`)), /Invalid savepoint name/);
  await sim.rejects("an unknown pipeline stage is refused, not skipped", () => orders.aggregate([{ $match: { STORE_ID: 1 } }, { $mtach: { X: 1 } } as never]), /Unknown|unsupported/i);
  await sim.rejects("an unknown join type is refused, not turned into LEFT JOIN", () => api.buildJoinSQL(T.ORDERS, { from: T.SECRET, localField: "ID", foreignField: "ID", joinType: "weird" }), /Unknown joinType/);

  // Bind names are sanitised: a hostile column name in a document cannot break the statement.
  await sim.rejects("insertOne with a hostile column name fails as a missing column, nothing inserted", customers.insertOne({ NAME: "Mallory", EMAIL: "m@canteen.sim", [`TIER") VALUES ('x','y','z'); --`]: "vip" }), /ORA-00904|ORA-00972|ORA-03001/);

  sim.eq("nothing leaked or changed: secrets intact, no customer added", [await rawCount(T.SECRET, "WHERE TOKEN = 'TOP-SECRET-TOKEN'"), await rawCount(T.CUSTOMERS)], [1, customersBefore]);
  sim.eq("no order was touched by the hostile input", await rawCount(T.ORDERS), model.orders.length);
  sim.ok("no result above contained the secret", !leaks(await customers.find({ NAME: "x' OR '1'='1" }).toArray()));
}
