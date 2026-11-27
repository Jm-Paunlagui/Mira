/**
 * UNIT — the createMira() config layer: defineConfig (src/config/defineConfig.ts),
 * fromEnv (src/config/fromEnv.ts) and the runtime registry added to
 * src/config/database.ts (registerConnection / unregisterConnection).
 * Registry tests use a fresh copy of database.ts so the shared registry the
 * adapter reads is never touched here.
 */
import { describe, it, expect } from "bun:test";
import { defineConfig, MiraConfigError } from "../../src/config/defineConfig";
import { fromEnv } from "../../src/config/fromEnv";
import type { MiraConfig } from "../../src/config/types";

const pool = { user: "APP", password: "secret-pw", connectString: "db:1521/APP" };

function issuesOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MiraConfigError);
    return (e as MiraConfigError).issues;
  }
  throw new Error("expected a MiraConfigError");
}

describe("unit: defineConfig", () => {
  it("one pool becomes the default; result is frozen and copied", () => {
    const input = { pools: { appDb: { ...pool, poolMax: 20, poolPingInterval: -1 } } };
    const c = defineConfig(input);
    expect(c.defaultPool).toBe("appDb");
    expect(c.poolNames).toEqual(["appDb"]);
    expect(c.pools.appDb.poolMax).toBe(20);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.pools)).toBe(true);
    expect(Object.isFrozen(c.pools.appDb)).toBe(true);
    expect(c.pools.appDb).not.toBe(input.pools.appDb);
  });

  it("several pools need defaultPool, which must be one of them", () => {
    expect(issuesOf(() => defineConfig({ pools: { a: pool, b: pool } }))).toEqual([
      "defaultPool is required when there is more than one pool",
    ]);
    expect(defineConfig({ pools: { a: pool, b: pool }, defaultPool: "b" }).defaultPool).toBe("b");
    expect(issuesOf(() => defineConfig({ pools: { a: pool }, defaultPool: "zz" } as MiraConfig))).toEqual([
      'defaultPool "zz" is not one of the pools',
    ]);
  });

  it("a non-object config or pools is refused up front", () => {
    for (const bad of [null, undefined, 42, [], {}, { pools: [] }, { pools: null }]) {
      expect(issuesOf(() => defineConfig(bad as unknown as MiraConfig))).toEqual([
        "config must be an object with a `pools` object",
      ]);
    }
  });

  it("collects every problem at once and never echoes a value", () => {
    const issues = issuesOf(() =>
      defineConfig({
        pools: {
          empty: {} as never,
          "9bad": pool,
          notObj: "x" as never,
          typo: { ...pool, poolmax: 5 } as never,
          nums: { ...pool, poolMin: 5, poolMax: 2, queueMax: -1, connectTimeout: 0, poolTimeout: 1.5, poolPingInterval: 0.5, stmtCacheSize: Number.NaN },
          blank: { user: " ", password: "", connectString: "db" },
        },
        defaultPool: "empty",
      }),
    );
    expect(issues).toEqual([
      "pools.empty.user must be a non-empty string",
      "pools.empty.password must be a non-empty string",
      "pools.empty.connectString must be a non-empty string",
      'pool name "9bad" must be a letter followed by up to 63 letters, digits or _',
      "pools.notObj must be an object",
      "pools.typo.poolmax is not a pool option",
      "pools.nums.queueMax must be an integer >= 0",
      "pools.nums.poolTimeout must be an integer >= 0",
      "pools.nums.connectTimeout must be an integer >= 1",
      "pools.nums.poolPingInterval must be an integer",
      "pools.nums.stmtCacheSize must be an integer >= 0",
      "pools.nums.poolMin must not exceed poolMax",
      "pools.blank.user must be a non-empty string",
      "pools.blank.password must be a non-empty string",
    ]);
    const err = (() => {
      try {
        defineConfig({ pools: { x: { ...pool, password: "" } } });
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(err.name).toBe("MiraConfigError");
    expect(err.message).toBe("[mira] Invalid config:\n  - pools.x.password must be a non-empty string");
    expect(err.message).not.toContain("APP");
  });

  it("an empty pools object is refused; long names are cut in messages", () => {
    expect(issuesOf(() => defineConfig({ pools: {} }))).toEqual(["pools must name at least one pool"]);
    const long = "x".repeat(65);
    expect(issuesOf(() => defineConfig({ pools: { [long]: pool } }))[0]).toBe(
      `pool name "${long}" must be a letter followed by up to 63 letters, digits or _`,
    );
    expect(defineConfig({ pools: { ["a" + "b".repeat(63)]: pool } }).poolNames).toHaveLength(1);
  });

  it("a resolved config is accepted again unchanged", () => {
    const c = defineConfig({ pools: { a: pool, b: pool }, defaultPool: "a" });
    expect(defineConfig(c)).toEqual(c);
  });
});

describe("unit: defineConfig — driver and logger", () => {
  it("valid driver and logger are kept (driver copied and frozen)", () => {
    const driver = { mode: "thick" as const, libDir: "/opt/ic" };
    const c = defineConfig({ pools: { a: pool }, driver, logger: console });
    expect(c.driver).toEqual(driver);
    expect(c.driver).not.toBe(driver);
    expect(Object.isFrozen(c.driver)).toBe(true);
    expect(c.logger).toBe(console);
    expect(defineConfig({ pools: { a: pool }, logger: false }).logger).toBe(false);
    const plain = defineConfig({ pools: { a: pool } });
    expect("driver" in plain).toBe(false);
    expect("logger" in plain).toBe(false);
  });

  it("reports bad driver and logger options with the pool issues", () => {
    expect(issuesOf(() => defineConfig({ pools: { a: pool }, driver: { mode: "fast", libDir: " ", x: 1 } as never, logger: {} as never }))).toEqual([
      "driver.x is not a driver option",
      'driver.mode must be "auto", "thin" or "thick"',
      "driver.libDir must be a non-empty string",
      "logger must have info, warn and error functions (debug optional), or be false",
    ]);
    expect(issuesOf(() => defineConfig({ pools: { a: pool }, driver: "thin" as never }))).toEqual(["driver must be an object"]);
  });
});

describe("unit: fromEnv", () => {
  const base = { MIRA_DB_USER: "APP", MIRA_DB_PASSWORD: "pw", MIRA_DB_CONNECT_STRING: "db:1521/APP" };

  it("defaults to one appDb pool under MIRA_DB; numbers parse, blanks are unset", () => {
    const c = fromEnv({ env: { ...base, MIRA_DB_POOL_MAX: " 20 ", MIRA_DB_POOL_MIN: "", MIRA_DB_POOL_PING_INTERVAL: "-1", MIRA_DB_QUEUE_TIMEOUT: "0" } });
    expect(c.defaultPool).toBe("appDb");
    expect(c.pools.appDb).toEqual({ user: "APP", password: "pw", connectString: "db:1521/APP", poolMax: 20, poolPingInterval: -1, queueTimeout: 0 });
  });

  it("reads process.env when no env is given", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { MIRA_PE_USER: "U", MIRA_PE_PASSWORD: "P", MIRA_PE_CONNECT_STRING: "h:1/s" });
      expect(fromEnv({ pools: { pe: "MIRA_PE" } }).pools.pe.user).toBe("U");
      expect(() => fromEnv()).toThrow(MiraConfigError); // no MIRA_DB_* in the test env
    } finally {
      for (const k of ["MIRA_PE_USER", "MIRA_PE_PASSWORD", "MIRA_PE_CONNECT_STRING"]) if (saved[k] === undefined) delete process.env[k];
    }
  });

  it("HOST + SERVICE build an Easy Connect string; PORT defaults to 1521", () => {
    const env = { MIRA_DB_USER: "u", MIRA_DB_PASSWORD: "p", MIRA_DB_HOST: "h", MIRA_DB_SERVICE: "svc" };
    expect(fromEnv({ env }).pools.appDb.connectString).toBe("h:1521/svc");
    expect(fromEnv({ env: { ...env, MIRA_DB_PORT: "1600" } }).pools.appDb.connectString).toBe("h:1600/svc");
    expect(fromEnv({ env: { ...env, MIRA_DB_CONNECT_STRING: "wins" } }).pools.appDb.connectString).toBe("wins");
  });

  it("several pools by prefix, with defaultPool", () => {
    const env = { ...base, MIRA_RPT_USER: "R", MIRA_RPT_PASSWORD: "r", MIRA_RPT_HOST: "rh", MIRA_RPT_SERVICE: "RPT" };
    const c = fromEnv({ env, pools: { appDb: "MIRA_DB", reporting: "MIRA_RPT" }, defaultPool: "reporting" });
    expect(c.poolNames).toEqual(["appDb", "reporting"]);
    expect(c.defaultPool).toBe("reporting");
    expect(c.pools.reporting.connectString).toBe("rh:1521/RPT");
  });

  it("names every missing or malformed variable, never a value", () => {
    const issues = issuesOf(() =>
      fromEnv({ env: { MIRA_DB_POOL_MAX: "twenty", MIRA_DB_QUEUE_MAX: "1.5", MIRA_DB_HOST: "h" }, pools: { appDb: "MIRA_DB", bad: "mira_x" as string, bad2: 7 as unknown as string } }),
    );
    expect(issues).toEqual([
      "MIRA_DB_USER is not set",
      "MIRA_DB_PASSWORD is not set",
      "set MIRA_DB_CONNECT_STRING, or MIRA_DB_HOST and MIRA_DB_SERVICE",
      "MIRA_DB_POOL_MAX must be a whole number",
      "MIRA_DB_QUEUE_MAX must be a whole number",
      'env prefix "mira_x" must be upper case letters, digits and _, starting with a letter',
      'env prefix "7" must be upper case letters, digits and _, starting with a letter',
    ]);
  });

  it("MIRA_DRIVER_MODE / MIRA_DRIVER_LIB_DIR set the driver when present", () => {
    expect("driver" in fromEnv({ env: base })).toBe(false);
    expect(fromEnv({ env: { ...base, MIRA_DRIVER_MODE: " thin " } }).driver).toEqual({ mode: "thin" });
    expect(fromEnv({ env: { ...base, MIRA_DRIVER_LIB_DIR: "/opt/ic" } }).driver).toEqual({ libDir: "/opt/ic" });
    expect(fromEnv({ env: { ...base, MIRA_DRIVER_MODE: "thick", MIRA_DRIVER_LIB_DIR: "/ic" } }).driver).toEqual({ mode: "thick", libDir: "/ic" });
    expect(issuesOf(() => fromEnv({ env: { ...base, MIRA_DRIVER_MODE: "turbo" } }))).toEqual(['driver.mode must be "auto", "thin" or "thick"']);
  });

  it("parsed numbers still go through defineConfig's ranges", () => {
    expect(issuesOf(() => fromEnv({ env: { ...base, MIRA_DB_POOL_MAX: "0" } }))).toEqual(["pools.appDb.poolMax must be an integer >= 1"]);
  });
});

describe("unit: runtime connection registry", () => {
  it("register adds a pool; unregister removes it", async () => {
    const m = await import("../../src/config/database.ts?registry-add");
    m.registerConnection("extraDb", { user: "u", password: "p", connectString: "h:1/s", poolMax: 3 });
    expect(m.getConnectionConfig("extraDb").poolMax).toBe(3);
    expect(m.getConnectionNames()).toEqual(["appDb", "appDbBulk", "extraDb"]);
    expect(m.POOL_NAMES).toEqual(["appDb", "appDbBulk"]);
    expect(() => m.registerConnection("extraDb", {})).toThrow('Connection "extraDb" is already registered by a live createMira() instance. Close that instance first.');
    expect(m.unregisterConnection("extraDb")).toBe(true);
    expect(m.unregisterConnection("extraDb")).toBe(false);
    expect(() => m.getConnectionConfig("extraDb")).toThrow(/Unknown connection "extraDb"/);
  });

  it("a built-in name is shadowed, then restored; built-ins cannot be unregistered", async () => {
    const m = await import("../../src/config/database.ts?registry-shadow");
    const original = m.getConnectionConfig("appDbBulk");
    m.registerConnection("appDbBulk", { user: "mine", password: "p", connectString: "h:1/s" });
    expect(m.getConnectionConfig("appDbBulk").user).toBe("mine");
    expect(m.unregisterConnection("appDbBulk")).toBe(true);
    expect(m.getConnectionConfig("appDbBulk")).toBe(original);
    expect(m.unregisterConnection("appDb")).toBe(false);
    expect(m.getConnectionConfig("appDb")).toBeDefined();
  });

  it("refuses bad names; lookups see own keys only", async () => {
    const m = await import("../../src/config/database.ts?registry-names");
    for (const bad of ["", "1x", "a-b", "__proto__", 5 as unknown as string]) {
      expect(() => m.registerConnection(bad, {})).toThrow(/^Invalid connection name/);
    }
    for (const inherited of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => m.getConnectionConfig(inherited)).toThrow(`Unknown connection "${inherited}"`);
    }
  });
});
