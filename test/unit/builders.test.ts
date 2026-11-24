/**
 * UNIT — pure SQL builders. No database round trip: every assertion is on the
 * SQL text and bind object a builder returns.
 *
 * Tests named "SECURITY:" / "DEFECT:" assert the behaviour the library SHOULD
 * have; they fail today and are listed in the run report as open defects.
 */
import { describe, it, expect } from "bun:test";
import {
  parseFilter,
  parseUpdate,
  buildAggregateSQL,
  buildWindowExpr,
  buildJoinSQL,
  buildConnectBy,
  buildPivot,
  buildUnpivot,
  buildScalarSubquery,
  buildExistsSubquery,
  buildNotExistsSubquery,
  buildCorrelatedSubquery,
  buildInSelectSubquery,
  buildAnyAllSubquery,
  quoteIdentifier,
  convertTypes,
  rowToDoc,
  buildOrderBy,
  buildProjection,
  mergeBinds,
  createDb,
  OracleCollection,
  QueryBuilder,
  withCTE,
  withRecursiveCTE,
} from "../../src/utils/oracle-mongo-wrapper";
import { resetBindCounter } from "../../src/utils/oracle-mongo-wrapper/parsers/filterParser";
import { resetUpdateCounter } from "../../src/utils/oracle-mongo-wrapper/parsers/updateParser";

const db = createDb("appDb");
const c = new OracleCollection("T_U", db);

describe("unit: utils", () => {
  it("quoteIdentifier wraps in double quotes and escapes embedded quotes", () => {
    expect(quoteIdentifier("NAME")).toBe('"NAME"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it("buildOrderBy maps -1 to DESC and anything else to ASC", () => {
    expect(buildOrderBy({ A: 1, B: -1 })).toBe('ORDER BY "A" ASC, "B" DESC');
    expect(buildOrderBy({})).toBe("");
    expect(buildOrderBy(null)).toBe("");
  });

  it("buildProjection: inclusion, exclusion, object values, nothing selectable", () => {
    expect(buildProjection({ A: 1, B: 1 })).toEqual({ columns: '"A", "B"', isExclusion: false, excludedCols: [] });
    expect(buildProjection({ A: 0 })).toEqual({ columns: "*", isExclusion: true, excludedCols: ["A"] });
    expect(buildProjection({ S: { $subquery: {} } }).columns).toBe('"S"');
    expect(buildProjection({ A: "x" }).columns).toBe("*");
    expect(buildProjection(null).columns).toBe("*");
  });

  it("mergeBinds merges and refuses key collisions", () => {
    expect(mergeBinds({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(() => mergeBinds({ a: 1 }, { a: 2 })).toThrow(/collision/);
  });

  it("convertTypes / rowToDoc coerce integer strings only (money stays a string)", () => {
    expect(convertTypes({ ID: "42", AMT: "50000.50", S: "abc", E: "", N: null })).toEqual({ ID: 42, AMT: "50000.50", S: "abc", E: "", N: null });
    expect(rowToDoc({ ID: "-7" })).toEqual({ ID: -7 });
    expect(convertTypes({ BIG: "9007199254740993" }).BIG).toBe("9007199254740993");
    expect(convertTypes(null as never)).toBeNull();
  });

  it("createDb validates its name and exposes the pool helpers", async () => {
    expect(() => createDb("" as string)).toThrow(TypeError);
    expect(() => createDb(42 as unknown as string)).toThrow(TypeError);
    const d = createDb();
    expect(d.connectionName).toBe("appDb");
    expect(typeof d.withBatchConnection).toBe("function");
  });

  it("legacy counter resets are harmless no-ops", () => {
    expect(resetBindCounter()).toBeUndefined();
    expect(resetUpdateCounter()).toBeUndefined();
  });
});

describe("unit: parseFilter", () => {
  it("equality + range on one field", () => {
    const { whereClause, binds } = parseFilter({ NAME: "x", AGE: { $gte: 18, $lt: 65 } });
    expect(whereClause).toBe('WHERE "NAME" = :where_NAME_0 AND ("AGE" >= :where_AGE_1 AND "AGE" < :where_AGE_2)');
    expect(binds).toEqual({ where_NAME_0: "x", where_AGE_1: 18, where_AGE_2: 65 });
  });

  it("every comparison operator", () => {
    const w = parseFilter({ A: { $eq: 1, $ne: 2, $gt: 3, $gte: 4, $lt: 5, $lte: 6 } }).whereClause;
    for (const op of ["=", "<>", ">", ">=", "<", "<="]) expect(w).toContain(`"A" ${op} :`);
  });

  it("Date values bind as-is (no string conversion)", () => {
    const d = new Date(0);
    expect(parseFilter({ D: d }).binds).toEqual({ where_D_0: d });
  });

  it("$in / $nin: normal, empty, non-array, and >1000 split (ORA-01795 guard)", () => {
    expect(parseFilter({ S: { $in: ["a", "b"] } }).whereClause).toBe('WHERE "S" IN (:where_S_0, :where_S_1)');
    expect(parseFilter({ S: { $in: [] } }).whereClause).toBe("WHERE 1=0");
    expect(parseFilter({ S: { $in: "x" } }).whereClause).toBe("WHERE 1=0");
    expect(parseFilter({ S: { $nin: [] } }).whereClause).toBe("WHERE 1=1");
    expect(parseFilter({ S: { $nin: ["a"] } }).whereClause).toBe('WHERE "S" NOT IN (:where_S_0)');
    // > 1,000 values of one type: a single collection bind (constant SQL text, linear cost)
    const nums = Array.from({ length: 2001 }, (_, i) => i);
    expect(parseFilter({ S: { $in: nums } })).toEqual({ whereClause: 'WHERE "S" IN (SELECT COLUMN_VALUE FROM TABLE(:where_S_0))', binds: { where_S_0: { type: "SYS.ODCINUMBERLIST", val: nums } } });
    expect(parseFilter({ S: { $nin: nums } }).whereClause).toBe('WHERE "S" NOT IN (SELECT COLUMN_VALUE FROM TABLE(:where_S_0))');
    const strs = nums.map(String);
    expect(parseFilter({ S: { $in: strs } }).binds.where_S_0).toEqual({ type: "SYS.ODCIVARCHAR2LIST", val: strs });
    const dates = nums.map((n) => new Date(n));
    expect(parseFilter({ S: { $in: dates } }).binds.where_S_0).toEqual({ type: "SYS.ODCIDATELIST", val: dates });
    // mixed types / over-long strings cannot be one collection: grouped IN lists of ≤ 1,000 (ORA-01795 guard)
    const mixed = [...nums.slice(0, 2000), "x"];
    const inW = parseFilter({ S: { $in: mixed } }).whereClause;
    expect(inW.match(/IN \(/g)?.length).toBe(3);
    expect(inW).toContain(" OR ");
    const ninW = parseFilter({ S: { $nin: mixed } }).whereClause;
    expect(ninW.match(/NOT IN \(/g)?.length).toBe(3);
    expect(ninW).toContain(" AND ");
    const longStrs = [...strs.slice(0, 1000), "é".repeat(2001)];
    expect(parseFilter({ S: { $in: longStrs } }).whereClause.match(/IN \(/g)?.length).toBe(2);
    expect(parseFilter({ S: { $in: [NaN, ...nums] } }).whereClause.match(/IN \(/g)?.length).toBe(3);
  });

  it("$and / $or / $nor / $not", () => {
    expect(parseFilter({ $and: [{ A: 1 }, { B: 2 }] }).whereClause).toBe('WHERE ("A" = :where_A_0 AND "B" = :where_B_1)');
    expect(parseFilter({ $or: [{ A: 1 }, { B: 2 }] }).whereClause).toBe('WHERE ("A" = :where_A_0 OR "B" = :where_B_1)');
    expect(parseFilter({ $nor: [{ A: 1 }, { B: 2 }] }).whereClause).toBe('WHERE NOT ("A" = :where_A_0 OR "B" = :where_B_1)');
    expect(parseFilter({ $not: { A: 1 } }).whereClause).toBe('WHERE NOT ("A" = :where_A_0)');
  });

  it("null / undefined / $exists map to IS [NOT] NULL", () => {
    expect(parseFilter({ A: null })).toEqual({ whereClause: 'WHERE "A" IS NULL', binds: {} });
    expect(parseFilter({ A: undefined }).whereClause).toBe('WHERE "A" IS NULL');
    expect(parseFilter({ A: { $exists: false } }).whereClause).toBe('WHERE "A" IS NULL');
    expect(parseFilter({ A: { $exists: true } }).whereClause).toBe('WHERE "A" IS NOT NULL');
  });

  it("$regex with and without $options; $like; $between; $notBetween", () => {
    const r = parseFilter({ A: { $regex: "^J", $options: "i" } });
    expect(r.whereClause).toBe('WHERE REGEXP_LIKE("A", :where_A_0, :where_A_opts_1)');
    expect(r.binds).toEqual({ where_A_0: "^J", where_A_opts_1: "i" });
    expect(parseFilter({ A: { $regex: "^J" } }).whereClause).toBe('WHERE REGEXP_LIKE("A", :where_A_0)');
    expect(parseFilter({ A: { $like: "J%" } }).binds).toEqual({ where_A_0: "J%" });
    expect(parseFilter({ A: { $between: [1, 2] } }).whereClause).toBe('WHERE "A" BETWEEN :where_A_min_0 AND :where_A_max_1');
    expect(parseFilter({ A: { $notBetween: [1, 2] } }).whereClause).toBe('WHERE "A" NOT BETWEEN :where_A_min_0 AND :where_A_max_1');
  });

  it("$any / $all bind every element", () => {
    expect(parseFilter({ A: { $any: [1, 2] } }).whereClause).toBe('WHERE "A" = ANY(:where_A_0, :where_A_1)');
    expect(parseFilter({ A: { $all: [1] } }).whereClause).toBe('WHERE "A" = ALL(:where_A_0)');
  });

  it("DEFECT: $eq / $ne with null become IS NULL / IS NOT NULL (a bound NULL matches nothing)", () => {
    expect(parseFilter({ A: { $eq: null } })).toEqual({ whereClause: 'WHERE "A" IS NULL', binds: {} });
    expect(parseFilter({ A: { $ne: null } })).toEqual({ whereClause: 'WHERE "A" IS NOT NULL', binds: {} });
    expect(parseFilter({ A: { $ne: undefined } }).whereClause).toBe('WHERE "A" IS NOT NULL');
  });

  it("$case with and without $else", () => {
    const r = parseFilter({ T: { $case: [{ when: { S: { $gte: 10 } }, then: "VIP" }], $else: "Reg" } });
    expect(r.whereClause).toBe('WHERE "T" = CASE WHEN "S" >= :where_S_0 THEN :where_T_then_1 ELSE :where_T_else_2 END');
    expect(r.binds).toEqual({ where_S_0: 10, where_T_then_1: "VIP", where_T_else_2: "Reg" });
    expect(parseFilter({ T: { $case: [{ when: { S: 1 }, then: "X" }] } }).whereClause).not.toContain("ELSE");
  });

  it("$coalesce: $refs are columns, every other value is bound; $nullif (both compared with the field)", () => {
    const r = parseFilter({ X: { $coalesce: ["$NICK", "anon", 5] } });
    expect(r.whereClause).toBe('WHERE "X" = COALESCE("NICK", :where_X_0, :where_X_1)');
    expect(r.binds).toEqual({ where_X_0: "anon", where_X_1: 5 });
    expect(parseFilter({ X: { $nullif: ["D", 0] } }).whereClause).toBe('WHERE "X" = NULLIF("D", :where_X_0)');
  });

  it("$outer. reference is bound (rewritten to the outer column by $lateralJoin)", () => {
    expect(parseFilter({ UID: "$outer.ID" })).toEqual({ whereClause: 'WHERE "UID" = :where_UID_0', binds: { where_UID_0: "$outer.ID" } });
  });

  it("correlated $subquery: as comparison operand and standalone, with $outer and literal binds", () => {
    const cmp = parseFilter({ SAL: { $gt: { $subquery: { collection: "E", aggregate: "$avg", field: "SAL", where: { DEPT: "$outer.DEPT", ACTIVE: 1 } } } } }, "t9");
    expect(cmp.whereClause).toBe('WHERE "SAL" > (SELECT AVG("SAL") FROM "E" WHERE "DEPT" = t9."DEPT" AND "ACTIVE" = :where_sub_ACTIVE_0)');
    const bare = parseFilter({ SAL: { $subquery: { collection: "E" } } });
    expect(bare.whereClause).toBe('WHERE (SELECT * FROM "E")');
    expect(parseFilter({ SAL: { $subquery: { collection: "E", where: { D: "$outer.D" } } } }).whereClause).toContain('t0."D"');
  });

  it("$now: true, empty, minus/plus with every unit (database wall-clock time, no session time zone)", () => {
    expect(parseFilter({ T: { $lt: { $now: true } } }).whereClause).toBe('WHERE "T" < CAST(SYSTIMESTAMP AS TIMESTAMP)');
    expect(parseFilter({ T: { $lt: { $now: {} } } }).whereClause).toBe('WHERE "T" < CAST(SYSTIMESTAMP AS TIMESTAMP)');
    expect(parseFilter({ T: { $lt: { $now: { withTimeZone: true } } } }).whereClause).toBe('WHERE "T" < SYSTIMESTAMP');
    const r = parseFilter({ T: { $gte: { $now: { minus: { days: 7, hours: 1 }, plus: { minutes: 2, seconds: 3 } } } } });
    expect(r.whereClause).toBe(
      "WHERE \"T\" >= CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:where_T_now_0, 'DAY') - NUMTODSINTERVAL(:where_T_now_1, 'HOUR') + NUMTODSINTERVAL(:where_T_now_2, 'MINUTE') + NUMTODSINTERVAL(:where_T_now_3, 'SECOND')",
    );
    expect(r.binds).toEqual({ where_T_now_0: 7, where_T_now_1: 1, where_T_now_2: 2, where_T_now_3: 3 });
  });

  it("$now rejects malformed specs", () => {
    expect(() => parseFilter({ T: { $lt: { $now: "yesterday" } } })).toThrow(/must be true/);
    expect(() => parseFilter({ T: { $lt: { $now: [1] } } })).toThrow(/must be true/);
    expect(() => parseFilter({ T: { $lt: { $now: { ago: { days: 1 } } } } })).toThrow(/unknown key/);
    expect(() => parseFilter({ T: { $lt: { $now: { minus: 5 } } } })).toThrow(/object of units/);
    expect(() => parseFilter({ T: { $lt: { $now: { minus: { weeks: 1 } } } } })).toThrow(/unknown unit/);
    expect(() => parseFilter({ T: { $lt: { $now: { minus: { days: -1 } } } } })).toThrow(/non-negative/);
    expect(() => parseFilter({ T: { $lt: { $now: { minus: { days: Infinity } } } } })).toThrow(/non-negative/);
  });

  it("$inSelect: array, empty array, QueryBuilder, object without _getBinds, raw SQL", () => {
    expect(parseFilter({ ID: { $inSelect: [1, 2] } }).whereClause).toBe('WHERE "ID" IN (:where_ID_0, :where_ID_1)');
    expect(parseFilter({ ID: { $inSelect: [] } }).whereClause).toBe("WHERE 1=0");
    expect(parseFilter({ ID: { $inSelect: Array.from({ length: 1500 }, (_, i) => i) } }).whereClause).toBe('WHERE "ID" IN (SELECT COLUMN_VALUE FROM TABLE(:where_ID_0))');
    const qb = c.find({ S: "a" }).project({ ID: 1 });
    const viaQb = parseFilter({ ID: { $inSelect: qb } });
    // The subquery's binds are prefixed (sq_0_) so they cannot collide with the outer filter's.
    expect(viaQb.whereClause).toBe('WHERE "ID" IN (SELECT "ID" FROM "T_U" t0 WHERE "S" = :sq_0_where_S_0)');
    expect(viaQb.binds).toEqual({ sq_0_where_S_0: "a" });
    expect(parseFilter({ ID: { $inSelect: { _buildSQL: () => "SELECT 1 FROM DUAL" } } }).whereClause).toBe('WHERE "ID" IN (SELECT 1 FROM DUAL)');
    expect(parseFilter({ ID: { $inSelect: "SELECT 1 FROM DUAL" } }).whereClause).toBe('WHERE "ID" IN (SELECT 1 FROM DUAL)');
  });

  it("$gtAny..$lteAll compile to ANY/ALL subqueries", () => {
    const spec = { collection: "O", field: "AMT" };
    expect(parseFilter({ A: { $gtAny: spec } }).whereClause).toBe('WHERE "A" > ANY (SELECT "AMT" FROM "O")');
    expect(parseFilter({ A: { $lteAny: spec } }).whereClause).toContain("<= ANY");
    expect(parseFilter({ A: { $ltAll: spec } }).whereClause).toBe('WHERE "A" < ALL (SELECT "AMT" FROM "O")');
    expect(parseFilter({ A: { $gteAll: spec } }).whereClause).toContain(">= ALL");
    expect(parseFilter({ A: { $ltAny: spec, $gtAll: spec, $gteAny: spec, $lteAll: spec } }).whereClause.match(/(ANY|ALL)/g)?.length).toBe(4);
  });

  it("$exists / $notExists subqueries: correlated, literal, and without match", () => {
    expect(parseFilter({ $exists: { collection: "O", match: { UID: "$ID", ST: "x" } } }).whereClause).toBe(
      'WHERE EXISTS (SELECT 1 FROM "O" WHERE "UID" = t0."ID" AND "ST" = :where_exists_ST_0)',
    );
    expect(parseFilter({ $exists: { collection: "O" } }, "a1").whereClause).toBe('WHERE EXISTS (SELECT 1 FROM "O")');
    expect(parseFilter({ $notExists: { collection: "O", match: { UID: "$ID", ST: "x" } } }, "a1").whereClause).toBe(
      'WHERE NOT EXISTS (SELECT 1 FROM "O" WHERE "UID" = a1."ID" AND "ST" = :where_notexists_ST_0)',
    );
    expect(parseFilter({ $notExists: { collection: "O" } }).whereClause).toBe('WHERE NOT EXISTS (SELECT 1 FROM "O")');
    expect(parseFilter({ $exists: { collection: "O", match: { U: "$I" } } }, "a1").whereClause).toContain("a1.");
    expect(parseFilter({ $notExists: { collection: "O", match: { U: "$I" } } }).whereClause).toContain("t0.");
  });

  it("unknown operator throws; empty / null filter yields no WHERE", () => {
    expect(() => parseFilter({ A: { $bogus: 1 } })).toThrow(/Unsupported operator: \$bogus/);
    expect(parseFilter({}).whereClause).toBe("");
    expect(parseFilter(null as never).whereClause).toBe("");
  });

  it("bind counters restart per call (deterministic SQL → statement cache hits)", () => {
    expect(parseFilter({ A: 1 }).whereClause).toBe(parseFilter({ A: 1 }).whereClause);
  });
});

describe("unit: parseUpdate", () => {
  it("compiles every supported operator", () => {
    const { setClause, binds } = parseUpdate({
      $set: { A: 1 },
      $inc: { B: 2 },
      $unset: { C: "" },
      $mul: { D: 2 },
      $min: { E: 1 },
      $max: { F: 2 },
      $currentDate: { G: true },
    });
    expect(setClause).toBe(
      'SET "A" = :upd_A_0, "B" = "B" + :upd_B_1, "C" = NULL, "D" = "D" * :upd_D_2, "E" = LEAST("E", :upd_E_3), "F" = GREATEST("F", :upd_F_4), "G" = SYSDATE',
    );
    expect(binds).toEqual({ upd_A_0: 1, upd_B_1: 2, upd_D_2: 2, upd_E_3: 1, upd_F_4: 2 });
  });

  it("$currentDate {$type} date/timestamp; anything else throws", () => {
    expect(parseUpdate({ $currentDate: { U: { $type: "timestamp" } } }).setClause).toBe('SET "U" = SYSTIMESTAMP');
    expect(parseUpdate({ $currentDate: { U: { $type: "date" } } }).setClause).toBe('SET "U" = SYSDATE');
    expect(() => parseUpdate({ $currentDate: { U: "yes" } })).toThrow();
    expect(() => parseUpdate({ $currentDate: { U: { $type: "epoch" } } })).toThrow();
  });

  it("rejects bare fields, empty / null updates and $rename", () => {
    expect(() => parseUpdate({ A: 1 })).toThrow(/Unsupported update operator/);
    expect(() => parseUpdate({})).toThrow(/must not be empty/);
    expect(() => parseUpdate(null as never)).toThrow(/must not be empty/);
    expect(() => parseUpdate({ $rename: { A: "B" } })).toThrow(/not supported/);
  });
});

describe("unit: aggregate pipeline", () => {
  const agg = (p: unknown[]) => buildAggregateSQL("T", p, {});

  it("$match → $group → $sort → $limit compiles to chained CTEs", () => {
    const { sql, binds } = agg([{ $match: { S: "x" } }, { $group: { _id: "$R", total: { $sum: "$AMT" }, n: { $count: "*" } } }, { $sort: { total: -1 } }, { $limit: 5 }]);
    expect(sql).toBe(
      'WITH "stage_0" AS (SELECT * FROM "T" WHERE "S" = :where_S_0),\n     "stage_1" AS (SELECT "R", SUM("AMT") AS "TOTAL", COUNT(*) AS "N" FROM "stage_0" GROUP BY "R"),\n     "stage_2" AS (SELECT * FROM "stage_1" ORDER BY "TOTAL" DESC)\nSELECT * FROM "stage_2" FETCH FIRST 5 ROWS ONLY',
    );
    expect(binds).toEqual({ where_S_0: "x" });
  });

  it("empty pipeline / single stage / adjacent $match merge", () => {
    expect(agg([]).sql).toBe('SELECT * FROM "T"');
    expect(agg([{ $skip: 3 }]).sql).toBe('SELECT * FROM "T" OFFSET 3 ROWS');
    expect(agg([{ $match: { A: 1 } }, { $match: { B: 2 } }]).sql).toBe('SELECT * FROM "T" WHERE ("A" = :where_A_0 AND "B" = :where_B_1)');
  });

  it("$count, $unwind, $replaceRoot (field and root)", () => {
    expect(agg([{ $count: "total" }]).sql).toBe('SELECT COUNT(*) AS "TOTAL" FROM "T"');
    expect(agg([{ $unwind: "$tags" }]).sql).toBe('SELECT * FROM "T"');
    expect(agg([{ $replaceRoot: { newRoot: "$doc" } }]).sql).toBe('SELECT "doc".* FROM "T"');
    expect(agg([{ $replaceRoot: { newRoot: "$" } }]).sql).toBe('SELECT * FROM "T"');
    expect(agg([{ $replaceRoot: { newRoot: { a: 1 } } }]).sql).toBe('SELECT * FROM "T"');
  });

  it("$group variants: null _id, literal _id, alias object, $rollup, $cube, $groupingSets", () => {
    expect(agg([{ $group: { _id: null, n: { $count: "*" } } }]).sql).toBe('SELECT COUNT(*) AS "N" FROM "T"');
    expect(agg([{ $group: { _id: "R", n: { $count: "ID" } } }]).sql).toBe('SELECT "R", COUNT("ID") AS "N" FROM "T" GROUP BY "R"');
    expect(agg([{ $group: { _id: { reg: "$R", lit: 5 } } }]).sql).toBe('SELECT "R" AS "REG", "lit" AS "LIT" FROM "T" GROUP BY "R", "lit"');
    expect(agg([{ $group: { _id: { $rollup: ["R", "P"] }, t: { $sum: "$A" } } }]).sql).toContain('GROUP BY ROLLUP("R", "P")');
    expect(agg([{ $group: { _id: { $cube: ["R"] }, t: { $sum: "$A" } } }]).sql).toContain('GROUP BY CUBE("R")');
    const gs = agg([{ $group: { _id: { $groupingSets: [["R", "P"], ["P"], [], "Q"] }, t: { $sum: "$A" } } }]).sql;
    expect(gs).toContain('GROUPING SETS(("R", "P"), ("P"), (), "Q")');
    expect(gs).toContain('SELECT "R", "P", "Q"');
    expect(agg([{ $group: { _id: [1] } }]).sql).toBe('SELECT  FROM "T"');
  });

  it("$having attaches to the preceding $group; every operator; unknown op → '='; scalar cond ignored", () => {
    const { sql, binds } = agg([
      { $group: { _id: "$R", total: { $sum: "$A" } } },
      { $having: { total: { $gt: 1, $gte: 2, $lt: 3, $lte: 4, $eq: 5, $ne: 6, $weird: 7 }, OTHER: { $gt: 0 }, SKIP: 3 } },
    ]);
    expect(sql).toContain('HAVING SUM("A") > :having_0 AND SUM("A") >= :having_1 AND SUM("A") < :having_2');
    expect(sql).toContain('SUM("A") = :having_6');
    expect(sql).toContain('"OTHER" > :having_7');
    expect(Object.keys(binds)).toHaveLength(8);
    expect(agg([{ $group: { _id: "$R" } }, { $having: { X: 1 } }]).sql).not.toContain("HAVING");
    // $having not after a $group cannot be attached → refused
    expect(() => agg([{ $having: { X: { $gt: 1 } } }])).toThrow(/\$having must directly follow a \$group/);
  });

  it("aggregate expressions: arithmetic, string, date, conditional, window, fallbacks", () => {
    const { sql, binds } = agg([
      {
        $project: {
          a: { $avg: "$A" }, mn: { $min: "$A" }, mx: { $max: "$A" }, f: { $first: "$A" }, l: { $last: "$A" },
          mul: { $mul: ["$A", 2] }, mul1: { $mul: "$A" },
          add: { $add: ["$A", 1, true] }, add1: { $add: "$A" },
          sub: { $subtract: ["$A", "x"] }, sub1: { $subtract: "$A" },
          div: { $divide: ["$A", 2] }, div1: { $divide: "$A" },
          cat: { $concat: ["$F", "$L"] }, cat1: { $concat: "$F" },
          up: { $toUpper: "$F" }, lo: { $toLower: "$F" },
          ss: { $substr: ["$F", 1, 3] }, ss1: { $substr: "$F" },
          d: { $dateToString: { format: "YYYY'Q", date: "$D" } }, d2: { $dateToString: { date: "$D" } },
          cnd: { $cond: { if: { A: { $gte: 10 } }, then: "VIP", else: "$B" } },
          cnd2: { $cond: { if: { $A: 5 }, then: 1, else: 0 } },
          cnd3: { $cond: { if: "nope", then: 1, else: { x: 1 } } },
          cnd4: { $cond: { if: { A: { $weird: 1 } }, then: 1, else: 0 } },
          inl: { $ifNull: ["$N", "anon"] }, inl1: { $ifNull: "$N" },
          sz: { $size: "$ARR" },
          w: { $window: { fn: "ROW_NUMBER" } },
          keep: 1, alias: "$A", star: { $count: "*" }, num: { $sum: 5 },
        },
      },
    ]);
    for (const frag of [
      'AVG("A")', 'MIN("A")', 'MAX("A")', '"A" * :agg_0', '("A" + :agg_1 + :agg_2)', '("A" - :agg_3)', '("A" / :agg_4)',
      '"F" || "L"', 'UPPER("F")', 'LOWER("F")', 'SUBSTR("F", 1, 3)', "TO_CHAR(\"D\", 'YYYY''Q')", "TO_CHAR(\"D\", 'YYYY-MM-DD')",
      'CASE WHEN "A" >= :cond_5 THEN :agg_6 ELSE "B" END', 'CASE WHEN "A" = :cond_7', "CASE WHEN 1=1 THEN :agg_",
      'COALESCE("N", :agg_', "JSON_VALUE(\"ARR\", '$.size()' RETURNING NUMBER)", "ROW_NUMBER() OVER ()", '"keep"', '"A" AS "ALIAS"',
      'COUNT(*) AS "STAR"', 'SUM(5) AS "NUM"', '"A" AS "MUL1"', '"F" AS "SS1"', '"N" AS "INL1"', "[object Object]",
    ])
      expect(sql).toContain(frag);
    expect(binds.agg_0).toBe(2);
    expect(binds.agg_2).toBe(true);
  });

  it("DEFECT: $match names a $group / $project alias in the case it was written ($and / $or / $not too)", () => {
    const { sql } = agg([
      { $group: { _id: "$R", total: { $sum: "$A" } } },
      { $project: { R: 1, total: 1, twice: { $mul: ["$total", 2] } } },
      { $match: { $or: [{ total: { $gt: 1 } }, { twice: 4 }], $not: { total: 5 }, R: "x" } },
    ]);
    expect(sql).toContain('("TOTAL" > :where_TOTAL_0 OR "TWICE" = :where_TWICE_1)');
    expect(sql).toContain('NOT ("TOTAL" = :where_TOTAL_2)');
    expect(sql).toContain('"R" = :where_R_3'); // not an alias: left as written
  });

  it("expressions: every date unit, $literal, $round/$trunc forms, null and argument errors", () => {
    const one = (e: unknown) => {
      const { sql, binds } = agg([{ $project: { X: e } }]);
      return { sql: sql.replace(/^SELECT /, "").replace(/ AS "X" FROM "T"$/, ""), binds };
    };
    expect(one({ $dateAdd: { startDate: "$D", unit: "hour", amount: 3 } }).sql).toBe(`("D" + NUMTODSINTERVAL(:agg_0, 'HOUR'))`);
    expect(one({ $dateAdd: { startDate: "$D", unit: "minute", amount: 3 } }).sql).toContain("'MINUTE'");
    expect(one({ $dateAdd: { startDate: "$D", unit: "second", amount: 3 } }).sql).toContain("'SECOND'");
    expect(one({ $dateAdd: { startDate: "$D", unit: "week", amount: 2 } }).sql).toBe('(CAST("D" AS DATE) + 7 * :agg_0)');
    expect(one({ $dateAdd: { startDate: "$D", unit: "quarter", amount: 1 } }).sql).toBe('ADD_MONTHS("D", 3 * :agg_0)');
    expect(one({ $dateAdd: { startDate: "$D", unit: "year", amount: 1 } }).sql).toBe('ADD_MONTHS("D", 12 * :agg_0)');
    expect(one({ $dateDiff: { startDate: "$S", endDate: "$E", unit: "week" } }).sql).toBe(`((TRUNC(CAST("E" AS DATE), 'IW') - TRUNC(CAST("S" AS DATE), 'IW')) / 7)`);
    expect(one({ $dateDiff: { startDate: "$S", endDate: "$E", unit: "quarter" } }).sql).toContain("TRUNC(((EXTRACT(YEAR FROM \"E\") * 12");
    expect(one({ $dateDiff: { startDate: "$S", endDate: "$E", unit: "year" } }).sql).toBe('(EXTRACT(YEAR FROM "E") - EXTRACT(YEAR FROM "S"))');
    for (const unit of ["year", "quarter", "week", "day", "hour", "minute"]) expect(one({ $dateTrunc: { date: "$D", unit } }).sql).toMatch(/^TRUNC\("D", '/);
    expect(() => one({ $dateTrunc: { date: "$D", unit: "fortnight" } })).toThrow(/\$dateTrunc expects unit/);
    expect(() => one({ $dateAdd: { startDate: "$D", unit: "eon", amount: 1 } })).toThrow(/\$dateAdd expects unit/);
    expect(() => one({ $dateDiff: { startDate: "$S", endDate: "$E", unit: "hour" } })).toThrow(/\$dateDiff expects unit/);
    expect(one({ $literal: "$NOT_A_COLUMN" })).toEqual({ sql: ":agg_0", binds: { agg_0: "$NOT_A_COLUMN" } });
    expect(one({ $round: "$A" }).sql).toBe('ROUND("A")');
    expect(one({ $trunc: ["$A"] }).sql).toBe('TRUNC("A")');
    expect(one({ $dateToString: { date: new Date(0), format: "YYYY" } }).sql).toBe("TO_CHAR(:agg_0, 'YYYY')");
    expect(one({ $ifNull: ["$A", null] }).sql).toBe('COALESCE("A", NULL)');
    expect(one({ $cond: { if: { $eq: ["$A", null] }, then: 1, else: 0 } }).sql).toContain('WHEN "A" IS NULL THEN');
    expect(one({ $cond: { if: { $ne: ["$A", null] }, then: 1, else: 0 } }).sql).toContain('WHEN "A" IS NOT NULL THEN');
    expect(one({ $switch: { branches: [{ case: { $gt: ["$A", 1] }, then: "x" }] } }).sql).toBe('CASE WHEN "A" > :agg_0 THEN :agg_1 END');
    expect(() => one({ $switch: { branches: [] } })).toThrow(/\$switch expects branches/);
    expect(() => one({ $mod: ["$A"] })).toThrow(/\$mod expects a list of at least 2/);
    expect(() => one({ $max: ["$A"] })).toThrow(/\$max expects a list of at least 2/);
    expect(() => one({ $cond: { if: { $gt: ["$A"] }, then: 1, else: 0 } })).toThrow(/\$gt expects two operands/);
    expect(one({ $sum: 7 }).sql).toBe("SUM(7)"); // a bare number in an aggregate stays a literal, as before
  });

  it("DEFECT: an unknown expression operator is refused, not turned into a column name", () => {
    expect(() => agg([{ $project: { R: { $cosine: ["$A", 0] } } }])).toThrow(/Unsupported expression operator "\$cosine"/);
    expect(() => agg([{ $group: { _id: "$R", s: { $stdDevPop: "$A" } } }])).toThrow(/Unsupported expression operator "\$stdDevPop"/);
  });

  it("$project with nothing selectable falls back to *", () => {
    expect(agg([{ $project: { a: 0 } }]).sql).toBe('SELECT * FROM "T"');
  });

  it("$addFields: expression, $ref, literal bind", () => {
    const { sql, binds } = agg([{ $addFields: { e: { $sum: "$A" }, r: "$B", lit: "x" } }]);
    expect(sql).toBe('SELECT "T".*, SUM("A") AS "E", "B" AS "R", :addf_0 AS "LIT" FROM "T"');
    expect(binds).toEqual({ addf_0: "x" });
  });

  it("$lookup delegates to the join builder", () => {
    expect(agg([{ $lookup: { from: "C", localField: "CID", foreignField: "ID", as: "c" } }]).sql).toBe(
      'SELECT "T".*, "c".* FROM "T" LEFT OUTER JOIN "C" "c" ON "T"."CID" = "c"."ID"',
    );
  });

  it("DEFECT: $lateralJoin `{ UID: '$outer.ID' }` must reference the OUTER source, not an unqualified column", () => {
    // Unqualified "ID" inside the LATERAL subquery resolves to the inner table, so the correlation is a no-op.
    const { sql } = agg([{ $lateralJoin: { subquery: c.find({ UID: "$outer.ID" }), as: "lj" } }]);
    expect(sql).toContain('"T"."ID"');
  });

  it("$lateralJoin: $outer values bound via $eq are rewritten to outer columns; missing subquery → DUAL", () => {
    const sub = c.find({ UID: { $eq: "$outer.ID" }, S: "x" }).limit(1);
    const { sql, binds } = agg([{ $lateralJoin: { subquery: sub, as: "lj" } }]);
    expect(sql).toContain('"T"."ID"');
    expect(sql).toContain("LATERAL (");
    expect(binds).toEqual({ where_S_1: "x" });
    expect(agg([{ $lateralJoin: { as: "lj" } }]).sql).toContain("LATERAL (SELECT 1 FROM DUAL)");
  });

  it("$out: single stage and multi-stage prepend INSERT INTO", () => {
    expect(agg([{ $match: { A: 1 } }, { $out: "DEST" }]).sql).toBe('INSERT INTO "DEST" SELECT * FROM "T" WHERE "A" = :where_A_0');
    expect(agg([{ $match: { A: 1 } }, { $sort: { A: 1 } }, { $out: "DEST" }]).sql).toMatch(/^INSERT INTO "DEST" WITH /);
  });

  it("$bucket: numeric boundaries with default, string boundaries, custom output", () => {
    const n = agg([{ $bucket: { groupBy: "$AGE", boundaries: [0, 18, 65], default: "Other" } }]);
    expect(n.sql).toContain("CASE WHEN \"AGE\" >= :bkt_0 AND \"AGE\" < :bkt_1 THEN :bkt_2");
    expect(n.sql).toContain("ELSE :bkt_6");
    expect(n.binds.bkt_2).toBe("0");
    const s = agg([{ $bucket: { groupBy: "G", boundaries: ["a", "m", "z"], output: { n: { $count: "*" } } } }]);
    expect(s.binds.bkt_2).toBe("a");
    expect(s.sql).toContain('COUNT(*) AS "N"');
    expect(s.sql).not.toContain("ELSE");
  });

  it("$merge wraps the pipeline in one MERGE statement (update non-key fields, insert new)", () => {
    const { sql, binds } = agg([{ $match: { S: "x" } }, { $group: { _id: "$ID", TOTAL: { $sum: "$A" } } }, { $merge: { into: "DEST", on: { ID: "ID" }, fields: ["ID", "TOTAL"] } }]);
    expect(sql).toBe(
      'MERGE INTO "DEST" tgt USING (WITH "stage_0" AS (SELECT * FROM "T" WHERE "S" = :where_S_0)\nSELECT "ID", SUM("A") AS "TOTAL" FROM "stage_0" GROUP BY "ID") src ON (tgt."ID" = src."ID") WHEN MATCHED THEN UPDATE SET tgt."TOTAL" = src."TOTAL" WHEN NOT MATCHED THEN INSERT ("ID", "TOTAL") VALUES (src."ID", src."TOTAL")',
    );
    expect(binds).toEqual({ where_S_0: "x" });
    expect(agg([{ $merge: { into: "D", on: { ID: "ID" }, fields: ["ID", "X"], whenMatched: "keepExisting" } }]).sql).toBe(
      'MERGE INTO "D" tgt USING (SELECT * FROM "T") src ON (tgt."ID" = src."ID") WHEN NOT MATCHED THEN INSERT ("ID", "X") VALUES (src."ID", src."X")',
    );
    expect(agg([{ $merge: { into: "D", on: { ID: "ID" }, fields: ["ID", "X"], whenNotMatched: "discard" } }]).sql).toBe(
      'MERGE INTO "D" tgt USING (SELECT * FROM "T") src ON (tgt."ID" = src."ID") WHEN MATCHED THEN UPDATE SET tgt."X" = src."X"',
    );
  });

  it("$merge refuses specs it cannot turn into valid SQL", () => {
    const bad = (m: unknown) => () => agg([{ $merge: m }]);
    expect(bad(undefined)).toThrow(/into is required/);
    expect(bad({ on: { ID: "ID" }, fields: ["ID"] })).toThrow(/into is required/);
    expect(bad({ into: "D", fields: ["ID"] })).toThrow(/on must map/);
    expect(bad({ into: "D", on: {}, fields: ["ID"] })).toThrow(/on must map/);
    expect(bad({ into: "D", on: { ID: "ID" } })).toThrow(/fields must list/);
    expect(bad({ into: "D", on: { ID: "ID" }, fields: ["ID"], whenMatched: "replace" })).toThrow(/whenMatched/);
    expect(bad({ into: "D", on: { ID: "ID" }, fields: ["ID"], whenNotMatched: "fail" })).toThrow(/whenNotMatched/);
    expect(bad({ into: "D", on: { ID: "ID" }, fields: ["ID"], whenNotMatched: "discard" })).toThrow(/nothing to do/);
    expect(() => agg([{ $merge: { into: "D", on: { ID: "ID" }, fields: ["ID"] } }, { $limit: 1 }])).toThrow(/last stage/);
  });

  it("$out alone still writes (INSERT … SELECT)", () => {
    expect(agg([{ $out: "DEST" }]).sql).toBe('INSERT INTO "DEST" SELECT * FROM "T"');
  });

  it("$facet produces one UNION ALL branch per facet (names escaped)", () => {
    const { sql } = agg([{ $facet: { "it's": [{ $count: "n" }], b: [{ $limit: 1 }] } }]);
    expect(sql).toContain("SELECT 'it''s' AS \"facet_name\", sub.*");
    expect(sql).toContain("UNION ALL");
  });

  it("DEFECT: $facet keeps the binds of its sub-pipelines", () => {
    const { sql, binds } = agg([{ $facet: { a: [{ $match: { S: "x" } }], b: [{ $match: { S: "y" } }] } }]);
    expect(sql).toContain(":f0_where_S_0");
    expect(sql).toContain(":f1_where_S_0");
    expect(sql).not.toMatch(/:where_S_0/);
    expect(binds).toEqual({ f0_where_S_0: "x", f1_where_S_0: "y" });
  });

  it("DEFECT: an unknown stage is rejected (not silently dropped)", () => {
    // A typo'd stage ($mtach) silently ignored turns a filtered report into a full-table read.
    expect(() => agg([{ $mtach: { S: "x" } }])).toThrow(/Unsupported stage: \$mtach/);
  });

  it("DEFECT: $concat binds literal strings instead of quoting them as identifiers", () => {
    const { sql, binds } = agg([{ $project: { full: { $concat: ["$F", " ", "$L"] } } }]);
    expect(sql).not.toContain('" "');
    expect(sql).toBe('SELECT "F" || :agg_0 || "L" AS "FULL" FROM "T"');
    expect(binds).toEqual({ agg_0: " " });
  });
});

describe("unit: window functions", () => {
  it("every documented function", () => {
    const o = { orderBy: { D: 1 } };
    expect(buildWindowExpr({ fn: "ROW_NUMBER", ...o })).toBe('ROW_NUMBER() OVER (ORDER BY "D" ASC)');
    expect(buildWindowExpr({ fn: "RANK", partitionBy: "R", orderBy: { AMT: -1 } })).toBe('RANK() OVER (PARTITION BY "R" ORDER BY "AMT" DESC)');
    expect(buildWindowExpr({ fn: "dense_rank", partitionBy: ["R", "P"] })).toBe('DENSE_RANK() OVER (PARTITION BY "R", "P")');
    expect(buildWindowExpr({ fn: "NTILE" })).toBe("NTILE(4) OVER ()");
    expect(buildWindowExpr({ fn: "NTILE", n: 3 })).toBe("NTILE(3) OVER ()");
    expect(buildWindowExpr({ fn: "LAG", field: "AMT" })).toBe('LAG("AMT", 1) OVER ()');
    expect(buildWindowExpr({ fn: "LEAD", field: "AMT", offset: 2 })).toBe('LEAD("AMT", 2) OVER ()');
    expect(buildWindowExpr({ fn: "FIRST_VALUE", field: "A" })).toBe('FIRST_VALUE("A") OVER ()');
    expect(buildWindowExpr({ fn: "LAST_VALUE", field: "A" })).toBe('LAST_VALUE("A") OVER ()');
    expect(buildWindowExpr({ fn: "NTH_VALUE", field: "A" })).toBe('NTH_VALUE("A", 1) OVER ()');
    expect(buildWindowExpr({ fn: "SUM", field: "*" })).toBe("SUM(*) OVER ()");
    expect(buildWindowExpr({ fn: "SUM", field: "A", frame: "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW" })).toBe('SUM("A") OVER (ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)');
    expect(buildWindowExpr({ fn: "AVG", field: "A" })).toBe('AVG("A") OVER ()');
    expect(buildWindowExpr({ fn: "AVG", field: "*" })).toBe("AVG(*) OVER ()");
    expect(buildWindowExpr({ fn: "COUNT", field: "*" })).toBe("COUNT(*) OVER ()");
    expect(buildWindowExpr({ fn: "COUNT", field: "A" })).toBe('COUNT("A") OVER ()');
    expect(buildWindowExpr({ fn: "MIN", field: "A" })).toBe('MIN("A") OVER ()');
    expect(buildWindowExpr({ fn: "MAX", field: "A" })).toBe('MAX("A") OVER ()');
    expect(buildWindowExpr({ fn: "CUME_DIST" })).toBe("CUME_DIST() OVER ()");
    expect(buildWindowExpr({ fn: "PERCENT_RANK", field: "A" })).toBe('PERCENT_RANK("A") OVER ()');
  });

  it("SECURITY: rejects a function name outside the documented allow-list", () => {
    expect(() => buildWindowExpr({ fn: "DBMS_LOCK.SLEEP" })).toThrow(/Unsupported window function/);
  });

  it("SECURITY: frame, n and offset are validated, not spliced into SQL", () => {
    expect(() => buildWindowExpr({ fn: "SUM", field: "A", frame: "ROWS UNBOUNDED PRECEDING) FROM DUAL --" })).toThrow(/Invalid frame/);
    expect(() => buildWindowExpr({ fn: "SUM", field: "A", frame: 5 as never })).toThrow(/Invalid frame/);
    expect(() => buildWindowExpr({ fn: "NTILE", n: "4) FROM DUAL --" as never })).toThrow(/n must be a positive integer/);
    expect(() => buildWindowExpr({ fn: "NTILE", n: 0 })).toThrow(/n must be/);
    expect(() => buildWindowExpr({ fn: "LAG", field: "A", offset: 1.5 })).toThrow(/offset must be/);
    // valid frames are normalised, not passed through
    expect(buildWindowExpr({ fn: "SUM", field: "A", orderBy: { D: 1 }, frame: " range  between unbounded preceding and 3 following " })).toBe(
      'SUM("A") OVER (ORDER BY "D" ASC RANGE BETWEEN UNBOUNDED PRECEDING AND 3 FOLLOWING)',
    );
    expect(buildWindowExpr({ fn: "SUM", field: "A", frame: "ROWS CURRENT ROW" })).toBe('SUM("A") OVER (ROWS CURRENT ROW)');
  });
});

describe("unit: joins", () => {
  const j = (x: Record<string, unknown>) => buildJoinSQL("O", { from: "C", localField: "CID", foreignField: "ID", ...x });
  it("all join types and alias defaulting", () => {
    expect(j({ as: "c", joinType: "left" })).toBe('SELECT O.*, "c".* FROM O LEFT OUTER JOIN "C" "c" ON O."CID" = "c"."ID"');
    expect(j({})).toBe('SELECT O.*, "C".* FROM O LEFT OUTER JOIN "C" "C" ON O."CID" = "C"."ID"');
    expect(j({ joinType: "RIGHT" })).toContain("RIGHT OUTER JOIN");
    expect(j({ joinType: "full" })).toContain("FULL OUTER JOIN");
    expect(j({ joinType: "inner" })).toContain("INNER JOIN");
    expect(j({ joinType: "cross", as: "x" })).toBe('SELECT O.*, "x".* FROM O CROSS JOIN "C" "x"');
    expect(j({ joinType: "self" })).toBe('SELECT t1.*, t2.* FROM "C" t1 INNER JOIN "C" t2 ON t1."ID" = t2."CID"');
    expect(j({ joinType: "natural" })).toBe('SELECT * FROM O NATURAL JOIN "C"');
    expect(j({ joinType: null })).toContain("LEFT OUTER JOIN");
  });

  it("multi-condition `on` and `select` (ORA-00918 guard)", () => {
    expect(j({ as: "c", on: [{ localField: "A", foreignField: "B" }, { localField: "C", foreignField: "D" }] })).toBe(
      'SELECT O.*, "c".* FROM O LEFT OUTER JOIN "C" "c" ON O."A" = "c"."B" AND O."C" = "c"."D"',
    );
    expect(j({ as: "c", select: ["EMAIL"] })).toContain('SELECT O.*, "c"."EMAIL" FROM');
  });

  it("DEFECT: an unknown joinType is rejected rather than defaulting to LEFT", () => {
    expect(() => j({ as: "c", joinType: "weird" })).toThrow(/Unknown joinType "weird"/);
  });
});

describe("unit: Oracle advanced", () => {
  it("CONNECT BY: level, path, siblings order, max level, non-PRIOR condition, no start", () => {
    expect(buildConnectBy("E", { startWith: { MGR: null }, connectBy: { MGR: "$PRIOR ID" }, includeLevel: true } as never).sql).toBe(
      'SELECT LEVEL, "E".* FROM "E" START WITH "MGR" IS NULL CONNECT BY NOCYCLE PRIOR "ID" = "MGR"',
    );
    const full = buildConnectBy("E", { startWith: { ID: 1 }, connectBy: { MGR_NAME: "$PRIORNAME" }, includePath: true, orderSiblings: { NAME: 1, ID: -1 }, maxLevel: 3 } as never);
    expect(full.sql).toBe(
      `SELECT SYS_CONNECT_BY_PATH("MGR_NAME", '/') AS "PATH", "E".* FROM "E" START WITH "ID" = :where_ID_0 CONNECT BY NOCYCLE PRIOR "NAME" = "MGR_NAME" AND LEVEL <= 3 ORDER SIBLINGS BY "NAME" ASC, "ID" DESC`,
    );
    expect(full.binds).toEqual({ where_ID_0: 1 });
    expect(buildConnectBy("E", { connectBy: { A: "B" }, includePath: true } as never).sql).toBe(`SELECT SYS_CONNECT_BY_PATH("NAME", '/') AS "PATH", "E".* FROM "E" CONNECT BY NOCYCLE "A" = "B"`);
    expect(buildConnectBy("E", { connectBy: null, includePath: true } as never).sql).toBe(`SELECT SYS_CONNECT_BY_PATH("NAME", '/') AS "PATH", "E".* FROM "E"`);
  });

  it("PIVOT / UNPIVOT (+ INCLUDE NULLS, bare field name)", () => {
    expect(buildPivot("O", { value: { $sum: "$AMT" }, pivotOn: "Q", pivotValues: ["Q1", "Q2"], groupBy: "R" }).sql).toBe(
      `SELECT * FROM (SELECT "R", "Q", "AMT" FROM "O") PIVOT (SUM("AMT") FOR "Q" IN ('Q1' AS "Q1", 'Q2' AS "Q2"))`,
    );
    expect(buildPivot("O", { value: { $max: "AMT" }, pivotOn: "Q", pivotValues: ["it's"], groupBy: "" }).sql).toBe(
      `SELECT * FROM (SELECT "Q", "AMT" FROM "O") PIVOT (MAX("AMT") FOR "Q" IN ('it''s' AS "it's"))`,
    );
    expect(buildUnpivot("Q", { valueColumn: "REV", nameColumn: "QTR", columns: ["Q1", "Q2"] }).sql).toBe('SELECT * FROM "Q" UNPIVOT EXCLUDE NULLS ("REV" FOR "QTR" IN ("Q1", "Q2"))');
    expect(buildUnpivot("Q", { valueColumn: "V", nameColumn: "N", columns: ["A"], includeNulls: true }).sql).toContain("INCLUDE NULLS");
  });

  it("SECURITY: PIVOT aggregate name is validated", () => {
    expect(() => buildPivot("O", { value: { "$COUNT(*)) FROM DUAL --": "$A" }, pivotOn: "Q", pivotValues: ["Q1"], groupBy: "R" })).toThrow(/Unsupported aggregate/);
  });
});

describe("unit: subquery builders", () => {
  it("scalar: every function, default, literal filter ignored, custom alias", () => {
    expect(buildScalarSubquery({ collection: "O", fn: "count", filter: { UID: "$ID", X: 1 } })).toBe('(SELECT COUNT(*) FROM "O" WHERE "UID" = t0."ID")');
    expect(buildScalarSubquery({ collection: "O" })).toBe('(SELECT COUNT(*) FROM "O" )');
    for (const fn of ["sum", "avg", "min", "max"]) expect(buildScalarSubquery({ collection: "O", fn, field: "A" }, "z")).toBe(`(SELECT ${fn.toUpperCase()}("A") FROM "O" )`);
    expect(buildScalarSubquery({ collection: "O", fn: "median" })).toContain("COUNT(*)");
  });

  it("exists / not exists / correlated / IN-select / ANY-ALL", () => {
    expect(buildExistsSubquery({ collection: "O", match: { UID: "$ID", X: 1 } })).toBe('EXISTS (SELECT 1 FROM "O" WHERE "UID" = t0."ID")');
    expect(buildExistsSubquery({ collection: "O", match: {} }, "a")).toBe('EXISTS (SELECT 1 FROM "O" )');
    expect(buildNotExistsSubquery({ collection: "O", match: { UID: "$ID" } }, "a")).toBe('NOT EXISTS (SELECT 1 FROM "O" WHERE "UID" = a."ID")');
    expect(buildCorrelatedSubquery({ collection: "E", field: "SAL", where: { D: "$outer.D", X: 1 } })).toBe('(SELECT AVG("SAL") FROM "E" WHERE "D" = t0."D")');
    expect(buildCorrelatedSubquery({ collection: "E", field: "SAL", aggregate: "$max" }, "q")).toBe('(SELECT MAX("SAL") FROM "E" )');
    expect(buildInSelectSubquery(c.find({}).project({ ID: 1 }))).toBe('IN (SELECT "ID" FROM "T_U" t0)');
    expect(buildAnyAllSubquery({ collection: "O", field: "AMT" })).toBe('ANY (SELECT "AMT" FROM "O")');
    expect(buildAnyAllSubquery({ collection: "O", field: "AMT" }, "ALL")).toBe('ALL (SELECT "AMT" FROM "O")');
  });

  it("SECURITY: correlated-subquery aggregate name is validated", () => {
    expect(() => buildCorrelatedSubquery({ collection: "E", field: "S", aggregate: "$avg(1)) FROM DUAL --" })).toThrow(/Unsupported aggregate/);
    expect(() => parseFilter({ S: { $gt: { $subquery: { collection: "E", field: "S", aggregate: "$MIN(0)-1+0*COUNT" } } } })).toThrow(/Unsupported aggregate/);
  });
});

describe("unit: QueryBuilder SQL (no execution)", () => {
  it("sort/skip/limit/project compile to OFFSET/FETCH", async () => {
    expect(await c.find({ A: { $gt: 1 } }).sort({ A: -1 }).skip(5).limit(10).project({ A: 1 }).explain()).toBe(
      'SELECT "A" FROM "T_U" t0 WHERE "A" > :where_A_0 ORDER BY "A" DESC OFFSET 5 ROWS FETCH FIRST 10 ROWS ONLY',
    );
  });

  it("find() options shortcut sets the same clauses", async () => {
    const sql = await c.find({}, { sort: { A: 1 }, limit: 2, skip: 1, projection: { A: 1 }, forUpdate: true }).explain();
    expect(sql).toContain("ROWID IN (SELECT t0.ROWID");
    expect(sql).toMatch(/FOR UPDATE$/);
  });

  it("forUpdate: every mode, plain (no paging) and paged", async () => {
    expect(await c.find({}).forUpdate(true).explain()).toBe('SELECT * FROM "T_U" t0 FOR UPDATE');
    expect(await c.find({ A: 1 }).forUpdate("nowait").explain()).toMatch(/NOWAIT$/);
    // A SKIP LOCKED queue read with a limit locks rows as it fetches them and stops after `limit` (maxRows).
    const q = c.find({}).sort({ A: 1 }).forUpdate("skip locked").limit(2)._buildSQL();
    expect(q).toEqual({ sql: 'SELECT * FROM "T_U" t0 ORDER BY "A" ASC FOR UPDATE SKIP LOCKED', binds: {}, maxRows: 2 });
    // With skip, or a limit of 0, it keeps the ROWID subquery page.
    expect(await c.find({}).forUpdate("skip locked").skip(1).limit(1).explain()).toBe(
      'SELECT * FROM "T_U" t0 WHERE t0.ROWID IN (SELECT t0.ROWID FROM "T_U" t0 OFFSET 1 ROWS FETCH FIRST 1 ROWS ONLY) FOR UPDATE SKIP LOCKED',
    );
    expect(await c.find({}).forUpdate({ skipLocked: true }).limit(0).explain()).toContain("ROWID IN");
    expect(await c.find({}).forUpdate({ of: ["A", "B"], wait: 5 }).explain()).toMatch(/FOR UPDATE OF t0\."A", t0\."B" WAIT 5$/);
    expect(await c.find({}).forUpdate({ nowait: true }).explain()).toMatch(/FOR UPDATE NOWAIT$/);
    expect(await c.find({}).forUpdate({ skipLocked: true }).explain()).toMatch(/SKIP LOCKED$/);
    expect(await c.find({}).forUpdate({}).explain()).toMatch(/FOR UPDATE$/);
    expect(await c.find({}).forUpdate(true).forUpdate(false).explain()).toBe('SELECT * FROM "T_U" t0');
    const fu = await c.find({ A: 1 }).forUpdate("nowait").limit(2).explain();
    expect(fu).toBe('SELECT * FROM "T_U" t0 WHERE "A" = :where_A_0 AND t0.ROWID IN (SELECT t0.ROWID FROM "T_U" t0 WHERE "A" = :where_A_0 FETCH FIRST 2 ROWS ONLY) FOR UPDATE NOWAIT');
  });

  it("forUpdate: invalid modes throw instead of waiting forever", () => {
    for (const bad of ["sometimes", null, [1], { wait: 1, nowait: true }, { of: [] }, { of: [""] }, { wait: -1 }, { wait: 1.5 }])
      expect(() => c.find({}).forUpdate(bad as never)).toThrow(TypeError);
  });

  it("subquery projection: correlated, literal-bound, every fn, no filter", async () => {
    const qb = c.find({ S: "a" }).project({
      NAME: 1,
      CNT: { $subquery: { collection: "O", fn: "count", filter: { UID: "$ID", ST: "x" } } },
      TOT: { $subquery: { collection: "O", fn: "sum", field: "AMT" } },
      DFL: { $subquery: { collection: "O", fn: "nope" } },
      IGNORED: "x" as never,
    });
    const { sql, binds } = qb._buildSQL();
    expect(sql).toBe(
      'SELECT t0."NAME", (SELECT COUNT(*) FROM "O" WHERE "UID" = t0."ID" AND "ST" = :sub_CNT_ST_1) AS "CNT", (SELECT SUM("AMT") FROM "O") AS "TOT", (SELECT COUNT(*) FROM "O") AS "DFL" FROM "T_U" t0 WHERE "S" = :where_S_0',
    );
    expect(binds).toEqual({ where_S_0: "a", sub_CNT_ST_1: "x" });
    expect(qb._getBinds()).toEqual(binds);
  });

  it("DEFECT: aggregate subquery projection applies its fn to a column (SUM needs an argument)", () => {
    const { sql } = c.find({}).project({ TOT: { $subquery: { collection: "O", fn: "sum", field: "AMT" } } })._buildSQL();
    expect(sql).toContain('SUM("AMT")');
    expect(() => c.find({}).project({ TOT: { $subquery: { collection: "O", fn: "avg" } } })._buildSQL()).toThrow(/needs a field/);
  });

  it("exclusion projection, AS OF SCN / TIMESTAMP, SAMPLE with and without seed", async () => {
    expect(await c.find({}).project({ PW: 0 }).explain()).toBe('SELECT * FROM "T_U" t0');
    expect(await new QueryBuilder("T_U", {}, db, null, { asOf: { scn: "123" } }).explain()).toBe('SELECT * FROM "T_U" AS OF SCN 123 t0');
    const ts = new QueryBuilder("T_U", {}, db, null, { asOf: { timestamp: "2026-01-01 00:00:00" } })._buildSQL();
    expect(ts.sql).toBe("SELECT * FROM \"T_U\" AS OF TIMESTAMP TO_TIMESTAMP(:asof_ts_0, 'YYYY-MM-DD HH24:MI:SS') t0");
    expect(ts.binds).toEqual({ asof_ts_0: "2026-01-01 00:00:00" });
    expect(await new QueryBuilder("T_U", {}, db, null, { asOf: {} }).explain()).toBe('SELECT * FROM "T_U" t0');
    expect(await new QueryBuilder("T_U", {}, db, null, { sample: { percentage: 10 } }).explain()).toBe('SELECT * FROM "T_U" SAMPLE(10) t0');
    expect(await new QueryBuilder("T_U", {}, db, null, { sample: { percentage: 10, seed: 7 } }).explain()).toBe('SELECT * FROM "T_U" SAMPLE(10) SEED(7) t0');
  });

  it("chaining after a terminal throws", async () => {
    const qb = c.find({});
    await qb.explain();
    expect(() => qb.sort({ A: 1 })).toThrow();
    expect(() => qb.limit(1)).toThrow();
    expect(() => qb.skip(1)).toThrow();
    expect(() => qb.project({ A: 1 })).toThrow();
    expect(() => qb.forUpdate(true)).toThrow();
  });

  it("DEFECT: limit/skip reject non-numeric input up front (today: FETCH FIRST NaN reaches Oracle)", () => {
    expect(() => c.find({}).limit("ten" as never)).toThrow(TypeError);
    expect(() => c.find({}).skip("ten" as never)).toThrow(TypeError);
    expect(() => c.find({}).limit(-1)).toThrow(/non-negative integer/);
    expect(() => c.find({}, { skip: 1.5 })).toThrow(TypeError);
    expect(() => new QueryBuilder("T_U", {}, db, null, { limit: -2 })).toThrow(TypeError);
    expect(new QueryBuilder("T_U", {}, db, null, { limit: 0, skip: 0 })._buildSQL().sql).toBe('SELECT * FROM "T_U" t0 OFFSET 0 ROWS FETCH FIRST 0 ROWS ONLY');
  });

  it("DEFECT: OracleCollection rejects an empty table name", () => {
    expect(() => new OracleCollection("", db)).toThrow(/tableName must be a non-empty string, got ""/);
    expect(() => new OracleCollection(undefined as never, db)).toThrow(/got undefined/);
  });
});

describe("unit: CTE / set-operation SQL (no execution)", () => {
  it("withCTE: default source, from, join (every type), sort, skip, limit", () => {
    const defs = { A: c.find({ S: "a" }), B: c.find({}) };
    // Each CTE's binds carry its own prefix (c0_, c1_ …).
    expect(withCTE(db, defs)._buildSQL().sql).toBe('WITH "A" AS (SELECT * FROM "T_U" t0 WHERE "S" = :c0_where_S_0),\n     "B" AS (SELECT * FROM "T_U" t0)\nSELECT * FROM A');
    const full = withCTE(db, defs).from("A").join({ from: "B", localField: "ID", foreignField: "UID" }).sort({ X: -1, Y: 1 }).skip(1).limit(2)._buildSQL().sql;
    expect(full).toContain('SELECT "A".*, "B".* FROM "A" INNER JOIN "B" ON "A"."ID" = "B"."UID" ORDER BY "X" DESC, "Y" ASC OFFSET 1 ROWS FETCH FIRST 2 ROWS ONLY');
    expect(() => withCTE(db, defs).from("A").join({ from: "B", localField: "I", foreignField: "U", joinType: "weird" })._buildSQL()).toThrow(/Unknown joinType "weird"/);
    for (const [t, sql] of [["left", "LEFT OUTER JOIN"], ["right", "RIGHT OUTER JOIN"], ["full", "FULL OUTER JOIN"], ["cross", "CROSS JOIN"], ["inner", "INNER JOIN"], ["", "INNER JOIN"]])
      expect(withCTE(db, defs).from("A").join({ from: "B", localField: "I", foreignField: "U", joinType: t })._buildSQL().sql).toContain(sql);
  });

  it("withRecursiveCTE: with column list, and every anchor-rewrite branch without one", () => {
    const anchor = c.find({ MGR: null });
    const r = withRecursiveCTE(db, "org", { anchor, recursive: { collection: "T_U", joinOn: { MGR: "$org.ID" } } }).sort({ LVL: 1, N: -1 }).skip(1).limit(5);
    const withCols = r._buildSQL(["ID", "MGR"]).sql;
    expect(withCols).toContain('WITH "org" ("ID", "MGR", "LVL") AS (');
    expect(withCols).toContain('SELECT t0."ID", t0."MGR", 1 AS "LVL" FROM "T_U" t0 WHERE "MGR" IS NULL');
    expect(withCols).toContain('SELECT e."ID", e."MGR", o."LVL" + 1 AS "LVL" FROM "T_U" e JOIN "org" o ON e."MGR" = o."ID"');
    expect(withCols).toContain('ORDER BY "LVL" ASC, "N" DESC OFFSET 1 ROWS FETCH FIRST 5 ROWS ONLY');
    expect(r._buildSQL().sql).toContain('SELECT t0.*, 1 AS "LVL" FROM');
    const dotStar = { tableName: "T_U", _buildSQL: () => ({ sql: "SELECT t0.* FROM X t0", binds: {} }) };
    expect(withRecursiveCTE(db, "org", { anchor: dotStar as never, recursive: { collection: "X", joinOn: { M: "$org.ID" } } })._buildSQL().sql).toContain('SELECT t0.*, 1 AS "LVL" FROM X');
    const cols = c.find({}).project({ ID: 1 });
    expect(withRecursiveCTE(db, "org", { anchor: cols, recursive: { collection: "T_U", joinOn: { M: "$org.ID" } } })._buildSQL().sql).toContain('SELECT "ID" , 1 AS "LVL" FROM');
  });

  it("set operations: UNION / UNION ALL / INTERSECT / MINUS, bind remapping, sort/skip/limit", () => {
    const u = OracleCollection.union(c.find({ A: 1 }), c.find({ A: 2 }));
    const { sql, binds } = u._buildSQL();
    expect(sql).toBe('(SELECT * FROM "T_U" t0 WHERE "A" = :where_A_0)\nUNION\n(SELECT * FROM "T_U" t0 WHERE "A" = :set2_where_A_0)');
    expect(binds).toEqual({ where_A_0: 1, set2_where_A_0: 2 });
    expect(OracleCollection.union(c.find({}), c.find({}), { all: true })._buildSQL().sql).toContain("UNION ALL");
    expect(OracleCollection.intersect(c.find({}), c.find({}))._buildSQL().sql).toContain("INTERSECT");
    const m = OracleCollection.minus(c.find({}), c.find({})).sort({ A: -1, B: 1 }).skip(1).limit(2)._buildSQL().sql;
    expect(m).toMatch(/^SELECT \* FROM \(/);
    expect(m).toContain('ORDER BY "A" DESC, "B" ASC OFFSET 1 ROWS FETCH FIRST 2 ROWS ONLY');
  });

  it("set operations refuse mismatched projections", () => {
    expect(() => OracleCollection.union(c.find({}).project({ A: 1 }), c.find({}).project({ A: 1, B: 1 }))).toThrow();
    expect(() => OracleCollection.union(c.find({}).project({ A: 1 }), c.find({}).project({ B: 1 }))).not.toThrow();
  });

  it("SECURITY: set-operation skip/limit are numeric (no SQL splicing)", () => {
    const u = () => OracleCollection.union(c.find({}), c.find({}));
    expect(() => u().limit("1 ROWS ONLY --" as never)).toThrow(TypeError);
    expect(() => u().skip(-1)).toThrow(TypeError);
    expect(u().skip(2).limit(3)._buildSQL().sql).toMatch(/OFFSET 2 ROWS FETCH FIRST 3 ROWS ONLY$/);
  });
});
