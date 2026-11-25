/**
 * UNIT — migrations (Mira 2.1): the paths a live schema does not produce on
 * demand, against stub connections, plus the new-file helpers.
 */
import { describe, it, expect } from "bun:test";
import { createMigrator } from "../../src/utils/oracle-mongo-wrapper";
import { migrationFileName, migrationTemplate } from "../../src/utils/oracle-mongo-wrapper/migrate/migrator";

/** A db whose connection runs `onExecute` for each statement. */
const stubDb = (onExecute: (sql: string) => unknown) =>
  ({
    oracledb: { OUT_FORMAT_OBJECT: 4002 },
    withConnection: async (cb: (c: unknown) => unknown) =>
      cb({ execute: async (sql: string) => onExecute(sql), rollback: async () => {} }),
  }) as never;

describe("unit: migrator against stub connections", () => {
  it("an error creating the history table other than 'already exists' is raised", async () => {
    const db = stubDb((sql) => {
      if (sql.startsWith("CREATE TABLE")) throw new Error("ORA-01031: insufficient privileges");
      return { rows: [] };
    });
    await expect(createMigrator(db).status()).rejects.toThrow(/ORA-01031/);
  });

  it("ORA-00955 (already exists) is fine; an error taking the lock other than ORA-00054 is raised", async () => {
    const db = stubDb((sql) => {
      if (sql.startsWith("CREATE TABLE")) throw new Error("ORA-00955: name is already used by an existing object");
      if (sql.includes("FOR UPDATE NOWAIT")) throw new Error("ORA-03113: end-of-file on communication channel");
      return { rows: [] };
    });
    expect(await createMigrator(db).status()).toEqual([]);
    await expect(createMigrator(db).up()).rejects.toThrow(/ORA-03113/);
  });

  it("dry run: a migration's statements, commits and closes never reach the real connection", async () => {
    const real: string[] = [];
    const db = stubDb((sql) => (real.push(sql), { rows: [] }));
    const runs = await createMigrator(db, {
      table: "H",
      migrations: [
        {
          name: "a",
          up: async ({ db: d, dryRun }) => {
            expect(dryRun).toBe(true);
            await d.withConnection(async (c) => {
              await c.execute("UPDATE T SET X = 1");
              await c.commit();
              await c.rollback();
              await c.close();
            });
          },
        },
      ],
    }).up({ dryRun: true });
    expect(runs[0].sql).toEqual(["UPDATE T SET X = 1"]);
    expect(real.some((s) => s.includes("UPDATE T"))).toBe(false);
    expect(real.some((s) => s.startsWith("INSERT INTO"))).toBe(false); // nothing recorded in the history
  });

  it("history rows with no file and no checksum match are reported in name order", async () => {
    const db = stubDb((sql) => (sql.startsWith('SELECT "NAME"') ? { rows: [{ NAME: "b", CHECKSUM: "x", BATCH: 2, APPLIED_AT: new Date(0) }, { NAME: "a", CHECKSUM: "y", BATCH: 1, APPLIED_AT: new Date(0) }] } : {}));
    const st = await createMigrator(db, { table: "H" }).status();
    expect(st.map((s) => [s.name, s.state, s.batch])).toEqual([["a", "missing", 1], ["b", "missing", 2]]);
  });
});

describe("unit: new migration files", () => {
  it("migrationFileName: UTC timestamp and a snake_case name", () => {
    const at = new Date(Date.UTC(2026, 10, 25, 7, 8, 9));
    expect(migrationFileName("Create Orders", at)).toBe("20261125070809_create_orders.ts");
    expect(migrationFileName("  add NOTE to ORDERS!! ", at)).toBe("20261125070809_add_note_to_orders.ts");
    expect(migrationFileName("x").endsWith("_x.ts")).toBe(true);
    expect(() => migrationFileName(" !! ")).toThrow(/give the new migration a name/);
  });

  it("migrationTemplate: up and down, importing the package by default", () => {
    expect(migrationTemplate()).toContain('import type { MigrationContext } from "@jm-paunlagui/mira";');
    expect(migrationTemplate("../src")).toContain('from "../src";');
    expect(migrationTemplate()).toMatch(/export async function up\([\s\S]*export async function down\(/);
  });
});
