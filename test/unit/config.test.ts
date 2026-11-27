/**
 * UNIT — connection registry (src/driver/registry.ts) and adapter factory
 * (src/config/index.ts). Module-load branches are reached by importing fresh
 * copies (`?tag` query) with the environment arranged first.
 */
import { describe, it, expect, afterEach } from "bun:test";
import database, { buildSimpleConnectString, buildTNSConnectString, getConnectionConfig, getConnectionNames, POOL_NAMES, READINESS_GATING_POOLS } from "../../src/driver/registry";
import config from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["NODE_ENV", "APP_TEST_DB_USERNAME", "APP_TEST_DB_PASSWORD", "DB_TEST_HOST", "DB_TEST_PORT", "DB_TEST_SID", "APP_POOL_TIMEOUT", "APP_POOL_MIN"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("unit: database registry", () => {
  it("connect-string builders", () => {
    expect(buildSimpleConnectString("h", 1521, "svc")).toBe("h:1521/svc");
    expect(buildTNSConnectString("h", 1521, "SID")).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(LOAD_BALANCE=yes)(CONNECT_DATA=(SERVER=DEDICATED)(SID=SID)(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))",
    );
  });

  it("lookup by name; unknown names list the registered pools", () => {
    expect(getConnectionConfig("appDb").user).toBe(process.env.APP_DB_USERNAME);
    expect(() => getConnectionConfig("nope")).toThrow(/Unknown connection "nope". Registered: appDb, appDbBulk/);
    expect(getConnectionNames()).toEqual(["appDb", "appDbBulk"]);
    expect(POOL_NAMES).toEqual(["appDb", "appDbBulk"]);
    expect(READINESS_GATING_POOLS).toEqual(["appDb"]);
    expect(database.connections.appDb.poolMax).toBeGreaterThan(0);
  });

  it("test-database switch: development + APP_TEST_DB_USERNAME redirects both pools", async () => {
    process.env.NODE_ENV = "development";
    process.env.APP_TEST_DB_USERNAME = "tester";
    process.env.APP_TEST_DB_PASSWORD = "pw";
    process.env.DB_TEST_HOST = "testhost";
    const m = await import("../../src/driver/registry.ts?testdb");
    expect(m.usingTestDb).toBe(true);
    expect(m.connections.appDb.user).toBe("tester");
    expect(m.connections.appDbBulk.connectString).toContain("HOST=testhost");
  });

  it("development alone never redirects; explicit 0 pool timeout is kept", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.APP_TEST_DB_USERNAME;
    process.env.APP_POOL_TIMEOUT = "0";
    process.env.APP_POOL_MIN = "";
    const m = await import("../../src/driver/registry.ts?devonly");
    expect(m.usingTestDb).toBe(false);
    expect(m.connections.appDb.poolTimeout).toBe(0);
    expect(m.connections.appDb.poolMin).toBe(5);
  });

  it("FAIL-CLOSED: a readiness pool that is not registered aborts module load", async () => {
    const orig = Array.prototype.includes;
    // Make the registry look like it lacks "appDb" for this one import only.
    Array.prototype.includes = function (this: unknown[], v: unknown, ...rest: number[]) {
      if (v === "appDb" && this.length === 2 && this[1] === "appDbBulk") return false;
      return orig.call(this, v, ...rest);
    } as typeof orig;
    try {
      await expect(import("../../src/driver/registry.ts?failclosed")).rejects.toThrow(/Invalid READINESS_GATING_POOLS entry "appDb"/);
    } finally {
      Array.prototype.includes = orig;
    }
  });
});

describe("unit: adapter factory", () => {
  it("resolves oracle by argument, by DB_TYPE, by default; rejects unknown engines", () => {
    expect(typeof config.createAdapter("oracle").withConnection).toBe("function");
    expect(typeof config.createAdapter("  ORACLE ").withConnection).toBe("function");
    expect(typeof config.createAdapter().withConnection).toBe("function");
    expect(() => config.createAdapter("postgres")).toThrow(/Unknown DB_TYPE "postgres"/);
    const prev = process.env.DB_TYPE;
    delete process.env.DB_TYPE;
    expect(typeof config.createAdapter().withConnection).toBe("function");
    if (prev !== undefined) process.env.DB_TYPE = prev;
  });

  it("exposes the adapter API merged with the registry", () => {
    for (const k of ["withConnection", "withTransaction", "withBatchConnection", "closeAll", "getPoolStats", "getConnectionConfig", "POOL_NAMES"]) expect(config).toHaveProperty(k);
  });
});
