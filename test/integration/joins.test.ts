/**
 * INTEGRATION — coverage-gap phase 3: joins and hierarchies inside the
 * pipeline. $lateralJoin with outer: true (OUTER APPLY), $lookup with its own
 * pipeline (join a grouped result), and $connectBy as a pipeline stage.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { coll, createEmployees, createOrders, createUsers, dropIfExists, schema, USERS } from "../helpers/db";

const U = "MIRA_JN_USERS";
const O = "MIRA_JN_ORDERS";
const E = "MIRA_JN_EMP";
const R = "MIRA_JN_RATES";
const I = "MIRA_JN_IMPORTS";
let orderRows: Record<string, unknown>[] = [];
let ids: number[] = [];
const RATES = [
  { CCY: "USD", RDATE: new Date(2026, 0, 1), RATE: 55.8 },
  { CCY: "USD", RDATE: new Date(2026, 2, 1), RATE: 56.25 },
  { CCY: "EUR", RDATE: new Date(2026, 0, 1), RATE: 60.5 },
];
const IMPORTS = [
  { INV_NO: "I1", CCY: "USD", IDATE: new Date(2026, 1, 10), AMOUNT: 100 },
  { INV_NO: "I2", CCY: "USD", IDATE: new Date(2026, 2, 1), AMOUNT: 10 },
  { INV_NO: "I3", CCY: "EUR", IDATE: new Date(2026, 5, 1), AMOUNT: 2 },
  { INV_NO: "I4", CCY: "JPY", IDATE: new Date(2026, 5, 1), AMOUNT: 5 },
];

beforeAll(async () => {
  await dropIfExists(O, U, E, R, I);
  await createUsers(U);
  orderRows = await createOrders(O, U);
  ids = (await coll(U).find({}).sort({ ID: 1 }).project({ ID: 1 }).toArray<{ ID: number }>()).map((r) => r.ID);
  await createEmployees(E);
  await schema.createTable(R, { CCY: { type: "CHAR(3)" }, RDATE: { type: "DATE" }, RATE: { type: "NUMBER" } });
  await schema.createTable(I, { INV_NO: { type: "VARCHAR2(5)" }, CCY: { type: "CHAR(3)" }, IDATE: { type: "DATE" }, AMOUNT: { type: "NUMBER" } });
  await coll(R).insertMany(RATES, { returning: [] });
  await coll(I).insertMany(IMPORTS, { returning: [] });
});
afterAll(() => dropIfExists(O, U, E, R, I));

describe("integration: joins inside the pipeline", () => {
  it("$lateralJoin outer: true keeps rows with no match (OUTER APPLY): latest rate on or before each date", async () => {
    const rows = await coll(I).aggregate([
      { $lateralJoin: { subquery: coll(R).find({ CCY: "$outer.CCY", RDATE: { $lte: "$outer.IDATE" } }).sort({ RDATE: -1 }).limit(1).project({ RATE: 1 }), as: "R", outer: true } },
      { $project: { INV_NO: 1, PHP: { $mul: ["$AMOUNT", "$RATE"] } } },
      { $sort: { INV_NO: 1 } },
    ]);
    expect(rows.map((r) => [r.INV_NO, r.PHP == null ? null : Number(r.PHP)])).toEqual([["I1", 5580], ["I2", 562.5], ["I3", 121], ["I4", null]]);
  });

  it("$lookup with a pipeline joins a grouped result: each user's order total next to the user", async () => {
    const rows = await coll(U).aggregate([
      { $lookup: { from: O, pipeline: [{ $group: { _id: "$USER_ID", TOTAL: { $sum: "$AMOUNT" }, N: { $count: "*" } } }], localField: "ID", foreignField: "USER_ID", as: "o", joinType: "left", select: ["TOTAL", "N"] } },
      { $project: { NAME: 1, TOTAL: { $ifNull: ["$TOTAL", 0] }, N: { $ifNull: ["$N", 0] } } },
    ]);
    const tot = (id: number) => orderRows.filter((o) => o.USER_ID === id).reduce((s, o) => s + Number(o.AMOUNT), 0);
    const cnt = (id: number) => orderRows.filter((o) => o.USER_ID === id).length;
    expect(Object.fromEntries(rows.map((r) => [r.NAME, [Number(r.TOTAL), Number(r.N)]]))).toEqual(Object.fromEntries(USERS.map((u, i) => [u.NAME, [tot(ids[i]), cnt(ids[i])]])));
  });

  it("a $lookup pipeline's values stay apart from the outer pipeline's (same column filtered in both)", async () => {
    const rows = await coll(U).aggregate([
      { $match: { STATUS: "active" } },
      { $lookup: { from: O, pipeline: [{ $match: { STATUS: "completed" } }, { $group: { _id: "$USER_ID", N: { $count: "*" } } }], localField: "ID", foreignField: "USER_ID", as: "o", joinType: "inner", select: ["N"] } },
    ]);
    const want = USERS.map((u, i) => [u, ids[i]] as const).filter(([u]) => u.STATUS === "active").map(([u, id]) => [u.NAME, orderRows.filter((o) => o.USER_ID === id && o.STATUS === "completed").length] as const).filter(([, n]) => n > 0);
    expect(Object.fromEntries(rows.map((r) => [r.NAME, Number(r.N)]))).toEqual(Object.fromEntries(want));
  });
});

describe("integration: nested pipelines after other stages (ORA-32034)", () => {
  it("DEFECT: $facet with multi-stage facets after another stage runs (Oracle refuses a WITH nested inside a WITH)", async () => {
    const rows = await coll(U).aggregate([
      { $match: { STATUS: "active" } },
      { $facet: { manila: [{ $match: { CITY: "Manila" } }, { $sort: { NAME: 1 } }, { $count: "n" }], older: [{ $match: { AGE: { $gte: 28 } } }, { $count: "n" }] } },
    ]);
    const act = USERS.filter((u) => u.STATUS === "active");
    expect(Object.fromEntries(rows.map((r) => [r.facet_name, Number(r.N)]))).toEqual({ manila: act.filter((u) => u.CITY === "Manila").length, older: act.filter((u) => u.AGE >= 28).length });
  });

  it("a multi-stage $lookup pipeline after another stage runs", async () => {
    const rows = await coll(U).aggregate([
      { $match: { STATUS: "active" } },
      { $lookup: { from: O, pipeline: [{ $match: { STATUS: "completed" } }, { $group: { _id: "$USER_ID", N: { $count: "*" } } }, { $match: { N: { $gte: 1 } } }], localField: "ID", foreignField: "USER_ID", as: "o", joinType: "inner", select: ["N"] } },
      { $sort: { NAME: 1 } },
    ]);
    const want = USERS.map((u, i) => [u, ids[i]] as const).filter(([u]) => u.STATUS === "active").map(([u, id]) => [u.NAME, orderRows.filter((o) => o.USER_ID === id && o.STATUS === "completed").length] as const).filter(([, n]) => n >= 1).sort();
    expect(rows.map((r) => [r.NAME, Number(r.N)])).toEqual(want.map(([a, b]) => [a, b]));
  });
});

describe("integration: $connectBy as a pipeline stage", () => {
  it("the tree feeds $group: salary of each manager's whole team (subtree roll-up)", async () => {
    const rows = await coll(E).aggregate([
      { $connectBy: { connectBy: { MANAGER_ID: "$PRIOR ID" }, root: "ID", includeLevel: true } },
      { $group: { _id: "$ROOT_ID", TEAM: { $sum: "$SALARY" }, N: { $count: "*" } } },
      { $sort: { ROOT_ID: 1 } },
    ]);
    const emps = [[1, null, 500], [2, 1, 300], [3, 1, 290], [4, 2, 120], [5, 2, 130], [6, 3, 100]] as const;
    const under = (id: number): number[] => [id, ...emps.filter((e) => e[1] === id).flatMap((e) => under(e[0]))];
    expect(rows.map((r) => [Number(r.ROOT_ID), Number(r.TEAM), Number(r.N)])).toEqual(emps.map(([id]) => [id, under(id).reduce((s, x) => s + emps.find((e) => e[0] === x)![2], 0), under(id).length]));
  });

  it("$connectBy after a $match, with startWith and its own values", async () => {
    const rows = await coll(E).aggregate([{ $match: { DEPT: { $ne: "FIN" } } }, { $connectBy: { startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, includeLevel: true, orderSiblings: { NAME: 1 } } }]);
    expect(rows.map((r) => [r.NAME, Number(r.LEVEL)])).toEqual([["CEO", 1], ["CTO", 2], ["Dev1", 3], ["Dev2", 3]]);
  });
});
