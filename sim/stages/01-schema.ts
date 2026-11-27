/**
 * Stage 1 — Build the canteen's schema with OracleSchema and OracleDCL.
 * Every DDL is verified through the USER_* data dictionary, not by the
 * method's own return value.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";
import type { Migration } from "../../src";

export async function schemaStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw, schemaUser } = ctx;
  const schema = new api.OracleSchema(db);
  const columns = async (t: string) => (await raw<{ C: string }>("SELECT COLUMN_NAME AS C FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID", { t })).map((r) => r.C);
  const constraint = async (t: string, type: string) =>
    (await raw<{ N: string }>("SELECT CONSTRAINT_NAME AS N FROM USER_CONSTRAINTS WHERE TABLE_NAME = :t AND CONSTRAINT_TYPE = :ty ORDER BY 1", { t, ty: type })).map((r) => r.N);

  sim.eq("createSchema: CREATE SCHEMA AUTHORIZATION on the simulation's own schema", await schema.createSchema(schemaUser), { acknowledged: true });

  await schema.createTable(T.STORES, {
    STORE_ID: { type: "NUMBER", primaryKey: true },
    NAME: { type: "VARCHAR2(50)", notNull: true },
    CITY: { type: "VARCHAR2(30)" },
  });
  await schema.createTable(T.PRODUCTS, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    SKU: { type: "VARCHAR2(20)", notNull: true },
    NAME: { type: "VARCHAR2(60)", notNull: true },
    CATEGORY: { type: "VARCHAR2(20)" },
    PRICE: { type: "NUMBER(12,2)", notNull: true, check: "PRICE >= 0" },
    ACTIVE: { type: "VARCHAR2(1)", default: "'Y'" },
  });
  await schema.createTable(T.CUSTOMERS, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    NAME: { type: "VARCHAR2(60)", notNull: true },
    EMAIL: { type: "VARCHAR2(80)", notNull: true },
    TIER: { type: "VARCHAR2(10)", default: "'regular'" },
    CITY: { type: "VARCHAR2(30)" },
    CREDIT: { type: "NUMBER(12,2)", default: 0, check: "CREDIT >= 0" },
    UPDATED_AT: { type: "TIMESTAMP" },
  });
  await schema.createTable(T.EMPLOYEES, {
    ID: { type: "NUMBER", primaryKey: true },
    NAME: { type: "VARCHAR2(60)", notNull: true },
    MANAGER_ID: { type: "NUMBER" },
    DEPT: { type: "VARCHAR2(10)" },
    SALARY: { type: "NUMBER" },
  });
  await schema.createTable(T.STOCK, {
    STORE_ID: { type: "NUMBER", notNull: true, references: { table: T.STORES, column: "STORE_ID" } },
    PRODUCT_ID: { type: "NUMBER", notNull: true, references: { table: T.PRODUCTS, column: "ID" } },
    QTY: { type: "NUMBER", notNull: true, check: "QTY >= 0" },
  });
  await schema.createTable(T.ORDERS, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    RECEIPT_NO: { type: "NUMBER", notNull: true },
    CUSTOMER_ID: { type: "NUMBER", references: { table: T.CUSTOMERS, column: "ID" } },
    STORE_ID: { type: "NUMBER", references: { table: T.STORES, column: "STORE_ID" } },
    QUARTER: { type: "VARCHAR2(2)" },
    STATUS: { type: "VARCHAR2(10)", default: "'open'" },
    TOTAL: { type: "NUMBER(12,2)", default: 0 },
    CREATED_AT: { type: "TIMESTAMP" },
  });
  await schema.createTable(T.LINES, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    ORDER_ID: { type: "NUMBER", notNull: true, references: { table: T.ORDERS, column: "ID" } },
    PRODUCT_ID: { type: "NUMBER", notNull: true, references: { table: T.PRODUCTS, column: "ID" } },
    QTY: { type: "NUMBER", notNull: true, check: "QTY > 0" },
    UNIT_PRICE: { type: "NUMBER(12,2)", notNull: true },
  });
  await schema.createTable(T.SECRET, { ID: { type: "NUMBER", primaryKey: true }, TOKEN: { type: "VARCHAR2(40)" } });
  state.createdAt = Date.now();

  sim.eq("createTable: products columns in order", await columns(T.PRODUCTS), ["ID", "SKU", "NAME", "CATEGORY", "PRICE", "ACTIVE"]);
  sim.eq("createTable: order lines columns in order", await columns(T.LINES), ["ID", "ORDER_ID", "PRODUCT_ID", "QTY", "UNIT_PRICE"]);
  sim.eq("createTable: stock has two foreign keys", (await constraint(T.STOCK, "R")).length, 2);
  sim.ok("createTable: products PRICE check constraint exists", (await constraint(T.PRODUCTS, "C")).length >= 1);

  sim.eq("createTable ifNotExists: existing table is left alone", await schema.createTable(T.STORES, { X: { type: "NUMBER" } }, { ifNotExists: true }), { acknowledged: true });
  sim.eq("createTable ifNotExists: columns unchanged", await columns(T.STORES), ["STORE_ID", "NAME", "CITY"]);
  await sim.rejects("createTable without ifNotExists: ORA-00955", schema.createTable(T.STORES, { X: { type: "NUMBER" } }), /ORA-00955/);

  await schema.alterTable(T.STOCK, { addConstraint: { type: "PRIMARY KEY", columns: ["STORE_ID", "PRODUCT_ID"], name: "PK_SIM_STOCK" } });
  sim.eq("alterTable addConstraint: composite primary key on stock", await constraint(T.STOCK, "P"), ["PK_SIM_STOCK"]);
  await schema.alterTable(T.PRODUCTS, { addConstraint: { type: "UNIQUE", columns: ["SKU"], name: "UQ_SIM_PRODUCTS_SKU" } });
  sim.eq("alterTable addConstraint: unique SKU", await constraint(T.PRODUCTS, "U"), ["UQ_SIM_PRODUCTS_SKU"]);

  await schema.alterTable(T.CUSTOMERS, { addColumn: { PHONE: "VARCHAR2(15)" } });
  await schema.alterTable(T.CUSTOMERS, { modifyColumn: { PHONE: "VARCHAR2(30)" } });
  const [{ L }] = await raw<{ L: number }>("SELECT DATA_LENGTH AS L FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t AND COLUMN_NAME = 'PHONE'", { t: T.CUSTOMERS });
  sim.eq("alterTable addColumn + modifyColumn: PHONE widened to 30", Number(L), 30);
  await schema.alterTable(T.CUSTOMERS, { renameColumn: { from: "PHONE", to: "MOBILE" } });
  sim.ok("alterTable renameColumn: MOBILE replaces PHONE", (await columns(T.CUSTOMERS)).includes("MOBILE") && !(await columns(T.CUSTOMERS)).includes("PHONE"));
  await schema.alterTable(T.CUSTOMERS, { dropColumn: "MOBILE" });
  sim.eq("alterTable dropColumn: customers back to their columns", await columns(T.CUSTOMERS), ["ID", "NAME", "EMAIL", "TIER", "CITY", "CREDIT", "UPDATED_AT"]);
  await schema.alterTable(T.SECRET, { addConstraint: { type: "UNIQUE", columns: ["TOKEN"], name: "UQ_SIM_SECRET_TOKEN" } });
  await schema.alterTable(T.SECRET, { dropConstraint: "UQ_SIM_SECRET_TOKEN" });
  sim.eq("alterTable dropConstraint: unique on TOKEN removed", await constraint(T.SECRET, "U"), []);
  await sim.rejects("alterTable with no operation is refused", schema.alterTable(T.SECRET, {}), /operation|alter/i);

  await schema.createSequence(T.RECEIPT_SEQ, { startWith: 1000, incrementBy: 1, minValue: 1000, cache: 20 });
  const [seq] = await raw<{ MIN_VALUE: number; INCREMENT_BY: number; CACHE_SIZE: number; CYCLE_FLAG: string }>(
    "SELECT MIN_VALUE, INCREMENT_BY, CACHE_SIZE, CYCLE_FLAG FROM USER_SEQUENCES WHERE SEQUENCE_NAME = :s",
    { s: T.RECEIPT_SEQ },
  );
  sim.eq("createSequence: receipt numbers start at 1000, step 1, no cycle", { min: Number(seq?.MIN_VALUE), step: Number(seq?.INCREMENT_BY), cache: Number(seq?.CACHE_SIZE), cycle: seq?.CYCLE_FLAG }, { min: 1000, step: 1, cache: 20, cycle: "N" });

  // Scratch table: truncate, rename, drop (ifExists and cascade).
  await schema.createTable(T.SCRATCH, { ID: { type: "NUMBER", primaryKey: true } });
  await ctx.raw(`INSERT INTO "${T.SCRATCH}" ("ID") SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 5`);
  await schema.truncateTable(T.SCRATCH);
  sim.eq("truncateTable: scratch table emptied", await ctx.rawCount(T.SCRATCH), 0);
  await schema.renameTable(T.SCRATCH, `${T.SCRATCH}_OLD`);
  const scratch = (await raw<{ N: string }>("SELECT TABLE_NAME AS N FROM USER_TABLES WHERE TABLE_NAME LIKE 'SIM\\_SCRATCH%' ESCAPE '\\'")).map((r) => r.N);
  sim.eq("renameTable: only the new name exists", scratch, [`${T.SCRATCH}_OLD`]);
  await schema.dropTable(`${T.SCRATCH}_OLD`, { cascade: true });
  sim.eq("dropTable ifExists: a missing table is not an error", await schema.dropTable(`${T.SCRATCH}_OLD`, { ifExists: true }), { acknowledged: true });
  await sim.rejects("dropTable on a missing table: ORA-00942", schema.dropTable(`${T.SCRATCH}_OLD`), /ORA-00942/);
  await sim.rejects("dropTable of a referenced table without cascade: ORA-02449", schema.dropTable(T.STORES), /ORA-02449/);

  // DCL: grant read access on the menu to another schema, then take it back.
  // `||`, not `??`: a blank `MIRA_SIM_GRANTEE=` line in .env is "" and must fall through.
  const grantee = (process.env.MIRA_SIM_GRANTEE?.trim() || process.env.APP_DB_USERNAME?.trim() || "PUBLIC").toUpperCase();
  const dcl = new api.OracleDCL(db as never);
  const grants = async () =>
    (await raw<{ P: string }>("SELECT PRIVILEGE AS P FROM USER_TAB_PRIVS_MADE WHERE TABLE_NAME = :t AND GRANTEE = :g ORDER BY 1", { t: T.PRODUCTS, g: grantee })).map((r) => r.P);
  await dcl.grant(["SELECT", "REFERENCES"], T.PRODUCTS, grantee);
  sim.eq(`grant: SELECT and REFERENCES on products to ${grantee}`, await grants(), ["REFERENCES", "SELECT"]);
  await dcl.revoke(["REFERENCES"], T.PRODUCTS, grantee);
  sim.eq("revoke: REFERENCES taken back, SELECT kept", await grants(), ["SELECT"]);
  await dcl.revoke(["SELECT"], T.PRODUCTS, grantee);
  sim.eq("revoke: no privileges left", await grants(), []);
  await sim.rejects("grant of an unknown privilege is refused", dcl.grant(["TELEPORT"], T.PRODUCTS, grantee), /OracleDCL\.grant/);

  // ── Migrations (2.1): the supplier schema arrives as versioned changes ────
  // The history table is SIM_MIGRATIONS (+ _LOCK), so the teardown drops it with the rest.
  const { t } = api;
  const Suppliers = api.defineTable(T.SUPPLIERS, { ID: t.id(), NAME: t.text(40), TERMS_DAYS: t.number().default(30) });
  const supplierMigrations: Migration[] = [
    { name: "20261101_0001_create_suppliers", up: ({ createTable }) => createTable(Suppliers), down: ({ schema: s }) => s.dropTable(T.SUPPLIERS) },
    {
      name: "20261101_0002_seed_suppliers",
      up: ({ collection }) => collection(T.SUPPLIERS).insertMany([{ NAME: "FreshFarm" }, { NAME: "BeanCo", TERMS_DAYS: 15 }, { NAME: "Paper&Co", TERMS_DAYS: 60 }], { returning: [] }),
      down: ({ execute }) => execute(`DELETE FROM "${T.SUPPLIERS}"`),
    },
    {
      name: "20261101_0003_supplier_view",
      up: ({ schema: s }) => s.createView(T.VIEW_SUPPLIERS, `SELECT "NAME", "TERMS_DAYS" FROM "${T.SUPPLIERS}" WHERE "TERMS_DAYS" <= 30`),
      down: ({ schema: s }) => s.dropView(T.VIEW_SUPPLIERS),
    },
  ];
  const migrator = api.createMigrator(db, { table: T.MIGRATIONS, migrations: supplierMigrations });
  sim.eq("migrator.list: three migrations in name order", (await migrator.list()).map((m) => m.name), ["20261101_0001_create_suppliers", "20261101_0002_seed_suppliers", "20261101_0003_supplier_view"]);
  const plan = await migrator.up({ dryRun: true });
  sim.eq("migrate up --dry-run: the SQL of each migration, nothing applied", [plan.map((r) => r.sql.length > 0), (await migrator.status()).map((s) => s.state)], [[true, true, true], ["pending", "pending", "pending"]]);
  sim.eq("migrate up: all three applied in one batch", (await migrator.up()).map((r) => r.name).length, 3);
  sim.eq("migrate up again: nothing pending", await migrator.up(), []);
  const viewRows = await raw<{ NAME: string }>(`SELECT NAME FROM "${T.VIEW_SUPPLIERS}" ORDER BY NAME`);
  sim.eq("the migrated view: suppliers paid within 30 days", viewRows.map((r) => r.NAME), ["BeanCo", "FreshFarm"]);
  sim.eq("migrate down: the newest migration (the view) rolled back", (await migrator.down()).map((r) => r.name), ["20261101_0003_supplier_view"]);
  sim.eq("migrate status: two applied, the view pending again", (await migrator.status()).map((s) => [s.state, s.batch]), [["applied", 1], ["applied", 1], ["pending", null]]);
  await migrator.up();
  sim.eq("migrate up: the view back, in batch 2", (await migrator.status()).map((s) => s.batch), [1, 1, 2]);
  await sim.rejects("migrate up refuses when an applied migration's code changed", api.createMigrator(db, { table: T.MIGRATIONS, migrations: supplierMigrations.map((m, i) => (i === 1 ? { ...m, checksum: "edited" } : m)) }).up(), /no longer match their files/);
}
