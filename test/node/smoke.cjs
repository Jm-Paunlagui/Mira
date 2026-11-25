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
const { createDb, OracleCollection, OracleSchema } = require("@jm-paunlagui/mira");

const T = "MIRA_NODE_SMOKE";

async function main() {
  assert.equal(typeof globalThis.Bun, "undefined", "run this with node, not bun");
  assert.match(require.resolve("@jm-paunlagui/mira"), /[\\/]dist[\\/]/, "the package must resolve to dist/");

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
