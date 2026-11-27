/**
 * INTEGRATION — coverage-gap phase 4: recursion that carries a calculation
 * (withRecursiveCTE set / while, and .aggregate() on top), and row generators
 * (series()). Results are compared with the same computation in JS.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { series, withRecursiveCTE } from "../../src";
import { coll, db, dropIfExists, schema } from "../helpers/db";

const B = "MIRA_RC_BOM";
const L = "MIRA_RC_LOAN";
const S = "MIRA_RC_SALES";
const BOM = [
  ["CAKE", "BATTER", 1], ["CAKE", "ICING", 0.5], ["BATTER", "FLOUR", 0.4], ["BATTER", "EGG", 2], ["BATTER", "SUGAR", 0.1], ["ICING", "SUGAR", 0.3], ["ICING", "BUTTER", 0.2],
  ["PIE", "CRUST", 1], ["CRUST", "FLOUR", 0.3], ["CRUST", "BUTTER", 0.15], ["PIE", "APPLE", 3],
].map(([PARENT, CHILD, QTY]) => ({ PARENT, CHILD, QTY })) as { PARENT: string; CHILD: string; QTY: number }[];
const LEAVES = new Set(["FLOUR", "EGG", "SUGAR", "BUTTER", "APPLE"]);
const explode = (item: string, mult: number, acc: Map<string, number>) => {
  for (const b of BOM.filter((x) => x.PARENT === item)) LEAVES.has(b.CHILD) ? acc.set(b.CHILD, (acc.get(b.CHILD) ?? 0) + mult * b.QTY) : explode(b.CHILD, mult * b.QTY, acc);
  return acc;
};
const r6 = (x: unknown) => Math.round(Number(x) * 1e6) / 1e6;

beforeAll(async () => {
  await dropIfExists(B, L, S);
  await schema.createTable(B, { PARENT: { type: "VARCHAR2(10)" }, CHILD: { type: "VARCHAR2(10)" }, QTY: { type: "NUMBER" } });
  await coll(B).insertMany(BOM, { returning: [] });
  await schema.createTable(L, { N: { type: "NUMBER" }, BAL: { type: "NUMBER" }, INTEREST: { type: "NUMBER" } });
  await coll(L).insertOne({ N: 0, BAL: 1000, INTEREST: 0 }, { returning: ["N"] });
  await schema.createTable(S, { SKU: { type: "VARCHAR2(5)" }, D: { type: "DATE" }, QTY: { type: "NUMBER" } });
  await coll(S).insertMany([{ SKU: "A", D: new Date(2026, 9, 2), QTY: 3 }, { SKU: "A", D: new Date(2026, 9, 2), QTY: 1 }, { SKU: "A", D: new Date(2026, 9, 5), QTY: 2 }], { returning: [] });
});
afterAll(() => dropIfExists(B, L, S));

describe("integration: series() row generator", () => {
  it("numbers, days, weeks and months, inclusive of both ends", async () => {
    expect((await series(db, { start: 1, end: 9, step: 2 }).toArray()).map((r) => Number(r.VALUE))).toEqual([1, 3, 5, 7, 9]);
    const days = await series(db, { start: new Date(2026, 0, 30), end: new Date(2026, 1, 2), unit: "day", as: "D" }).toArray<{ D: Date }>();
    expect(days.map((r) => r.D.toDateString())).toEqual(["Fri Jan 30 2026", "Sat Jan 31 2026", "Sun Feb 01 2026", "Mon Feb 02 2026"]);
    expect((await series(db, { start: new Date(2026, 0, 1), end: new Date(2026, 0, 31), unit: "week", as: "W" }).toArray()).length).toBe(5);
    expect((await series(db, { start: 5, end: 1 }).toArray()).length).toBe(0);
  });

  it(".aggregate(): month-ends of a year (depreciation dates)", async () => {
    const rows = await series(db, { start: new Date(2026, 0, 1), end: new Date(2026, 11, 1), unit: "month", as: "M" }).aggregate([{ $project: { D: { $dateToString: { date: { $lastDayOfMonth: "$M" }, format: "YYYY-MM-DD" } } } }, { $sort: { D: 1 } }]);
    expect(rows.map((r) => r.D)).toEqual(Array.from({ length: 12 }, (_, m) => `2026-${String(m + 1).padStart(2, "0")}-${String(new Date(2026, m + 1, 0).getDate()).padStart(2, "0")}`));
  });

  it(".aggregate() with a grouped $lookup: a calendar of daily sales including zero days", async () => {
    const rows = await series(db, { start: new Date(2026, 9, 1), end: new Date(2026, 9, 7), unit: "day", as: "D" }).aggregate([
      { $lookup: { from: S, pipeline: [{ $match: { SKU: "A" } }, { $group: { _id: "$D", Q: { $sum: "$QTY" } } }], localField: "D", foreignField: "D", as: "s", joinType: "left", select: ["Q"] } },
      { $project: { D: 1, SOLD: { $ifNull: ["$Q", 0] } } },
      { $sort: { D: 1 } },
    ]);
    expect(rows.map((r) => Number(r.SOLD))).toEqual([0, 4, 0, 0, 2, 0, 0]);
  });

  it("quarter and year units; database errors are reported with the statement", async () => {
    const q = await series(db, { start: new Date(2026, 0, 15), end: new Date(2026, 11, 31), unit: "quarter", as: "Q" }).aggregate([{ $project: { M: { $month: "$Q" } } }, { $sort: { M: 1 } }]);
    expect(q.map((r) => Number(r.M))).toEqual([1, 4, 7, 10]);
    expect((await series(db, { start: new Date(2026, 0, 1), end: new Date(2030, 0, 1), unit: "year", step: 2 }).toArray()).length).toBe(3);
    await expect(series(db, { start: 1, end: 3 }).aggregate([{ $project: { X: "$NO_SUCH_COLUMN" } }])).rejects.toThrow(/series\.aggregate.*ORA-00904/s);
    await expect(withRecursiveCTE(db, "X", { anchor: coll(B).find({ PARENT: "CAKE" }), recursive: { collection: B, joinOn: { PARENT: "$X.CHILD" } } }).aggregate([{ $project: { X: "$NO_SUCH_COLUMN" } }])).rejects.toThrow(/RecursiveCTEResult\.aggregate.*ORA-00904/s);
  });

  it("refuses a step that is not a positive number and an unknown unit", () => {
    expect(() => series(db, { start: 1, end: 3, step: 0 })).toThrow(/step/);
    expect(() => series(db, { start: new Date(), end: new Date(), unit: "fortnight" as never })).toThrow(/unit/);
    expect(() => series(db, { start: 1, end: new Date() } as never)).toThrow(/both numbers or both dates/);
  });
});

describe("integration: withRecursiveCTE set / while / aggregate", () => {
  it("set carries a calculation down the levels: quantity per finished product, multiplied through every level", async () => {
    const rows = await withRecursiveCTE(db, "X", {
      anchor: coll(B).find({ PARENT: { $in: ["CAKE", "PIE"] } }),
      recursive: { collection: B, joinOn: { PARENT: "$X.CHILD" }, set: { PARENT: "$prior.PARENT", QTY: { $mul: ["$prior.QTY", "$QTY"] } } },
    }).aggregate([{ $match: { CHILD: { $in: [...LEAVES] } } }, { $group: { _id: { PARENT: "$PARENT", CHILD: "$CHILD" }, QTY: { $sum: "$QTY" } } }, { $sort: { PARENT: 1, CHILD: 1 } }]);
    const want = ["CAKE", "PIE"].flatMap((p) => [...explode(p, 1, new Map())].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, q]) => [p, c, r6(q)]));
    expect(rows.map((r) => [r.PARENT, r.CHILD, r6(r.QTY)])).toEqual(want);
  });

  it("while stops the recursion; an empty joinOn recurses on the row itself: compound interest for 5 periods", async () => {
    const rows = await withRecursiveCTE(db, "G", {
      anchor: coll(L).find({}),
      recursive: { collection: L, joinOn: {}, set: { N: { $add: ["$prior.N", 1] }, INTEREST: { $round: [{ $mul: ["$prior.BAL", 0.1] }, 2] }, BAL: { $round: [{ $mul: ["$prior.BAL", 1.1] }, 2] } }, while: { $lt: ["$prior.N", 5] } },
    })
      .sort({ N: 1 })
      .toArray<{ N: number; BAL: number; INTEREST: number }>();
    let bal = 1000;
    const want = [[0, 1000, 0], ...Array.from({ length: 5 }, (_, i) => { const int = Math.round(bal * 10) / 100; bal = Math.round(bal * 110) / 100; return [i + 1, bal, int]; })];
    expect(rows.map((r) => [Number(r.N), Number(r.BAL), Number(r.INTEREST)])).toEqual(want);
  });

  it("an empty joinOn without while is refused (it would never stop)", async () => {
    await expect(withRecursiveCTE(db, "G", { anchor: coll(L).find({}), recursive: { collection: L, joinOn: {} } }).toArray()).rejects.toThrow(/give a while condition/);
  });

  it("a joinOn recursion over looping data still stops with Oracle's cycle error (no CYCLE clause added)", async () => {
    await coll(B).insertOne({ PARENT: "FLOUR", CHILD: "CAKE", QTY: 1 }, { returning: ["PARENT"] });
    await expect(withRecursiveCTE(db, "X", { anchor: coll(B).find({ PARENT: "CAKE" }), recursive: { collection: B, joinOn: { PARENT: "$X.CHILD" } } }).toArray()).rejects.toThrow(/ORA-32044/);
    await coll(B).deleteMany({ PARENT: "FLOUR" });
  });

  it("refuses set on a column the table does not have", async () => {
    await expect(withRecursiveCTE(db, "X", { anchor: coll(B).find({}), recursive: { collection: B, joinOn: { PARENT: "$X.CHILD" }, set: { NOPE: 1 } } }).toArray()).rejects.toThrow(/NOPE/);
  });
});
