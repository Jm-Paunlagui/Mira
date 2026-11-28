/**
 * SECURITY — regression tests for the holes the fuzzer (fuzz.test.ts) and the
 * 3.0.1 red-team pass found. No database: a recording connection captures SQL.
 */
import { describe, it, expect } from "bun:test";
import oracledb from "oracledb";
import { OracleSchema, OracleDCL, parseFilter, parseUpdate, buildAggregateSQL, buildSimpleConnectString, buildTNSConnectString, fromEnv, OracleCollection } from "../../src";
import { sqlFragmentProblem, assertMaxDepth } from "../../src/shared/utils";

const seen: string[] = [];
const conn = { execute: async (s: string) => (seen.push(s), { rows: [], rowsAffected: 0 }), commit: async () => {}, rollback: async () => {} };
const fakeDb = { oracledb, withConnection: async (cb: (c: unknown) => unknown) => cb(conn), withTransaction: async (cb: (c: unknown) => unknown) => cb(conn) } as never;
const nest = (depth: number, leaf: unknown = { A: 1 }) => { let v: unknown = leaf; for (let i = 0; i < depth; i++) v = { $and: [v] }; return v as Record<string, unknown>; };

describe("security: DDL fragments (types, DEFAULT, CHECK)", () => {
  it("national q-quoted literals (Nq'…') are refused like q'…', so they cannot hide a top-level comma", () => {
    expect(sqlFragmentProblem("NUMBER DEFAULT Nq'{'}',EVIL NUMBER,Z NUMBER DEFAULT nq'{'}'")).toMatch(/q-quoted/);
    expect(sqlFragmentProblem("VARCHAR2(9) DEFAULT nQ'[a,b]'")).toMatch(/q-quoted/);
    expect(sqlFragmentProblem("NUMBER CHECK (COLUMNq > 0)")).toBeNull(); // a q inside a name is not a quote
    expect(sqlFragmentProblem("VARCHAR2(9) DEFAULT 'q'")).toBeNull();
  });

  it("sqlFragmentProblem accepts real types and expressions", () => {
    for (const ok of ["NUMBER", "NUMBER(19,4)", "VARCHAR2(100 CHAR)", "TIMESTAMP(6) WITH TIME ZONE", "INTERVAL DAY(2) TO SECOND(6)", "NUMBER GENERATED ALWAYS AS (DEBIT - CREDIT) VIRTUAL", "SYS.ODCIVARCHAR2LIST", "'open'", "SYSTIMESTAMP", "AGE > 0 AND AGE < 150", "STATUS IN ('a', 'b')", `"Weird Col" > 0`, "'it''s'", "NAME <> 'a--b;c/*d'"]) {
      expect([ok, sqlFragmentProblem(ok)]).toEqual([ok, null]);
    }
  });

  it("sqlFragmentProblem refuses anything that leaves the column definition", () => {
    const bad: Array<[unknown, RegExp]> = [
      ["NUMBER) , EVIL NUMBER", /did not open/], ["NUMBER, EVIL NUMBER", /","/], ["NUMBER; DROP TABLE T", /";"/],
      ["NUMBER -- rest", /comment/], ["NUMBER /* x */", /comment/], ["VARCHAR2(10", /not closed/], ["'open", /not closed/],
      [`"open`, /not closed/], ["'a''", /not closed/], ["q'[x]'", /q-quoted/], ["", /empty/], ["   ", /empty/], ["A\u0000B", /NUL/],
      [42, /expected a string, got number/], [null, /got null/], [{ toString: () => "NUMBER" }, /got object/],
    ];
    for (const [v, re] of bad) expect(sqlFragmentProblem(v) ?? "").toMatch(re);
  });

  it("createTable / alterTable refuse a hostile type, DEFAULT or CHECK before any SQL runs", async () => {
    const schema = new OracleSchema(fakeDb);
    seen.length = 0;
    await expect(schema.createTable("T", { A: { type: "NUMBER) PCTFREE 0 --" } })).rejects.toThrow(/createTable.*"A".*is not a column type/s);
    await expect(schema.createTable("T", { A: { type: "NUMBER", default: "0, EVIL NUMBER" } })).rejects.toThrow(/A default.*","/);
    await expect(schema.createTable("T", { A: { type: "NUMBER", default: Infinity } })).rejects.toThrow(/finite/);
    await expect(schema.createTable("T", { A: { type: "NUMBER", check: "A > 0) , CONSTRAINT X CHECK (1=1" } })).rejects.toThrow(/A check.*did not open/);
    await expect(schema.createTable("T", { A: { type: "NUMBER)); EXECUTE IMMEDIATE ('DROP TABLE X')" } }, { ifNotExists: true })).rejects.toThrow(/not a column type/);
    await expect(schema.alterTable("T", { addColumn: { X: "NUMBER, Y NUMBER" } })).rejects.toThrow(/alterTable.*"X"/s);
    await expect(schema.alterTable("T", { modifyColumn: { X: "NUMBER; DROP TABLE T" } })).rejects.toThrow(/alterTable.*"X"/s);
    await expect(schema.alterTable("T", { addConstraint: { type: "CHECK (1=1) --", columns: ["A"] } })).rejects.toThrow(/UNIQUE.*PRIMARY KEY/);
    expect(seen.every((s) => !/EVIL|DROP|PCTFREE|1=1/.test(s))).toBe(true);
  });

  it("valid DDL is unchanged", async () => {
    const schema = new OracleSchema(fakeDb);
    seen.length = 0;
    await schema.createTable("T", { ID: { type: "NUMBER", primaryKey: true }, S: { type: "VARCHAR2(10)", default: "'open'", check: "S IN ('open', 'shut')" }, N: { type: "NUMBER(3)", default: 0 }, B: { type: "NUMBER(19)", default: 10n as never } });
    await schema.alterTable("T", { addColumn: { X: "NUMBER(10,2)" } });
    await schema.alterTable("T", { addConstraint: { type: "primary  key", columns: ["ID"], name: "PK_T" } });
    expect(seen).toEqual([
      `CREATE TABLE "T" ("ID" NUMBER PRIMARY KEY, "S" VARCHAR2(10) DEFAULT 'open' CHECK (S IN ('open', 'shut')), "N" NUMBER(3) DEFAULT 0, "B" NUMBER(19) DEFAULT 10)`,
      `ALTER TABLE "T" ADD ("X" NUMBER(10,2))`,
      `ALTER TABLE "T" ADD CONSTRAINT "PK_T" PRIMARY KEY ("ID")`,
    ]);
  });
});

describe("security: DCL privileges", () => {
  it("grant / revoke accept only Oracle object privileges", async () => {
    const dcl = new OracleDCL(fakeDb as never);
    seen.length = 0;
    await dcl.grant(["select", " Insert ", "ON  COMMIT REFRESH"], "T", "APP_RO");
    await dcl.revoke(["ALL PRIVILEGES"], "T", "APP_RO");
    expect(seen).toEqual([`GRANT SELECT, INSERT, ON COMMIT REFRESH ON "T" TO "APP_RO"`, `REVOKE ALL PRIVILEGES ON "T" FROM "APP_RO"`]);
    for (const bad of [["SELECT ON SECRET TO PUBLIC --"], ["DBA"], ["SELECT", "INSERT, DELETE"], [{ toString: () => "SELECT" }], []]) {
      await expect(dcl.grant(bad as string[], "T", "U")).rejects.toThrow(/is not an object privilege/);
      await expect(dcl.revoke(bad as string[], "T", "U")).rejects.toThrow(/is not an object privilege/);
    }
    expect(seen).toHaveLength(2);
  });
});

describe("security: connect strings", () => {
  it("the builders refuse parts that would rewrite the descriptor", () => {
    for (const [h, p, s] of [["db)(ADDRESS=(HOST=evil)", 1521, "S"], ["db", "1521)(HOST=evil", "S"], ["db", 1521, "S)(SERVER=DEDICATED"], ["db/x?ssl_server_dn_match=false", 1521, "S"], ["db", 0, "S"], ["db", 65536, "S"], ["db", 1.5, "S"], ["", 1521, "S"], [{ toString: () => "db" }, 1521, "S"], ["db", 1521, ""], ["db host", 1521, "S"]] as const) {
      expect(() => buildSimpleConnectString(h, p, s)).toThrow(TypeError);
      expect(() => buildTNSConnectString(h, p, s)).toThrow(TypeError);
    }
  });

  it("errors never echo the value", () => {
    try { buildTNSConnectString("secret)(HOST=evil", 1521, "S"); } catch (e) { expect(String((e as Error).message)).not.toContain("secret"); }
  });

  it("hosts, IPv6 and service names still work", () => {
    expect(buildSimpleConnectString("db-1.example.com", "1521", "pdb1.example.com")).toBe("db-1.example.com:1521/pdb1.example.com");
    expect(buildSimpleConnectString("::1", 1521, "FREEPDB1")).toBe("[::1]:1521/FREEPDB1");
    expect(buildSimpleConnectString("[fe80::1]", 1521, "S")).toBe("[fe80::1]:1521/S");
    expect(buildTNSConnectString("[::1]", 1521, "ORCL")).toContain("(HOST=::1)(PORT=1521)");
    expect(buildTNSConnectString(" 10.0.0.5 ", 1521, "ORCL$1")).toContain("(HOST=10.0.0.5)(PORT=1521)");
  });

  it("fromEnv reports bad HOST / PORT / SERVICE by variable name only", () => {
    const env = { MIRA_DB_USER: "u", MIRA_DB_PASSWORD: "p", MIRA_DB_HOST: "db)(HOST=evil", MIRA_DB_SERVICE: "S" };
    expect(() => fromEnv({ env })).toThrow(/MIRA_DB_HOST, MIRA_DB_PORT or MIRA_DB_SERVICE is not valid/);
    try { fromEnv({ env }); } catch (e) { expect((e as Error).message).not.toContain("evil"); }
    expect(fromEnv({ env: { ...env, MIRA_DB_HOST: "db", MIRA_DB_PORT: "1522" } }).pools.appDb.connectString).toBe("db:1522/S");
  });
});

describe("security: nesting depth (stack exhaustion)", () => {
  it("filters, updates and pipelines deeper than 100 levels are refused quickly", () => {
    const start = performance.now();
    expect(() => parseFilter(nest(100_000))).toThrow(/nested more than 100 levels/);
    // each { $and: [ … ] } is two levels (the object and its list)
    expect(() => parseFilter(nest(50))).toThrow(RangeError);
    expect(parseFilter(nest(49)).whereClause).toContain('"A" = :');
    let e: unknown = "$A"; for (let i = 0; i < 100_000; i++) e = { $add: [e, 1] };
    expect(() => buildAggregateSQL("T", [{ $project: { X: e } }], {})).toThrow(/aggregatePipeline.*nested/);
    let u: unknown = 1; for (let i = 0; i < 200; i++) u = { a: u };
    expect(() => parseUpdate({ $set: { DOC: u } })).toThrow(/updateParser.*nested/);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("a self-referencing filter is refused, not an infinite loop", () => {
    const f: Record<string, unknown> = { A: 1 };
    f.$and = [f];
    expect(() => parseFilter(f)).toThrow(/refers to itself/);
  });

  it("a shallow value that reuses one sub-object at every level is refused, not walked exponentially", () => {
    let shared: Record<string, unknown> = { A: 1 };
    for (let i = 0; i < 40; i++) shared = { x: shared, y: shared }; // 2^40 paths, 41 levels
    const start = performance.now();
    expect(() => assertMaxDepth(shared, "t")).toThrow(/more than 100000 objects/);
    expect(performance.now() - start).toBeLessThan(2000);
    const wide = { $or: Array.from({ length: 5000 }, (_, i) => ({ ID: i })) };
    expect(() => assertMaxDepth(wide, "t")).not.toThrow(); // a big real filter is fine
  });

  it("assertMaxDepth treats class instances, Dates and Buffers as leaves", () => {
    const qb = new OracleCollection("T", fakeDb).find({});
    expect(() => assertMaxDepth({ A: { $in: [qb, new Date(), Buffer.from("x")] } }, "t", 4)).not.toThrow();
    expect(() => assertMaxDepth([[[[1]]]], "t", 3)).toThrow(/nested more than 3/);
    expect(() => assertMaxDepth(null, "t")).not.toThrow();
    expect(() => assertMaxDepth(Object.create(null), "t")).not.toThrow();
  });
});

describe("security: inlined binds (CREATE VIEW / materialized view)", () => {
  it("a value that names another bind cannot pull it in and break out of the quotes", async () => {
    seen.length = 0;
    const q = new OracleCollection("USERS", fakeDb).find({ NAME: ":where_CITY_1", CITY: " || (SELECT PASSWORD FROM SECRETS) || " });
    await new OracleSchema(fakeDb).createView("V", q);
    expect(seen[0]).toBe(`CREATE VIEW "V" AS SELECT * FROM "USERS" t0 WHERE "NAME" = ':where_CITY_1' AND "CITY" = ' || (SELECT PASSWORD FROM SECRETS) || '`);
  });

  it("inlineBinds is one pass: quoted text and unknown names are untouched, prefixes are not confused", async () => {
    const { inlineBinds, renameBinds } = await import("../../src/shared/utils");
    expect(inlineBinds(`SELECT ':a', ":a", :a, :ab, :zz FROM T`, { a: "x:ab", ab: 2 }, "t")).toBe(`SELECT ':a', ":a", 'x:ab', 2, :zz FROM T`);
    expect(inlineBinds(`X = :a`, { a: "it's" }, "t")).toBe(`X = 'it''s'`);
    const r = renameBinds(`A = :a AND B = :p_a AND C = ':a' AND "x:a" = 1`, { a: 1, p_a: 2 }, "p_");
    expect(r).toEqual({ sql: `A = :p_a AND B = :p_p_a AND C = ':a' AND "x:a" = 1`, binds: { p_a: 1, p_p_a: 2 } });
  });

  it("a negative number is parenthesised, so a '-' before its placeholder cannot make a '--' comment", async () => {
    const { inlineBinds } = await import("../../src/shared/utils");
    expect(inlineBinds(`A = 10-:n AND T = :t`, { n: -5, t: 7 }, "t")).toBe(`A = 10-(-5) AND T = 7`);
    expect(inlineBinds(`A = 10-:n`, { n: -0 }, "t")).toBe(`A = 10-(0)`);
    expect(inlineBinds(`A = 10-:n`, { n: -5n }, "t")).toBe(`A = 10-(-5)`);
    expect(inlineBinds(`A = :n`, { n: 5 }, "t")).toBe(`A = 5`);
  });

  it("placeholders inside comments and q-quoted literals are left alone", async () => {
    const { inlineBinds, renameBinds } = await import("../../src/shared/utils");
    const sql = `SELECT q'[:a]', Nq'{it's :a}', q'!:a!' FROM T -- don't touch :a\n WHERE /* it's :a */ X = :a`;
    expect(inlineBinds(sql, { a: "v" }, "t")).toBe(`SELECT q'[:a]', Nq'{it's :a}', q'!:a!' FROM T -- don't touch :a\n WHERE /* it's :a */ X = 'v'`);
    expect(renameBinds(sql, { a: 1 }, "p_").sql).toBe(`SELECT q'[:a]', Nq'{it's :a}', q'!:a!' FROM T -- don't touch :a\n WHERE /* it's :a */ X = :p_a`);
  });
});

describe("security: untrusted filters", () => {
  it("sanitizeFilter passes plain values and refuses operators, objects, lists and odd keys", async () => {
    const { sanitizeFilter } = await import("../../src");
    const d = new Date(0);
    expect(sanitizeFilter({ A: "x", B: 1, C: true, D: null, E: d, F: 2n, "DATA.k": "v" })).toEqual({ A: "x", B: 1, C: true, D: null, E: d, F: 2n, "DATA.k": "v" });
    expect(sanitizeFilter(undefined)).toEqual({});
    expect(sanitizeFilter(null)).toEqual({});
    expect(sanitizeFilter(Object.assign(Object.create(null), { A: 1 }))).toEqual({ A: 1 });
    const bad: Array<[unknown, RegExp]> = [
      [{ $or: [] }, /"\$or": operators/], [{ A: { $ne: 1 } }, /"A": an object/], [{ A: [1, 2] }, /a list/], [{ A: undefined }, /missing value/],
      [{ A: NaN }, /non-finite number/], [{ A: new Date("x") }, /an invalid Date/], [{ A: () => 1 }, /a function/], [JSON.parse('{"__proto__":{"x":1}}'), /"__proto__": this key/],
      [{ constructor: 1 }, /this key/], [{ "": 1 }, /1 to 128/], [{ ["A".repeat(129)]: 1 }, /1 to 128/], ["NAME=x", /plain object/], [[{ A: 1 }], /plain object/], [new Map(), /plain object/],
    ];
    for (const [v, re] of bad) expect(() => sanitizeFilter(v)).toThrow(re);
  });

  it("$inSelect takes a query, a sql`` statement or values, never a string", async () => {
    const { parseFilter, sql } = await import("../../src");
    expect(() => parseFilter({ ID: { $inSelect: "SELECT 1 FROM DUAL" } })).toThrow(/not a string/);
    expect(() => parseFilter({ ID: { $inSelect: { sql: "SELECT 1 FROM DUAL", binds: {} } } })).toThrow(/not an object/);
    expect(() => parseFilter({ ID: { $inSelect: null } })).toThrow(/not a null/);
    const r = parseFilter({ ID: { $inSelect: sql`SELECT ID FROM T WHERE A = ${"x"} AND B = ${2}` }, NAME: "n" });
    expect(r.whereClause).toMatch(/^WHERE "ID" IN \(SELECT ID FROM T WHERE A = :sq_\d+_p0 AND B = :sq_\d+_p1\) AND "NAME" = :where_NAME_\d+$/);
    expect(Object.values(r.binds)).toEqual(["x", 2, "n"]);
  });
});

describe("security: DCL errors", () => {
  it("an Oracle error that is not about privileges is wrapped with the statement", async () => {
    const failing = { oracledb, withConnection: async (cb: (c: unknown) => unknown) => cb({ execute: async () => { throw Object.assign(new Error("ORA-01917: user or role 'NOPE' does not exist"), { errorNum: 1918 }); } }) } as never;
    const dcl = new OracleDCL(failing);
    await expect(dcl.grant(["SELECT"], "T", "NOPE")).rejects.toThrow(/OracleDCL\.grant.*GRANT SELECT ON "T" TO "NOPE"/s);
    await expect(dcl.revoke(["SELECT"], "T", "NOPE")).rejects.toThrow(/OracleDCL\.revoke.*REVOKE SELECT ON "T" FROM "NOPE"/s);
  });
});

describe("security: connect-string validation is linear (no ReDoS)", () => {
  it("long hostile hosts are refused quickly", () => {
    const start = performance.now();
    for (const h of ["0:".repeat(50_000) + "!", "a".repeat(100_000) + "!", "[" + ":".repeat(100_000), "1".repeat(300)]) {
      expect(() => buildSimpleConnectString(h, 1521, "S")).toThrow(TypeError);
    }
    expect(() => buildSimpleConnectString("[::1", 1521, "S")).toThrow(TypeError);
    expect(() => buildSimpleConnectString("::1]", 1521, "S")).toThrow(TypeError);
    expect(() => buildSimpleConnectString("[a.b]", 1521, "S")).toThrow(TypeError);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
