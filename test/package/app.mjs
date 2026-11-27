// PACKAGE CHECK — an ES module on plain Node: named imports from the CommonJS build.
import assert from "node:assert/strict";
import { createMira, fromEnv, initDriver } from "@jm-paunlagui/mira";

const config = fromEnv({ pools: { shop: "PKG_DB" }, env: process.env });
const mira = createMira({ ...config, logger: false });
try {
  assert.ok(["thin", "thick"].includes(initDriver().mode));
  assert.equal(await mira.collection("DUAL").countDocuments(), 1);
} finally {
  await mira.close();
}
console.log("package check OK: ES module under Node");
