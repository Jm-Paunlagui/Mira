/**
 * PACKAGE CHECK — a TypeScript app that installed @jm-paunlagui/mira from the
 * packed tarball, in an empty project with no .env. Type-checked strictly
 * (skipLibCheck: false, so the published .d.ts files are checked too), then run
 * with Bun. Its pool is named "shop" and its credentials come from its own
 * variables (PKG_DB_*): Mira must not need MIRA_* or any 2.x name.
 */
import fs from "node:fs";
import { createMira, defineTable, t, MiraConfigError, type MiraDb } from "@jm-paunlagui/mira";

const assert = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`package check failed: ${what}`);
};
const T = "MIRA_PKG_TS";
const Items = defineTable(T, { ID: t.number().primaryKey(), NAME: t.text(40), PRICE: t.money() });
type Item = typeof Items.$row;

const sdtz = process.env.ORA_SDTZ;
const env = process.env;
const mira = createMira({
  pools: { shop: { user: env.PKG_DB_USER!, password: env.PKG_DB_PASSWORD!, connectString: env.PKG_DB_CONNECT_STRING!, poolMin: 0, poolMax: 2 } },
  logger: false,
});
assert(process.env.ORA_SDTZ === sdtz, "createMira() initialises nothing");

async function main() {
  let issues: readonly string[] = [];
  try {
    createMira({ pools: { bad: { user: "u", password: "p", connectString: "c", poolmax: 1 } as never } });
  } catch (e) {
    assert(e instanceof MiraConfigError, "a bad config throws MiraConfigError");
    issues = (e as MiraConfigError).issues;
  }
  assert(issues.join() === "pools.bad.poolmax is not a pool option", "the issue names the key");

  assert(JSON.stringify(await mira.open()) === JSON.stringify([{ name: "shop", success: true }]), "open() opens the pool");
  const db: MiraDb = mira.db();
  const schema = mira.schema();
  await schema.dropTable(T, { ifExists: true });
  try {
    await Items.create(db);
    const items = Items.on(db);
    await items.insertMany([{ ID: 1, NAME: "pen", PRICE: "1.25" }, { ID: 2, NAME: "ink", PRICE: 3 }]);
    const rows: Item[] = await items.find({ PRICE: { $gt: 1 } }).sort({ ID: 1 }).toArray();
    const price: string = rows[0].PRICE; // t.money() reads as an exact string
    assert(rows.length === 2 && price === "1.25", "typed find returns exact money");
    // @ts-expect-error no column NOPE: the typed layer must reject it at compile time
    void items.find({ NOPE: 1 });
    assert(mira.health.isHealthy() && Object.keys((await mira.stats()).pools).join() === "shop", "health and stats see the shop pool");
  } finally {
    await schema.dropTable(T, { ifExists: true });
    await mira.close();
  }
  assert(!mira.health.isHealthy(), "closed instance reports unhealthy");
  assert(!fs.existsSync("logs"), "Mira wrote no log folder");
  console.log("package check OK: TypeScript app under Bun");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
