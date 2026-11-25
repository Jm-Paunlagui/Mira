/**
 * UNIT — src/config/adapters/oracle.ts driven by a scriptable stub driver.
 *
 * Each scenario loads a FRESH copy of the adapter (`import("…oracle.ts?tag")`)
 * with a stub `oracledb` placed in require.cache, so pool creation, acquire
 * races, retries, the health monitor and shutdown can be made to fail on cue.
 * The real adapter (and the real driver) used by the other suites is untouched.
 *
 * Timers: setTimeout is wrapped for this file only; `timeScale` shrinks long
 * delays (30 s health ticks, 5 s cool-downs, 30 s shutdown guard) to
 * milliseconds while a test needs them to fire.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import database from "../../src/config/database";
import * as realRuntime from "../../src/utils/runtimePaths";
import { logger } from "../../src/utils/logger";
import * as realAdapter from "../../src/config/adapters/oracle";

type Adapter = typeof import("../../src/config/adapters/oracle");
const realOracledb = realAdapter.oracledb;
const realSetTimeout = globalThis.setTimeout;
const wait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
let timeScale = 1;

// ── stub driver ────────────────────────────────────────────────────────────────
type StubConn = { ping: () => Promise<void>; close: () => Promise<void>; execute: (...a: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> };
type PoolScript = {
  create?: () => Promise<void> | void; // throw to fail createPool
  getConnection?: () => Promise<StubConn>;
  close?: () => Promise<void>;
  stats?: Partial<{ connectionsOpen: number; connectionsInUse: number; poolMin: number; poolMax: number; queueLength: number }>;
};
const scripts: Record<string, PoolScript> = {};
const conn = (over: Partial<StubConn> = {}): StubConn => ({
  ping: async () => {},
  close: async () => {},
  execute: async () => ({ rows: [] }),
  commit: async () => {},
  rollback: async () => {},
  ...over,
});
function makeDriver(extra: Record<string, unknown> = {}) {
  return {
    OUT_FORMAT_OBJECT: realOracledb.OUT_FORMAT_OBJECT,
    SYSDBA: realOracledb.SYSDBA,
    DB_TYPE_NUMBER: realOracledb.DB_TYPE_NUMBER,
    DB_TYPE_CLOB: realOracledb.DB_TYPE_CLOB,
    DB_TYPE_NCLOB: realOracledb.DB_TYPE_NCLOB,
    DB_TYPE_BLOB: realOracledb.DB_TYPE_BLOB,
    STRING: realOracledb.STRING,
    BUFFER: realOracledb.BUFFER,
    oracleClientVersion: undefined as number | undefined,
    initOracleClient: () => {
      throw new Error("NJS-077: already initialized");
    },
    async createPool(cfg: { user: string; poolAlias: string }) {
      const s = scripts[cfg.user] ?? {};
      await s.create?.();
      return {
        poolAlias: cfg.poolAlias,
        poolMin: 1,
        poolMax: 10,
        connectionsOpen: 0,
        connectionsInUse: 0,
        queueLength: 0,
        ...s.stats,
        getConnection: s.getConnection ?? (async () => conn()),
        close: s.close ?? (async () => {}),
      };
    },
    ...extra,
  };
}

// ── fresh-instance loader ──────────────────────────────────────────────────────
const oracledbKey = require.resolve("oracledb");
let seq = 0;
async function loadAdapter(driver: unknown, opts: { compiled?: boolean } = {}): Promise<Adapter> {
  const saved = require.cache[oracledbKey];
  require.cache[oracledbKey] = { id: oracledbKey, filename: oracledbKey, loaded: true, exports: driver } as never;
  if (opts.compiled) mock.module("../../src/utils/runtimePaths", () => ({ ...realRuntime, IS_COMPILED: true }));
  try {
    return (await import(`../../src/config/adapters/oracle.ts?fresh=${++seq}`)) as Adapter;
  } finally {
    if (opts.compiled) mock.module("../../src/utils/runtimePaths", () => ({ ...realRuntime }));
    require.cache[oracledbKey] = saved;
  }
}

// ── registry entries for stub pools ────────────────────────────────────────────
const conns = database.connections as Record<string, Record<string, unknown>>;
function register(name: string, script: PoolScript = {}, extra: Record<string, unknown> = {}) {
  scripts[name] = script;
  conns[name] = { user: name, password: "pw", connectString: "stub", poolMin: 1, poolMax: 10, ...extra };
}
const registered = () => Object.keys(conns).filter((k) => k.startsWith("s_"));

let A: Adapter;
beforeAll(async () => {
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms && ms > 1 ? Math.max(1, Math.round(ms * timeScale)) : ms, ...rest)) as typeof setTimeout;
  A = await loadAdapter(makeDriver());
});
afterAll(async () => {
  globalThis.setTimeout = realSetTimeout;
  for (const n of registered()) delete conns[n];
});

// ── load-time branches ─────────────────────────────────────────────────────────
describe("unit/adapter: driver loading and Oracle client environment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-ic-"));
  const envBackup = { ORACLE_INSTANT_CLIENT: process.env.ORACLE_INSTANT_CLIENT, PATH: process.env.PATH };
  afterAll(() => {
    process.env.ORACLE_INSTANT_CLIENT = envBackup.ORACLE_INSTANT_CLIENT;
    process.env.PATH = envBackup.PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("validateOracleClient: unset, missing dir, missing DLLs, complete install (both DLL names)", () => {
    delete process.env.ORACLE_INSTANT_CLIENT;
    expect(A.validateOracleClient()).toBe(false);
    process.env.ORACLE_INSTANT_CLIENT = path.join(tmp, "nope");
    expect(A.validateOracleClient()).toBe(false);
    process.env.ORACLE_INSTANT_CLIENT = tmp;
    expect(A.validateOracleClient()).toBe(false);
    fs.writeFileSync(path.join(tmp, "oci.dll"), "");
    fs.writeFileSync(path.join(tmp, "oraociei.dll"), "");
    expect(A.validateOracleClient()).toBe(true);
    fs.writeFileSync(path.join(tmp, "oraociei23.dll"), "");
    expect(A.validateOracleClient()).toBe(true);
  });

  it("setupOracleEnvironment prepends the client dir to PATH exactly once", () => {
    process.env.ORACLE_INSTANT_CLIENT = tmp;
    process.env.PATH = "/usr/bin";
    A.setupOracleEnvironment();
    expect(process.env.PATH).toBe(`${tmp};/usr/bin`);
    A.setupOracleEnvironment();
    expect(process.env.PATH).toBe(`${tmp};/usr/bin`);
    delete process.env.PATH;
    process.env.ORACLE_INSTANT_CLIENT = tmp + "x";
    A.setupOracleEnvironment();
    process.env.ORACLE_INSTANT_CLIENT = tmp;
    A.setupOracleEnvironment();
    expect(process.env.PATH).toBe(`${tmp};`);
    process.env.PATH = envBackup.PATH;
  });

  it("Thick mode: valid ORACLE_INSTANT_CLIENT → initOracleClient({ libDir })", async () => {
    process.env.ORACLE_INSTANT_CLIENT = tmp;
    let got: unknown;
    const a = await loadAdapter(makeDriver({ initOracleClient: (o: unknown) => { got = o; } }));
    expect(got).toEqual({ libDir: tmp });
    await a.closeAll();
  });

  it("Thick mode from PATH when no valid client dir; non-NJS-077 init errors are logged, not thrown", async () => {
    delete process.env.ORACLE_INSTANT_CLIENT;
    let got: unknown = "unset";
    const a = await loadAdapter(makeDriver({ initOracleClient: (o: unknown) => { got = o; } }));
    expect(got).toEqual({});
    const b = await loadAdapter(makeDriver({ initOracleClient: () => { throw new Error("DPI-1047: cannot locate a 64-bit Oracle Client library"); } }));
    const c = await loadAdapter(makeDriver({ oracleClientVersion: 1903000000 }));
    expect(c.oracledb.oracleClientVersion).toBe(1903000000);
    for (const x of [a, b, c]) await x.closeAll();
  });

  it("a driver that cannot load aborts the module (logged CRITICAL, rethrown)", async () => {
    const broken = makeDriver();
    Object.defineProperty(broken, "oracleClientVersion", { get() { throw new Error("driver exploded"); } });
    await expect(loadAdapter(broken)).rejects.toThrow("driver exploded");
  });

  it("compiled exe: reads .env from the working directory (existing keys win)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mira-env-"));
    fs.writeFileSync(path.join(dir, ".env"), "# comment\n\nNOEQUALS\nMIRA_COMPILED_PROBE = yes\nAPP_DB_USERNAME=should-not-override\n");
    const cwd = process.cwd();
    const userBefore = process.env.APP_DB_USERNAME;
    process.chdir(dir);
    try {
      delete process.env.MIRA_COMPILED_PROBE;
      // The existing value is whatever this machine set (.env locally, the job env in CI).
      process.env.APP_DB_USERNAME = "existing-user";
      const a = await loadAdapter(makeDriver(), { compiled: true });
      expect(process.env.MIRA_COMPILED_PROBE).toBe("yes");
      expect(process.env.APP_DB_USERNAME).toBe("existing-user");
      await a.closeAll();
    } finally {
      process.chdir(cwd);
      process.env.APP_DB_USERNAME = userBefore;
      delete process.env.MIRA_COMPILED_PROBE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compiled exe: unreadable .env is skipped and the absence is reported; connect string is collapsed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mira-env-"));
    fs.mkdirSync(path.join(dir, ".env")); // exists, but reading it throws EISDIR
    const cwd = process.cwd();
    process.chdir(dir);
    let seen = "";
    try {
      const a = await loadAdapter(
        makeDriver({ async createPool(cfg: { connectString: string; poolAlias: string }) { seen = cfg.connectString; return { poolAlias: cfg.poolAlias, getConnection: async () => conn(), close: async () => {} }; } }),
        { compiled: true },
      );
      register("s_compiled", {}, { connectString: "  (DESCRIPTION=\n   (ADDRESS=x))  " });
      await a.withConnection("s_compiled", async () => 1);
      expect(seen).toBe("(DESCRIPTION= (ADDRESS=x))");
      await a.closeAll();
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── pure helpers ───────────────────────────────────────────────────────────────
describe("unit/adapter: pure helpers", () => {
  it("toDriverConnectTimeoutSec rounds up, floors at 1 s, falls back on junk", () => {
    expect(A.toDriverConnectTimeoutSec(20000)).toBe(20);
    expect(A.toDriverConnectTimeoutSec(1)).toBe(1);
    expect(A.toDriverConnectTimeoutSec(1500)).toBe(2);
    expect(A.toDriverConnectTimeoutSec(0)).toBe(15);
    expect(A.toDriverConnectTimeoutSec(NaN)).toBe(15);
  });

  it("moneySafeFetchTypeHandler returns scaled NUMBERs as strings only", () => {
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_NUMBER, scale: 4 } as never)).toEqual({ type: realOracledb.STRING });
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_NUMBER, scale: 0 } as never)).toBeUndefined();
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_NUMBER } as never)).toBeUndefined();
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_VARCHAR, scale: 2 } as never)).toBeUndefined();
  });

  it("fetch handler materialises LOBs: CLOB / NCLOB → string, BLOB → Buffer", () => {
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_CLOB } as never)).toEqual({ type: realOracledb.STRING });
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_NCLOB } as never)).toEqual({ type: realOracledb.STRING });
    expect(A.moneySafeFetchTypeHandler({ dbType: realOracledb.DB_TYPE_BLOB } as never)).toEqual({ type: realOracledb.BUFFER });
  });

  it("constants", () => {
    expect(A.POOL_DEFAULTS.queueMax).toBe(40);
    expect(A.EXECUTE_OPTIONS.autoCommit).toBe(true);
    expect(A.SYSDBA_PRIVILEGE).toBe(realOracledb.SYSDBA);
  });
});

// ── pool lifecycle ─────────────────────────────────────────────────────────────
describe("unit/adapter: pool creation", () => {
  it("missing credentials throw; dev-mode placeholder only warns", async () => {
    register("s_nopw", {}, { password: "" });
    await expect(A.withConnection("s_nopw", async () => 1)).rejects.toThrow(/Missing config fields for "s_nopw": password/);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    register("s_placeholder", {}, { user: "placeholder_user", password: "", connectString: "" });
    scripts.placeholder_user = {};
    expect(await A.withConnection("s_placeholder", async () => "ran")).toBe("ran");
    process.env.NODE_ENV = env;
    register("s_prodplaceholder", {}, { user: "placeholder_x", password: "" });
    await expect(A.withConnection("s_prodplaceholder", async () => 1)).rejects.toThrow(/Missing config fields/);
  });

  it("unknown pool name is refused", async () => {
    await expect(A.withConnection("s_unregistered", async () => 1)).rejects.toThrow(/Unknown connection/);
  });

  it("createPool retries with backoff, then succeeds; a failed warm-up ping closes the partial pool", async () => {
    let attempts = 0;
    let closes = 0;
    register("s_flaky", {
      create: () => { if (++attempts < 3) throw new Error("ORA-12541: TNS:no listener"); },
    });
    timeScale = 0.001;
    expect(await A.withConnection("s_flaky", async () => "ok")).toBe("ok");
    expect(attempts).toBe(3);
    let pings = 0;
    register("s_pingfail", {
      getConnection: async () => conn({ ping: async () => { if (++pings === 1) throw new Error("ORA-03113"); } }),
      close: async () => { closes++; throw new Error("close failed too"); },
    });
    expect(await A.withConnection("s_pingfail", async () => "ok")).toBe("ok");
    expect(closes).toBe(1);
    timeScale = 1;
  });

  it("gives up after 4 attempts; the rejected pool is evicted after its cool-down and retried", async () => {
    let attempts = 0;
    register("s_dead", { create: () => { attempts++; throw new Error("ORA-01017: invalid username/password"); } });
    timeScale = 0.001;
    await expect(A.withConnection("s_dead", async () => 1)).rejects.toThrow(/s_dead/);
    expect(attempts).toBe(4);
    await expect(A.withConnection("s_dead", async () => 1)).rejects.toThrow(); // cached rejection, no new attempts
    expect(attempts).toBe(4);
    await wait(60); // 5 s cool-down at 1/1000 scale
    scripts.s_dead.create = () => {};
    expect(await A.withConnection("s_dead", async () => "recovered")).toBe("recovered");
    timeScale = 1;
  });

  it("initializePools reports per-pool success / failure with NJS-116 and NJS-046 hints", async () => {
    const B = await loadAdapter(makeDriver());
    register("s_njs116", { create: () => { throw new Error("NJS-116: password verifier type 0x939 is not supported"); } });
    register("s_njs046", { create: () => { throw new Error("NJS-046: poolAlias already exists"); } });
    timeScale = 0.001;
    const res = await B.initializePools();
    timeScale = 1;
    const byName = Object.fromEntries(res.map((r) => [r.name, r.success]));
    expect(byName.appDb).toBe(true);
    expect(byName.s_njs116).toBe(false);
    expect(byName.s_njs046).toBe(false);
    for (const n of ["s_njs116", "s_njs046", "s_dead", "s_nopw", "s_prodplaceholder", "s_placeholder"]) delete conns[n];
    const ok = await B.initializePools();
    expect(ok.every((r) => r.success)).toBe(true);
    await B.closeAll();
  });
});

// ── acquire / withConnection ───────────────────────────────────────────────────
describe("unit/adapter: acquire and withConnection", () => {
  it("transient acquire errors are retried (ORA-12516, ECONNRESET, NJS-500, wrapped chain)", async () => {
    const queue: unknown[] = [];
    let calls = 0;
    register("s_transient", { getConnection: async () => { calls++; if (queue.length) throw queue.shift(); return conn(); } });
    expect(await A.withConnection("s_transient", async () => "warm")).toBe("warm"); // pool warm-up
    queue.push(Object.assign(new Error("listener could not find handler"), { errorNum: 12516 }), Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    calls = 0;
    expect(await A.withConnection("s_transient", async () => "a")).toBe("a");
    expect(calls).toBe(3); // 2 retries, then served
    queue.push(Object.assign(new Error("outer"), { originalError: new Error("NJS-500: connection to the Oracle Database was broken") }));
    calls = 0;
    expect(await A.withConnection("s_transient", async () => "b")).toBe("b");
    expect(calls).toBe(2); // wrapped NJS-500 is transient
    queue.push(new Error("ORA-12541: a"), new Error("ORA-12541: b"), new Error("ORA-12541: c"));
    await expect(A.withConnection("s_transient", async () => 1)).rejects.toThrow(/ORA-12541: c/); // gives up after 3
  });

  it("non-transient errors (ORA-00001 anywhere in the chain, unknown) are not retried", async () => {
    let calls = 0;
    let mode: "dup" | "other" | "ok" = "ok";
    register("s_nontransient", {
      getConnection: async () => {
        calls++;
        if (mode === "dup") throw Object.assign(new Error("ORA-12541: wrapper"), { originalError: Object.assign(new Error("dup"), { errorNum: 1 }) });
        if (mode === "other") throw new Error("something unrelated");
        return conn();
      },
    });
    await A.withConnection("s_nontransient", async () => 1);
    mode = "dup";
    calls = 0;
    await expect(A.withConnection("s_nontransient", async () => 1)).rejects.toThrow(/wrapper/);
    expect(calls).toBe(1);
    mode = "other";
    calls = 0;
    await expect(A.withConnection("s_nontransient", async () => 1)).rejects.toThrow(/unrelated/);
    expect(calls).toBe(1);
    // an error with no message at all
    scripts.s_nontransient.getConnection = async () => { throw {}; };
    await expect(A.withConnection("s_nontransient", async () => 1)).rejects.toThrow();
  });

  it("acquire timeout races the driver; late connections are closed (orphan guard), late failures ignored", async () => {
    let mode: "late-ok" | "late-close-fails" | "late-reject" | "fast" = "fast";
    let orphanClosed = 0;
    register(
      "s_slow",
      {
        getConnection: () => {
          const m = mode; // behaviour fixed at acquire time
          if (m === "fast") return Promise.resolve(conn());
          return new Promise<StubConn>((resolve, reject) =>
            realSetTimeout(() => {
              if (m === "late-reject") reject(new Error("too late"));
              else resolve(conn({ close: async () => { orphanClosed++; if (m === "late-close-fails") throw new Error("close failed"); } }));
            }, 40),
          );
        },
      },
      { connectTimeout: 10 },
    );
    await A.withConnection("s_slow", async () => 1);
    for (const m of ["late-ok", "late-close-fails", "late-reject"] as const) {
      mode = m;
      await expect(A.withConnection("s_slow", async () => 1)).rejects.toThrow(/Timed out getting connection from "s_slow"/);
    }
    await wait(150);
    // 3 attempts each for the two resolving modes, plus the health check the timeouts nudge
    // (its own acquire also lands late and is closed).
    expect(orphanClosed).toBeGreaterThanOrEqual(6);
    expect(orphanClosed).toBeLessThanOrEqual(8);
    mode = "fast";
  });

  it("callback must be a function", async () => {
    await expect(A.withConnection("s_basic", "nope" as never)).rejects.toThrow(TypeError);
  });

  it("operational errors pass through unwrapped; driver errors are wrapped with context", async () => {
    register("s_basic");
    const op = Object.assign(new Error("conflict"), { isOperational: true });
    await expect(A.withConnection("s_basic", async () => { throw op; })).rejects.toBe(op);
    const wrapped = await A.withConnection("s_basic", async () => { throw new Error("ORA-00942: table or view does not exist"); }).catch((e) => e);
    expect(wrapped.message).toContain("ORA-00942");
    expect(wrapped.connectionName).toBe("s_basic");
    expect(wrapped.originalError.message).toContain("ORA-00942");
    expect(typeof wrapped.durationMs).toBe("number");
  });

  it("slow operations (> 5 s) are flagged; close failures after the callback are only logged", async () => {
    const realNow = Date.now;
    let closeFails = false;
    register("s_closefail", { getConnection: async () => conn({ close: async () => { if (closeFails) throw new Error("NJS-003"); } }) });
    await A.withConnection("s_closefail", async () => 1); // warm-up close must succeed
    closeFails = true;
    expect(await A.withConnection("s_closefail", async () => "closed-badly")).toBe("closed-badly");
    const r = await A.withConnection("s_closefail", async () => {
      const t = realNow();
      Date.now = () => t + 6000;
      return "slow";
    });
    Date.now = realNow;
    expect(r).toBe("slow");
  });

  it("withTransaction commits, rolls back, and survives a failing rollback", async () => {
    const log: string[] = [];
    let rollbackFails = false;
    register("s_tx", {
      getConnection: async () =>
        conn({
          commit: async () => { log.push("commit"); },
          rollback: async () => { log.push("rollback"); if (rollbackFails) throw new Error("ORA-03113"); },
        }),
    });
    expect(await A.withTransaction("s_tx", async () => "done")).toBe("done");
    await expect(A.withTransaction("s_tx", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    rollbackFails = true;
    await expect(A.withTransaction("s_tx", async () => { throw new Error("boom2"); })).rejects.toThrow("boom2");
    expect(log).toEqual(["commit", "rollback", "rollback"]);
  });

  it("withBatchConnection: validates input, records per-op results, aborts on fatal ORA-00028", async () => {
    await expect(A.withBatchConnection("s_tx", [])).rejects.toThrow(TypeError);
    await expect(A.withBatchConnection("s_tx", "x" as never)).rejects.toThrow(TypeError);
    const res = await A.withBatchConnection("s_tx", [async () => 1, 2 as never, async () => { throw new Error("op"); }]);
    expect(res).toEqual([
      { success: true, result: 1, index: 0 },
      { success: false, error: "Op 1 is not a function.", index: 1 },
      { success: false, error: "op", index: 2 },
    ]);
    await expect(A.withBatchConnection("s_tx", [async () => { throw Object.assign(new Error("killed"), { code: "ORA-00028" }); }])).rejects.toThrow(/killed/);
  });
});

// ── health monitor / circuit breaker ───────────────────────────────────────────
describe("unit/adapter: health monitor and circuit breaker", () => {
  it("test seam refuses to run outside NODE_ENV=test", () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    expect(() => A.__setPoolHealthForTest("s_tx", false)).toThrow(/test-only seam/);
    process.env.NODE_ENV = env;
  });

  it("an open breaker fails fast with NJS-503; bypassBreaker still reaches the pool; probe success closes it", async () => {
    const changes: unknown[] = [];
    const off = A.onPoolHealthChange((c) => changes.push(c));
    A.__setPoolHealthForTest("s_tx", false);
    expect(A.isPoolHealthy("s_tx")).toBe(false);
    expect(A.allPoolsHealthy()).toBe(false);
    await expect(A.withConnection("s_tx", async () => 1)).rejects.toThrow(/s_tx/);
    expect(await A.withConnection("s_tx", async () => "probe", { bypassBreaker: true })).toBe("probe");
    await expect(A.withConnection("s_tx", async () => { throw new Error("ORA-12541: no listener"); }, { bypassBreaker: true })).rejects.toThrow();
    A.recordProbeSuccess("s_tx");
    A.recordProbeSuccess("s_tx");
    expect(A.isPoolHealthy("s_tx")).toBe(true);
    expect(A.allPoolsHealthy()).toBe(true);
    expect(changes).toEqual([{ name: "s_tx", healthy: false }, { name: "s_tx", healthy: true }]);
    off();
    expect(A.getHealthMetrics()).toHaveProperty("s_tx");
    expect(A.isPoolHealthy("never-seen")).toBe(true);
  });

  it("listener faults never break the monitor", async () => {
    const off1 = A.onPoolHealthChange(() => { throw new Error("listener bug"); });
    const off2 = A.onPoolHealthCheck(() => { throw new Error("listener bug"); });
    A.__setPoolHealthForTest("s_tx", false);
    A.__setPoolHealthForTest("s_tx", true);
    timeScale = 0.001;
    A.nudgePoolHealth("s_tx"); // a real check → "check" listener throws → swallowed
    for (let i = 0; i < 50 && !A.getHealthMetrics().s_tx; i++) await wait(5);
    await wait(20);
    timeScale = 1;
    off1();
    off2();
    expect(A.isPoolHealthy("s_tx")).toBe(true);
  });

  it("connectivity failures nudge a check; 3 failed checks open the breaker; recovery is noticed", async () => {
    let up = true;
    let pingCloseFails = false;
    register("s_flap", {
      getConnection: async () => {
        if (!up) throw new Error("ORA-12541: TNS:no listener");
        return conn({ close: async () => { if (pingCloseFails) throw new Error("close during check"); } });
      },
    });
    await A.withConnection("s_flap", async () => 1);
    const checks: { name: string; ok: boolean }[] = [];
    const off = A.onPoolHealthCheck((c) => checks.push(c));
    up = false;
    timeScale = 0.001;
    // Re-arm the monitor's timer under the fast scale (an earlier scenario left a real 5 s tick pending).
    A.setPoolHealthWatched(true);
    A.setPoolHealthWatched(false);
    // real traffic hits a connectivity error → nudge (debounced) → checks start at the fast cadence
    await expect(A.withConnection("s_flap", async () => 1)).rejects.toThrow(/ORA-12541/);
    A.nudgePoolHealth("s_flap");
    A.nudgePoolHealth("s_flap");
    for (let i = 0; i < 100 && A.isPoolHealthy("s_flap"); i++) await wait(10);
    expect(A.isPoolHealthy("s_flap")).toBe(false);
    await expect(A.withConnection("s_flap", async () => 1)).rejects.toThrow(/s_flap/); // breaker open
    up = true;
    pingCloseFails = true;
    for (let i = 0; i < 100 && !A.isPoolHealthy("s_flap"); i++) await wait(10);
    expect(A.isPoolHealthy("s_flap")).toBe(true);
    expect(checks.some((c) => c.name === "s_flap" && !c.ok)).toBe(true);
    expect(checks.some((c) => c.name === "s_flap" && c.ok)).toBe(true);
    off();
    timeScale = 1;
  });

  it("watched mode re-arms the schedule; a check that itself throws is logged, not fatal", async () => {
    timeScale = 0.001;
    A.setPoolHealthWatched(true);
    A.setPoolHealthWatched(true); // no-op
    await wait(30);
    let warm = true;
    register("s_throwcheck", { getConnection: async () => { if (warm) return conn(); throw new Error("ORA-12541"); } });
    await A.withConnection("s_throwcheck", async () => 1);
    warm = false;
    const realWarning = logger.warning;
    let thrown = 0;
    (logger as { warning: unknown }).warning = (...a: unknown[]) => {
      if (thrown++ === 0) throw new Error("logger down");
      return (realWarning as (...x: unknown[]) => unknown).apply(logger, a);
    };
    A.nudgePoolHealth("s_throwcheck"); // check fails → its failure log throws → checkPool rejects → _runCheck logs it
    await wait(50);
    (logger as { warning: unknown }).warning = realWarning;
    expect(thrown).toBeGreaterThan(1);
    A.setPoolHealthWatched(false);
    timeScale = 1;
  });
});

// ── stats and shutdown ─────────────────────────────────────────────────────────
describe("unit/adapter: stats and shutdown", () => {
  it("getPoolStats: utilisation recommendations and failed pools", async () => {
    register("s_hot", { stats: { connectionsOpen: 10, connectionsInUse: 9, poolMax: 10 } });
    register("s_mid", { stats: { connectionsOpen: 10, connectionsInUse: 5, poolMax: 0 } });
    register("s_cold", { stats: { connectionsOpen: 0, connectionsInUse: 0 } });
    register("s_broken", { create: () => { throw new Error("nope"); } });
    for (const n of ["s_hot", "s_mid", "s_cold"]) await A.withConnection(n, async () => 1);
    timeScale = 0.001;
    await A.withConnection("s_broken", async () => 1).catch(() => {});
    timeScale = 1;
    const stats = await A.getPoolStats();
    const pools = stats.pools as Record<string, Record<string, unknown>>;
    expect(pools.s_hot).toMatchObject({ utilizationPct: "90%", recommendation: "Increase poolMax", isHighUtilization: true, isNearCapacity: true });
    expect(pools.s_mid).toMatchObject({ recommendation: "Optimal", capacityPct: "0%" });
    expect(pools.s_cold).toMatchObject({ utilizationPct: "0%", recommendation: "Pool oversized" });
    expect(pools.s_broken).toHaveProperty("error");
  });

  it("closeAll: drains, tolerates close errors and hung pools (30 s guard), refuses new work, is idempotent", async () => {
    const C = await loadAdapter(makeDriver());
    register("s_close_err", { close: async () => { throw new Error("NJS-104"); } });
    register("s_close_hang", { close: () => new Promise(() => {}) });
    register("s_retrying", { create: () => { throw new Error("ORA-12541"); } });
    await C.withConnection("s_close_err", async () => 1);
    await C.withConnection("s_close_hang", async () => 1);
    timeScale = 1; // keep the retry sleeping while we shut down
    const retrying = C.withConnection("s_retrying", async () => 1).catch((e) => e);
    await wait(5);
    timeScale = 0.001;
    await C.closeAll();
    timeScale = 1;
    expect(((await retrying) as Error).message).toMatch(/shutting down|s_retrying/);
    await C.closeAll(); // second call only warns
    await expect(C.withConnection("s_close_err", async () => 1)).rejects.toThrow(/shutting down/);
  });

  it("DEFECT: isPoolHealthy reports false once closeAll has shut the pools down", async () => {
    const H = await loadAdapter(makeDriver());
    register("s_health_close");
    await H.withConnection("s_health_close", async () => 1);
    expect(H.isPoolHealthy("s_health_close")).toBe(true);
    await H.closeAll();
    expect(H.isPoolHealthy("s_health_close")).toBe(false);
    expect(H.isPoolHealthy("never-seen")).toBe(false);
  });

  it("a pool creation that fails during shutdown stops retrying", async () => {
    const D = await loadAdapter(makeDriver());
    let attempts = 0;
    register("s_stop", { create: () => { attempts++; throw new Error("ORA-12541"); } });
    const p = D.withConnection("s_stop", async () => 1).catch((e) => e);
    await wait(5);
    timeScale = 0.001;
    const closing = D.closeAll();
    await closing;
    const err = (await p) as Error;
    timeScale = 1;
    expect(err).toBeInstanceOf(Error);
    expect(attempts).toBeLessThanOrEqual(2);
  });

  it("main stub adapter shuts down cleanly", async () => {
    await A.closeAll();
    await expect(A.withConnection("s_tx", async () => 1)).rejects.toThrow(/shutting down/);
  });
});

describe("unit/adapter: Thick-mode safety (2.1)", () => {
  const captureWarnings = async (fn: () => Promise<void>) => {
    const real = logger.warning;
    const seen: string[] = [];
    (logger as { warning: unknown }).warning = (msg: unknown) => void seen.push(String(msg));
    try {
      await fn();
    } finally {
      (logger as { warning: unknown }).warning = real;
    }
    return seen;
  };
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  it("sets ORA_SDTZ=+00:00 before the client loads, unless it is already set", async () => {
    await withEnv({ ORA_SDTZ: undefined }, async () => {
      await loadAdapter(makeDriver());
      expect(process.env.ORA_SDTZ).toBe("+00:00");
    });
    await withEnv({ ORA_SDTZ: "  " }, async () => {
      await loadAdapter(makeDriver());
      expect(process.env.ORA_SDTZ).toBe("+00:00");
    });
    await withEnv({ ORA_SDTZ: "-05:00" }, async () => {
      await loadAdapter(makeDriver());
      expect(process.env.ORA_SDTZ).toBe("-05:00");
    });
  });

  it("warns when a Thick-mode pool can outgrow UV_THREADPOOL_SIZE; never in Thin mode", async () => {
    const run = async (driver: unknown, uv: string | undefined) =>
      captureWarnings(() =>
        withEnv({ UV_THREADPOOL_SIZE: uv }, async () => {
          const a = await loadAdapter(driver);
          register("s_threads", { stats: { poolMax: 10 } });
          await a.withConnection("s_threads", async () => 1);
          await a.closeAll();
        }),
      );
    const thick = () => makeDriver({ oracleClientVersion: 1906000000 });
    const unset = await run(thick(), undefined);
    expect(unset.filter((w) => w.includes("UV_THREADPOOL_SIZE"))).toEqual([
      'Pool "s_threads" can open 10 connections, but Thick mode runs each call on one of 4 worker threads (UV_THREADPOOL_SIZE not set; Node\'s default is 4). Calls waiting on row locks can hold every thread and hang the process: set UV_THREADPOOL_SIZE=10 or more before the process starts.',
    ]);
    const small = await run(thick(), "6");
    expect(small.filter((w) => w.includes("UV_THREADPOOL_SIZE"))).toEqual([
      'Pool "s_threads" can open 10 connections, but Thick mode runs each call on one of 6 worker threads (UV_THREADPOOL_SIZE). Calls waiting on row locks can hold every thread and hang the process: set UV_THREADPOOL_SIZE=10 or more before the process starts.',
    ]);
    expect((await run(thick(), "10")).filter((w) => w.includes("UV_THREADPOOL_SIZE"))).toEqual([]);
    expect((await run(thick(), "junk")).some((w) => w.includes("not set; Node's default is 4"))).toBe(true);
    expect((await run(makeDriver(), undefined)).filter((w) => w.includes("UV_THREADPOOL_SIZE"))).toEqual([]);
  });
});
