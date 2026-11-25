/**
 * ============================================================================
 * typed/relations.ts — relations between typed tables (Mira 2.1)
 * ============================================================================
 *
 *   export const Customers = defineTable("CUSTOMERS", { ID: t.id(), NAME: t.text(60) });
 *   export const Orders = defineTable("ORDERS", { ID: t.id(), CUSTOMER_ID: t.number(), TOTAL: t.money() });
 *
 *   export const CustomersR = relations(Customers, {
 *     orders: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }),          // ORDERS.CUSTOMER_ID = CUSTOMERS.ID
 *   });
 *   export const OrdersR = relations(Orders, {
 *     customer: belongsTo(Customers, { foreignKey: "CUSTOMER_ID" }),   // ORDERS.CUSTOMER_ID = CUSTOMERS.ID
 *   });
 *
 *   await CustomersR.on(db).find().include("orders", { sort: { TOTAL: -1 }, limit: 5 }).toArray();
 *
 * Relations are declared apart from the tables, once every table exists, so two
 * tables can point at each other and generated table files stay as they are.
 * relations() returns the same table with the relations attached; include() then
 * fetches related rows in the same statement (see include.ts).
 * ============================================================================
 */

import { TypedTable, type RowOf } from "./table";
import type { AnyColumn } from "./columns";
import type { RelationKind, RelationSpec } from "./include";

type Columns = Record<string, AnyColumn>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type BinaryKeys<C extends Columns> = { [K in keyof C]: C[K]["$read"] extends Buffer ? K : never }[keyof C];

/** A related row as include() returns it: binary columns are left out (JSON has no binary type). */
export type NestedRow<C extends Columns> = Simplify<Omit<RowOf<C>, BinaryKeys<C>>>;

/** A relation declaration: its kind, the related table's columns, and what include() adds. */
export interface Relation<Kind extends RelationKind, TC extends Columns> {
  readonly kind: Kind;
  readonly target: TypedTable<TC, any>;
  readonly foreignKey: string;
  readonly key?: string;
  /** Type-only: the value include() puts on each row. */
  readonly $out: Kind extends "hasMany" ? Array<NestedRow<TC>> : NestedRow<TC> | null;
}
export type AnyRelation = Relation<RelationKind, any>;

/**
 * One parent row has many related rows: `related.foreignKey = this.localKey`
 * (localKey defaults to this table's primary key).
 */
function hasMany<TC extends Columns>(target: TypedTable<TC, any>, options: { foreignKey: keyof TC & string; localKey?: string }): Relation<"hasMany", TC> {
  return { kind: "hasMany", target, foreignKey: options.foreignKey, key: options.localKey } as Relation<"hasMany", TC>;
}

/** Like hasMany, but include() returns one related row (the first by `sort`) or null. */
function hasOne<TC extends Columns>(target: TypedTable<TC, any>, options: { foreignKey: keyof TC & string; localKey?: string }): Relation<"hasOne", TC> {
  return { kind: "hasOne", target, foreignKey: options.foreignKey, key: options.localKey } as Relation<"hasOne", TC>;
}

/**
 * This row points at one related row: `this.foreignKey = related.references`
 * (references defaults to the related table's primary key).
 */
function belongsTo<TC extends Columns>(target: TypedTable<TC, any>, options: { foreignKey: string; references?: keyof TC & string }): Relation<"belongsTo", TC> {
  return { kind: "belongsTo", target, foreignKey: options.foreignKey, key: options.references } as Relation<"belongsTo", TC>;
}

/** The single primary-key column of a table, for a relation that does not name its key. */
function primaryKeyOf(table: TypedTable<Columns, any>, relation: string): string {
  const pk = Object.entries(table.columns).filter(([, c]) => c.meta.primaryKey).map(([k]) => k);
  if (pk.length !== 1) throw new TypeError(`[relations] ${relation}: ${table.name} has ${pk.length === 0 ? "no" : "a multi-column"} primary key; name the key column in the relation.`);
  return pk[0];
}

/** Attach relations to a table. Returns the same table (name, columns, ddl, on) with include() available. */
function relations<C extends Columns, Rel extends Record<string, AnyRelation>>(table: TypedTable<C, any>, rels: Rel): TypedTable<C, Rel> {
  if (!(table instanceof TypedTable)) throw new TypeError("[relations] the first argument must be a defineTable() table.");
  const specs: Record<string, RelationSpec> = {};
  for (const [name, r] of Object.entries(rels ?? {})) {
    const where = `${table.name}.${name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`[relations] ${where}: a relation name must be an identifier.`);
    if (name in table.columns) throw new TypeError(`[relations] ${where}: ${table.name} already has a column named ${name}.`);
    if (!r || !["hasMany", "hasOne", "belongsTo"].includes(r.kind) || !(r.target instanceof TypedTable)) throw new TypeError(`[relations] ${where}: use hasMany(), hasOne() or belongsTo() with a defineTable() table.`);
    const target = r.target as TypedTable<Columns, any>;
    const isBelongsTo = r.kind === "belongsTo";
    // The foreign key lives on the related table (hasMany / hasOne) or on this one (belongsTo).
    const fkTable = isBelongsTo ? (table as TypedTable<Columns, any>) : target;
    const keyTable = isBelongsTo ? target : (table as TypedTable<Columns, any>);
    if (!(r.foreignKey in fkTable.columns)) throw new TypeError(`[relations] ${where}: ${fkTable.name} has no column ${r.foreignKey}.`);
    const key = r.key ?? primaryKeyOf(keyTable, where);
    if (!(key in keyTable.columns)) throw new TypeError(`[relations] ${where}: ${keyTable.name} has no column ${key}.`);
    specs[name] = { kind: r.kind, target: { name: target.name, columns: target.columns }, foreignKey: r.foreignKey, key };
  }
  return new TypedTable<C, Rel>(table.name, table.columns, specs, table.options);
}

export { hasMany, hasOne, belongsTo, relations };
