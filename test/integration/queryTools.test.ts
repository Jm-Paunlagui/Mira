/**
 * INTEGRATION — the smaller 2.1 additions (roadmap item 9), against the live schema:
 *   - after(): keyset pagination in the order of sort()
 *   - for await (const row of find()): streaming on one held connection
 *   - sql`…`: raw SQL whose values are always binds
 *   - onQuery(): an event per statement, chained to an earlier trace handler
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import oracledb from "oracledb";
import { defineTable, t, sql, onQuery, Transaction, type QueryEvent } from "../../src/utils/oracle-mongo-wrapper";
import { db, coll, dropIfExists, rawExec, appDbInUse } from "../helpers/db";

const P = "MIRA_QT_PAGES";
const Pages = defineTable(P, { ID: t.number(10).primaryKey(), SCORE: t.number(5), GRP: t.text(4).nullable(), DOC: t.json<{ n: number }>().nullable() });
const pages = Pages.on(db);
// 25 rows; SCORE repeats (ID % 7) so the sort needs ID to break ties.
const ROWS = Array.from({ length: 25 }, (_, i) => ({ ID: i + 1, SCORE: (i + 1) % 7, GRP: i % 2 ? "odd" : "even", DOC: { n: i + 1 } }));

beforeAll(async () => {
  await dropIfExists(P);
  await Pages.create(db);
  await pages.insertMany(ROWS);
});
afterAll(async () => {
  await dropIfExists(P);
});

describe("after(): keyset pagination", () => {
  const byScoreDescId = [...ROWS].sort((a, b) => b.SCORE - a.SCORE || a.ID - b.ID).map((r) => r.ID);

  it("pages of 4, each after the previous page's last row, give every row once in sort order", async () => {
    const seen: number[] = [];
    let last: { ID: number; SCORE: number } | undefined;
    for (;;) {
      const q = pages.find().sort({ SCORE: -1, ID: 1 }).limit(4);
      const page = await (last ? q.after(last) : q).toArray();
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.ID));
      last = page[page.length - 1];
    }
    expect(seen).toEqual(byScoreDescId);
  });

  it("works with a filter, ascending keys and the { order } sort form; a cursor of just the keys is enough", async () => {
    const rows = await pages.find({ GRP: "odd" }).sort({ SCORE: { order: 1, nulls: "last" }, ID: 1 }).after({ SCORE: 3, ID: 10 }).toArray();
    const want = ROWS.filter((r) => r.GRP === "odd" && (r.SCORE > 3 || (r.SCORE === 3 && r.ID > 10))).sort((a, b) => a.SCORE - b.SCORE || a.ID - b.ID).map((r) => r.ID);
    expect(rows.map((r) => r.ID)).toEqual(want);
    expect(await coll(P).find({}).sort({ ID: 1 }).after({ ID: 23 }).toArray()).toHaveLength(2);
  });

  it("refuses: no sort, a null / missing sort key, a cursor that is not an object", () => {
    expect(() => coll(P).find({}).after({ ID: 1 })._buildSQL()).toThrow("[QueryBuilder.after] MIRA_QT_PAGES: keyset pagination needs a sort(); after() continues from a row in that order.");
    expect(() => coll(P).find({}).sort({ SCORE: 1, ID: 1 }).after({ ID: 1 })._buildSQL()).toThrow("[QueryBuilder.after] SCORE is null or missing in the cursor: keyset pagination needs non-null sort keys.");
    expect(() => coll(P).find({}).sort({ ID: 1 }).after({ ID: null })._buildSQL()).toThrow("ID is null or missing");
    expect(() => coll(P).find({}).after([1] as never)).toThrow("[QueryBuilder.after] the cursor must be an object of sort-key values (or the previous page's last row), got [1].");
    expect(() => coll(P).find({}).after(null as never)).toThrow("got null.");
  });
});

describe("for await: streaming", () => {
  it("yields every row (typed: JSON decoded, exclusion projection applied) and releases the connection", async () => {
    const ids: number[] = [];
    for await (const row of pages.find({ ID: { $lte: 5 } }).sort({ ID: 1 })) {
      expect(row.DOC).toEqual({ n: row.ID });
      ids.push(row.ID);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    for await (const row of coll(P).find({ ID: 1 }).project({ DOC: 0, GRP: 0 })) expect(Object.keys(row).sort()).toEqual(["ID", "SCORE"]);
    expect(await appDbInUse()).toBe(0);
  });

  it("break and throw end the stream and give the connection back", async () => {
    let n = 0;
    for await (const _row of coll(P).find({})) if (++n === 3) break;
    expect(n).toBe(3);
    await expect(
      (async () => {
        for await (const _row of coll(P).find({})) throw new Error("consumer failed");
      })(),
    ).rejects.toThrow("consumer failed");
    expect(await appDbInUse()).toBe(0);
  });

  it("a failing query rejects the loop with Mira's error, and the connection is back", async () => {
    const run = async () => {
      for await (const _row of coll("MIRA_QT_NO_SUCH_TABLE").find({})) void _row;
    };
    await expect(run()).rejects.toThrow(/\[QueryBuilder\[Symbol\.asyncIterator\]\] ORA-00942/);
    expect(await appDbInUse()).toBe(0);
  });

  it("inside a transaction it reads on the session's connection (sees its uncommitted row)", async () => {
    await new Transaction(db).withTransaction(async (session) => {
      await Pages.on(session).insertOne({ ID: 99, SCORE: 1 });
      const ids: number[] = [];
      for await (const row of Pages.on(session).find({ ID: { $gte: 25 } }).sort({ ID: 1 })) ids.push(row.ID);
      expect(ids).toEqual([25, 99]);
      await session.abortTransaction?.();
      throw new Error("roll back");
    }).catch((e: Error) => expect(e.message).toContain("roll back"));
    expect(await pages.countDocuments({ ID: 99 })).toBe(0);
  });

  it("a pool that cannot lend a connection rejects the loop", async () => {
    const broken = { ...db, withConnection: () => Promise.reject(new Error("pool closed")) };
    const q = coll(P).find({});
    q.db = broken as never;
    await expect((async () => {
      for await (const _row of q) void _row;
    })()).rejects.toThrow("pool closed");
  });
});

// Calls the tag the way a template literal does, for values a literal would convert (null, undefined).
const tagged = (strings: string[], ...values: unknown[]) => sql(Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray, ...values);

describe("sql`…`", () => {
  it("every value is a bind: scalars, null, dates, buffers, arrays (IN), identifiers and nested fragments", async () => {
    const ids = [3, 5, 8];
    const when = new Date("2026-01-02T03:04:05Z");
    const filter = sql`${sql.ident("P", "SCORE")} >= ${2}`; // the unquoted alias p is P to Oracle
    const q = sql`SELECT p.ID, ${tagged(["", ""], null)} AS N, ${when} AS W, ${Buffer.from("ab")} AS B, ${"it's"} AS S
                    FROM ${sql.ident(P)} p WHERE p.ID IN (${ids}) AND ${filter} AND p.GRP <> ${"x"} ORDER BY p.ID`;
    expect(q.sql.replace(/\s+/g, " ")).toBe(`SELECT p.ID, :p0 AS N, :p1 AS W, :p2 AS B, :p3 AS S FROM "${P}" p WHERE p.ID IN (:p4, :p5, :p6) AND "P"."SCORE" >= :p7 AND p.GRP <> :p8 ORDER BY p.ID`);
    expect(Object.keys(q.binds)).toHaveLength(9);
    const rows = await q.rows<{ ID: number; N: null; W: Date; B: Buffer; S: string }>(db);
    expect(rows.map((r) => r.ID)).toEqual([3, 5]); // SCORE of 8 is 1
    expect([rows[0].N, rows[0].W.toISOString(), rows[0].B.toString(), rows[0].S]).toEqual([null, when.toISOString(), "ab", "it's"]);
  });

  it("a fragment's text is never re-parsed: ':p0' inside its string literal stays as it is", async () => {
    const frag = sql`':p0' || ${"!"}`;
    const q = sql`SELECT ${"a"} || ${frag} AS V FROM DUAL`;
    expect(q.sql).toBe("SELECT :p0 || ':p0' || :p1 AS V FROM DUAL");
    expect(await q.rows<{ V: string }>(db)).toEqual([{ V: "a:p0!" }]);
  });

  it("execute(): DML commits outside a transaction and rolls back inside one; Oracle errors are wrapped", async () => {
    expect(await sql`UPDATE ${sql.ident(P)} SET GRP = ${"x"} WHERE ID = ${1}`.execute(db)).toEqual({ rows: [], rowsAffected: 1 });
    expect(await pages.findOne({ ID: 1 })).toMatchObject({ GRP: "x" });
    await new Transaction(db)
      .withTransaction(async (session) => {
        await sql`UPDATE ${sql.ident(P)} SET GRP = ${"y"} WHERE ID = ${1}`.execute(session);
        expect(await sql`SELECT GRP FROM ${sql.ident(P)} WHERE ID = ${1}`.rows(session)).toEqual([{ GRP: "y" }]);
        throw new Error("roll back");
      })
      .catch(() => {});
    expect(await pages.findOne({ ID: 1 })).toMatchObject({ GRP: "x" });
    await expect(sql`SELECT * FROM MIRA_QT_NOPE WHERE ID = ${1}`.rows(db)).rejects.toThrow(/\[sql\] ORA-00942/);
  });

  it("refuses values that are almost always mistakes, and odd identifiers", () => {
    expect(() => sql`IN (${[]})`).toThrow("[sql] an empty array has no SQL form (IN () is not valid); check for it before the query.");
    expect(() => tagged(["= ", ""], undefined)).toThrow("[sql] a value is undefined; pass null for SQL NULL.");
    expect(() => sql`= ${() => 1}`).toThrow("[sql] a function cannot be bound.");
    expect(() => sql`= ${Symbol("s")}`).toThrow("[sql] a symbol cannot be bound.");
    expect(() => sql`= ${{ a: 1 }}`).toThrow("[sql] a plain object cannot be bound; pass its fields, or JSON.stringify() it for a JSON column.");
    expect(() => sql.ident()).toThrow("[sql] sql.ident() needs at least one name.");
    expect(() => sql.ident('A"; DROP TABLE X; --')).toThrow('[sql] sql.ident(): "A\\"; DROP TABLE X; --" is not a plain identifier.');
    expect(() => sql.ident(5 as never)).toThrow("[sql] sql.ident(): 5 is not a plain identifier.");
  });
});

describe("onQuery(): query events", () => {
  it("one event per execute / executeMany with SQL, bind count, timing, rows and errors; never bind values", async () => {
    const events: QueryEvent[] = [];
    const stop = onQuery((e) => events.push(e));
    await coll(P).find({ ID: 2, GRP: "odd" }).toArray();
    await coll(P).insertMany([{ ID: 200, SCORE: 1 }, { ID: 201, SCORE: 1 }], { returning: [] });
    await coll(P).deleteMany({ ID: { $in: [200, 201] } });
    await sql`SELECT * FROM MIRA_QT_NOPE`.rows(db).catch(() => {});
    stop();
    await coll(P).find({ ID: 3 }).toArray();
    const mine = events.filter((e) => e.sql.includes(P) || e.sql.includes("MIRA_QT_NOPE"));
    expect(mine.map((e) => [e.operation, e.bindCount, e.batchSize ?? null, e.rowCount ?? null, e.rowsAffected ?? null, e.error ? "error" : null])).toEqual([
      ["execute", 2, null, 1, null, null],
      ["executeMany", 2, 2, null, 2, null],
      ["execute", 2, null, null, 2, null],
      ["execute", 0, null, null, null, "error"],
    ]);
    expect(mine.every((e) => e.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('"odd"'); // the bind value is not in any event
  });

  it("a throwing listener is ignored; several listeners; refuses a non-function", async () => {
    const got: string[] = [];
    const stopA = onQuery(() => {
      throw new Error("listener bug");
    });
    const stopB = onQuery((e) => got.push(e.operation));
    expect(await coll(P).countDocuments({ ID: 4 })).toBe(1);
    stopA();
    await coll(P).countDocuments({ ID: 4 });
    stopB();
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(() => onQuery(5 as never)).toThrow("[onQuery] the listener must be a function.");
  });

  it("chains to a trace handler installed before it (e.g. OpenTelemetry), and puts it back afterwards", async () => {
    const th = (oracledb as unknown as { traceHandler: { TraceHandlerBase: new () => object; setTraceInstance(o: unknown): void; getTraceInstance(): unknown } }).traceHandler;
    const calls: string[] = [];
    class Otel extends th.TraceHandlerBase {
      isEnabled() {
        return true;
      }
      onEnterFn(c: { operation: string }) {
        calls.push(`enter ${c.operation}`);
      }
      onExitFn(c: { operation: string }) {
        calls.push(`exit ${c.operation}`);
      }
      onPoolAcquire() {
        calls.push("acquire");
      }
    }
    const otel = new Otel();
    th.setTraceInstance(otel);
    try {
      const stop = onQuery(() => calls.push("mira"));
      await coll(P).countDocuments({ ID: 5 });
      stop();
      expect(th.getTraceInstance()).toBe(otel);
      expect(calls).toContain("enter oracledb.Connection.execute");
      expect(calls).toContain("exit oracledb.Connection.execute");
      expect(calls).toContain("acquire");
      expect(calls).toContain("mira");
      // A disabled earlier handler is not called.
      (otel as { isEnabled: () => boolean }).isEnabled = () => false;
      calls.length = 0;
      const stop2 = onQuery(() => calls.push("mira"));
      await coll(P).countDocuments({ ID: 5 });
      stop2();
      expect(calls.filter((c) => c !== "mira")).toEqual([]);
      // Someone replaced Mira's handler meanwhile: unsubscribing leaves theirs in place.
      const stop3 = onQuery(() => {});
      const other = new Otel();
      th.setTraceInstance(other);
      stop3();
      expect(th.getTraceInstance()).toBe(other);
    } finally {
      th.setTraceInstance(undefined);
    }
  });
});

void rawExec;
