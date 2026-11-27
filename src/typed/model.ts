/**
 * ============================================================================
 * typed/model.ts — model conveniences on a typed table (Mira 2.1)
 * ============================================================================
 *
 *   const Orders = defineTable("ORDERS", {
 *     ID: t.id(),
 *     TOTAL: t.money(),
 *     CREATED_AT: t.createdAt(),
 *     UPDATED_AT: t.updatedAt(),
 *     DELETED_AT: t.deletedAt(),
 *   }, {
 *     validate: true,
 *     hooks: { beforeInsert: (doc) => ({ ...doc, TOTAL: Number(doc.TOTAL).toFixed(2) }) },
 *   });
 *
 * A table that uses any of these gets a ModelCollection from on(): the same
 * OracleCollection, with these methods wrapped:
 *
 *   reads    find, findOne, countDocuments, distinct, aggregate
 *            skip soft-deleted rows (withDeleted() sees them)
 *   inserts  insertOne, insertMany                          hooks, validation
 *   updates  updateOne, updateMany, replaceOne,
 *            findOneAndUpdate, findOneAndReplace           hooks, validation,
 *                                                           updatedAt, skip deleted
 *   deletes  deleteOne, deleteMany, findOneAndDelete       hooks; soft unless { force: true }
 *   bulkWrite                                              runs the wrapped methods
 *
 * Everything else (merge, bulkUpdateByKeys, updateFromJoin, insertFromQuery,
 * connectBy, pivot, raw SQL …) is 2.0's and does none of this: they write
 * many rows in one statement, or read other tables.
 *
 * Tables without these features keep the plain OracleCollection.
 * ============================================================================
 */

import { OracleCollection } from "../core/OracleCollection";
import type { DbConnection } from "../driver/db";
import type { ColumnMeta } from "./columns";
import { validateInsert, validateUpdate } from "./validate";

type Doc = Record<string, unknown>;
type Metas = Readonly<Record<string, { meta: Readonly<ColumnMeta> }>>;

/**
 * What a hook receives last. It works like a transaction session: `Log.on(ctx)` or
 * `ctx.collection("LOG")` is another table on the same connection, so inside a
 * transaction a hook's own writes commit or roll back with it.
 */
export interface HookContext {
  /** The table the write is on. */
  table: string;
  /** That table's collection (model behaviour included), on the same connection. */
  self: OracleCollection;
  /** Another table on the same connection. */
  collection(tableName: string): OracleCollection;
}

/** Untyped hooks as the runtime calls them (see TableHooks in table.ts for the typed form). */
export interface ModelHooks {
  beforeInsert?: (doc: Doc, ctx: HookContext) => unknown;
  afterInsert?: (doc: Doc, insertedId: unknown, ctx: HookContext) => unknown;
  beforeUpdate?: (update: Doc, filter: Doc, ctx: HookContext) => unknown;
  afterUpdate?: (result: { matchedCount: number; modifiedCount: number }, filter: Doc, update: Doc, ctx: HookContext) => unknown;
  beforeDelete?: (filter: Doc, ctx: HookContext) => unknown;
  afterDelete?: (result: { deletedCount: number; soft: boolean }, filter: Doc, ctx: HookContext) => unknown;
}

/** A typed table's model settings, resolved once by defineTable(). */
export interface ModelSpec {
  columns: Metas;
  primaryKey: readonly string[];
  updatedAt?: string;
  deletedAt?: string;
  version?: string;
  validate: boolean;
  hooks: ModelHooks;
}

/**
 * A write that gave the version it read (optimistic locking) found the row changed since:
 * someone else updated it in between. Re-read the row and try again.
 */
export class MiraConcurrencyError extends Error {
  /**
   * An expected outcome, not a database failure: the adapter passes it through a
   * transaction unwrapped (and does not log it as critical). HTTP: 409 Conflict.
   */
  readonly isOperational = true;
  readonly statusCode = 409;
  readonly table: string;
  readonly expectedVersion: unknown;
  readonly currentVersion: unknown;
  constructor(table: string, operation: string, expected: unknown, current: unknown) {
    super(`[${table}] ${operation}: the row changed since it was read (version ${String(expected)} expected, now ${String(current)}); re-read it and try again.`);
    this.name = "MiraConcurrencyError";
    this.table = table;
    this.expectedVersion = expected;
    this.currentVersion = current;
  }
}

const isEmpty = (o: unknown) => !o || (typeof o === "object" && Object.keys(o).length === 0);

const fail = (table: string, why: string): never => {
  throw new Error(`[${table}] ${why}`);
};

class ModelCollection extends OracleCollection {
  declare _model: ModelSpec;
  /** withDeleted(): reads and writes see soft-deleted rows too. */
  declare _withDeleted: boolean;

  constructor(tableName: string, db: ConstructorParameters<typeof OracleCollection>[1], conn: DbConnection | null, model: ModelSpec, withDeleted = false) {
    super(tableName, db, conn);
    this._model = model;
    this._withDeleted = withDeleted;
  }

  /** The same model collection on another connection (bulkWrite's transaction). */
  override _onConnection(conn: DbConnection): OracleCollection {
    const c = new ModelCollection(this.tableName, this.db, conn, this._model, this._withDeleted);
    c._json = this._json;
    c._relations = this._relations;
    return c;
  }

  /** This collection with soft-deleted rows visible to reads, updates and deletes. */
  withDeleted(): ModelCollection {
    if (!this._model.deletedAt) fail(this.tableName, "withDeleted() needs a t.deletedAt() column.");
    const c = new ModelCollection(this.tableName, this.db, this._conn, this._model, true);
    c._json = this._json;
    c._relations = this._relations;
    return c;
  }

  /** Clear the deleted mark of the soft-deleted rows matching the filter (an update: hooks and updatedAt apply). */
  async restore(filter: Doc = {}): Promise<{ acknowledged: boolean; matchedCount: number; modifiedCount: number }> {
    const col = this._model.deletedAt;
    if (!col) return fail(this.tableName, "restore() needs a t.deletedAt() column.");
    return this.withDeleted().updateMany({ ...filter, [col]: { $ne: null } }, { $set: { [col]: null } });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private get _ctx(): HookContext {
    return { table: this.tableName, self: this, collection: (name: string) => new OracleCollection(name, this.db, this._conn) };
  }

  /**
   * Only rows that are not soft-deleted: the filter plus `deletedAt: null`. A filter that
   * names the column itself, or withDeleted(), is left as it is.
   */
  _scope(filter: Doc | undefined): Doc {
    const f = filter ?? {};
    const col = this._model.deletedAt;
    if (!col || this._withDeleted || col in f) return f;
    return { ...f, [col]: null };
  }

  /** The update with updatedAt stamped and the version raised (unless the update sets those columns itself). */
  _stamp(update: Doc): Doc {
    let out = update;
    const touches = (col: string) => Object.values(out).some((fields) => !!fields && typeof fields === "object" && col in (fields as Doc));
    const col = this._model.updatedAt;
    if (col && !touches(col)) out = { ...out, $currentDate: { ...((out.$currentDate as Doc | undefined) ?? {}), [col]: { $type: "timestamp" } } };
    const ver = this._model.version;
    if (ver && !touches(ver)) out = { ...out, $inc: { ...((out.$inc as Doc | undefined) ?? {}), [ver]: 1 } };
    return out;
  }

  /** The version value a filter pins (`{ ID: 1, VERSION: 3 }`), or undefined. */
  _pinnedVersion(filter: Doc): number | undefined {
    const ver = this._model.version;
    const v = ver ? filter[ver] : undefined;
    return typeof v === "number" ? v : undefined;
  }

  /**
   * A single-row write that pinned a version matched nothing: if the row (the filter without
   * the version) is still there, it changed in between, so throw MiraConcurrencyError.
   * A filter of nothing but the version is not a row to check.
   */
  async _checkConflict(filter: Doc, matched: number, operation: string): Promise<void> {
    const expected = this._pinnedVersion(filter);
    if (matched > 0 || expected === undefined) return;
    const ver = this._model.version as string;
    const { [ver]: _pinned, ...row } = filter;
    if (isEmpty(row)) return;
    const current = await super.findOne<Doc>(this._scope(row));
    if (current) throw new MiraConcurrencyError(this.tableName, operation, expected, current[ver]);
  }

  async _beforeInsert(doc: Doc): Promise<Doc> {
    const hook = this._model.hooks.beforeInsert;
    const out = hook ? ((await hook({ ...doc }, this._ctx)) as Doc | undefined) ?? doc : doc;
    if (this._model.validate) validateInsert(this.tableName, this._model.columns, out);
    return out;
  }

  async _beforeUpdate(update: Doc, filter: Doc): Promise<Doc> {
    const hook = this._model.hooks.beforeUpdate;
    const out = hook ? ((await hook({ ...update }, filter, this._ctx)) as Doc | undefined) ?? update : update;
    if (this._model.validate) validateUpdate(this.tableName, this._model.columns, out);
    return this._stamp(out);
  }

  async _afterUpdate(result: { matchedCount: number; modifiedCount: number }, filter: Doc, update: Doc): Promise<void> {
    await this._model.hooks.afterUpdate?.(result, filter, update, this._ctx);
  }

  async _beforeDelete(filter: Doc): Promise<void> {
    await this._model.hooks.beforeDelete?.(filter, this._ctx);
  }

  async _afterDelete(result: { deletedCount: number; soft: boolean }, filter: Doc): Promise<void> {
    await this._model.hooks.afterDelete?.(result, filter, this._ctx);
  }

  /** A replacement as a $set: every given column except the primary key and the version (Mira raises it). */
  _replacementAsSet(replacement: Doc): Doc {
    const set: Doc = {};
    for (const [k, v] of Object.entries(replacement)) if (!this._model.primaryKey.includes(k) && k !== this._model.version) set[k] = v;
    if (isEmpty(set)) fail(this.tableName, "a replacement needs at least one column besides the primary key.");
    return { $set: set };
  }

  /** The soft delete's update: the deletedAt column set to SYSTIMESTAMP. */
  private get _softDeleteUpdate(): Doc {
    return { $currentDate: { [this._model.deletedAt as string]: { $type: "timestamp" } } };
  }

  // ─── Reads ────────────────────────────────────────────────────

  override find(filter: Doc = {}, options: Parameters<OracleCollection["find"]>[1] = {}) {
    return super.find(this._scope(filter), options);
  }

  override findOne<T = Doc>(filter: Doc = {}, options: Doc = {}): Promise<T | null> {
    return super.findOne<T>(this._scope(filter), options);
  }

  override countDocuments(filter: Doc = {}): Promise<number> {
    return super.countDocuments(this._scope(filter));
  }

  override distinct(field: string, filter: Doc = {}): Promise<unknown[]> {
    return super.distinct(field, this._scope(filter));
  }

  override aggregate(pipeline: unknown[]) {
    const scope = this._scope({});
    return super.aggregate(isEmpty(scope) ? pipeline : [{ $match: scope }, ...pipeline]);
  }

  // ─── Inserts ──────────────────────────────────────────────────

  override async insertOne(document: Doc, options: Parameters<OracleCollection["insertOne"]>[1] = {}) {
    const doc = await this._beforeInsert(document);
    const result = await super.insertOne(doc, options);
    await this._model.hooks.afterInsert?.(doc, result.insertedId, this._ctx);
    return result;
  }

  override async insertMany(documents: Doc[], options: Parameters<OracleCollection["insertMany"]>[1] = {}) {
    if (!Array.isArray(documents) || documents.length === 0) return super.insertMany(documents, options);
    const docs: Doc[] = [];
    for (const d of documents) docs.push(await this._beforeInsert(d));
    const result = await super.insertMany(docs, options);
    const after = this._model.hooks.afterInsert;
    if (after) for (let i = 0; i < docs.length; i++) await after(docs[i], result.insertedIds[i] ?? null, this._ctx);
    return result;
  }

  // ─── Updates ──────────────────────────────────────────────────

  override async updateOne(filter: Doc, update: Doc, options: Parameters<OracleCollection["updateOne"]>[2] = {}) {
    if (options.upsert && this._pinnedVersion(filter) !== undefined) fail(this.tableName, "upsert with a version in the filter would insert a second row when the version is stale; update without upsert.");
    const u = await this._beforeUpdate(update, filter);
    const result = await super.updateOne(this._scope(filter), u, options);
    await this._checkConflict(filter, result.matchedCount, "updateOne");
    await this._afterUpdate(result, filter, u);
    return result;
  }

  override async updateMany(filter: Doc, update: Doc, options: Parameters<OracleCollection["updateMany"]>[2] = {}) {
    const u = await this._beforeUpdate(update, filter);
    const result = await super.updateMany(this._scope(filter), u, options);
    await this._afterUpdate(result, filter, u);
    return result;
  }

  /** A model table replaces through $set, so updatedAt, hooks and validation apply. The primary key is kept. */
  override async replaceOne(filter: Doc, replacement: Doc, _options: Doc = {}) {
    const { acknowledged, matchedCount, modifiedCount } = await this.updateOne(filter, this._replacementAsSet(replacement));
    return { acknowledged, matchedCount, modifiedCount };
  }

  override async findOneAndUpdate<T = Doc>(filter: Doc, update: Doc, options: Doc = {}): Promise<T | null> {
    const u = await this._beforeUpdate(update, filter);
    if (options.upsert && this._pinnedVersion(filter) !== undefined) fail(this.tableName, "upsert with a version in the filter would insert a second row when the version is stale; update without upsert.");
    const doc = await super.findOneAndUpdate<T>(this._scope(filter), u, options);
    await this._checkConflict(filter, doc ? 1 : 0, "findOneAndUpdate");
    const n = doc ? 1 : 0;
    await this._afterUpdate({ matchedCount: n, modifiedCount: n }, filter, u);
    return doc;
  }

  override findOneAndReplace<T = Doc>(filter: Doc, replacement: Doc, options: Doc = {}): Promise<T | null> {
    return this.findOneAndUpdate<T>(filter, this._replacementAsSet(replacement), options);
  }

  // ─── Deletes ──────────────────────────────────────────────────

  override async deleteOne(filter: Doc, options: Parameters<OracleCollection["deleteOne"]>[1] & { force?: boolean } = {}) {
    const { force, ...rest } = options;
    await this._beforeDelete(filter);
    let result: Awaited<ReturnType<OracleCollection["deleteOne"]>>;
    const soft = !!this._model.deletedAt && !force;
    if (soft) {
      const r = await super.updateOne(this._scope(filter), this._softDeleteUpdate, rest);
      result = { acknowledged: r.acknowledged, deletedCount: r.modifiedCount, ...(r.returning ? { returning: r.returning } : {}) };
    } else {
      result = await super.deleteOne(this._scope(filter), rest);
    }
    await this._checkConflict(filter, result.deletedCount, "deleteOne");
    await this._afterDelete({ deletedCount: result.deletedCount, soft }, filter);
    return result;
  }

  override async deleteMany(filter: Doc, options: Parameters<OracleCollection["deleteMany"]>[1] & { force?: boolean } = {}) {
    const { force, ...rest } = options;
    const soft = !!this._model.deletedAt && !force;
    if (soft && rest.limit !== undefined) fail(this.tableName, "a soft deleteMany has no limit; pass { force: true } to delete rows for real, or narrow the filter.");
    await this._beforeDelete(filter);
    let result: Awaited<ReturnType<OracleCollection["deleteMany"]>>;
    if (soft) {
      const r = await super.updateMany(this._scope(filter), this._softDeleteUpdate, rest);
      result = { acknowledged: r.acknowledged, deletedCount: r.modifiedCount, ...(r.returning ? { returning: r.returning } : {}) };
    } else {
      result = await super.deleteMany(this._scope(filter), rest);
    }
    await this._afterDelete({ deletedCount: result.deletedCount, soft }, filter);
    return result;
  }

  override async findOneAndDelete<T = Doc>(filter: Doc, options: { force?: boolean } = {}): Promise<T | null> {
    await this._beforeDelete(filter);
    const soft = !!this._model.deletedAt && !options.force;
    const doc = soft
      ? await super.findOneAndUpdate<T>(this._scope(filter), this._softDeleteUpdate, { returnDocument: "before" })
      : await super.findOneAndDelete<T>(this._scope(filter));
    await this._checkConflict(filter, doc ? 1 : 0, "findOneAndDelete");
    await this._afterDelete({ deletedCount: doc ? 1 : 0, soft }, filter);
    return doc;
  }
}

export { ModelCollection };
