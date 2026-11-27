/**
 * ============================================================================
 * typed/table.ts — defineTable(): typed tables (Mira 2.1)
 * ============================================================================
 *
 *   export const Orders = defineTable("ORDERS", {
 *     ID: t.id(),
 *     CUSTOMER_ID: t.number(),
 *     TOTAL: t.money(),
 *     NOTE: t.text(400).nullable(),
 *     CREATED_AT: t.timestamp().default("SYSTIMESTAMP"),
 *   });
 *   export type Order = typeof Orders.$row;
 *
 *   const orders = Orders.on(db);          // or Orders.on(session) in a transaction
 *   await orders.find({ TOTAL: { $gt: 100 } }).project({ ID: 1 }).toArray(); // { ID: number }[]
 *
 * A definition needs no database: it can live at module scope, be written by
 * `mira generate types`, and be read by migrations. on() binds it.
 *
 * THE TYPED LAYER IS COMPILE-TIME ONLY, with one opt-in exception. on()
 * returns the ordinary OracleCollection (its QueryBuilders are ordinary too),
 * so every behaviour, check and error is exactly 2.0's; only the TypeScript
 * signatures are narrowed. Anything the typed signatures do not cover is one
 * `.untyped` away. The exception: a table with t.updatedAt() / t.deletedAt() /
 * t.version() columns, hooks or { validate: true } gets a ModelCollection (see model.ts).
 * ============================================================================
 */

import { OracleCollection } from "../core/OracleCollection";
import type { QueryBuilder } from "../core/QueryBuilder";
import { OracleSchema } from "../schema/OracleSchema";
import type { WrapperDb } from "../driver/db";
import type { AnyColumn, ColumnMeta } from "./columns";
import { ModelCollection, type HookContext, type ModelHooks, type ModelSpec } from "./model";
import { quoteIdentifier } from "../shared/utils";
import type { RelationSpec } from "./include";
import type { AnyRelation, Relation } from "./relations";

// ─── Row, insert and write types derived from the columns ───────────────────

type Columns = Record<string, AnyColumn>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** No extra members: the type of an empty object literal. */
type Empty = Record<never, never>;

/** The value a column reads back: its R type, or null when it is nullable. */
type ReadOf<C> = C extends AnyColumn ? (C["$nullable"] extends true ? C["$read"] | null : C["$read"]) : never;
/** The values a column accepts in a write: its W type, plus null when it is nullable. */
type WriteOf<C> = C extends AnyColumn ? (C["$nullable"] extends true ? C["$write"] | null : C["$write"]) : never;

type GeneratedKeys<C extends Columns> = { [K in keyof C]: C[K]["$generated"] extends true ? K : never }[keyof C];
type OptionalKeys<C extends Columns> = { [K in keyof C]: C[K]["$generated"] extends true ? never : C[K]["$nullable"] extends true ? K : C[K]["$hasDefault"] extends true ? K : never }[keyof C];
type RequiredKeys<C extends Columns> = Exclude<keyof C, GeneratedKeys<C> | OptionalKeys<C>>;

/** One row as Mira returns it. */
export type RowOf<C extends Columns> = Simplify<{ [K in keyof C]: ReadOf<C[K]> }>;
/** A document insertOne() accepts: identity columns left out, nullable / defaulted ones optional. */
export type InsertOf<C extends Columns> = Simplify<{ [K in RequiredKeys<C>]: WriteOf<C[K]> } & { [K in OptionalKeys<C>]?: WriteOf<C[K]> }>;
/** The values a write (or a filter) may give each column. */
export type WriteRowOf<C extends Columns> = { [K in keyof C]: WriteOf<C[K]> };

// ─── Filters, updates, sorts and projections ────────────────────────────────

type Scalar<V> = Exclude<V, null>;
type NumericKeys<W> = { [K in keyof W]: Scalar<W[K]> extends number ? K : number extends Scalar<W[K]> ? K : never }[keyof W];
type DateKeys<R> = { [K in keyof R]: Scalar<R[K]> extends Date ? K : never }[keyof R];
type StringKeys<R> = { [K in keyof R]: Scalar<R[K]> extends string ? K : never }[keyof R];

/** Operators on one column. Values are the column's write type (money takes string or number). */
export type FieldOperators<V, IsString extends boolean> = {
  $eq?: V | null;
  $ne?: V | null;
  $gt?: Scalar<V>;
  $gte?: Scalar<V>;
  $lt?: Scalar<V>;
  $lte?: Scalar<V>;
  $in?: ReadonlyArray<V | null>;
  $nin?: ReadonlyArray<V | null>;
  $between?: readonly [Scalar<V>, Scalar<V>];
  $notBetween?: readonly [Scalar<V>, Scalar<V>];
  $exists?: boolean;
  $not?: FieldOperators<V, IsString>;
  // Comparisons with a subquery list (see the README): the list's values are checked.
  $gtAny?: ReadonlyArray<Scalar<V>>; $gteAny?: ReadonlyArray<Scalar<V>>; $ltAny?: ReadonlyArray<Scalar<V>>; $lteAny?: ReadonlyArray<Scalar<V>>;
  $gtAll?: ReadonlyArray<Scalar<V>>; $gteAll?: ReadonlyArray<Scalar<V>>; $ltAll?: ReadonlyArray<Scalar<V>>; $lteAll?: ReadonlyArray<Scalar<V>>;
  // Subquery forms build their own SQL; their arguments are not typed here.
  $inSelect?: unknown;
  $subquery?: unknown;
} & (IsString extends true ? { $like?: string; $regex?: string; $options?: string } : Empty)
  // A JSON column holding an array: an element matching every condition (JSON_EXISTS).
  & (Scalar<V> extends object ? (Scalar<V> extends Date | Buffer ? Empty : { $elemMatch?: Record<string, unknown> }) : Empty);

/** "COL.a.b": a path into a JSON column. Known column first; the rest of the path is not checked. */
export type JsonPath<W> = `${string & keyof W}.${string}`;

/** A filter on a typed table: known columns only, each with its own value type. */
export type Filter<W> = {
  [K in keyof W]?: W[K] | null | FieldOperators<W[K], Scalar<W[K]> extends string ? true : false>;
} & {
  $and?: ReadonlyArray<Filter<W>>;
  $or?: ReadonlyArray<Filter<W>>;
  $nor?: ReadonlyArray<Filter<W>>;
  $not?: Filter<W>;
  // EXISTS / NOT EXISTS subqueries take another table's spec: not typed here.
  $exists?: unknown;
  $notExists?: unknown;
} & {
  // Paths into JSON columns ("DOC.address.city"): values and operators as for a column.
  [P in JsonPath<W>]?: unknown;
};

/** Update operators on a typed table. */
export type Update<W, R> = {
  $set?: Partial<W> & { [P in JsonPath<W>]?: unknown };
  $unset?: { [K in keyof W]?: 1 | true | "" } & { [P in JsonPath<W>]?: 1 | true | "" };
  $inc?: { [K in NumericKeys<W>]?: number };
  $mul?: { [K in NumericKeys<W>]?: number };
  $min?: Partial<W>;
  $max?: Partial<W>;
  $currentDate?: { [K in DateKeys<R>]?: true | { $type: "date" | "timestamp" } };
  $rename?: { [K in keyof W]?: string };
  /** Append to an array in a JSON column: a value, or { $each: [...] }. */
  $push?: { [P in JsonPath<W>]?: unknown };
  /** Remove values from an array in a JSON column: a value, or { $in: [...] }. */
  $pull?: { [P in JsonPath<W>]?: unknown };
};

export type SortDirection = 1 | -1 | { order?: 1 | -1; nulls?: "first" | "last" };
export type Sort<R> = { [K in keyof R]?: SortDirection };

/** { COL: 1 } keeps COL; { COL: 0 } drops it (do not mix the two, as in MongoDB). */
export type Projection<R> = { [K in keyof R]?: 0 | 1 | boolean };
type IncludedKeys<P> = { [K in keyof P]: P[K] extends 1 | true ? K : never }[keyof P];
/** The row type left after a projection. */
export type Projected<R, P> = [IncludedKeys<P>] extends [never] ? Simplify<Omit<R, keyof P>> : Simplify<Pick<R, IncludedKeys<P> & keyof R>>;

// ─── Typed query and collection signatures ──────────────────────────────────

type LimitOptions = Parameters<QueryBuilder["limit"]>[1];
type ForUpdateMode = Parameters<QueryBuilder["forUpdate"]>[0];

/** include() options for one relation: a filter and order on the related table; limit for hasMany. */
export type IncludeOptionsOf<Rel> = Rel extends Relation<infer Kind, infer TC>
  ? { where?: Filter<WriteRowOf<TC>>; sort?: Sort<RowOf<TC>> } & (Kind extends "hasMany" ? { limit?: number } : Empty)
  : never;

/**
 * A find() chain on a typed table. B is the row (narrowed by project()), Rel the
 * table's relations, Inc what include() has added so far. Rows are B & Inc.
 */
export interface TypedQuery<B, Rel = Empty, Inc = Empty> extends PromiseLike<Array<Simplify<B & Inc>>> {
  sort(spec: Sort<B>): TypedQuery<B, Rel, Inc>;
  limit(n: number, options?: LimitOptions): TypedQuery<B, Rel, Inc>;
  skip(n: number): TypedQuery<B, Rel, Inc>;
  project<P extends Projection<B>>(spec: P): TypedQuery<Projected<B, P>, Rel, Inc>;
  /** Fetch a declared relation in the same statement (see relations()). */
  include<K extends keyof Rel & string>(name: K, options?: IncludeOptionsOf<Rel[K]>): TypedQuery<B, Rel, Inc & { [P in K]: Rel[K] extends { $out: infer O } ? O : never }>;
  forUpdate(mode: ForUpdateMode): TypedQuery<B, Rel, Inc>;
  /** Keyset pagination: continue after this row (the previous page's last row, or its sort keys). */
  after(cursor: Partial<B>): TypedQuery<B, Rel, Inc>;
  /** `for await (const row of query)`: rows streamed one at a time on one connection. */
  [Symbol.asyncIterator](): AsyncIterator<Simplify<B & Inc>>;
  toArray(): Promise<Array<Simplify<B & Inc>>>;
  next(): Promise<Simplify<B & Inc> | null>;
  hasNext(): Promise<boolean>;
  count(): Promise<number>;
  forEach(fn: (row: Simplify<B & Inc>) => unknown): Promise<void>;
  explain(): Promise<string>;
  /** The same QueryBuilder with 2.0's untyped signatures. */
  readonly untyped: QueryBuilder;
}

type Out<M extends keyof OracleCollection> = OracleCollection[M] extends (...a: never[]) => infer T ? T : never;
type Arg<M extends keyof OracleCollection, I extends number> = OracleCollection[M] extends (...a: infer A) => unknown ? A[I] : never;

/** A collection on a typed table. Same object and behaviour as OracleCollection; typed signatures. */
export interface TypedCollection<R, I, W, Rel = Empty> {
  readonly tableName: string;
  find(filter?: Filter<W>, options?: Arg<"find", 1>): TypedQuery<R, Rel>;
  findOne(filter: Filter<W>): Promise<R | null>;
  countDocuments(filter?: Filter<W>): Promise<number>;
  distinct<K extends keyof R & string>(field: K, filter?: Filter<W>): Promise<Array<R[K]>>;
  insertOne(document: I, options?: Arg<"insertOne", 1>): Out<"insertOne">;
  insertMany(documents: readonly I[], options?: Arg<"insertMany", 1>): Out<"insertMany">;
  updateOne(filter: Filter<W>, update: Update<W, R>, options?: Arg<"updateOne", 2>): Out<"updateOne">;
  updateMany(filter: Filter<W>, update: Update<W, R>, options?: Arg<"updateMany", 2>): Out<"updateMany">;
  replaceOne(filter: Filter<W>, replacement: I): Out<"replaceOne">;
  /** On a soft-deleting table (t.deletedAt()) this marks the row; { force: true } deletes it for real. */
  deleteOne(filter: Filter<W>, options?: Arg<"deleteOne", 1> & { force?: boolean }): Out<"deleteOne">;
  /** On a soft-deleting table (t.deletedAt()) this marks the rows; { force: true } deletes them for real. */
  deleteMany(filter: Filter<W>, options?: Arg<"deleteMany", 1> & { force?: boolean }): Out<"deleteMany">;
  /** Pipeline output has its own shape: name it, or get untyped rows. */
  aggregate<T = Record<string, unknown>>(pipeline: unknown[]): Promise<T[]>;
  /** The same collection with 2.0's untyped signatures, for everything else. */
  readonly untyped: OracleCollection;
}

/** Extra methods on a soft-deleting table's collection (one with a t.deletedAt() column). */
export interface SoftDeleteMethods<R, I, W, Rel> {
  /** The same collection, with soft-deleted rows visible to reads, updates and deletes. */
  withDeleted(): TypedCollection<R, I, W, Rel> & SoftDeleteMethods<R, I, W, Rel>;
  /** Clear the deleted mark of the soft-deleted rows matching the filter. */
  restore(filter?: Filter<W>): Out<"updateMany">;
}

/** True when a table has a t.deletedAt() column. */
type HasSoftDelete<C extends Columns> = { [K in keyof C]: C[K] extends { $softDelete: true } ? K : never }[keyof C] extends never ? false : true;

/** The collection on() returns for a table. */
export type CollectionOf<C extends Columns, Rel> = TypedCollection<RowOf<C>, InsertOf<C>, WriteRowOf<C>, Rel> &
  (HasSoftDelete<C> extends true ? SoftDeleteMethods<RowOf<C>, InsertOf<C>, WriteRowOf<C>, Rel> : Empty);

/**
 * Hooks run around writes through the table's collection. A before-hook may return a new
 * document / update (or nothing, to keep it) and may throw to stop the write; it runs
 * before validation. `ctx.collection` is the collection on the same connection, so a hook
 * inside a transaction is part of it.
 */
export interface TableHooks<C extends Columns> {
  beforeInsert?(doc: InsertOf<C>, ctx: HookContext): InsertOf<C> | void | Promise<InsertOf<C> | void>;
  afterInsert?(doc: InsertOf<C>, insertedId: unknown, ctx: HookContext): void | Promise<void>;
  beforeUpdate?(update: Update<WriteRowOf<C>, RowOf<C>>, filter: Filter<WriteRowOf<C>>, ctx: HookContext): Update<WriteRowOf<C>, RowOf<C>> | void | Promise<Update<WriteRowOf<C>, RowOf<C>> | void>;
  afterUpdate?(result: { matchedCount: number; modifiedCount: number }, filter: Filter<WriteRowOf<C>>, update: Update<WriteRowOf<C>, RowOf<C>>, ctx: HookContext): void | Promise<void>;
  beforeDelete?(filter: Filter<WriteRowOf<C>>, ctx: HookContext): void | Promise<void>;
  afterDelete?(result: { deletedCount: number; soft: boolean }, filter: Filter<WriteRowOf<C>>, ctx: HookContext): void | Promise<void>;
}

/** defineTable()'s third argument. */
export interface TableOptions<C extends Columns> {
  /** Check every insert and update against the column definitions before any SQL (MiraValidationError). */
  validate?: boolean;
  hooks?: TableHooks<C>;
}

/** What on() accepts: the db handle from createDb(), or a transaction session. */
export type TableTarget = WrapperDb | { collection(tableName: string): OracleCollection };

// ─── defineTable ────────────────────────────────────────────────────────────

/** Column specs for OracleSchema.createTable(). */
type ColumnSpec = Parameters<OracleSchema["createTable"]>[1][string];

/** A table definition. Build one with defineTable(); bind it to a db or session with on(). */
export class TypedTable<C extends Columns, Rel extends Record<string, AnyRelation> = Empty> {
  /** Type-only: one row as Mira returns it (`typeof Orders.$row`). */
  declare readonly $row: RowOf<C>;
  /** Type-only: the document insertOne() accepts. */
  declare readonly $insert: InsertOf<C>;
  readonly name: string;
  /** The column builders (frozen). */
  readonly columns: C;
  /** Relations attached with relations(): what include() can fetch. */
  readonly relations: Readonly<Record<string, RelationSpec>>;
  /** validate and hooks, as given to defineTable(). */
  readonly options: Readonly<TableOptions<C>>;
  /** The model settings on() hands to the collection, or undefined for a plain typed table. */
  private readonly model?: ModelSpec;

  constructor(name: string, columns: C, relationSpecs: Record<string, RelationSpec> = {}, options: TableOptions<C> = {}) {
    if (typeof name !== "string" || name.trim() === "") throw new TypeError("[defineTable] the table name must be a non-empty string.");
    const entries = Object.entries(columns ?? {});
    if (entries.length === 0) throw new TypeError(`[defineTable] ${name}: define at least one column.`);
    for (const [k, c] of entries) {
      if (!c || typeof c !== "object" || !("meta" in c)) throw new TypeError(`[defineTable] ${name}.${k}: use a column builder (t.number(), t.text(n), …).`);
    }
    const identities = entries.filter(([, c]) => c.meta.identity || /\bAS IDENTITY\b/i.test(c.meta.type)).map(([k]) => k);
    if (identities.length > 1) throw new TypeError(`[defineTable] ${name}: Oracle allows one identity column per table (ORA-30669), got ${identities.join(", ")}.`);
    this.name = name;
    this.columns = Object.freeze({ ...columns });
    this.relations = Object.freeze({ ...relationSpecs });
    this.options = Object.freeze({ ...options });
    const roles = (role: NonNullable<ColumnMeta["role"]>) => entries.filter(([, c]) => c.meta.role === role).map(([k]) => k);
    for (const role of ["createdAt", "updatedAt", "deletedAt", "version"] as const) {
      if (roles(role).length > 1) throw new TypeError(`[defineTable] ${name}: one t.${role}() column per table, got ${roles(role).join(", ")}.`);
    }
    const hooks = (options.hooks ?? {}) as ModelHooks;
    for (const [k, v] of Object.entries(hooks)) {
      if (!["beforeInsert", "afterInsert", "beforeUpdate", "afterUpdate", "beforeDelete", "afterDelete"].includes(k)) throw new TypeError(`[defineTable] ${name}: unknown hook ${k}.`);
      if (typeof v !== "function") throw new TypeError(`[defineTable] ${name}: hook ${k} must be a function.`);
    }
    const [updatedAt] = roles("updatedAt");
    const [deletedAt] = roles("deletedAt");
    const [version] = roles("version");
    if (options.validate || Object.keys(hooks).length > 0 || updatedAt || deletedAt || version) {
      this.model = Object.freeze({
        columns: this.columns,
        primaryKey: Object.freeze(entries.filter(([, c]) => c.meta.primaryKey).map(([k]) => k)),
        updatedAt,
        deletedAt,
        version,
        validate: options.validate === true,
        hooks: Object.freeze({ ...hooks }),
      });
    }
  }

  /** The table as a typed collection on a db handle, or inside a transaction session. */
  on(target: TableTarget): CollectionOf<C, Rel> {
    const t = target as { collection?: unknown };
    let coll = typeof t.collection === "function" ? (t as { collection(n: string): OracleCollection }).collection(this.name) : new OracleCollection(this.name, target as WrapperDb);
    // Timestamps, soft delete, hooks or validation: the model subclass, on the same connection.
    if (this.model) coll = new ModelCollection(this.name, coll.db, coll._conn, this.model);
    // The collection hands the relations to every find(), where include() reads them.
    if (Object.keys(this.relations).length > 0) coll._relations = this.relations;
    // JSON columns: values written as JSON text, JSON text read back as JS values.
    const json = Object.entries(this.columns).filter(([, c]) => c.meta.json);
    if (json.length > 0) {
      const client = coll.db.oracledb.oracleClientVersion;
      const native = json.filter(([, c]) => c.meta.json === "native").map(([k]) => k);
      // A 19c Oracle Client cannot read the 23ai JSON type (ORA-40569) and a write can break the
      // session (ORA-03106): refuse it up front. Thin mode and 21c+ clients handle it.
      if (native.length > 0 && client && client < 2100000000) throw new Error(`[defineTable] ${this.name}: ${native.join(", ")} use the native JSON type, which needs Thin mode or Oracle Client 21c+ (this is ${coll.db.oracledb.oracleClientVersionString}). Use t.json() without { native: true } for JSON text.`);
      coll._json = { encode: json.map(([k]) => k), decode: json.filter(([, c]) => c.meta.json === "text").map(([k]) => k) };
    }
    return coll as unknown as CollectionOf<C, Rel>;
  }

  /** The column specs createTable() takes (also what migrations compare). */
  ddl(): Record<string, ColumnSpec> {
    const out: Record<string, ColumnSpec> = {};
    for (const [k, c] of Object.entries(this.columns)) out[k] = toColumnSpec(k, c.meta);
    return out;
  }

  /** CREATE TABLE from this definition. */
  async create(db: WrapperDb, options: { ifNotExists?: boolean } = {}): Promise<{ acknowledged: boolean }> {
    return new OracleSchema(db).createTable(this.name, this.ddl(), options);
  }
}

function toColumnSpec(name: string, m: Readonly<ColumnMeta>): ColumnSpec {
  const spec: ColumnSpec = { type: m.type };
  if (m.identity) spec.autoIncrement = true;
  if (m.primaryKey) spec.primaryKey = true;
  else if (!m.nullable) spec.notNull = true;
  if (m.default !== undefined) spec.default = m.default;
  // JSON text: an IS JSON check, so Oracle refuses anything that is not a JSON document.
  const isJson = m.json === "text" ? `${quoteIdentifier(name)} IS JSON` : undefined;
  if (isJson && m.check !== undefined) spec.check = `(${isJson}) AND (${m.check})`;
  else if (isJson ?? m.check) spec.check = isJson ?? m.check;
  if (m.references) spec.references = { ...m.references };
  return spec;
}

/**
 * Define a typed table. Needs no database; bind it with `.on(db)`.
 * `options`: { validate: true } checks writes against the columns; `hooks` run around writes.
 */
function defineTable<C extends Columns>(name: string, columns: C, options: TableOptions<C> = {}): TypedTable<C> {
  return new TypedTable(name, columns, {}, options);
}

export { defineTable };
