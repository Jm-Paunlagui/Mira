/**
 * ============================================================================
 * sql.ts — the sql`…` tag: raw SQL whose values are always binds (Mira 2.1)
 * ============================================================================
 *
 *   const rows = await sql`
 *     SELECT ID, TOTAL FROM ORDERS
 *      WHERE STATUS = ${status} AND TOTAL > ${min} AND ID IN (${ids})
 *   `.rows<{ ID: number; TOTAL: string }>(db);
 *
 *   → SELECT ID, TOTAL FROM ORDERS WHERE STATUS = :p0 AND TOTAL > :p1 AND ID IN (:p2, :p3, :p4)
 *
 * Every interpolated value becomes a bind, so a value can never change the
 * statement. Two exceptions, both explicit:
 *   - sql.ident("ORDERS") / sql.ident("t0", "TOTAL") — a quoted identifier
 *     (checked: letters, digits, _ $ #, and no quotes)
 *   - another sql`…` fragment — spliced in, its binds renumbered
 * An array becomes a comma-separated list of binds (for IN); an empty array is
 * refused, since "IN ()" is not SQL. undefined, functions and plain objects are
 * refused: they are almost always a mistake.
 *
 * Run it on the db handle or inside a transaction (session, or a hook's ctx):
 *   .rows(target)     → the rows, as objects
 *   .execute(target)  → { rows, rowsAffected } (DML; autoCommit outside a transaction)
 * ============================================================================
 */

import { OracleCollection } from "./core/OracleCollection";
import type { DbConnection, WrapperDb } from "./db";
import { quoteIdentifier } from "./utils";
import { oracleMongoWrapperMessages as MSG } from "../../constants/messages";

/** What .rows() / .execute() run on: the db handle, a transaction session, or a hook's ctx. */
export type SqlTarget = WrapperDb | { collection(tableName: string): OracleCollection };

/** A quoted identifier spliced into a sql`…` statement. */
class SqlIdentifier {
  readonly text: string;
  constructor(parts: string[]) {
    if (parts.length === 0) throw new Error(MSG.SQL_TAG_INVALID("sql.ident() needs at least one name"));
    for (const p of parts) if (typeof p !== "string" || !/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(p)) throw new Error(MSG.SQL_TAG_INVALID(`sql.ident(): ${JSON.stringify(p)} is not a plain identifier`));
    this.text = parts.map((p) => quoteIdentifier(p)).join(".");
  }
}

/** A statement built by the sql`…` tag: its text and binds, ready to run. */
class SqlStatement {
  readonly sql: string;
  readonly binds: Readonly<Record<string, unknown>>;
  private readonly strings: readonly string[];
  private readonly values: readonly unknown[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    this.strings = strings;
    this.values = values;
    const binds: Record<string, unknown> = {};
    let n = 0;
    this.sql = this.render((v) => {
      const name = `p${n++}`;
      binds[name] = v;
      return `:${name}`;
    });
    this.binds = Object.freeze(binds);
  }

  /** The text with each value spliced in by `bind` (a fragment is rendered from its parts, never re-parsed). */
  private render(bind: (v: unknown) => string): string {
    let text = this.strings[0];
    this.values.forEach((v, i) => {
      text += SqlStatement.splice(v, bind) + this.strings[i + 1];
    });
    return text;
  }

  /** One interpolated value as SQL text: a bind, a list of binds, an identifier or a fragment. */
  private static splice(v: unknown, bind: (v: unknown) => string): string {
    if (v instanceof SqlIdentifier) return v.text;
    if (v instanceof SqlStatement) return v.render(bind); // its binds join this statement's sequence
    if (Array.isArray(v)) {
      if (v.length === 0) throw new Error(MSG.SQL_TAG_INVALID("an empty array has no SQL form (IN () is not valid); check for it before the query"));
      return v.map((x) => SqlStatement.splice(x, bind)).join(", ");
    }
    if (v === undefined) throw new Error(MSG.SQL_TAG_INVALID("a value is undefined; pass null for SQL NULL"));
    if (typeof v === "function" || typeof v === "symbol") throw new Error(MSG.SQL_TAG_INVALID(`a ${typeof v} cannot be bound`));
    if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
      throw new Error(MSG.SQL_TAG_INVALID("a plain object cannot be bound; pass its fields, or JSON.stringify() it for a JSON column"));
    }
    return bind(v);
  }

  /** Run on the target's connection (a session's, or a pooled one); autoCommit outside a transaction. */
  private run<T>(target: SqlTarget): Promise<{ rows: T[]; rowsAffected: number }> {
    const t = target as { collection?: unknown };
    const coll = typeof t.collection === "function" ? (t as { collection(n: string): OracleCollection }).collection("DUAL") : new OracleCollection("DUAL", target as WrapperDb);
    return coll._execute(async (conn: DbConnection) => {
      try {
        const result = await conn.execute<T>(this.sql, { ...this.binds }, { outFormat: coll.db.oracledb.OUT_FORMAT_OBJECT, autoCommit: !coll._conn });
        return { rows: result.rows ?? [], rowsAffected: result.rowsAffected ?? 0 };
      } catch (err) {
        throw new Error(MSG.wrapError("sql", err, this.sql, this.binds as Record<string, unknown>));
      }
    });
  }

  /** The rows of a query, as objects. */
  async rows<T = Record<string, unknown>>(target: SqlTarget): Promise<T[]> {
    return (await this.run<T>(target)).rows;
  }

  /** Any statement: { rows, rowsAffected }. Outside a transaction, DML is committed. */
  execute<T = Record<string, unknown>>(target: SqlTarget): Promise<{ rows: T[]; rowsAffected: number }> {
    return this.run<T>(target);
  }
}

/** Tag a template: sql`SELECT … WHERE ID = ${id}`. Every value is a bind. */
function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlStatement {
  return new SqlStatement(strings, values);
}
/** A quoted identifier: sql.ident("ORDERS"), sql.ident("o", "TOTAL") → "o"."TOTAL". */
sql.ident = (...parts: string[]) => new SqlIdentifier(parts);

export { sql, SqlStatement, SqlIdentifier };
