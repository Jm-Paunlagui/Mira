/**
 * INTEGRATION — pipeline expressions (coverage-gap phase 1): nested
 * arithmetic, numeric functions, GREATEST / LEAST, $switch, column-to-column
 * conditions, date arithmetic, aggregates over expressions and GROUPING flags.
 * Every result is compared with the same computation in JS on the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { coll, createUsers, createOrders, dropIfExists, USERS } from "../helpers/db";

const U = "MIRA_EX_USERS";
const O = "MIRA_EX_ORDERS";
const users = coll(U);
const orders = coll(O);
let orderRows: Record<string, unknown>[] = [];
const byName = <T>(rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => T) => Object.fromEntries(rows.map((r) => [String(r.NAME), f(r)]));
const want = <T>(f: (u: (typeof USERS)[number]) => T) => Object.fromEntries(USERS.map((u) => [u.NAME, f(u)]));

beforeAll(async () => {
  await dropIfExists(O, U);
  await createUsers(U);
  orderRows = await createOrders(O, U);
  // Give every user a known timestamp: day (index + 1) of March 2026, 10:30.
  for (const [i, u] of USERS.entries()) await users.updateOne({ NAME: u.NAME }, { $set: { UPDATED_AT: new Date(2026, 2, i + 1, 10, 30) } });
});
afterAll(() => dropIfExists(O, U));

describe("integration: expressions", () => {
  it("nested arithmetic: arguments can be expressions", async () => {
    const rows = await users.aggregate([{ $project: { NAME: 1, X: { $add: [{ $mul: ["$SCORE", 2] }, { $divide: ["$AGE", 4] }, 1] } } }]);
    expect(byName(rows, (r) => Number(r.X))).toEqual(want((u) => u.SCORE * 2 + u.AGE / 4 + 1));
  });

  it("numeric functions: $round $floor $ceil $trunc $mod $abs", async () => {
    const rows = await users.aggregate([
      {
        $project: {
          NAME: 1,
          R: { $round: [{ $divide: ["$SCORE", 3] }, 2] },
          F: { $floor: { $divide: ["$SCORE", 7] } },
          C: { $ceil: { $divide: ["$SCORE", 7] } },
          TR: { $trunc: [{ $divide: ["$AGE", 3] }, 1] },
          M: { $mod: ["$AGE", 7] },
          A: { $abs: { $subtract: ["$AGE", 40] } },
          R0: { $round: { $divide: ["$SCORE", 8] } },
        },
      },
    ]);
    const round = (x: number, p: number) => Math.sign(x) * Math.round(Math.abs(x) * 10 ** p) / 10 ** p;
    expect(byName(rows, (r) => [Number(r.R), Number(r.F), Number(r.C), Number(r.TR), Number(r.M), Number(r.A), Number(r.R0)])).toEqual(
      want((u) => [round(u.SCORE / 3, 2), Math.floor(u.SCORE / 7), Math.ceil(u.SCORE / 7), Math.trunc((u.AGE / 3) * 10) / 10, u.AGE % 7, Math.abs(u.AGE - 40), round(u.SCORE / 8, 0)]),
    );
  });

  it("$max / $min with a list are GREATEST / LEAST (with literals and nested expressions)", async () => {
    const rows = await users.aggregate([{ $project: { NAME: 1, HI: { $max: ["$AGE", "$SCORE", 50] }, LO: { $min: ["$AGE", { $add: ["$SCORE", 0] }] } } }]);
    expect(byName(rows, (r) => [Number(r.HI), Number(r.LO)])).toEqual(want((u) => [Math.max(u.AGE, u.SCORE, 50), Math.min(u.AGE, u.SCORE)]));
  });

  it("$switch: several branches in order, with a default", async () => {
    const rows = await users.aggregate([
      { $project: { NAME: 1, G: { $switch: { branches: [{ case: { $gte: ["$SCORE", 90] }, then: "A" }, { case: { $gte: ["$SCORE", 70] }, then: "B" }, { case: { SCORE: { $gte: 50 } }, then: "C" }], default: "D" } } } },
    ]);
    expect(byName(rows, (r) => r.G)).toEqual(want((u) => (u.SCORE >= 90 ? "A" : u.SCORE >= 70 ? "B" : u.SCORE >= 50 ? "C" : "D")));
  });

  it("$cond compares two columns, and combines conditions with $and / $or / $not", async () => {
    const rows = await users.aggregate([
      {
        $project: {
          NAME: 1,
          W: { $cond: { if: { $gt: ["$SCORE", "$AGE"] }, then: "score", else: "age" } },
          BOTH: { $cond: { if: { $and: [{ $gte: ["$AGE", 25] }, { $lt: ["$SCORE", 80] }] }, then: 1, else: 0 } },
          ANY: { $cond: { if: { $or: [{ $eq: ["$STATUS", "banned"] }, { $not: { $gte: ["$AGE", 18] } }] }, then: 1, else: 0 } },
        },
      },
    ]);
    expect(byName(rows, (r) => [r.W, Number(r.BOTH), Number(r.ANY)])).toEqual(
      want((u) => [u.SCORE > u.AGE ? "score" : "age", u.AGE >= 25 && u.SCORE < 80 ? 1 : 0, u.STATUS === "banned" || !(u.AGE >= 18) ? 1 : 0]),
    );
  });

  it("date arithmetic: $dateDiff, $dateAdd, $dateTrunc, $lastDayOfMonth, $year / $month / $dayOfMonth", async () => {
    const asOf = new Date(2026, 3, 15); // 15 April 2026
    const rows = await users.aggregate([
      {
        $project: {
          NAME: 1,
          DAYS: { $dateDiff: { startDate: "$UPDATED_AT", endDate: asOf, unit: "day" } },
          MONTHS: { $dateDiff: { startDate: "$UPDATED_AT", endDate: new Date(2026, 11, 31), unit: "month" } },
          PLUS: { $dateToString: { date: { $dateAdd: { startDate: "$UPDATED_AT", unit: "month", amount: 2 } }, format: "YYYY-MM-DD" } },
          WEEK: { $dateToString: { date: { $dateAdd: { startDate: "$UPDATED_AT", unit: "day", amount: 7 } }, format: "YYYY-MM-DD" } },
          MSTART: { $dateToString: { date: { $dateTrunc: { date: "$UPDATED_AT", unit: "month" } }, format: "YYYY-MM-DD HH24:MI" } },
          MEND: { $dateToString: { date: { $lastDayOfMonth: "$UPDATED_AT" }, format: "YYYY-MM-DD" } },
          Y: { $year: "$UPDATED_AT" },
          MO: { $month: "$UPDATED_AT" },
          D: { $dayOfMonth: "$UPDATED_AT" },
        },
      },
    ]);
    const day = (i: number) => String(i + 1).padStart(2, "0");
    expect(byName(rows, (r) => [Number(r.DAYS), Number(r.MONTHS), r.PLUS, r.WEEK, r.MSTART, r.MEND, Number(r.Y), Number(r.MO), Number(r.D)])).toEqual(
      Object.fromEntries(
        USERS.map((u, i) => [
          u.NAME,
          [45 - i, 9, `2026-05-${day(i)}`, `2026-03-${String(i + 8).padStart(2, "0")}`, "2026-03-01 00:00", "2026-03-31", 2026, 3, i + 1],
        ]),
      ),
    );
  });

  it("date arithmetic: the other units run on Oracle and give calendar answers", async () => {
    const start = new Date(2026, 0, 30, 22, 0); // Fri 30 Jan 2026 22:00
    const [r] = await users.aggregate([
      { $match: { NAME: "Juan" } },
      {
        $project: {
          WK: { $dateDiff: { startDate: start, endDate: new Date(2026, 1, 9), unit: "week" } }, // Mon 9 Feb: 2 ISO-week boundaries
          QT: { $dateDiff: { startDate: start, endDate: new Date(2026, 6, 1), unit: "quarter" } },
          YR: { $dateDiff: { startDate: start, endDate: new Date(2027, 0, 1), unit: "year" } },
          H: { $dateToString: { date: { $dateAdd: { startDate: start, unit: "hour", amount: 3 } }, format: "YYYY-MM-DD HH24:MI" } },
          Q: { $dateToString: { date: { $dateAdd: { startDate: start, unit: "quarter", amount: 1 } }, format: "YYYY-MM-DD" } },
          Y: { $dateToString: { date: { $dateAdd: { startDate: start, unit: "year", amount: 1 } }, format: "YYYY-MM-DD" } },
          W: { $dateToString: { date: { $dateTrunc: { date: start, unit: "week" } }, format: "YYYY-MM-DD" } },
        },
      },
    ]);
    expect([Number(r.WK), Number(r.QT), Number(r.YR), r.H, r.Q, r.Y, r.W]).toEqual([2, 2, 1, "2026-01-31 01:00", "2026-04-30", "2027-01-30", "2026-01-26"]);
  });

  it("aggregates over expressions: SUM of a product, AVG of a CASE", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, T: { $sum: { $mul: ["$SCORE", "$AGE"] } }, HI: { $sum: { $cond: { if: { $gte: ["$SCORE", 80] }, then: 1, else: 0 } } } } }]);
    expect([Number(r.T), Number(r.HI)]).toEqual([USERS.reduce((s, u) => s + u.SCORE * u.AGE, 0), USERS.filter((u) => u.SCORE >= 80).length]);
  });

  it("ROLLUP with grouping: true flags subtotal rows, so a NULL key is not mistaken for a subtotal", async () => {
    const rows = await users.aggregate([{ $group: { _id: { $rollup: ["CITY"], grouping: true }, N: { $count: "*" } } }]);
    const sub = rows.filter((r) => Number(r.GROUPING_CITY) === 1);
    const nullCity = rows.filter((r) => r.CITY === null && Number(r.GROUPING_CITY) === 0);
    expect(sub.map((r) => Number(r.N))).toEqual([USERS.length]);
    expect(nullCity.map((r) => Number(r.N))).toEqual([USERS.filter((u) => u.CITY === null).length]);
    const cube = await orders.aggregate([{ $group: { _id: { $cube: ["REGION", "PRODUCT"], grouping: true }, T: { $sum: "$AMOUNT" } } }]);
    const grand = cube.find((r) => Number(r.GROUPING_REGION) === 1 && Number(r.GROUPING_PRODUCT) === 1);
    expect(Number(grand?.T)).toBe(orderRows.reduce((s, o) => s + Number(o.AMOUNT), 0));
  });
});
