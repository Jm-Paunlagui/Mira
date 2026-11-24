/**
 * INTEGRATION — coverage-gap phase 2: row pattern matching ($matchRecognize)
 * and hierarchy columns for connectBy (root, leaf, cycle, chosen path column).
 * Results are compared with the same computation in JS.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { coll, createEmployees, dropIfExists, schema } from "../helpers/db";

const D = "MIRA_PT_DAILY";
const P = "MIRA_PT_PAY";
const E = "MIRA_PT_EMP";
const zeros: Record<string, number[]> = { A: [3, 4, 5, 12, 20, 21], B: [1, 2, 9, 10, 11, 12, 30] };
const PAY = [
  { ID: 1, SUP: "X", PDATE: new Date(2026, 4, 4), AMT: 950 },
  { ID: 2, SUP: "X", PDATE: new Date(2026, 4, 5), AMT: 940 },
  { ID: 3, SUP: "X", PDATE: new Date(2026, 4, 6), AMT: 990 },
  { ID: 4, SUP: "X", PDATE: new Date(2026, 7, 20), AMT: 300 },
  { ID: 5, SUP: "Y", PDATE: new Date(2026, 5, 1), AMT: 999 },
  { ID: 6, SUP: "Y", PDATE: new Date(2026, 5, 20), AMT: 999 },
  { ID: 7, SUP: "Y", PDATE: new Date(2026, 5, 21), AMT: 1500 },
];

beforeAll(async () => {
  await dropIfExists(D, P, E);
  await schema.createTable(D, { SKU: { type: "VARCHAR2(5)" }, D: { type: "NUMBER" }, QTY: { type: "NUMBER" } });
  await coll(D).insertMany(["A", "B"].flatMap((SKU) => Array.from({ length: 31 }, (_, i) => ({ SKU, D: i + 1, QTY: zeros[SKU].includes(i + 1) ? 0 : 1 + (i % 4) }))), { returning: [] });
  await schema.createTable(P, { ID: { type: "NUMBER", primaryKey: true }, SUP: { type: "VARCHAR2(5)" }, PDATE: { type: "DATE" }, AMT: { type: "NUMBER" } });
  await coll(P).insertMany(PAY, { returning: [] });
  await createEmployees(E);
});
afterAll(() => dropIfExists(D, P, E));

describe("integration: $matchRecognize", () => {
  it("ONE ROW PER MATCH: every run of zero-stock days, per item", async () => {
    const rows = await coll(D).aggregate([
      { $matchRecognize: { partitionBy: ["SKU"], orderBy: { D: 1 }, measures: { START_D: { $first: "$D" }, DAYS: { $count: "*" } }, pattern: "Z+", define: { Z: { QTY: 0 } } } },
      { $sort: { SKU: 1, START_D: 1 } },
    ]);
    const runs = (days: number[]) => days.reduce<number[][]>((acc, d) => (acc.length && acc[acc.length - 1].at(-1) === d - 1 ? acc[acc.length - 1].push(d) : acc.push([d]), acc), []);
    expect(rows.map((r) => [r.SKU, Number(r.START_D), Number(r.DAYS)])).toEqual(["A", "B"].flatMap((s) => runs(zeros[s]).map((r) => [s, r[0], r.length])));
  });

  it("a pattern of two variables, $prev, and a $match on a measure: split payments", async () => {
    const rows = await coll(P).aggregate([
      {
        $matchRecognize: {
          partitionBy: ["SUP"],
          orderBy: { PDATE: 1, ID: 1 },
          measures: { FIRST_ID: { $first: "$ID" }, LAST_ID: { $last: "$ID" }, N: { $count: "*" }, TOTAL: { $sum: "$AMT" } },
          pattern: "A B+",
          define: { A: { $lt: ["$AMT", 1000] }, B: { $and: [{ $lt: ["$AMT", 1000] }, { $lte: [{ $subtract: ["$PDATE", { $prev: "$PDATE" }] }, 3] }] } },
        },
      },
      { $match: { total: { $gt: 1000 } } },
    ]);
    expect(rows.map((r) => [r.SUP, Number(r.FIRST_ID), Number(r.LAST_ID), Number(r.N), Number(r.TOTAL)])).toEqual([["X", 1, 3, 3, 2880]]);
  });

  it("ALL ROWS PER MATCH with $classifier and $matchNumber", async () => {
    const rows = await coll(P).aggregate([
      { $matchRecognize: { partitionBy: ["SUP"], orderBy: { ID: 1 }, measures: { CLS: { $classifier: true }, MNO: { $matchNumber: true } }, rowsPerMatch: "all", pattern: "S+ L", define: { S: { $lt: ["$AMT", 1000] }, L: { $gte: ["$AMT", 1000] } } } },
      { $sort: { ID: 1 } },
    ]);
    expect(rows.map((r) => [Number(r.ID), r.CLS, Number(r.MNO)])).toEqual([[5, "S", 1], [6, "S", 1], [7, "L", 1]]);
  });

  it("refuses a pattern that is not a pattern, and undefined variables (while building, before any SQL runs)", () => {
    expect(() => coll(P).aggregate([{ $matchRecognize: { orderBy: { ID: 1 }, measures: { N: { $count: "*" } }, pattern: "A) FROM DUAL --", define: { A: { AMT: 1 } } } }])).toThrow(/pattern/);
    expect(() => coll(P).aggregate([{ $matchRecognize: { orderBy: { ID: 1 }, measures: { N: { $count: "*" } }, pattern: "A B", define: { A: { AMT: 1 } } } }])).toThrow(/B is not defined/);
    expect(() => coll(P).aggregate([{ $matchRecognize: { orderBy: { ID: 1 }, measures: { N: { $median: "$AMT" } }, pattern: "A", define: { A: { AMT: 1 } } } }])).toThrow(/measure/);
  });
});

describe("integration: connectBy hierarchy columns", () => {
  it("root, leaf flag and a chosen path column", async () => {
    const rows = (await coll(E).connectBy({ startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, root: "NAME", includeIsLeaf: true, includePath: true, pathColumn: "NAME", orderSiblings: { NAME: 1 } })) as Record<string, unknown>[];
    expect(rows.map((r) => [r.NAME, r.ROOT_NAME, Number(r.IS_LEAF), r.PATH])).toEqual([
      ["CEO", "CEO", 0, "/CEO"],
      ["CFO", "CEO", 0, "/CEO/CFO"],
      ["Acct", "CEO", 1, "/CEO/CFO/Acct"],
      ["CTO", "CEO", 0, "/CEO/CTO"],
      ["Dev1", "CEO", 1, "/CEO/CTO/Dev1"],
      ["Dev2", "CEO", 1, "/CEO/CTO/Dev2"],
    ]);
  });

  it("includeIsCycle reports the row that closes a loop", async () => {
    await coll(E).updateOne({ ID: 1 }, { $set: { MANAGER_ID: 6 } }); // the CEO now reports to the accountant
    const rows = (await coll(E).connectBy({ startWith: { ID: 1 }, connectBy: { MANAGER_ID: "$PRIOR ID" }, includeIsCycle: true })) as Record<string, unknown>[];
    expect(rows.filter((r) => Number(r.IS_CYCLE) === 1).map((r) => r.NAME)).toEqual(["Acct"]);
    await coll(E).updateOne({ ID: 1 }, { $set: { MANAGER_ID: null } });
  });
});
