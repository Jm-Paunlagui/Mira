/**
 * Node smoke test for the npm build: loads the package by its own name (resolved
 * through package.json "exports", so dist/ is what runs), then does a live round
 * trip on a scratch table. Plain CommonJS JavaScript, no Bun.
 *
 *   bun run build && node --env-file=.env test/node/smoke.cjs
 *
 * Node does not read .env by itself (Bun does): pass --env-file, or set the
 * DB_* / APP_DB_* variables in the environment as CI does.
 */
"use strict";
const assert = require("node:assert/strict");
const sdtzBefore = process.env.ORA_SDTZ;
const { createDb, createMira, initDriver, buildTNSConnectString, OracleCollection, OracleSchema } = require("@jm-paunlagui/mira");
// Importing the package initialises nothing: no session time zone, no Oracle Client.
assert.equal(process.env.ORA_SDTZ, sdtzBefore, "import must not touch ORA_SDTZ");

const T = "MIRA_NODE_SMOKE";

async function main() {
  assert.equal(typeof globalThis.Bun, "undefined", "run this with node, not bun");
  assert.match(require.resolve("@jm-paunlagui/mira"), /[\\/]dist[\\/]/, "the package must resolve to dist/");

  const driver = initDriver();
  assert.ok(driver.mode === "thin" || driver.mode === "thick");
  const db = createDb("appDb");
  const schema = new OracleSchema(db);
  const t = new OracleCollection(T, db);
  await schema.dropTable(T, { ifExists: true });
  try {
    await schema.createTable(T, { ID: { type: "NUMBER", primaryKey: true }, CITY: { type: "VARCHAR2(20)" }, AMT: { type: "NUMBER(12,2)" }, NOTE: { type: "CLOB" } });
    await t.insertMany([
      { ID: 1, CITY: "Cebu", AMT: 10.5, NOTE: "x".repeat(5000) },
      { ID: 2, CITY: "Cebu", AMT: 20 },
      { ID: 3, CITY: null, AMT: 30.25 },
    ]);
    const rows = await t.find({ CITY: "Cebu" }).sort({ ID: 1 }).toArray();
    assert.deepEqual(rows.map((r) => r.ID), [1, 2]);
    assert.equal(rows[0].AMT, "10.5", "scaled NUMBER arrives as an exact string");
    assert.equal(rows[0].NOTE.length, 5000, "CLOB arrives as a string");
    const [g] = await t.aggregate([{ $group: { _id: null, total: { $sum: "$AMT" }, n: { $count: "*" } } }]);
    assert.equal(Number(g.N), 3);
    assert.equal(Number(g.TOTAL), 60.75);

    // createMira(): a pool passed in as a config object, closed on its own.
    const env = process.env;
    const mira = createMira({
      pools: { nodeSmoke: { user: env.APP_DB_USERNAME, password: env.APP_DB_PASSWORD, connectString: buildTNSConnectString(env.DB_HOST, env.DB_PORT, env.DB_APP_SERVICE_NAME), poolMin: 0, poolMax: 1 } },
      driver: { mode: driver.mode },
      logger: false,
    });
    assert.equal(await mira.collection(T).countDocuments(), 3);
    await mira.close();
    assert.equal(mira.closed, true);

    const mode = db.oracledb.oracleClientVersion ? "Thick" : "Thin";
    console.log(`node smoke OK (${process.version}, ${mode} mode)`);
  } finally {
    await schema.dropTable(T, { ifExists: true });
    await db.closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
