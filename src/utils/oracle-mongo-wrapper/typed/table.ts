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
 * THE TYPED LAYER IS COMPILE-TIME ONLY. on() returns the ordinary
 * OracleCollection (its QueryBuilders are ordinary too), so every behaviour,
 * check and error is exactly 2.0's; only the TypeScript signatures are
 * narrowed. Anything the typed signatures do not cover is one `.untyped` away.
 * ============================================================================
 */

import { OracleCollection } from "../core/OracleCollection";
import type { QueryBuilder } from "../core/QueryBuilder";
import { OracleSchema } from "../schema/OracleSchema";
import type { WrapperDb } from "../db";
import type { AnyColumn, ColumnMeta } from "./columns";
import type { RelationSpec } from "./include";
import type { AnyRelation, Relation } from "./relations";

// ─── Row, insert and write types derived from the columns ───────────────────

type Columns = Record<string, AnyColumn>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

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
} & (IsString extends true ? { $like?: string; $regex?: string; $options?: string } : {});

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
};

/** Update operators on a typed table. */
export type Update<W, R> = {
  $set?: Partial<W>;
  $unset?: { [K in keyof W]?: 1 | true | "" };
  $inc?: { [K in NumericKeys<W>]?: number };
  $mul?: { [K in NumericKeys<W>]?: number };
  $min?: Partial<W>;
  $max?: Partial<W>;
  $currentDate?: { [K in DateKeys<R>]?: true | { $type: "date" | "timestamp" } };
  $rename?: { [K in keyof W]?: string };
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
  ? { where?: Filter<WriteRowOf<TC>>; sort?: Sort<RowOf<TC>> } & (Kind extends "hasMany" ? { limit?: number } : {})
  : never;

/**
 * A find() chain on a typed table. B is the row (narrowed by project()), Rel the
 * table's relations, Inc what include() has added so far. Rows are B & Inc.
 */
export interface TypedQuery<B, Rel = {}, Inc = {}> extends PromiseLike<Array<Simplify<B & Inc>>> {
  sort(spec: Sort<B>): TypedQuery<B, Rel, Inc>;
  limit(n: number, options?: LimitOptions): TypedQuery<B, Rel, Inc>;
  skip(n: number): TypedQuery<B, Rel, Inc>;
  project<P extends Projection<B>>(spec: P): TypedQuery<Projected<B, P>, Rel, Inc>;
  /** Fetch a declared relation in the same statement (see relations()). */
  include<K extends keyof Rel & string>(name: K, options?: IncludeOptionsOf<Rel[K]>): TypedQuery<B, Rel, Inc & { [P in K]: Rel[K] extends { $out: infer O } ? O : never }>;
  forUpdate(mode: ForUpdateMode): TypedQuery<B, Rel, Inc>;
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
export interface TypedCollection<R, I, W, Rel = {}> {
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
  deleteOne(filter: Filter<W>, options?: Arg<"deleteOne", 1>): Out<"deleteOne">;
  deleteMany(filter: Filter<W>, options?: Arg<"deleteMany", 1>): Out<"deleteMany">;
  /** Pipeline output has its own shape: name it, or get untyped rows. */
  aggregate<T = Record<string, unknown>>(pipeline: unknown[]): Promise<T[]>;
  /** The same collection with 2.0's untyped signatures, for everything else. */
  readonly untyped: OracleCollection;
}

/** What on() accepts: the db handle from createDb(), or a transaction session. */
export type TableTarget = WrapperDb | { collection(tableName: string): OracleCollection };

// ─── defineTable ────────────────────────────────────────────────────────────

/** Column specs for OracleSchema.createTable(). */
type ColumnSpec = Parameters<OracleSchema["createTable"]>[1][string];

/** A table definition. Build one with defineTable(); bind it to a db or session with on(). */
export class TypedTable<C extends Columns, Rel extends Record<string, AnyRelation> = {}> {
  /** Type-only: one row as Mira returns it (`typeof Orders.$row`). */
  declare readonly $row: RowOf<C>;
  /** Type-only: the document insertOne() accepts. */
  declare readonly $insert: InsertOf<C>;
  readonly name: string;
  /** The column builders (frozen). */
  readonly columns: C;
  /** Relations attached with relations(): what include() can fetch. */
  readonly relations: Readonly<Record<string, RelationSpec>>;

  constructor(name: string, columns: C, relationSpecs: Record<string, RelationSpec> = {}) {
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
  }

  /** The table as a typed collection on a db handle, or inside a transaction session. */
  on(target: TableTarget): TypedCollection<RowOf<C>, InsertOf<C>, WriteRowOf<C>, Rel> {
    const t = target as { collection?: unknown };
    const coll = typeof t.collection === "function" ? (t as { collection(n: string): OracleCollection }).collection(this.name) : new OracleCollection(this.name, target as WrapperDb);
    // The collection hands the relations to every find(), where include() reads them.
    if (Object.keys(this.relations).length > 0) coll._relations = this.relations;
    return coll as unknown as TypedCollection<RowOf<C>, InsertOf<C>, WriteRowOf<C>, Rel>;
  }

  /** The column specs createTable() takes (also what migrations compare). */
  ddl(): Record<string, ColumnSpec> {
    const out: Record<string, ColumnSpec> = {};
    for (const [k, c] of Object.entries(this.columns)) out[k] = toColumnSpec(c.meta);
    return out;
  }

  /** CREATE TABLE from this definition. */
  async create(db: WrapperDb, options: { ifNotExists?: boolean } = {}): Promise<{ acknowledged: boolean }> {
    return new OracleSchema(db).createTable(this.name, this.ddl(), options);
  }
}

function toColumnSpec(m: Readonly<ColumnMeta>): ColumnSpec {
  const spec: ColumnSpec = { type: m.type };
  if (m.identity) spec.autoIncrement = true;
  if (m.primaryKey) spec.primaryKey = true;
  else if (!m.nullable) spec.notNull = true;
  if (m.default !== undefined) spec.default = m.default;
  if (m.check !== undefined) spec.check = m.check;
  if (m.references) spec.references = { ...m.references };
  return spec;
}

/** Define a typed table. Needs no database; bind it with `.on(db)`. */
function defineTable<C extends Columns>(name: string, columns: C): TypedTable<C> {
  return new TypedTable(name, columns);
}

export { defineTable };
