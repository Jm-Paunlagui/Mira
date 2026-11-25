/**
 * Mira 2.1 statistics: the $group accumulators, window options and sort / paging
 * options that 2.0 lacked. Every expected value is computed here from the USERS
 * fixture, never copied from a query result.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { coll, createUsers, dropIfExists, USERS } from "../helpers/db";

const U = "MIRA_ST_USERS";
const users = coll(U);

// USERS gets IDs 1..10 in fixture order (identity column on a fresh table).
const ROWS = USERS.map((u, i) => ({ ...u, ID: i + 1 }));
const byStatus = (s: string) => ROWS.filter((r) => r.STATUS === s);
const scores = ROWS.map((r) => r.SCORE);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[], sample: boolean) => {
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
};
/** Oracle PERCENTILE_CONT: linear interpolation at row number 1 + p * (n - 1). */
const pctCont = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const rn = p * (s.length - 1);
  const lo = Math.floor(rn), hi = Math.ceil(rn);
  return s[lo] + (rn - lo) * (s[hi] - s[lo]);
};
/** Oracle PERCENTILE_DISC: the first value whose cumulative distribution is >= p. */
const pctDisc = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
};
const close = (a: unknown, b: number) => expect(Number(a)).toBeCloseTo(b, 9);

beforeAll(() => createUsers(U));
afterAll(() => dropIfExists(U));

describe("statistics: $group accumulators", () => {
  it("$countDistinct counts distinct non-null values", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, cities: { $countDistinct: "$CITY" } } }]);
    expect(Number(r.CITIES)).toBe(new Set(ROWS.map((u) => u.CITY).filter((c) => c != null)).size);
  });

  it("$push returns a JS array per group, in the order asked for", async () => {
    const rows = await users.aggregate([
      { $group: { _id: "$STATUS", names: { $push: { input: "$NAME", orderBy: { NAME: 1 } } } } },
      { $sort: { STATUS: 1 } },
    ]);
    for (const r of rows) {
      expect(Array.isArray(r.NAMES)).toBe(true);
      expect(r.NAMES).toEqual(byStatus(r.STATUS as string).map((u) => u.NAME).sort());
    }
  });

  it("$push keeps NULLs, like MongoDB", async () => {
    const [r] = await users.aggregate([{ $match: { STATUS: "active" } }, { $group: { _id: null, cities: { $push: { input: "$CITY", orderBy: { ID: 1 } } } } }]);
    expect(r.CITIES).toEqual(byStatus("active").map((u) => u.CITY));
  });

  it("$push of a plain column (no options) collects every value", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, s: { $push: "$SCORE" } } }]);
    expect((r.S as number[]).slice().sort((a, b) => a - b)).toEqual(scores.slice().sort((a, b) => a - b));
  });

  it("$addToSet returns each value once, NULL included once", async () => {
    const [r] = await users.aggregate([{ $match: { STATUS: "active" } }, { $group: { _id: null, cities: { $addToSet: { input: "$CITY", orderBy: { CITY: 1 } } } } }]);
    const distinct = [...new Set(byStatus("active").map((u) => u.CITY))];
    const nonNull = distinct.filter((c) => c != null).sort();
    expect(r.CITIES).toEqual([...nonNull, null]); // ASC puts NULL last
  });

  it("$addToSet of a plain column", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, s: { $addToSet: "$STATUS" } } }]);
    expect((r.S as string[]).slice().sort()).toEqual([...new Set(ROWS.map((u) => u.STATUS))].sort());
  });

  it("$listAgg joins values into one string: separator, order, distinct", async () => {
    const rows = await users.aggregate([
      { $group: { _id: "$STATUS", names: { $listAgg: { input: "$NAME", separator: " | ", orderBy: { NAME: 1 } } } } },
      { $sort: { STATUS: 1 } },
    ]);
    for (const r of rows) expect(r.NAMES).toBe(byStatus(r.STATUS as string).map((u) => u.NAME).sort().join(" | "));
    const [d] = await users.aggregate([{ $group: { _id: null, c: { $listAgg: { input: "$CITY", distinct: true } } } }]);
    expect(d.C).toBe([...new Set(ROWS.map((u) => u.CITY).filter((c) => c != null))].sort().join(","));
    const [p] = await users.aggregate([{ $match: { STATUS: "inactive" } }, { $group: { _id: null, n: { $listAgg: "$NAME" } } }]);
    expect(p.N).toBe(byStatus("inactive").map((u) => u.NAME).sort().join(","));
  });

  it("$median, $stdDevPop, $stdDevSamp", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, med: { $median: "$SCORE" }, pop: { $stdDevPop: "$SCORE" }, samp: { $stdDevSamp: "$SCORE" } } }]);
    close(r.MED, pctCont(scores, 0.5));
    close(r.POP, Math.sqrt(variance(scores, false)));
    close(r.SAMP, Math.sqrt(variance(scores, true)));
  });

  it("$median accepts { input } and an expression", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, med: { $median: { input: { $mul: ["$SCORE", 2] } } } } }]);
    close(r.MED, pctCont(scores, 0.5) * 2);
  });

  it("$percentile: continuous (default) and discrete, one p or a list", async () => {
    const [r] = await users.aggregate([
      {
        $group: {
          _id: null,
          p90: { $percentile: { input: "$SCORE", p: 0.9 } },
          d90: { $percentile: { input: "$SCORE", p: 0.9, method: "discrete" } },
          many: { $percentile: { input: "$SCORE", p: [0.5, 0.9] } },
        },
      },
    ]);
    close(r.P90, pctCont(scores, 0.9));
    close(r.D90, pctDisc(scores, 0.9));
    expect(Array.isArray(r.MANY)).toBe(true);
    close((r.MANY as number[])[0], pctCont(scores, 0.5));
    close((r.MANY as number[])[1], pctCont(scores, 0.9));
  });

  it("accumulators work per group with GROUP BY", async () => {
    const rows = await users.aggregate([{ $group: { _id: "$STATUS", med: { $median: "$SCORE" }, n: { $countDistinct: "$CITY" } } }, { $sort: { STATUS: 1 } }]);
    for (const r of rows) {
      const g = byStatus(r.STATUS as string);
      close(r.MED, pctCont(g.map((u) => u.SCORE), 0.5));
      expect(Number(r.N)).toBe(new Set(g.map((u) => u.CITY).filter((c) => c != null)).size);
    }
  });
});

describe("statistics: window options", () => {
  const win = (spec: Record<string, unknown>) =>
    users.aggregate([{ $addFields: { W: { $window: spec } } }, { $sort: { ID: 1 } }]) as Promise<Array<{ ID: number; W: unknown }>>;

  it("LAG / LEAD with a default for the rows outside the partition", async () => {
    const lag = await win({ fn: "LAG", field: "SCORE", orderBy: { ID: 1 }, default: 0 });
    expect(lag.map((r) => r.W)).toEqual(ROWS.map((_, i) => (i === 0 ? 0 : ROWS[i - 1].SCORE)));
    const lead = await win({ fn: "LEAD", field: "NAME", offset: 2, orderBy: { ID: 1 }, default: "-" });
    expect(lead.map((r) => r.W)).toEqual(ROWS.map((_, i) => ROWS[i + 2]?.NAME ?? "-"));
  });

  it("IGNORE NULLS skips NULL values; the default only fills past the edge", async () => {
    // Row 9's next CITY is row 10's NULL. Without IGNORE NULLS LEAD returns that NULL;
    // with it there is no non-null value left, so the default applies.
    const plain = await win({ fn: "LEAD", field: "CITY", orderBy: { ID: 1 }, default: "none" });
    const skip = await win({ fn: "LEAD", field: "CITY", orderBy: { ID: 1 }, default: "none", ignoreNulls: true });
    expect(plain[8].W).toBeNull();
    expect(skip[8].W).toBe("none");
    const first = await win({ fn: "FIRST_VALUE", field: "CITY", orderBy: { ID: -1 }, ignoreNulls: true });
    expect(first[8].W).toBe(ROWS[8].CITY); // frame is rows 10, 9: row 10's NULL is skipped
  });

  it("RATIO_TO_REPORT: each value's share of its partition total", async () => {
    const rows = await win({ fn: "RATIO_TO_REPORT", field: "SCORE", partitionBy: "STATUS" });
    for (const r of rows) {
      const u = ROWS[r.ID - 1];
      close(r.W, u.SCORE / byStatus(u.STATUS).reduce((a, x) => a + x.SCORE, 0));
    }
  });

  it("window orderBy takes NULLS FIRST / LAST", async () => {
    const rows = await win({ fn: "ROW_NUMBER", orderBy: { CITY: { order: 1, nulls: "first" }, ID: 1 } });
    expect(rows.find((r) => ROWS[r.ID - 1].CITY === null)?.W).toBe(1);
  });
});

describe("statistics: sorting and paging", () => {
  it("find().sort() takes NULLS FIRST / LAST", async () => {
    const first = await users.find({}).sort({ CITY: { order: 1, nulls: "first" } }).project({ CITY: 1 }).toArray<{ CITY: string | null }>();
    expect(first[0].CITY).toBeNull();
    const last = await users.find({}).sort({ CITY: { order: -1, nulls: "last" } }).project({ CITY: 1 }).toArray<{ CITY: string | null }>();
    expect(last[last.length - 1].CITY).toBeNull();
    expect(last[0].CITY).toBe("Manila");
  });

  it("$sort in a pipeline takes NULLS FIRST / LAST", async () => {
    const rows = await users.aggregate([{ $sort: { CITY: { order: -1, nulls: "first" }, ID: 1 } }, { $project: { CITY: 1 } }]);
    expect(rows[0].CITY).toBeNull();
  });

  it("$push orderBy takes NULLS FIRST", async () => {
    const [r] = await users.aggregate([{ $group: { _id: null, c: { $push: { input: "$CITY", orderBy: { CITY: { order: 1, nulls: "first" } } } } } }]);
    expect((r.C as unknown[])[0]).toBeNull();
  });

  it("limit(n, { withTies: true }) keeps every row tied with the last one", async () => {
    const rows = await users.find({}).sort({ STATUS: 1 }).limit(1, { withTies: true }).toArray();
    expect(rows).toHaveLength(byStatus("active").length);
    const plain = await users.find({}).sort({ STATUS: 1 }).limit(1).toArray();
    expect(plain).toHaveLength(1);
  });

  it("{ $limit: { n, withTies: true } } right after a $sort", async () => {
    const rows = await users.aggregate([{ $match: { STATUS: { $ne: "active" } } }, { $sort: { STATUS: 1 } }, { $limit: { n: 2, withTies: true } }]);
    // banned (1), inactive (2): the 2nd row is an "inactive" one, so both inactive rows stay.
    expect(rows.map((r) => r.STATUS)).toEqual(["banned", "inactive", "inactive"]);
  });

  it("{ $limit: { n } } without ties is a plain limit", async () => {
    expect(await users.aggregate([{ $sort: { ID: 1 } }, { $limit: { n: 3 } }])).toHaveLength(3);
  });
});
