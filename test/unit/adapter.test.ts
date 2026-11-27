/**
 * UNIT — src/driver/oracle.ts driven by a scriptable stub driver.
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
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import database from "../../src/driver/registry";
import { setLogger, getLogger } from "../../src/shared/log";
import * as realAdapter from "../../src/driver/oracle";

type Adapter = typeof import("../../src/driver/oracle");
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
async function loadAdapter(driver: unknown): Promise<Adapter> {
  const saved = require.cache[oracledbKey];
  require.cache[oracledbKey] = { id: oracledbKey, filename: oracledbKey, loaded: true, exports: driver } as never;
  try {
    return (await import(`../../src/driver/oracle.ts?fresh=${++seq}`)) as Adapter;
  } finally {
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
describe("unit/adapter: driver loading and Oracle client", () => {
  const envClient = process.env.ORACLE_INSTANT_CLIENT;
  afterAll(() => {
    if (envClient === undefined) delete process.env.ORACLE_INSTANT_CLIENT;
    else process.env.ORACLE_INSTANT_CLIENT = envClient;
  });

  it("auto: importing touches nothing; initDriver tries the system library path once; ORACLE_INSTANT_CLIENT is not read", async () => {
    process.env.ORACLE_INSTANT_CLIENT = "/env/should/not/be/read";
    let got: unknown;
    const a = await loadAdapter(makeDriver({ initOracleClient: (o: unknown) => { got = o; } }));
    expect(got).toBeUndefined(); // importing the adapter no longer touches the driver
    expect(a.initDriver()).toEqual({ mode: "thin" }); // the stub reports no client version
    expect(got).toEqual({});
    expect(a.initDriver()).toBe(a.initDriver()); // once per process
    await a.closeAll();
  });

  it("auto: the system path again; non-NJS-077 init errors are logged, not thrown", async () => {
    let got: unknown = "unset";
    const a = await loadAdapter(makeDriver({ initOracleClient: (o: unknown) => { got = o; } }));
    a.initDriver();
    expect(got).toEqual({});
    // No client: an ordinary Thin start, so a one-line notice, not a warning. A libDir that fails is a warning.
    const before = getLogger();
    const seen: string[] = [];
    setLogger({ info: (m: string) => void seen.push(`info ${m}`), warn: (m: string) => void seen.push(`warn ${m}`), error() {} });
    let b: Adapter;
    try {
      const dpi = () => { throw new Error("DPI-1047: cannot locate a 64-bit Oracle Client library\nNode-oracledb installation instructions: …"); };
      b = await loadAdapter(makeDriver({ initOracleClient: dpi }));
      expect(b.initDriver().mode).toBe("thin");
      const withDir = await loadAdapter(makeDriver({ initOracleClient: dpi }));
      withDir.configureDriver({ libDir: "/opt/missing" });
      expect(withDir.initDriver().mode).toBe("thin");
    } finally {
      setLogger(before);
    }
    expect(seen.filter((l) => /Oracle Client|Oracle client/.test(l))).toEqual([
      "info No Oracle Client on the library path; using Thin mode (DPI-1047: cannot locate a 64-bit Oracle Client library).",
      "warn Oracle client init from /opt/missing failed; using Thin mode: DPI-1047: cannot locate a 64-bit Oracle Client library\nNode-oracledb installation instructions: …",
    ]);
    const c = await loadAdapter(makeDriver({ oracleClientVersion: 1903000000 }));
    expect(c.initDriver()).toEqual({ mode: "thick", clientVersion: 1903000000 });
    expect(c.oracledb.oracleClientVersion).toBe(1903000000);
    for (const x of [a, b, c]) await x.closeAll();
  });

  it("a driver that fails to initialise throws from initDriver (logged CRITICAL), not at import", async () => {
    const broken = makeDriver();
    Object.defineProperty(broken, "oracleClientVersion", { get() { throw new Error("driver exploded"); } });
    const a = await loadAdapter(broken);
    expect(() => a.initDriver()).toThrow("driver exploded");
    expect(() => a.initDriver()).toThrow("driver exploded"); // not cached: retried next time
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
  it("missing credentials throw, in every environment", async () => {
    register("s_nopw", {}, { password: "" });
    await expect(A.withConnection("s_nopw", async () => 1)).rejects.toThrow(/Missing config fields for "s_nopw": password/);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      register("s_placeholder", {}, { user: "placeholder_user", password: "", connectString: "" });
      await expect(A.withConnection("s_placeholder", async () => "ran")).rejects.toThrow(/Missing config fields for "s_placeholder": password, connectString/);
    } finally {
      process.env.NODE_ENV = env;
    }
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
    for (const n of ["s_njs116", "s_njs046", "s_dead", "s_nopw", "s_placeholder"]) delete conns[n];
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
    const before = getLogger();
    let thrown = 0;
    setLogger({ info() {}, warn: () => { if (thrown++ === 0) throw new Error("logger down"); }, error() {} });
    A.nudgePoolHealth("s_throwcheck"); // check fails → its failure log throws → checkPool rejects → _runCheck logs it
    await wait(50);
    setLogger(before);
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
    const before = getLogger();
    const seen: string[] = [];
    setLogger({ info() {}, warn: (msg: string) => void seen.push(String(msg)), error() {} });
    try {
      await fn();
    } finally {
      setLogger(before);
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
      const a = await loadAdapter(makeDriver());
      expect(process.env.ORA_SDTZ).toBeUndefined(); // not at import
      a.initDriver();
      expect(process.env.ORA_SDTZ).toBe("+00:00");
    });
    await withEnv({ ORA_SDTZ: "  " }, async () => {
      (await loadAdapter(makeDriver())).initDriver();
      expect(process.env.ORA_SDTZ).toBe("+00:00");
    });
    await withEnv({ ORA_SDTZ: "-05:00" }, async () => {
      (await loadAdapter(makeDriver())).initDriver();
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

describe("unit/adapter: driver mode — configureDriver / initDriver (2.2)", () => {
  const spyDriver = (extra: Record<string, unknown> = {}) => {
    const calls: unknown[] = [];
    const d = makeDriver({ initOracleClient: (o: unknown) => void calls.push(o), ...extra });
    return { d: d as typeof d & { fetchTypeHandler?: unknown; fetchArraySize?: number }, calls };
  };
  it("thin: never loads an Oracle Client; driver-wide settings apply at init, not import", async () => {
    const { d, calls } = spyDriver();
    const a = await loadAdapter(d);
    expect(d.fetchTypeHandler).toBeUndefined();
    a.configureDriver({ mode: "thin" });
    expect(a.initDriver()).toEqual({ mode: "thin" });
    expect(calls).toEqual([]);
    expect(d.fetchTypeHandler).toBe(a.moneySafeFetchTypeHandler);
    expect(d.fetchArraySize).toBe(1000);
  });

  it("the first pool initialises the driver as configured", async () => {
    const { d, calls } = spyDriver();
    const a = await loadAdapter(d);
    a.configureDriver({ mode: "thick", libDir: "/opt/ic" });
    register("s_drv_first");
    await a.withConnection("s_drv_first", async () => 1);
    expect(calls).toEqual([{ libDir: "/opt/ic" }]);
    await a.closeAll();
  });

  it("thick: libDir, else the system path; NJS-077 is fine, other errors throw", async () => {
    let x = spyDriver();
    let a = await loadAdapter(x.d);
    a.configureDriver({ mode: "thick", libDir: "/opt/ic" });
    a.initDriver();
    expect(x.calls).toEqual([{ libDir: "/opt/ic" }]);

    x = spyDriver();
    a = await loadAdapter(x.d);
    a.configureDriver({ mode: "thick" });
    a.initDriver();
    expect(x.calls).toEqual([{}]);

    x = spyDriver({ oracleClientVersion: 2300000000 });
    a = await loadAdapter(x.d);
    a.configureDriver({ mode: "thick" });
    expect(a.initDriver()).toEqual({ mode: "thick", clientVersion: 2300000000 });
    expect(x.calls).toEqual([]); // already loaded

    a = await loadAdapter(makeDriver()); // stub init throws NJS-077
    a.configureDriver({ mode: "thick" });
    expect(a.initDriver().mode).toBe("thin");

    a = await loadAdapter(makeDriver({ initOracleClient: () => { throw new Error("DPI-1047: no client"); } }));
    a.configureDriver({ mode: "thick", libDir: "/nope" });
    expect(() => a.initDriver()).toThrow("DPI-1047: no client");
  });

  it("auto with libDir: passed as is", async () => {
    const { d, calls } = spyDriver();
    const a = await loadAdapter(d);
    a.configureDriver({ mode: "auto", libDir: "/opt/instantclient_23" });
    a.initDriver();
    expect(calls).toEqual([{ libDir: "/opt/instantclient_23" }]);
  });

  it("binaryDir (compiled executables) is passed to initOracleClient in every Thick path", async () => {
    let x = spyDriver();
    let a = await loadAdapter(x.d);
    a.configureDriver({ mode: "thick", libDir: "/ic", binaryDir: "/app/oracledb" });
    a.initDriver();
    expect(x.calls).toEqual([{ libDir: "/ic", binaryDir: "/app/oracledb" }]);
    x = spyDriver();
    a = await loadAdapter(x.d);
    a.configureDriver({ binaryDir: "/app/oracledb" }); // auto, no client dir → system path
    a.initDriver();
    expect(x.calls).toEqual([{ binaryDir: "/app/oracledb" }]);
    a.configureDriver({ binaryDir: "/app/oracledb" });
    expect(() => a.configureDriver({ binaryDir: "/elsewhere" })).toThrow("already initialised as thin (binaryDir /app/oracledb); it cannot change to auto (binaryDir /elsewhere)");
  });

  it("configureDriver validates; after init it accepts compatible options only", async () => {
    const a = await loadAdapter(makeDriver({ oracleClientVersion: 2300000000 }));
    expect(() => a.configureDriver({ mode: "fast" as "thin", libDir: "", binaryDir: 3, extra: 1 } as never)).toThrow(
      '[mira] Invalid config:\n  - driver.extra is not a driver option\n  - driver.mode must be "auto", "thin" or "thick"\n  - driver.libDir must be a non-empty string\n  - driver.binaryDir must be a non-empty string',
    );
    a.configureDriver(); // defaults to auto
    a.initDriver();
    a.configureDriver();
    a.configureDriver({ mode: "thick" });
    expect(() => a.configureDriver({ mode: "thin" })).toThrow(
      "[mira] The Oracle driver is already initialised as thick; it cannot change to thin in this process. Set the driver before the first pool opens.",
    );
    expect(() => a.configureDriver({ libDir: "/other" })).toThrow("already initialised as thick; it cannot change to auto (/other)");

    const b = await loadAdapter(makeDriver());
    b.configureDriver({ libDir: "/ic" });
    b.initDriver();
    b.configureDriver({ libDir: "/ic", mode: "thin" });
    expect(() => b.configureDriver({ mode: "thick" })).toThrow("already initialised as thin (/ic); it cannot change to thick");
  });
});

describe("unit/adapter: closePool during pool creation (3.0)", () => {
  it("an attempt still in flight is not retried once the pool is closed", async () => {
    const a = await loadAdapter(makeDriver());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let creates = 0;
    register("s_close_inflight", { create: async () => { creates++; await gate; throw new Error("ORA-12541: TNS:no listener"); } });
    const pending = a.withConnection("s_close_inflight", async () => 1).catch((e: Error) => e);
    await wait(5);
    const closing = a.closePool("s_close_inflight");
    release();
    await closing;
    expect(((await pending) as Error).message).toMatch(/"s_close_inflight" was closed while it was being created; not retrying/);
    expect(creates).toBe(1);
  });

  it("a creation waiting out its backoff stops there", async () => {
    const a = await loadAdapter(makeDriver());
    const realRandom = Math.random;
    Math.random = () => 0.5; // backoff sleep = 500 ms, long enough to close during it
    let creates = 0;
    register("s_close_backoff", { create: () => { creates++; throw new Error("ORA-12541: TNS:no listener"); } });
    try {
      const pending = a.withConnection("s_close_backoff", async () => 1).catch((e: Error) => e);
      await wait(50); // attempt 1 has failed; the retry is sleeping
      const started = Date.now();
      await a.closePool("s_close_backoff");
      expect(((await pending) as Error).message).toMatch(/was closed while it was being created/);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(creates).toBe(1);
    } finally {
      Math.random = realRandom;
    }
  });
});

describe("unit/adapter: releasing a connection the server already closed (3.0)", () => {
  it("a reset that throws (dead session) neither replaces the error nor skips the release: the connection is dropped", async () => {
    const a = await loadAdapter(makeDriver());
    const closes: unknown[] = [];
    const dead = conn({ close: async (...args: unknown[]) => void closes.push(args[0] ?? "plain") } as never);
    Object.defineProperty(dead, "callTimeout", {
      get: () => 500,
      set: () => { throw new Error("DPI-1010: not connected"); },
    });
    register("s_dead_session", { getConnection: async () => dead });
    const err = await a
      .withConnection("s_dead_session", async () => { throw new Error("NJS-500: connection to Oracle Database was closed or broken"); })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/NJS-500/);
    expect((err as Error).message).not.toMatch(/DPI-1010/);
    expect(closes).toEqual(["plain", { drop: true }]); // the pool's warm-up ping, then the dead session dropped

    // A live session with a callTimeout is reset and returned to the pool as usual.
    const live = conn({ close: async (...args: unknown[]) => void closes.push(args[0] ?? "plain") } as never) as ReturnType<typeof conn> & { callTimeout: number };
    live.callTimeout = 500;
    register("s_live_session", { getConnection: async () => live });
    expect(await a.withConnection("s_live_session", async () => "ok")).toBe("ok");
    expect(live.callTimeout).toBe(0);
    expect(closes).toEqual(["plain", { drop: true }, "plain", "plain"]); // + the new pool's warm-up, then returned
    await a.closeAll();
  });
});

describe("unit/adapter: session time zone per pooled session (3.0)", () => {
  // Under Bun a runtime process.env change never reaches the Oracle Client, so ORA_SDTZ alone
  // left Thick-mode sessions in the machine's zone. Every pool sets it in its sessionCallback.
  const capture = () => {
    const seen: { cfg?: { sessionCallback?: (c: unknown, tag: string, done: (e?: Error) => void) => void } } = {};
    const driver = makeDriver({
      async createPool(cfg: { poolAlias: string; sessionCallback?: never }) {
        seen.cfg = cfg;
        return { poolAlias: cfg.poolAlias, poolMin: 1, poolMax: 1, connectionsOpen: 0, connectionsInUse: 0, getConnection: async () => conn(), close: async () => {} };
      },
    });
    return { seen, driver };
  };
  const runCallback = (cb: NonNullable<NonNullable<ReturnType<typeof capture>["seen"]["cfg"]>["sessionCallback"]>, fail = false) =>
    new Promise<{ sql: string; err?: Error }>((resolve) => {
      let sql = "";
      const c = { execute: async (s: string) => { sql = s; if (fail) throw new Error("ORA-01882: timezone region not found"); return {}; } };
      cb(c, "", (err) => resolve({ sql, err }));
    });
  const withSdtz = async (value: string | undefined, fn: () => Promise<void>) => {
    const before = process.env.ORA_SDTZ;
    if (value === undefined) delete process.env.ORA_SDTZ;
    else process.env.ORA_SDTZ = value;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.ORA_SDTZ;
      else process.env.ORA_SDTZ = before;
    }
  };

  it("default +00:00: every new session runs ALTER SESSION SET TIME_ZONE; a failure reaches the driver", async () => {
    await withSdtz(undefined, async () => {
      const { seen, driver } = capture();
      const a = await loadAdapter(driver);
      register("s_tz_default");
      await a.withConnection("s_tz_default", async () => 1);
      const cb = seen.cfg!.sessionCallback!;
      expect(await runCallback(cb)).toEqual({ sql: "ALTER SESSION SET TIME_ZONE = '+00:00'", err: undefined });
      const failed = await runCallback(cb, true);
      expect(failed.err?.message).toMatch(/ORA-01882/);
      await a.closeAll();
    });
  });

  it("an ORA_SDTZ the caller set wins; one that could break out of the SQL literal is refused with a warning", async () => {
    await withSdtz("Asia/Manila", async () => {
      const { seen, driver } = capture();
      const a = await loadAdapter(driver);
      register("s_tz_own");
      await a.withConnection("s_tz_own", async () => 1);
      expect((await runCallback(seen.cfg!.sessionCallback!)).sql).toBe("ALTER SESSION SET TIME_ZONE = 'Asia/Manila'");
      await a.closeAll();
    });
    await withSdtz("+08:00' ; DROP TABLE X --", async () => {
      const before = getLogger();
      const warnings: string[] = [];
      setLogger({ info() {}, warn: (m: string) => void warnings.push(m), error() {} });
      try {
        const { seen, driver } = capture();
        const a = await loadAdapter(driver);
        register("s_tz_bad");
        await a.withConnection("s_tz_bad", async () => 1);
        expect(seen.cfg!.sessionCallback).toBeUndefined();
        expect(warnings.some((w) => w.startsWith("ORA_SDTZ is not an offset"))).toBe(true);
        await a.closeAll();
      } finally {
        setLogger(before);
      }
    });
  });
});
