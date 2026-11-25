/**
 * UNIT — Mira 2.1 statistics: SQL shape and argument checks for the new $group
 * accumulators, window options and sort / paging options. No database round trip.
 */
import { describe, it, expect } from "bun:test";
import { buildAggregateSQL, buildWindowExpr, buildOrderBy, createDb, OracleCollection, QueryBuilder } from "../../src/utils/oracle-mongo-wrapper";
import { sortTerm } from "../../src/utils/oracle-mongo-wrapper/utils";

const db = createDb("appDb");
const c = new OracleCollection("T_U", db);
const agg = (p: unknown[]) => buildAggregateSQL("T", p as never[], {});
const group = (acc: Record<string, unknown>) => agg([{ $group: { _id: null, X: acc } }]);

describe("unit: sortTerm and NULLS FIRST / LAST", () => {
  it("1 / -1 keep their meaning; an object adds NULLS", () => {
    expect(sortTerm("A", 1)).toBe('"A" ASC');
    expect(sortTerm("A", -1)).toBe('"A" DESC');
    expect(sortTerm("A", { order: -1, nulls: "last" })).toBe('"A" DESC NULLS LAST');
    expect(sortTerm("A", { order: 1, nulls: "FIRST" })).toBe('"A" ASC NULLS FIRST');
    expect(sortTerm("A", { nulls: "first" })).toBe('"A" ASC NULLS FIRST');
    expect(sortTerm("A", { order: -1 })).toBe('"A" DESC');
  });

  it("refuses an unknown direction or NULLS position", () => {
    expect(() => sortTerm("A", { order: 2 })).toThrow(/order must be 1 or -1/);
    expect(() => sortTerm("A", { nulls: "middle" })).toThrow(/nulls must be "first" or "last"/);
  });

  it("every ORDER BY builder uses it", () => {
    expect(buildOrderBy({ A: { order: -1, nulls: "last" } })).toBe('ORDER BY "A" DESC NULLS LAST');
    expect(agg([{ $sort: { a: { order: 1, nulls: "first" } } }]).sql).toContain('ORDER BY "A" ASC NULLS FIRST');
    expect(buildWindowExpr({ fn: "RANK", orderBy: { A: { order: -1, nulls: "last" } } })).toBe('RANK() OVER (ORDER BY "A" DESC NULLS LAST)');
    expect(c.find({}).sort({ A: { order: 1, nulls: "last" } })._buildSQL().sql).toContain('ORDER BY "A" ASC NULLS LAST');
  });
});

describe("unit: $group accumulators", () => {
  it("$countDistinct, $median, $stdDevPop, $stdDevSamp", () => {
    expect(group({ $countDistinct: "$A" }).sql).toContain('COUNT(DISTINCT "A") AS "X"');
    expect(group({ $median: "$A" }).sql).toContain('MEDIAN("A") AS "X"');
    expect(group({ $median: { input: "$A" } }).sql).toContain('MEDIAN("A") AS "X"');
    expect(group({ $stdDevPop: "$A" }).sql).toContain('STDDEV_POP("A") AS "X"');
    expect(group({ $stdDevSamp: "$A" }).sql).toContain('STDDEV_SAMP("A") AS "X"');
  });

  it("$push / $addToSet → JSON_ARRAYAGG as CLOB, flagged for parsing", () => {
    const p = group({ $push: "$A" });
    expect(p.sql).toContain('JSON_ARRAYAGG("A" NULL ON NULL RETURNING CLOB) AS "X"');
    expect(p.arrays).toEqual({ X: "array" });
    const s = group({ $addToSet: { input: "$A", orderBy: { B: -1 } } });
    expect(s.sql).toContain('JSON_ARRAYAGG("A" ORDER BY "B" DESC NULL ON NULL RETURNING CLOB) AS "X"');
    expect(s.arrays).toEqual({ X: "set" });
    expect(agg([{ $group: { _id: null, X: { $sum: "$A" } } }]).arrays).toBeUndefined();
  });

  it("$listAgg: separator bound, DISTINCT, WITHIN GROUP order (defaults to the value)", () => {
    const l = group({ $listAgg: { input: "$A", separator: "; ", distinct: true, orderBy: { B: 1 } } });
    expect(l.sql).toMatch(/LISTAGG\(DISTINCT "A", :\w+\) WITHIN GROUP \(ORDER BY "B" ASC\) AS "X"/);
    expect(Object.values(l.binds)).toContain("; ");
    expect(group({ $listAgg: "$A" }).sql).toMatch(/LISTAGG\("A", :\w+\) WITHIN GROUP \(ORDER BY "A"\) AS "X"/);
    expect(() => group({ $listAgg: { input: "$A", separator: 1 } })).toThrow(/separator/);
  });

  it("$percentile: CONT / DISC, a list becomes a JSON array", () => {
    expect(group({ $percentile: { input: "$A", p: 0.9 } }).sql).toContain('PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY "A") AS "X"');
    expect(group({ $percentile: { input: "$A", p: 0.25, method: "discrete" } }).sql).toContain('PERCENTILE_DISC(0.25) WITHIN GROUP (ORDER BY "A")');
    const many = group({ $percentile: { input: "$A", p: [0, 1] } });
    expect(many.sql).toContain('JSON_ARRAY(PERCENTILE_CONT(0) WITHIN GROUP (ORDER BY "A"), PERCENTILE_CONT(1) WITHIN GROUP (ORDER BY "A")) AS "X"');
    expect(many.arrays).toEqual({ X: "array" });
  });

  it("$percentile refuses p outside [0, 1], an empty list, an unknown method or no input", () => {
    expect(() => group({ $percentile: { input: "$A", p: 1.5 } })).toThrow(/p/);
    expect(() => group({ $percentile: { input: "$A", p: "0.5) FROM DUAL --" } })).toThrow(/p/);
    expect(() => group({ $percentile: { input: "$A", p: [] } })).toThrow(/p/);
    expect(() => group({ $percentile: { input: "$A", p: 0.5, method: "approx" } })).toThrow(/method/);
    expect(() => group({ $percentile: { p: 0.5 } })).toThrow(/input/);
    expect(() => group({ $push: {} })).toThrow(/input/);
  });
});

describe("unit: window options", () => {
  it("LAG / LEAD default: numbers inline, other values bound through the pipeline", () => {
    expect(buildWindowExpr({ fn: "LAG", field: "A", default: 0 })).toBe('LAG("A", 1, 0) OVER ()');
    expect(buildWindowExpr({ fn: "LEAD", field: "A", default: null })).toBe('LEAD("A", 1, NULL) OVER ()');
    const { sql, binds } = agg([{ $addFields: { W: { $window: { fn: "LAG", field: "A", default: "none" } } } }]);
    expect(sql).toMatch(/LAG\("A", 1, :\w+\) OVER \(\)/);
    expect(Object.values(binds)).toContain("none");
    expect(() => buildWindowExpr({ fn: "LAG", field: "A", default: "x" })).toThrow(/default/);
    expect(() => buildWindowExpr({ fn: "LAG", field: "A", default: Number.NaN })).toThrow(/default/);
    expect(() => buildWindowExpr({ fn: "RANK", default: 0 })).toThrow(/default/);
  });

  it("ignoreNulls on the value functions only", () => {
    expect(buildWindowExpr({ fn: "LAG", field: "A", ignoreNulls: true })).toBe('LAG("A", 1) IGNORE NULLS OVER ()');
    expect(buildWindowExpr({ fn: "FIRST_VALUE", field: "A", ignoreNulls: true, orderBy: { B: 1 } })).toBe('FIRST_VALUE("A") IGNORE NULLS OVER (ORDER BY "B" ASC)');
    expect(buildWindowExpr({ fn: "NTH_VALUE", field: "A", n: 2, ignoreNulls: true })).toBe('NTH_VALUE("A", 2) IGNORE NULLS OVER ()');
    expect(() => buildWindowExpr({ fn: "ROW_NUMBER", ignoreNulls: true })).toThrow(/ignoreNulls/);
  });

  it("RATIO_TO_REPORT takes a partition, never an ORDER BY or frame", () => {
    expect(buildWindowExpr({ fn: "RATIO_TO_REPORT", field: "A", partitionBy: "B" })).toBe('RATIO_TO_REPORT("A") OVER (PARTITION BY "B")');
    expect(() => buildWindowExpr({ fn: "RATIO_TO_REPORT", field: "A", orderBy: { B: 1 } })).toThrow(/RATIO_TO_REPORT/);
  });
});

describe("unit: FETCH … WITH TIES", () => {
  it("QueryBuilder.limit(n, { withTies: true }) needs a sort", () => {
    expect(c.find({}).sort({ A: 1 }).limit(3, { withTies: true })._buildSQL().sql).toBe('SELECT * FROM "T_U" t0 ORDER BY "A" ASC FETCH FIRST 3 ROWS WITH TIES');
    expect(c.find({}).sort({ A: 1 }).skip(2).limit(3, { withTies: true })._buildSQL().sql).toContain("OFFSET 2 ROWS FETCH FIRST 3 ROWS WITH TIES");
    expect(() => c.find({}).limit(3, { withTies: true })._buildSQL()).toThrow(/withTies needs a sort/);
    expect(new QueryBuilder("T_U", {}, db, null, { limit: 2 })._buildSQL().sql).toContain("FETCH FIRST 2 ROWS ONLY");
  });

  it("$limit { n, withTies } repeats the $sort right before it", () => {
    const { sql } = agg([{ $sort: { a: -1 } }, { $limit: { n: 5, withTies: true } }]);
    expect(sql).toContain('ORDER BY "A" DESC FETCH FIRST 5 ROWS WITH TIES');
    expect(agg([{ $limit: { n: 5 } }]).sql).toContain("FETCH FIRST 5 ROWS ONLY");
    expect(() => agg([{ $limit: { n: 5, withTies: true } }])).toThrow(/directly after a \$sort/);
    expect(() => agg([{ $sort: { a: 1 } }, { $match: { a: 1 } }, { $limit: { n: 5, withTies: true } }])).toThrow(/directly after a \$sort/);
    expect(() => agg([{ $limit: { n: -1 } }])).toThrow(/non-negative integer/);
    expect(() => agg([{ $limit: "5 ROWS ONLY UNION SELECT 1 FROM DUAL" }])).toThrow(/non-negative integer/);
  });
});
