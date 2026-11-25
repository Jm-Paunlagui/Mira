/**
 * INTEGRATION — migrations (Mira 2.1) against the live schema: history and
 * checksums, up / down / status, the lock, dry runs, failures, migration files
 * on disk (named and default exports, typed-table definitions), and the
 * `mira migrate` command line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMigrator, defineTable, t, type Migration } from "../../src/utils/oracle-mongo-wrapper";
import { db, schema, coll, dropIfExists, rawExec } from "../helpers/db";

const H = "MIRA_IT_MIG_HIST";
const A = "MIRA_IT_MIG_A";
const B = "MIRA_IT_MIG_B";
const V = "MIRA_IT_MIG_V";
const srcIndex = path.resolve(import.meta.dir, "../../src/utils/oracle-mongo-wrapper/index.ts").replace(/\\/g, "/");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-mig-"));

const Things = defineTable(A, { ID: t.id(), NAME: t.text(40), QTY: t.number().default(0) });
const m1: Migration = {
  name: "20260101_0001_create_a",
  up: ({ createTable }) => createTable(Things),
  down: ({ schema: s }) => s.dropTable(A),
};
const m2: Migration = {
  name: "20260101_0002_seed_and_index",
  up: async ({ collection, execute }) => {
    await collection(A).insertMany([{ NAME: "pen" }, { NAME: "ink", QTY: 3 }], { returning: [] });
    await collection(A).createIndex({ NAME: 1 }, { name: "MIRA_IT_MIG_A_NAME" });
    await execute(`COMMENT ON TABLE "${A}" IS 'seeded'`);
  },
  down: async ({ collection }) => {
    await collection(A).dropIndex("MIRA_IT_MIG_A_NAME");
    await collection(A).deleteMany({});
  },
};
const m3: Migration = {
  name: "20260101_0003_create_b",
  up: ({ schema: s }) => s.createTable(B, { ID: { type: "NUMBER", primaryKey: true } }),
  down: ({ schema: s }) => s.dropTable(B),
};
const migrator = (migrations: Migration[], extra: { table?: string; dir?: string } = {}) => createMigrator(db, { table: H, migrations, ...extra });

async function reset() {
  await dropIfExists(B, A, H, `${H}_LOCK`);
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP VIEW "${V}"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
}
beforeAll(reset);
afterAll(async () => {
  await reset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("migrations: up, down, status, history", () => {
  beforeEach(reset);

  it("status before anything: every migration pending; the history tables are created", async () => {
    const st = await migrator([m2, m1]).status();
    expect(st.map((s) => [s.name, s.state, s.batch])).toEqual([[m1.name, "pending", null], [m2.name, "pending", null]]);
    expect(await coll(H).countDocuments()).toBe(0);
    expect(await coll(`${H}_LOCK`).countDocuments()).toBe(1);
  });

  it("up applies pending migrations in name order, one batch per run, and records them", async () => {
    const runs = await migrator([m2, m1]).up();
    expect(runs.map((r) => r.name)).toEqual([m1.name, m2.name]);
    expect(runs.every((r) => r.sql.length === 0 && r.durationMs >= 0)).toBe(true);
    expect((await coll(A).find({}).sort({ ID: 1 }).toArray()).map((r) => [r.NAME, r.QTY])).toEqual([["pen", 0], ["ink", 3]]);
    expect(await migrator([m1, m2]).up()).toEqual([]); // nothing left to do
    await migrator([m1, m2, m3]).up();
    const st = await migrator([m1, m2, m3]).status();
    expect(st.map((s) => [s.state, s.batch])).toEqual([["applied", 1], ["applied", 1], ["applied", 2]]);
    expect(st.every((s) => s.appliedAt instanceof Date)).toBe(true);
  });

  it("up({ to }) stops at that migration; down rolls back newest first", async () => {
    const all = migrator([m1, m2, m3]);
    expect((await all.up({ to: m2.name })).map((r) => r.name)).toEqual([m1.name, m2.name]);
    await all.up();
    expect((await all.down()).map((r) => r.name)).toEqual([m3.name]);
    expect((await all.down({ steps: 2 })).map((r) => r.name)).toEqual([m2.name, m1.name]);
    expect((await all.status()).every((s) => s.state === "pending")).toBe(true);
    expect(await coll(H).countDocuments()).toBe(0);
    await all.up();
    expect((await all.down({ to: m1.name })).map((r) => r.name)).toEqual([m3.name, m2.name]);
    expect((await all.down({ to: null })).map((r) => r.name)).toEqual([m1.name]);
    expect(await all.down()).toEqual([]);
  });

  it("a pending migration that sorts before applied ones (merged from a branch) is applied", async () => {
    await migrator([m1, m3]).up();
    expect((await migrator([m1, m2, m3]).up()).map((r) => r.name)).toEqual([m2.name]);
  });

  it("a changed or missing applied migration is reported, and up() refuses", async () => {
    await migrator([m1, m2]).up();
    const edited = { ...m2, checksum: "edited" };
    expect((await migrator([m1, edited]).status()).map((s) => s.state)).toEqual(["applied", "changed"]);
    await expect(migrator([m1, edited, m3]).up()).rejects.toThrow(/20260101_0002_seed_and_index \(changed\)/);
    expect((await migrator([m1]).status()).map((s) => [s.name, s.state])).toEqual([[m1.name, "applied"], [m2.name, "missing"]]);
    await expect(migrator([m1, m3]).up()).rejects.toThrow(/\(missing\)/);
    await expect(migrator([m1]).down()).rejects.toThrow(/its file is gone/);
  });

  it("argument checks", async () => {
    await expect(migrator([m1]).up({ to: "nope" })).rejects.toThrow(/no migration named nope/);
    await expect(migrator([m1]).down({ to: "nope" })).rejects.toThrow(/no applied migration named nope/);
    await expect(migrator([m1]).down({ steps: 0 })).rejects.toThrow(/steps must be a positive integer/);
    await expect(migrator([m1, { ...m1 }]).status()).rejects.toThrow(/two migrations are named/);
    await expect(migrator([{ ...m1, name: "bad name!" }]).status()).rejects.toThrow(/invalid migration name/);
    await expect(migrator([{ name: "x_no_up" } as never]).status()).rejects.toThrow(/has no up\(\) function/);
  });

  it("a migration without down() cannot be rolled back", async () => {
    const oneWay: Migration = { name: "20260101_0009_one_way", up: () => {} };
    await migrator([oneWay]).up();
    await expect(migrator([oneWay]).down()).rejects.toThrow(/has no down\(\) function/);
  });

  it("a failing migration names itself, warns that DDL is not transactional, and is not recorded", async () => {
    const broken: Migration = {
      name: "20260101_0004_broken",
      up: async ({ schema: s }) => {
        await s.createTable(B, { ID: { type: "NUMBER" } });
        await s.createTable(B, { ID: { type: "NUMBER" } }); // ORA-00955
      },
      down: () => {},
    };
    const err = await migrator([m1, broken]).up().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/20260101_0004_broken up\(\) failed: .*ORA-00955/s);
    expect((err as Error).message).toMatch(/not transactional/);
    expect((err as Error & { migration: string }).migration).toBe(broken.name);
    // m1 ran in the same call and stays recorded; the broken one does not; its first table stays.
    expect((await migrator([m1, broken]).status()).map((s) => s.state)).toEqual(["applied", "pending"]);
    expect(await coll(B).countDocuments()).toBe(0);
  });

  it("dry run: records the SQL, changes nothing, records nothing", async () => {
    const view: Migration = { name: "20260101_0005_view", up: ({ schema: s }) => s.createView(V, `SELECT 1 AS X FROM DUAL`), down: ({ schema: s }) => s.dropView(V) };
    const runs = await migrator([m1, m2, view]).up({ dryRun: true });
    expect(runs.map((r) => r.name)).toEqual([m1.name, m2.name, view.name]);
    expect(runs[0].sql).toEqual([`CREATE TABLE "${A}" ("ID" NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "NAME" VARCHAR2(40) NOT NULL, "QTY" NUMBER DEFAULT 0 NOT NULL)`]);
    expect(runs[1].sql.some((s) => s.startsWith(`INSERT INTO "${A}"`))).toBe(true);
    expect(runs[1].sql).toContain(`COMMENT ON TABLE "${A}" IS 'seeded'`);
    expect(runs[2].sql).toEqual([`CREATE VIEW "${V}" AS SELECT 1 AS X FROM DUAL`]);
    expect((await migrator([m1, m2, view]).status()).every((s) => s.state === "pending")).toBe(true);
    expect(await rawExec(`SELECT COUNT(*) N FROM USER_TABLES WHERE TABLE_NAME = '${A}'`).then((r) => Number((r.rows?.[0] as { N: number }).N))).toBe(0);
    await migrator([m1]).up();
    const back = await migrator([m1]).down({ dryRun: true });
    expect(back[0].sql).toEqual([`DROP TABLE "${A}"`]);
    expect((await migrator([m1]).status())[0].state).toBe("applied");
  });

  it("the lock: a second run while one is in progress fails at once", async () => {
    const slow: Migration = { name: "20260101_0006_slow", up: ({ execute }) => execute("BEGIN DBMS_SESSION.SLEEP(2); END;"), down: () => {} };
    const first = migrator([slow]).up();
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    await expect(migrator([slow]).up()).rejects.toThrow(/another migration run holds the lock/);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await first).map((r) => r.name)).toEqual([slow.name]);
    // the lock is free again once the run ends
    expect(await migrator([slow]).up()).toEqual([]);
  }, 30000);
});

describe("migrations: files on disk", () => {
  beforeEach(reset);
  const dir = path.join(tmp, "files");

  it("loads .ts / .js / default-export files in name order, skips .d.ts and other files, checksums the file", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "20260102_0001_a.ts"), `import { defineTable, t, type MigrationContext } from "${srcIndex}";\nconst Things = defineTable("${A}", { ID: t.id(), NAME: t.text(40) });\nexport async function up({ createTable }: MigrationContext) { await createTable(Things); }\nexport async function down({ schema }: MigrationContext) { await schema.dropTable("${A}"); }\n`);
    fs.writeFileSync(path.join(dir, "20260102_0002_b.js"), `module.exports = { up: ({ schema }) => schema.createTable("${B}", { ID: { type: "NUMBER" } }), down: ({ schema }) => schema.dropTable("${B}") };\n`);
    fs.writeFileSync(path.join(dir, "20260102_0003_noop.mjs"), `export default { up() {}, down() {} };\n`);
    fs.writeFileSync(path.join(dir, "20260102_0004_types.d.ts"), `export {};\n`);
    fs.writeFileSync(path.join(dir, "README.md"), "not a migration\n");
    const mig = createMigrator(db, { table: H, dir });
    expect((await mig.list()).map((m) => m.name)).toEqual(["20260102_0001_a", "20260102_0002_b", "20260102_0003_noop"]);
    expect((await mig.up()).map((r) => r.name)).toEqual(["20260102_0001_a", "20260102_0002_b", "20260102_0003_noop"]);
    fs.appendFileSync(path.join(dir, "20260102_0002_b.js"), "// edited after it was applied\n");
    expect((await mig.status()).map((s) => s.state)).toEqual(["applied", "changed", "applied"]);
    await expect(mig.up()).rejects.toThrow(/20260102_0002_b \(changed\)/);
  });

  it("refuses a missing directory and a file without up()", async () => {
    await expect(createMigrator(db, { table: H, dir: path.join(tmp, "nope") }).status()).rejects.toThrow(/migration directory not found/);
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "20260103_0001_x.js"), "module.exports = { down() {} };\n");
    await expect(createMigrator(db, { table: H, dir: bad }).status()).rejects.toThrow(/20260103_0001_x.js exports no up\(\) function/);
  });
});

describe("migrations: `mira migrate` command line", () => {
  beforeEach(reset);
  const cli = path.resolve(import.meta.dir, "../../src/cli/mira.ts");
  const dir = path.join(tmp, "cli");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", cli, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const mig = (...args: string[]) => run("migrate", ...args, "--dir", dir, "--table", H);

  it("new, status, up --dry-run, up, down --dry-run, down --steps / --to / --all", () => {
    const created = run("migrate", "new", "Create", "A", "--dir", dir, "--import", srcIndex);
    expect(created.code).toBe(0);
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith("_create_a.ts"))!);
    expect(created.out).toContain("_create_a.ts");
    expect(fs.readFileSync(file, "utf8")).toContain(`import type { MigrationContext } from "${srcIndex}";`);
    fs.writeFileSync(file, `export async function up({ schema }) { await schema.createTable("${A}", { ID: { type: "NUMBER" } }); }\nexport async function down({ schema }) { await schema.dropTable("${A}"); }\n`);
    fs.writeFileSync(path.join(dir, "29990101000000_create_b.ts"), `export async function up({ schema }) { await schema.createTable("${B}", { ID: { type: "NUMBER" } }); }\nexport async function down({ schema }) { await schema.dropTable("${B}"); }\n`);
    const name = path.basename(file, ".ts");

    expect(mig("status").out).toBe(`pending  ${name}\npending  29990101000000_create_b\n`);
    const dry = mig("up", "--dry-run");
    expect(dry.out).toContain(`would apply ${name}\n  CREATE TABLE "${A}" ("ID" NUMBER);`);
    expect(mig("status").out).toContain(`pending  ${name}`);
    const up = mig("up", "--to", name);
    expect(up.code).toBe(0);
    expect(up.out).toMatch(new RegExp(`^apply ${name} \\(\\d+ ms\\)\\n$`));
    expect(mig("up").out).toMatch(/^apply 29990101000000_create_b/);
    expect(mig("up").out).toBe("nothing to apply.\n");
    expect(mig("status").out).toBe(`applied  ${name}  (batch 1)\napplied  29990101000000_create_b  (batch 2)\n`);
    expect(mig("down", "--dry-run").out).toContain(`would roll back 29990101000000_create_b\n  DROP TABLE "${B}";`);
    expect(mig("down", "--steps", "1").out).toMatch(/^roll back 29990101000000_create_b/);
    expect(mig("down", "--to", name).out).toBe("nothing to roll back.\n");
    expect(mig("down", "--all").out).toMatch(new RegExp(`^roll back ${name}`));
    expect(mig("status").code).toBe(0);
  }, 60000);

  it("status exits 1 when an applied migration changed; errors exit 1; bad usage exits 2", () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty, { recursive: true });
    expect(run("migrate", "status", "--dir", empty, "--table", H).out).toBe("no migrations.\n");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    const f = path.join(dir, "20260104_0001_x.ts");
    fs.writeFileSync(f, "export async function up() {}\nexport async function down() {}\n");
    expect(mig("up").code).toBe(0);
    fs.appendFileSync(f, "// edited\n");
    const st = mig("status");
    expect([st.code, st.out]).toEqual([1, "changed  20260104_0001_x  (batch 1)\n"]);
    const up = mig("up");
    expect(up.code).toBe(1);
    expect(up.err).toContain("mira: [migrate] applied migrations no longer match their files");
    expect(run("migrate", "sideways").code).toBe(2);
    expect(run("migrate", "new").code).toBe(2);
    expect(run("migrate", "new", "!!!", "--dir", dir).err).toContain("give the new migration a name");
  }, 60000);
});
