// PACKAGE CHECK — a CommonJS app on plain Node, installed from the packed tarball.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const sdtz = process.env.ORA_SDTZ;
const { createMira, OracleCollection } = require("@jm-paunlagui/mira");
assert.equal(process.env.ORA_SDTZ, sdtz, "require() initialises nothing");
assert.match(require.resolve("@jm-paunlagui/mira"), /node_modules[\\/]@jm-paunlagui[\\/]mira[\\/]dist[\\/]index\.js$/);

(async () => {
  const env = process.env;
  const mira = createMira({ pools: { shop: { user: env.PKG_DB_USER, password: env.PKG_DB_PASSWORD, connectString: env.PKG_DB_CONNECT_STRING, poolMin: 0, poolMax: 1 } }, logger: false });
  try {
    const { rows } = await mira.db().withConnection((c) => c.execute("SELECT 1 AS N FROM DUAL", [], { outFormat: mira.db().oracledb.OUT_FORMAT_OBJECT }));
    assert.equal(rows[0].N, 1);
    assert.ok(mira.collection("DUAL") instanceof OracleCollection);
  } finally {
    await mira.close();
  }
  assert.ok(!fs.existsSync("logs"), "Mira wrote no log folder");
  console.log("package check OK: CommonJS app under Node");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
