/**
 * SECURITY — injection, data-exposure and abuse tests against the live MIRA
 * schema. Each injection test checks the OUTCOME in the database (rows leaked,
 * tables dropped, data altered), not just the SQL text.
 *
 * "SECURITY:" tests assert the safe behaviour and fail while the hole is open.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OracleCollection, parseFilter } from "../../src";
import * as config from "../../src/driver/oracle";
import registry from "../../src/driver/registry";
import { mira, db, coll, createUsers, dropIfExists, rawExec, recordMetric, USERS } from "../helpers/db";

const U = "MIRA_SC_USERS";
const S = "MIRA_SC_SECRETS";
const users = coll(U);
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "security", metric, value, unit, note });
const intact = async () => {
  expect(await users.countDocuments()).toBe(USERS.length);
  expect(await coll(S).countDocuments()).toBe(1);
};

const PAYLOADS = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "x'; DROP TABLE MIRA_SC_USERS; --",
  "') UNION SELECT USERNAME, PASSWORD FROM DBA_USERS --",
  "%' OR NAME LIKE '%",
  "\\'; DELETE FROM MIRA_SC_USERS; --",
  "＇ OR ＇1＇=＇1", // full-width quotes
  "1; BEGIN EXECUTE IMMEDIATE 'DROP TABLE MIRA_SC_USERS'; END;",
  "' || (SELECT SECRET FROM MIRA_SC_SECRETS) || '",
  "\u0000' OR '1'='1",
];

beforeAll(async () => {
  await dropIfExists(U, S);
  await createUsers(U);
  await rawExec(`CREATE TABLE "${S}" ("SECRET" VARCHAR2(100))`);
  await rawExec(`INSERT INTO "${S}" VALUES ('TOP-SECRET-TOKEN')`);
});
afterAll(() => dropIfExists(U, S));

describe("security: values are always bound, never spliced", () => {
  it("filter values: classic injection payloads match nothing and change nothing", async () => {
    let blocked = 0;
    for (const p of PAYLOADS) {
      expect(await users.find({ NAME: p }).toArray()).toHaveLength(0);
      expect(await users.countDocuments({ $or: [{ NAME: p }, { EMAIL: p }] })).toBe(0);
      expect(await users.find({ NAME: { $in: [p, p] } }).count()).toBe(0);
      expect(await users.find({ NAME: { $like: p } }).count()).toBeLessThanOrEqual(0);
      blocked++;
    }
    m("injection payloads blocked (filter values)", blocked, "count");
    await intact();
  });

  it("$regex payloads are bound (a hostile pattern cannot add SQL)", async () => {
    await users.find({ NAME: { $regex: "') OR 1=1 --" } }).toArray().catch((e: Error) => expect(e.message).toMatch(/ORA-12726|ORA-/));
    expect(await users.countDocuments({ NAME: { $regex: "^J", $options: "i' OR '1'='1" } }).catch(() => 0)).toBe(0);
    await intact();
  });

  it("update / insert values are stored literally", async () => {
    const id = (await users.insertOne({ NAME: PAYLOADS[2], EMAIL: PAYLOADS[0] })).insertedId;
    await users.updateOne({ ID: id }, { $set: { CITY: PAYLOADS[8] } });
    const row = await users.findOne<{ NAME: string; EMAIL: string; CITY: string }>({ ID: id });
    expect(row).toMatchObject({ NAME: PAYLOADS[2], EMAIL: PAYLOADS[0], CITY: PAYLOADS[8] });
    expect(row?.CITY).not.toContain("TOP-SECRET");
    await users.deleteOne({ ID: id });
    await intact();
  });

  it("insertMany / bulkUpdateByKeys / merge bind every value", async () => {
    await users.insertMany(PAYLOADS.map((p, i) => ({ NAME: p, EMAIL: `p${i}@x` })), { returning: [] });
    expect(await users.countDocuments({ NAME: { $in: PAYLOADS } })).toBe(PAYLOADS.length);
    await users.deleteMany({ NAME: { $in: PAYLOADS } });
    await coll(S).merge({ SECRET: "' OR 1=1 --" }, { localField: "SECRET", foreignField: "SECRET" }, { whenNotMatched: "insert" });
    expect(await coll(S).countDocuments()).toBe(2);
    await coll(S).deleteOne({ SECRET: "' OR 1=1 --" });
    await intact();
  });

  it("aggregate literals ($cond / $ifNull / $addFields) are bound", async () => {
    const rows = await users.aggregate([{ $addFields: { tag: "x' || (SELECT SECRET FROM MIRA_SC_SECRETS) || '" } }, { $limit: 1 }]);
    expect(JSON.stringify(rows)).not.toContain("TOP-SECRET");
  });
});

describe("security: identifiers", () => {
  it("table names are quoted: a hostile collection name cannot run extra SQL", async () => {
    const evil = new OracleCollection(`${U}" WHERE 1=1 --`, db);
    await expect(evil.countDocuments()).rejects.toThrow(/ORA-/);
    await expect(new OracleCollection(`${U}"; DROP TABLE "${S}`, db).find({}).toArray()).rejects.toThrow(/ORA-/);
    await intact();
  });

  it("SECURITY: bind-variable names derived from field names are sanitised", () => {
    const { whereClause, binds } = parseFilter({ ['NAME" IS NOT NULL OR "NAME']: "x" });
    for (const k of Object.keys(binds)) expect(k).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(whereClause).not.toMatch(/:[^ ]*"/);
  });

  it("hostile field names never return extra rows (live)", async () => {
    const r = await users.find({ ['NAME" IS NOT NULL OR "NAME']: "x" }).toArray().catch((e: Error) => e);
    if (Array.isArray(r)) expect(r).toHaveLength(0);
    else expect(r.message).toMatch(/ORA-|NJS-/);
    await intact();
  });

  it("__proto__ / constructor keys do not pollute prototypes", async () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 1}}}');
    await users.find(hostile).toArray().catch(() => {});
    await users.updateMany({ NAME: "nobody" }, JSON.parse('{"$set": {"__proto__": {"polluted": 1}}}')).catch(() => {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("savepoint names are validated", async () => {
    const { Transaction } = await import("../../src");
    await expect(new Transaction(db).withTransaction((s) => s.savepoint("A; DROP TABLE X"))).rejects.toThrow(/Invalid savepoint/);
  });

  it("pool names cannot be forged", async () => {
    expect(() => registry.getConnectionConfig("appDb; DROP TABLE X")).toThrow(/Unknown connection/);
    expect(() => mira.db("appDb' OR '1'='1" as "appDb")).toThrow(/Unknown pool/);
    expect(() => registry.registerConnection("x' OR '1'='1", {})).toThrow(/Invalid connection name/);
  });
});

describe("security: raw-SQL splice points (live exploit attempts)", () => {
  it("SECURITY: window `frame` cannot smuggle a subquery that reads another table", async () => {
    const rows = await (async () => users
      .aggregate([
        // frame closes OVER() early and appends a scalar subquery column reading another table
        { $addFields: { W: { $window: { fn: "SUM", field: "AGE", frame: `) AS LEAK0, (SELECT SECRET FROM "${S}"` } } } },
        { $limit: 1 },
      ]))()
      .catch((e: Error) => e);
    const leaked = Array.isArray(rows) && JSON.stringify(rows).includes("TOP-SECRET");
    m("window frame injection leaked secret", leaked ? 1 : 0, "bool");
    expect(leaked).toBe(false);
    expect((rows as Error).message).toMatch(/Invalid frame/); // refused before any SQL is sent
  });

  it("SECURITY: window `fn` cannot be an arbitrary SQL expression", async () => {
    const rows = await (async () => users.aggregate([{ $addFields: { W: { $window: { fn: `NVL((SELECT SECRET FROM "${S}"), 'X') || MAX`, field: "NAME" } } } }, { $limit: 1 }]))().catch((e: Error) => e);
    const leaked = Array.isArray(rows) && JSON.stringify(rows).includes("TOP-SECRET");
    m("window fn injection leaked secret", leaked ? 1 : 0, "bool");
    expect(leaked).toBe(false);
    expect((rows as Error).message).toMatch(/Unsupported window function/);
  });

  it("SECURITY: correlated-subquery `aggregate` cannot rewrite the filter", async () => {
    // Intended: AGE > (SELECT MAX(AGE) …) → 0 rows. Injected: AGE > (SELECT MIN(0)-1+0*COUNT(AGE) …) = -1 → every row.
    const r = await users
      .find({ AGE: { $gt: { $subquery: { collection: U, aggregate: `$MIN(0)-1+0*COUNT`, field: "AGE" } } } })
      .toArray()
      .catch((e: Error) => e);
    const extra = Array.isArray(r) ? r.length : 0;
    m("subquery aggregate injection rows returned", extra, "rows");
    expect(extra).toBe(0);
  });

  it("SECURITY: set-operation limit/skip are numeric", async () => {
    // a non-number must be refused before any SQL is built
    expect(() => OracleCollection.union(users.find({ NAME: "Juan" }), users.find({ NAME: "Ana" })).limit("1 ROWS ONLY --" as never)).toThrow(TypeError);
    expect(await OracleCollection.union(users.find({ NAME: "Juan" }), users.find({ NAME: "Ana" })).limit(1).toArray()).toHaveLength(1);
  });

  it("documented escape hatch: raw $inSelect strings execute verbatim (never pass user input)", async () => {
    const r = await users.find({ ID: { $inSelect: `SELECT "ID" FROM "${U}" WHERE "NAME" = 'Juan'` } }).toArray();
    expect(r).toHaveLength(1);
  });
});

describe("security: data exposure", () => {
  it("error messages describe bind SHAPES, never bind VALUES", async () => {
    const secret = "S3cr3t-Value-Do-Not-Log";
    const err = await users.insertOne({ NAME: secret, EMAIL: null }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/ORA-01400/);
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).toMatch(/<string:\d+>/);
    const err2 = await users.find({ NAME: secret, NOPE: 1 }).toArray().catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain(secret);
  });

  it("credentials never appear in pool stats or connection errors", async () => {
    const pw = String(registry.getConnectionConfig("appDb").password);
    expect(JSON.stringify(await config.getPoolStats())).not.toContain(pw);
    const conns = (await import("../../src/driver/registry")).default.connections as Record<string, Record<string, unknown>>;
    conns.sec_badpw = { ...conns.appDb, password: "Wr0ng-P@ss-Should-Not-Leak", poolMin: 0 };
    const e = await config.withConnection("sec_badpw", async () => 1).catch((x: Error) => x);
    delete conns.sec_badpw;
    expect((e as Error).message).toMatch(/ORA-01017/);
    expect((e as Error).message).not.toContain("Wr0ng-P@ss");
  }, 30000);

  it("least privilege: the MIRA account holds no system-wide ANY / DBA privileges", async () => {
    const privs = ((await rawExec<{ P: string }>("SELECT PRIVILEGE AS P FROM SESSION_PRIVS")).rows ?? []).map((r) => r.P);
    const roles = ((await rawExec<{ R: string }>("SELECT GRANTED_ROLE AS R FROM USER_ROLE_PRIVS")).rows ?? []).map((r) => r.R);
    m("session privileges", privs.length, "count", privs.join(","));
    expect(privs.filter((p) => / ANY |^DBA|ALTER SYSTEM|GRANT ANY/.test(p))).toEqual([]);
    expect(roles).not.toContain("DBA");
  });
});

describe("security: resource abuse", () => {
  it("SECURITY (DoS): $in cost grows linearly with list size", async () => {
    // Each 1,000-bind group is OR-ed into one statement; Oracle's parse cost grows super-linearly,
    // so an attacker-sized list (e.g. 50,000 → ~50 s observed) pins a pool connection.
    const time = async (n: number) => {
      const t0 = performance.now();
      expect(await users.countDocuments({ NAME: { $in: Array.from({ length: n }, (_, i) => `n${i}`) } })).toBe(0);
      return performance.now() - t0;
    };
    const t2k = await time(2000);
    const t20k = await time(20000);
    m("$in 2,000 values", t2k, "ms");
    m("$in 20,000 values", t20k, "ms");
    m("$in growth factor (10x input)", t20k / t2k, "x", "linear ≈ 10x");
    expect(t20k / t2k).toBeLessThan(20);
  }, 120000);

  it("an oversized value is rejected by Oracle (ORA-12899), not truncated silently", async () => {
    await expect(users.insertOne({ NAME: "x".repeat(5000), EMAIL: "big@x" })).rejects.toThrow(/ORA-12899|ORA-01461/);
    await intact();
  });
});
