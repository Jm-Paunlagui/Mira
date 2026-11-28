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
import { Readable } from "node:stream";
import database from "../../src/driver/registry";
import { setLogger, getLogger } from "../../src/shared/log";
import * as realAdapter from "../../src/driver/oracle";
import { MiraDbError, CODE_KIND, type MiraErrorCode } from "../../src/driver/errors";

type Adapter = typeof import("../../src/driver/oracle");
const realOracledb = realAdapter.oracledb;
const realSetTimeout = globalThis.setTimeout;
const wait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
let timeScale = 1;

// ── stub driver ────────────────────────────────────────────────────────────────
type StubConn = { ping: () => Promise<void>; close: () => Promise<void>; execute: (...a: unknown[]) => Promise<unknown>; commit: () => Promise<void>; rollback: () => Promise<void> };
type PoolScript = {
  create?: (cfg: { poolAlias: string; poolMin?: number }) => Promise<void> | void; // throw to fail createPool
  reconfigure?: (opts: { poolMin?: number }) => Promise<void>;
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
    async createPool(cfg: { user: string; poolAlias: string; poolMin?: number }) {
      const s = scripts[cfg.user] ?? {};
      await s.create?.(cfg);
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
        reconfigure: s.reconfigure ?? (async () => {}),
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
    await wait(80); // the monitor's tick, scheduled while the clock ran fast, must not land in the next test
  });

  it("gives up after 4 attempts; the rejected pool is evicted after its cool-down and retried", async () => {
    let attempts = 0;
    register("s_dead", { create: () => { attempts++; throw new Error("ORA-01017: invalid username/password"); } });
    timeScale = 0.001;
    await expect(A.withConnection("s_dead", async () => 1)).rejects.toThrow(/s_dead/);
    expect(attempts).toBe(4);
    // Three failed attempts opened the breaker (each attempt counts, no check had to wait for the creation).
    await expect(A.withConnection("s_dead", async () => 1)).rejects.toThrow(/circuit open/);
    expect(attempts).toBe(4); // no new attempts
    // A probe that bypasses the breaker meets the cached failure of the creation: the same MiraDbError, no new attempts.
    const cached = await A.withConnection("s_dead", async () => 1, { bypassBreaker: true }).catch((e: unknown) => e);
    expect(cached).toBeInstanceOf(MiraDbError);
    expect((cached as Error).message).toMatch(/Could not create pool "s_dead" after 4 attempts/);
    expect(attempts).toBe(4);
    await wait(60); // 5 s cool-down at 1/1000 scale: evicted; a check opens the pool, two more close the breaker
    scripts.s_dead.create = () => {};
    for (let i = 0; i < 200 && !A.isPoolHealthy("s_dead"); i++) await wait(10);
    expect(A.isPoolHealthy("s_dead")).toBe(true);
    expect(await A.withConnection("s_dead", async () => "recovered")).toBe("recovered");
    timeScale = 1;
    await wait(80); // see above
  });

  it("initializePools reports per-pool success / failure with NJS-116 and NJS-046 hints", async () => {
    const B = await loadAdapter(makeDriver());
    register("s_njs116", { create: () => { throw new Error("NJS-116: password verifier type 0x939 is not supported"); } });
    register("s_njs046", { create: () => { throw new Error("NJS-046: poolAlias already exists"); } });
    timeScale = 0.001;
    const res = await B.initializePools();
    timeScale = 1;
    await wait(80); // see above
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

  it("acquire timeout races the driver; late connections are closed (orphan guard), late failures ignored; a Mira bound is never retried", async () => {
    let mode: "late-ok" | "late-close-fails" | "late-reject" | "fast" = "fast";
    let orphanClosed = 0;
    let acquires = 0;
    register(
      "s_slow",
      {
        getConnection: () => {
          acquires++;
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
      { connectTimeout: 10, queueTimeout: 10 }, // Mira's bound is queueTimeout + connectTimeout = 20 ms
    );
    await A.withConnection("s_slow", async () => 1);
    for (const m of ["late-ok", "late-close-fails", "late-reject"] as const) {
      mode = m;
      acquires = 0;
      const err = await A.withConnection("s_slow", async () => 1).catch((e) => e);
      expect(err.message).toMatch(/Timed out getting connection from "s_slow"/);
      expect(acquires).toBe(1); // one attempt per caller: a Mira acquire bound is not retried
      expect(err).toBeInstanceOf(MiraDbError);
      expect(err.code).toBe("MIRA_ACQUIRE_TIMEOUT");
      expect(err.kind).toBe("connectivity");
      expect(err.outcomeUnknown).toBe(false);
      expect(err.message).toMatch(/\[MIRA_ACQUIRE_TIMEOUT\]/);
    }
    // The two resolving modes each leave one late connection, closed by the orphan guard; the
    // health check the timeouts nudge may add its own late acquire (also closed). Wait for the real condition.
    for (let i = 0; i < 100 && orphanClosed < 2; i++) await wait(5);
    expect(orphanClosed).toBeGreaterThanOrEqual(2);
    expect(orphanClosed).toBeLessThanOrEqual(4);
    mode = "fast";
  });

  it("acquire bound is queueTimeout + connectTimeout (connectTimeout alone when queueTimeout is 0)", async () => {
    let delay = 0;
    register(
      "s_bound",
      { getConnection: () => (delay ? new Promise<StubConn>((r) => realSetTimeout(() => r(conn()), delay)) : Promise.resolve(conn())) },
      { connectTimeout: 50, queueTimeout: 400 },
    );
    await A.withConnection("s_bound", async () => 1);
    delay = 150; // later than connectTimeout alone, well inside the sum
    expect(await A.withConnection("s_bound", async () => "served")).toBe("served");
    register("s_bound0", { getConnection: scripts.s_bound.getConnection }, { connectTimeout: 50, queueTimeout: 0 });
    delay = 0;
    await A.withConnection("s_bound0", async () => 1);
    delay = 400;
    const err = await A.withConnection("s_bound0", async () => 1).catch((e) => e);
    expect(err.code).toBe("MIRA_ACQUIRE_TIMEOUT"); // fired at connectTimeout, not 15 s
    await A.closePool("s_bound");
    await A.closePool("s_bound0");
  });

  it("the driver's pool-full error is not retried; nor is a Mira bound wrapped inside another error", async () => {
    let calls = 0;
    let next: unknown;
    register("s_full", { getConnection: async () => { calls++; if (next) throw next; return conn(); } });
    await A.withConnection("s_full", async () => 1);
    next = new Error("NJS-040: connection request timeout. Request exceeded queueTimeout of 15");
    calls = 0;
    const full = await A.withConnection("s_full", async () => 1).catch((e) => e);
    expect(calls).toBe(1);
    expect(full.kind).toBe("saturation");
    expect(full.code).toBeUndefined();
    // a transient-looking ORA code, but a MiraDbError is in the chain
    next = Object.assign(new Error("ORA-12541: outer"), { originalError: new MiraDbError("inner", { kind: "connectivity", code: "MIRA_ACQUIRE_TIMEOUT" }) });
    calls = 0;
    await expect(A.withConnection("s_full", async () => 1)).rejects.toThrow(/outer/);
    expect(calls).toBe(1);
    // and one that only carries the token in its text
    next = new Error("ORA-12541: stuck [MIRA_POOL_OPEN_TIMEOUT]");
    calls = 0;
    await expect(A.withConnection("s_full", async () => 1)).rejects.toThrow(/stuck/);
    expect(calls).toBe(1);
    next = undefined;
    await A.closePool("s_full");
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
    expect(wrapped).toBeInstanceOf(MiraDbError);
    expect(wrapped.name).toBe("MiraDbError");
    expect(wrapped).toMatchObject({ kind: "statement", code: undefined, outcomeUnknown: false });
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
    const open = await A.withConnection("s_tx", async () => 1).catch((e) => e);
    expect(open.message).toMatch(/s_tx/);
    expect(open.message).toContain("NJS-503"); // CATHERINE's classifier reads this token
    expect(open).toBeInstanceOf(MiraDbError);
    expect(open).toMatchObject({ kind: "connectivity", code: "MIRA_CIRCUIT_OPEN", outcomeUnknown: false, connectionName: "s_tx" });
    expect(open.message.endsWith("[MIRA_CIRCUIT_OPEN]")).toBe(true);
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

  it("closeAll: drains, tolerates close errors and hung pools (bounded), refuses new work, is idempotent", async () => {
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

  it("never writes ORA_SDTZ (forcing +00:00 moved Dates on a process not on UTC)", async () => {
    for (const value of [undefined, "  ", "-05:00"]) {
      await withEnv({ ORA_SDTZ: value }, async () => {
        (await loadAdapter(makeDriver())).initDriver();
        expect(process.env.ORA_SDTZ).toBe(value);
      });
    }
  });

  it("thread budget: one warning over ALL registered pools, raised again only when a pool raises the need; runtime-specific text; never in Thin", async () => {
    const thick = () => makeDriver({ oracleClientVersion: 1906000000 });
    const mine = () => Object.keys(conns);
    // Σ poolMax + 3 per registered pool + 2, whatever else the file registered.
    const need = () => mine().reduce((n, k) => n + (Number(conns[k].poolMax) || 50) + 3, 2);
    const budget = (w: string[]) => w.filter((m) => m.includes("worker threads"));
    const run = async (driver: unknown, uv: string | undefined, runtime?: "bun" | "node") =>
      captureWarnings(() =>
        withEnv({ UV_THREADPOOL_SIZE: uv }, async () => {
          const versions = process.versions as Record<string, string | undefined>;
          const bunBefore = versions.bun;
          if (runtime === "node") delete versions.bun;
          if (runtime === "bun") versions.bun = bunBefore ?? "1.0.0";
          try {
            const a = await loadAdapter(driver);
            register("s_threads", { stats: { poolMax: 10 } });
            await a.withConnection("s_threads", async () => 1);
            await a.closeAll();
          } finally {
            if (bunBefore === undefined) delete versions.bun;
            else versions.bun = bunBefore;
          }
        }),
      );
    const node = budget(await run(thick(), undefined, "node"));
    expect(node).toHaveLength(1); // once, not once per pool
    expect(node[0]).toContain(`can need ${need()} worker threads`);
    expect(node[0]).toContain("on Node runs every database call on one of 4 (UV_THREADPOOL_SIZE not set; Node's default is 4)");
    expect(node[0]).toContain(`Set UV_THREADPOOL_SIZE=${need()} or more before the process starts, or use Thin mode.`);
    const bun = budget(await run(thick(), undefined, "bun"));
    expect(bun).toHaveLength(1);
    expect(bun[0]).toMatch(/on Bun runs every database call on one of \d+ \(UV_THREADPOOL_SIZE not set; Bun uses one thread per CPU core\)/);
    const small = budget(await run(thick(), "6", "node"));
    expect(small[0]).toContain("one of 6 (UV_THREADPOOL_SIZE)");
    expect(budget(await run(thick(), String(need()), "node"))).toEqual([]); // enough threads: silent
    expect(budget(await run(thick(), "junk", "node"))[0]).toContain("Node's default is 4");
    // Bun ignores 1 (measured), so it falls back to its default (one per core), Node honours it.
    expect(budget(await run(thick(), "1", "bun"))[0]).toContain("Bun uses one thread per CPU core");
    expect(budget(await run(thick(), "1", "node"))[0]).toContain("one of 1 (UV_THREADPOOL_SIZE)");
    expect(budget(await run(makeDriver(), undefined, "node"))).toEqual([]); // Thin: never

    // A second pool that raises the need warns again; one that does not, never.
    const warnings = await captureWarnings(() =>
      withEnv({ UV_THREADPOOL_SIZE: "4" }, async () => {
        const a = await loadAdapter(thick());
        register("s_threads", { stats: { poolMax: 10 } });
        await a.withConnection("s_threads", async () => 1);
        await a.withConnection("s_threads", async () => 1);
        const first = need();
        register("s_threads_more", { stats: { poolMax: 10 } }, { poolMax: 7 });
        await a.withConnection("s_threads_more", async () => 1);
        expect(need()).toBe(first + 10);
        await a.closeAll();
      }),
    );
    const seen = budget(warnings);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain(`can need ${need()} worker threads`);
    delete conns.s_threads_more;
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
  // node-oracledb writes a Date in the PROCESS's zone and Oracle reads it in the SESSION's zone,
  // so every pool sets each new session to the process's offset (or the caller's ORA_SDTZ).
  const capture = (extra: Record<string, unknown> = {}) => {
    const seen: { cfg?: { sessionCallback?: (c: unknown, tag: string, done: (e?: Error) => void) => void } } = {};
    const driver = makeDriver({
      ...extra,
      async createPool(cfg: { poolAlias: string; sessionCallback?: never }) {
        seen.cfg = cfg;
        return { poolAlias: cfg.poolAlias, poolMin: 1, poolMax: 1, connectionsOpen: 0, connectionsInUse: 0, getConnection: async () => conn(), close: async () => {} };
      },
    });
    return { seen, driver };
  };
  /** Runs the callback on a stub session; `refuse` makes statements matching it fail (ORA-01882). */
  const runCallback = (cb: NonNullable<NonNullable<ReturnType<typeof capture>["seen"]["cfg"]>["sessionCallback"]>, refuse: RegExp | null = null) =>
    new Promise<{ sql: string; sqls: string[]; err?: Error }>((resolve) => {
      const sqls: string[] = [];
      const c = { execute: async (q: string) => { sqls.push(q); if (refuse?.test(q)) throw new Error("ORA-01882: timezone region not found"); return {}; } };
      cb(c, "", (err) => resolve({ sql: sqls[sqls.length - 1], sqls, err }));
    });
  const withTz = async (zone: string, fn: () => Promise<void>) => {
    const tz = process.env.TZ;
    process.env.TZ = zone;
    try {
      await fn();
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  };
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

  it("Thin: the process's region (or its offset when it has none); an unknown region falls back to the offset", async () => {
    await withSdtz(undefined, async () => {
      const { seen, driver } = capture();
      const a = await loadAdapter(driver); // the stub reports no client version: Thin mode
      register("s_tz_thin");
      await a.withConnection("s_tz_thin", async () => 1);
      const cb = seen.cfg!.sessionCallback!;
      for (const [zone, sql] of [
        ["UTC", "ALTER SESSION SET TIME_ZONE = '+00:00'"],
        ["Asia/Manila", "ALTER SESSION SET TIME_ZONE = 'Asia/Manila'"],
        ["America/New_York", "ALTER SESSION SET TIME_ZONE = 'America/New_York'"],
      ]) {
        await withTz(zone, async () => expect(await runCallback(cb)).toEqual({ sql, sqls: [sql], err: undefined }));
      }
      await withTz("Asia/Kolkata", async () => {
        const region = Intl.DateTimeFormat().resolvedOptions().timeZone; // ICU may say Asia/Calcutta
        const r = await runCallback(cb, /Asia\//);
        expect(r).toEqual({ sql: "ALTER SESSION SET TIME_ZONE = '+05:30'", sqls: [`ALTER SESSION SET TIME_ZONE = '${region}'`, "ALTER SESSION SET TIME_ZONE = '+05:30'"], err: undefined });
      });
      await withTz("America/Caracas", async () => {
        const failed = await runCallback(cb, /./); // region and offset both refused: the driver hears of it
        expect(failed.sqls).toEqual(["ALTER SESSION SET TIME_ZONE = 'America/Caracas'", "ALTER SESSION SET TIME_ZONE = '-04:00'"]);
        expect(failed.err?.message).toMatch(/ORA-01882/);
      });
      await a.closeAll();
    });
  });

  it("Thick: the offset, never a region (the client's time-zone file can differ from the server's: ORA-01805)", async () => {
    await withSdtz(undefined, async () => {
      const { seen, driver } = capture({ oracleClientVersion: 2300000000 });
      const a = await loadAdapter(driver);
      register("s_tz_thick");
      await a.withConnection("s_tz_thick", async () => 1);
      const cb = seen.cfg!.sessionCallback!;
      await withTz("Asia/Manila", async () => expect((await runCallback(cb)).sqls).toEqual(["ALTER SESSION SET TIME_ZONE = '+08:00'"]));
      await withTz("America/Caracas", async () => expect((await runCallback(cb)).sqls).toEqual(["ALTER SESSION SET TIME_ZONE = '-04:00'"]));
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

describe("unit/adapter: a database that stops answering (3.1)", () => {
  let B: Adapter; // a fresh instance: earlier scenarios shut the shared one down
  beforeAll(async () => { B = await loadAdapter(makeDriver()); });
  afterAll(async () => { await B.closeAll(); });

  /** A promise held open until release() — a native call on a stalled link. */
  function hang<T>() {
    let release!: (v: T) => void;
    const p = new Promise<T>((r) => { release = r; });
    return { p, release };
  }

  it("pool open is bounded at each step; whatever arrives late is closed", async () => {
    timeScale = 0.01; // retry back-off 1–4 s → 10–40 ms
    const pools: Array<ReturnType<typeof hang<void>>> = [];
    let poolCloses = 0;
    register("s_hang_create", { create: () => { const h = hang<void>(); pools.push(h); return h.p; }, close: async () => { poolCloses++; } }, { connectTimeout: 20 });
    const before = getLogger();
    const warned: string[] = [];
    setLogger({ info() {}, warn: (m: string) => void warned.push(String(m)), error() {} });
    let waited: unknown;
    let result: Awaited<ReturnType<Adapter["initializePools"]>>[number];
    try {
      // A caller no longer waits out the whole opening: it gives up after connectTimeout, the opening goes on.
      waited = await B.withConnection("s_hang_create", async () => 1).catch((e: Error) => e);
      // initializePools (mira.open()) waits for all of it, by design.
      [result] = await B.initializePools(["s_hang_create"]);
    } finally {
      setLogger(before);
    }
    expect(waited).toBeInstanceOf(MiraDbError);
    expect((waited as MiraDbError).code).toBe("MIRA_POOL_OPENING");
    expect((waited as Error).message).toMatch(/still opening after 20 ms/);
    expect(result.success).toBe(false);
    // Two attempts timed out and are still hanging (the cap): the other two are deferred, not started.
    expect(warned.filter((m) => /Timed out opening pool "s_hang_create".*\[MIRA_POOL_OPEN_TIMEOUT\]/.test(m))).toHaveLength(2);
    expect(result.error).toContain("[MIRA_CREATE_DEFERRED]");
    expect(pools.length).toBe(2);
    expect((await B.getPoolStats()).abandoned.pools).toBeGreaterThanOrEqual(2);
    for (const h of pools) h.release();
    for (let i = 0; i < 50 && poolCloses < 2; i++) await wait(5);
    expect(poolCloses).toBe(2); // each late pool is closed

    const late = hang<StubConn>();
    const closes: unknown[] = [];
    let first = true;
    register("s_hang_conn", {
      getConnection: () => (first ? ((first = false), late.p) : Promise.resolve(conn({ ping: () => new Promise<void>(() => {}), close: async (o?: unknown) => void closes.push(o ?? "plain") } as never))),
    }, { connectTimeout: 20 });
    const [conResult] = await B.initializePools(["s_hang_conn"]);
    expect(conResult.error).toContain("[MIRA_CREATE_DEFERRED]"); // the hung connect and the hung ping fill the cap of 2
    late.release(conn({ close: async () => void closes.push("late") } as never));
    for (let i = 0; i < 50 && !closes.includes("late"); i++) await wait(5);
    expect(closes).toContain("late"); // the late first connection is returned
    expect(closes).toContainEqual({ drop: true }); // a connection whose ping hung is dropped
    timeScale = 1;
    await B.closePool("s_hang_create");
    await B.closePool("s_hang_conn");
  });

  it("a health check on a stalled link fails within connectTimeout instead of hanging (getConnection or ping)", async () => {
    let mode: "ok" | "acquire" | "ping" = "ok";
    const late = hang<StubConn>();
    const closes: unknown[] = [];
    register("s_hang_check", {
      getConnection: async () => {
        if (mode === "acquire") return late.p;
        return conn({ ping: () => (mode === "ping" ? new Promise<void>(() => {}) : Promise.resolve()), close: async (o?: unknown) => void closes.push(o ?? "plain") } as never);
      },
    }, { connectTimeout: 20 });
    await B.withConnection("s_hang_check", async () => 1);
    const checks: boolean[] = [];
    const off = B.onPoolHealthCheck((c) => { if (c.name === "s_hang_check") checks.push(c.ok); });
    for (const m of ["acquire", "ping"] as const) {
      mode = m;
      const before = checks.length;
      B.nudgePoolHealth("s_hang_check");
      for (let i = 0; i < 100 && checks.length === before; i++) await wait(10);
      expect(checks.slice(before)).toEqual([false]);
    }
    off();
    expect(closes).toContainEqual({ drop: true }); // the hung ping's connection is dropped
    late.release(conn({ close: async () => void closes.push("late") } as never));
    for (let i = 0; i < 50 && !closes.includes("late"); i++) await wait(5);
    expect(closes).toContain("late");
    mode = "ok";
    await B.closePool("s_hang_check");
  });

  it("callTimeout: set on each borrowed connection, a hung call is cut off in JS and its connection dropped; methods are restored", async () => {
    timeScale = 0.01; // the JS backstop (callTimeout + 1 s) → ~10 ms
    const closes: unknown[] = [];
    let hangNext = false;
    const c = conn({
      execute: async () => (hangNext ? new Promise(() => {}) : { rows: [] }),
      close: async (o?: unknown) => void closes.push(o ?? "plain"),
    } as never) as StubConn & { callTimeout?: number };
    const ownExecute = c.execute;
    register("s_calltimeout", { getConnection: async () => c }, { callTimeout: 50 });
    expect(await B.withConnection("s_calltimeout", async (k: { callTimeout: number }) => k.callTimeout)).toBe(50);
    expect(c.execute).toBe(ownExecute); // put back on release
    expect(c.callTimeout).toBe(0);
    hangNext = true;
    const cut = await B.withConnection("s_calltimeout", (k: StubConn) => k.execute("SELECT 1 FROM DUAL")).catch((e: MiraDbError) => e);
    expect(cut.message).toMatch(/did not finish within 1050 ms/);
    expect(cut).toBeInstanceOf(MiraDbError);
    expect(cut).toMatchObject({ kind: "connectivity", code: "MIRA_CALL_TIMEOUT", outcomeUnknown: false, connectionName: "s_calltimeout" });
    expect(((cut as MiraDbError).originalError as MiraDbError).code).toBe("MIRA_CALL_TIMEOUT");
    expect(closes.at(-1)).toEqual({ drop: true });
    // The cut call is still running natively: the ledger counts it (it never settles in this stub).
    const cutStats = (await B.getPoolStats()).pools as Record<string, { abandonedCalls: number }>;
    expect(cutStats.s_calltimeout.abandonedCalls).toBe(1);
    hangNext = false;
    // Other errors pass through unchanged and keep the connection.
    const failing = conn({ execute: async () => { throw new Error("ORA-00942: no table"); }, close: async (o?: unknown) => void closes.push(o ?? "plain") } as never);
    register("s_calltimeout2", { getConnection: async () => failing }, { callTimeout: 50 });
    await expect(B.withConnection("s_calltimeout2", (k: StubConn) => k.execute("SELECT 1 FROM T"))).rejects.toThrow(/ORA-00942/);
    expect(closes.at(-1)).toBe("plain");
    timeScale = 1;
    await B.closePool("s_calltimeout");
    await B.closePool("s_calltimeout2");
  });
});

// ── errors: kind / code / outcomeUnknown (3.1) ─────────────────────────────────
describe("unit/adapter: error taxonomy — errorKind and MiraDbError (3.1)", () => {
  const kind = (e: unknown) => A.errorKind(e);

  it("a MiraDbError in the chain gives its own kind, wherever it sits", () => {
    const inner = new MiraDbError("x", { kind: "timeout" });
    expect(kind(inner)).toBe("timeout");
    expect(kind(Object.assign(new Error("ORA-12541"), { originalError: inner }))).toBe("timeout");
    expect(kind(Object.assign(new Error("outer"), { cause: inner }))).toBe("timeout");
  });

  it("a [MIRA_CODE] token in a message maps through CODE_KIND; an unknown token falls through", () => {
    for (const code of Object.keys(CODE_KIND) as MiraErrorCode[]) expect(kind(new Error(`something [${code}]`))).toBe(CODE_KIND[code]);
    expect(kind(new Error("x [MIRA_BOGUS]"))).toBe("statement");
    expect(kind(new Error("NJS-040 [MIRA_BOGUS]"))).toBe("saturation");
  });

  it("driver codes: pool full is saturation, call timeouts are timeout, link and session loss are connectivity", () => {
    for (const m of ["NJS-040: connection request timeout", "NJS-076: connection request rejected. Pool queue length queueMax 40 reached"]) expect(kind(new Error(m))).toBe("saturation");
    for (const m of ["DPI-1067: call timeout of 5000 ms exceeded", "NJS-123: call timeout of 5000 ms exceeded", "ORA-03156: OCI call timed out"]) expect(kind(new Error(m))).toBe("timeout");
    for (const m of ["ORA-12541: no listener", "ORA-03113: end-of-file on communication channel", "ORA-01089: shutdown in progress", "NJS-500: broken", "NJS-503: unavailable", "NJS-521: x", "DPI-1080: connection was closed"]) {
      expect(kind(new Error(m))).toBe("connectivity");
    }
    for (const m of ["ORA-00942: table or view does not exist", "ORA-00001: unique constraint", "something else"]) expect(kind(new Error(m))).toBe("statement");
  });

  it("Mira's own bounds are codes now, not message patterns: the old text alone is a statement failure", () => {
    expect(kind(new Error('Timed out getting connection from "x"'))).toBe("statement");
    expect(kind(new Error('A call on "x" did not finish within 5 ms'))).toBe("statement");
    expect(kind(new Error('Timed out opening pool "x" after 5 ms'))).toBe("statement");
  });

  it("walks originalError and cause, at most 5 links, and survives a cycle; non-objects are statements", () => {
    const link = (n: number): Error => (n === 0 ? new Error("ORA-12541: deep") : Object.assign(new Error(`wrap${n}`), { originalError: link(n - 1) }));
    expect(kind(link(4))).toBe("connectivity"); // 5 links: the 5th is read
    expect(kind(link(5))).toBe("statement"); // the 6th is not
    expect(kind(Object.assign(new Error("w"), { cause: new Error("NJS-040") }))).toBe("saturation");
    const loop: Record<string, unknown> = { message: "ORA-12541" };
    loop.originalError = loop;
    expect(kind(loop)).toBe("connectivity");
    for (const v of ["ORA-12541: a string", null, undefined, 42, {}]) expect(kind(v)).toBe("statement");
  });

  it("MiraDbError: fields, defaults, name; the wrapper keeps the first Mira code found in the chain", async () => {
    const e = new MiraDbError("m", { kind: "saturation" });
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ name: "MiraDbError", kind: "saturation", code: undefined, outcomeUnknown: false, connectionName: undefined, durationMs: undefined, originalError: undefined });
    const full = new MiraDbError("m", { kind: "connectivity", code: "MIRA_CALL_TIMEOUT", outcomeUnknown: true, connectionName: "p", durationMs: 7, originalError: e });
    expect(full).toMatchObject({ code: "MIRA_CALL_TIMEOUT", outcomeUnknown: true, connectionName: "p", durationMs: 7, originalError: e });

    const T = await loadAdapter(makeDriver());
    register("s_code_chain");
    // a collection method rebuilds errors as plain Errors: the token in the text keeps the code
    const viaToken = await T.withConnection("s_code_chain", async () => { throw new Error("Could not create pool [MIRA_POOL_OPEN_TIMEOUT]"); }).catch((x) => x);
    expect(viaToken).toMatchObject({ kind: "connectivity", code: "MIRA_POOL_OPEN_TIMEOUT" });
    // a MiraDbError without a code, with a coded one deeper
    const deep = new MiraDbError("no code", { kind: "connectivity", originalError: new MiraDbError("coded", { kind: "connectivity", code: "MIRA_CHECK_TIMEOUT" }) });
    const viaChain = await T.withConnection("s_code_chain", async () => { throw deep; }).catch((x) => x);
    expect(viaChain.code).toBe("MIRA_CHECK_TIMEOUT");
    await T.closeAll();
  });
});

// ── bounded close and the abandoned-work ledger (3.1) ──────────────────────────
describe("unit/adapter: pool close is bounded; abandoned work is counted (3.1)", () => {
  let C: Adapter;
  beforeAll(async () => { C = await loadAdapter(makeDriver()); });
  afterAll(async () => { await C.closeAll(); });

  function hang<T>() {
    let release!: (v: T) => void;
    const p = new Promise<T>((r) => { release = r; });
    return { p, release };
  }
  const abandoned = async () => (await C.getPoolStats()).abandoned;
  const captureLog = async (fn: () => Promise<void>) => {
    const before = getLogger();
    const seen: string[] = [];
    setLogger({ info() {}, warn: (m: string) => void seen.push(String(m)), error() {} });
    try {
      await fn();
    } finally {
      setLogger(before);
    }
    return seen;
  };

  it("closePool on a pool whose close never returns resolves at the bound, logs it, and counts the pool until the close ends", async () => {
    const h = hang<void>();
    register("s_close_hang1", { close: () => h.p }, { connectTimeout: 20 });
    await C.withConnection("s_close_hang1", async () => 1);
    expect(await abandoned()).toEqual({ calls: 0, pools: 0, zombies: 0 });
    const t = performance.now();
    const seen = await captureLog(async () => {
      timeScale = 0.001; // bound = 10 s + 2 x 20 ms → ~10 ms
      await C.closePool("s_close_hang1");
      timeScale = 1;
    });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(seen.filter((m) => m.includes("did not close within"))).toHaveLength(1);
    expect(seen.find((m) => m.includes("did not close within"))).toContain("[MIRA_CLOSE_TIMEOUT]");
    expect(await abandoned()).toEqual({ calls: 0, pools: 1, zombies: 0 });
    h.release();
    for (let i = 0; i < 100 && (await abandoned()).pools > 0; i++) await wait(5);
    expect((await abandoned()).pools).toBe(0); // the ledger survives the pool and drains when the close ends
  });

  it("two hung pools closed together take one bound, not two", async () => {
    for (const n of ["s_close_hang2a", "s_close_hang2b"]) register(n, { close: () => new Promise<void>(() => {}) }, { connectTimeout: 20 });
    await C.withConnection("s_close_hang2a", async () => 1);
    await C.withConnection("s_close_hang2b", async () => 1);
    timeScale = 0.05; // bound ~ 500 ms
    const t = performance.now();
    await Promise.allSettled([C.closePool("s_close_hang2a"), C.closePool("s_close_hang2b")]);
    const took = performance.now() - t;
    timeScale = 1;
    expect(took).toBeGreaterThan(400);
    expect(took).toBeLessThan(800); // two in a row would be ~1000
    expect((await abandoned()).pools).toBe(2); // these two never end
  });

  it("closeAll: no guard timer outlives a normal close", async () => {
    const D = await loadAdapter(makeDriver());
    register("s_ca_ok");
    await D.withConnection("s_ca_ok", async () => 1);
    // A normal close: every long timer it sets is cleared (the 30 s guard used to keep the process alive).
    const setT = globalThis.setTimeout;
    const clearT = globalThis.clearTimeout;
    const longTimers = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const t = (setT as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      if (ms && ms >= 10_000) longTimers.add(t);
      return t;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((t: never) => {
      longTimers.delete(t);
      return clearT(t);
    }) as typeof clearTimeout;
    try {
      register("s_ca_ok2");
      await D.withConnection("s_ca_ok2", async () => 1);
      await D.closeAll();
    } finally {
      globalThis.setTimeout = setT;
      globalThis.clearTimeout = clearT;
    }
    expect(longTimers.size).toBe(0);
  });

  it("closeAll: a pool that never closes does not hold shutdown past its bound", async () => {
    const D = await loadAdapter(makeDriver());
    register("s_ca_hang2", { close: () => new Promise<void>(() => {}) }, { connectTimeout: 20 });
    await D.withConnection("s_ca_hang2", async () => 1);
    timeScale = 0.001;
    const t = performance.now();
    await D.closeAll();
    timeScale = 1;
    expect(performance.now() - t).toBeLessThan(2000);
    expect((await D.getPoolStats()).abandoned.pools).toBe(1);
  });

  it("a pool whose registration is gone still closes (bound from the defaults)", async () => {
    register("s_unregistered_close");
    await C.withConnection("s_unregistered_close", async () => 1);
    delete conns.s_unregistered_close;
    await C.closePool("s_unregistered_close");
    expect(C.isPoolOpen("s_unregistered_close")).toBe(false);
  });

  it("a close that fails is logged, not thrown", async () => {
    register("s_close_fails", { close: async () => { throw new Error("NJS-104: close failed"); } });
    await C.withConnection("s_close_fails", async () => 1);
    const seen = await captureLog(() => C.closePool("s_close_fails"));
    expect(seen.some((m) => m.includes("close error") && m.includes("NJS-104"))).toBe(true);
    expect((await abandoned()).pools).toBe(2); // unchanged: a failed close is not an abandoned one
  });

  it("an acquire the driver never answers is counted per pool until its late connection is closed", async () => {
    const h = hang<StubConn>();
    let hung = false;
    let closed = 0;
    register("s_orphan_ledger", { getConnection: () => (hung ? h.p : Promise.resolve(conn())) }, { connectTimeout: 10, queueTimeout: 10 });
    await C.withConnection("s_orphan_ledger", async () => 1);
    hung = true;
    await expect(C.withConnection("s_orphan_ledger", async () => 1)).rejects.toThrow(/Timed out getting connection/);
    const during = (await C.getPoolStats()).pools as Record<string, { abandonedCalls: number; abandonedPools: number }>;
    expect(during.s_orphan_ledger).toMatchObject({ abandonedCalls: 1, abandonedPools: 0 });
    h.release(conn({ close: async () => void closed++ }));
    for (let i = 0; i < 100 && closed === 0; i++) await wait(5);
    expect(closed).toBe(1);
    for (let i = 0; i < 100 && ((await C.getPoolStats()).pools as typeof during).s_orphan_ledger.abandonedCalls > 0; i++) await wait(5);
    expect(((await C.getPoolStats()).pools as typeof during).s_orphan_ledger.abandonedCalls).toBe(0);
    hung = false;
    await C.closePool("s_orphan_ledger");
  });
});

// ── the per-connection guard (3.1, step 4) ─────────────────────────────────────
describe("unit/adapter: SessionGuard — queueing, dead connections, outcome unknown, release (3.1)", () => {
  let G: Adapter;
  beforeAll(async () => { G = await loadAdapter(makeDriver()); });
  afterAll(async () => { await G.closeAll(); });

  type K = StubConn & { callTimeout?: number };
  const never = () => new Promise<never>(() => {});
  function hang<T>() {
    let release!: (v: T) => void;
    const p = new Promise<T>((r) => { release = r; });
    return { p, release };
  }
  /** Executes one after another, like the driver's per-connection lock; each takes `ms` of real time. */
  function serialExecute(ms: number) {
    let tail: Promise<unknown> = Promise.resolve();
    return () => {
      const run = tail.then(() => wait(ms)).then(() => ({ rows: [] }));
      tail = run.catch(() => {});
      return run;
    };
  }
  const captureLog = async (fn: () => Promise<void>) => {
    const before = getLogger();
    const seen: string[] = [];
    setLogger({ info() {}, warn: (m: string) => void seen.push(String(m)), error() {} });
    try { await fn(); } finally { setLogger(before); }
    return seen;
  };
  /** A pool whose one connection's `method` never answers once `armed.on`. */
  function hung(name: string, method: keyof StubConn, extra: Partial<StubConn> = {}) {
    const armed = { on: false };
    const closes: unknown[] = [];
    const calls: Record<string, number> = { rollback: 0 };
    const c = conn({
      rollback: async () => { calls.rollback++; },
      close: async (o?: unknown) => void closes.push(o ?? "plain"),
      ...extra,
      [method]: (...a: unknown[]) => (armed.on ? never() : Promise.resolve(method === "execute" || method === "executeMany" ? { rows: [] } : undefined)),
    } as never) as K;
    register(name, { getConnection: async () => c }, { callTimeout: 50 });
    return { armed, closes, calls, c };
  }

  it("calls started together on one connection are timed one after another: a Promise.all of healthy calls is never cut", async () => {
    timeScale = 0.04; // callTimeout 2000 -> bound 3000 ms -> 120 ms; four calls of 40 ms take 160 ms in all
    const closes: unknown[] = [];
    const c = conn({ execute: serialExecute(40), close: async (o?: unknown) => void closes.push(o ?? "plain") } as never) as K;
    register("s_guard_queue", { getConnection: async () => c }, { callTimeout: 2000 });
    const out = await G.withConnection("s_guard_queue", (k: StubConn) => Promise.all([1, 2, 3, 4].map(() => k.execute("SELECT 1 FROM DUAL"))));
    timeScale = 1;
    expect(out).toHaveLength(4);
    expect(closes.at(-1)).toBe("plain"); // not dropped
    const s = (await G.getPoolStats()).pools as Record<string, { abandonedCalls: number }>;
    expect(s.s_guard_queue.abandonedCalls).toBe(0);
    await G.closePool("s_guard_queue");
  });

  it("after a call is cut, later calls fail at once (MIRA_CONNECTION_DEAD); withTransaction skips the rollback", async () => {
    timeScale = 0.01;
    const h = hung("s_guard_dead", "execute");
    await G.withConnection("s_guard_dead", async () => 1); // warm the pool
    h.armed.on = true;
    let after: MiraDbError | undefined;
    let ms = Infinity;
    const err = await G.withConnection("s_guard_dead", async (k: StubConn) => {
      await k.execute("SELECT 1 FROM DUAL").catch(() => {});
      const t = performance.now();
      after = await k.execute("SELECT 2 FROM DUAL").catch((e: MiraDbError) => e);
      ms = performance.now() - t;
      throw after;
    }).catch((e: MiraDbError) => e);
    expect(after).toBeInstanceOf(MiraDbError);
    expect(after).toMatchObject({ code: "MIRA_CONNECTION_DEAD", kind: "connectivity", outcomeUnknown: false });
    expect(ms).toBeLessThan(50);
    expect(err).toMatchObject({ code: "MIRA_CALL_TIMEOUT", outcomeUnknown: false }); // the guard remembers what it cut

    // A transaction: the cut drops the session, the server rolls it back, Mira does not ask again.
    h.calls.rollback = 0;
    await expect(G.withTransaction("s_guard_dead", (k: StubConn) => k.execute("UPDATE T SET A = 1"))).rejects.toThrow(/did not finish within/);
    expect(h.calls.rollback).toBe(0);
    // A live connection still rolls back.
    h.armed.on = false;
    await expect(G.withTransaction("s_guard_dead", async () => { throw new Error("ORA-00001: unique"); })).rejects.toThrow(/ORA-00001/);
    expect(h.calls.rollback).toBe(1);
    timeScale = 1;
    await G.closePool("s_guard_dead");
  });

  it("withBatchConnection stops at a cut call or a lost link, and carries on after a statement failure", async () => {
    timeScale = 0.01;
    const h = hung("s_guard_batch", "execute");
    await G.withConnection("s_guard_batch", async () => 1);
    let ran = 0;
    const op = (k: StubConn) => { ran++; return k.execute("SELECT 1 FROM DUAL"); };
    h.armed.on = true;
    await expect(G.withBatchConnection("s_guard_batch", [op as never, op as never])).rejects.toThrow(/did not finish within/);
    expect(ran).toBe(1); // the second op never ran
    h.armed.on = false;
    ran = 0;
    const lost = () => { throw new Error("ORA-03113: end-of-file on communication channel"); };
    await expect(G.withBatchConnection("s_guard_batch", [lost, op as never])).rejects.toThrow(/ORA-03113/);
    expect(ran).toBe(0);
    const bad = () => { throw new Error("ORA-00942: no table"); };
    const res = await G.withBatchConnection("s_guard_batch", [bad, op as never]);
    expect(res.map((r) => r.success)).toEqual([false, true]);
    timeScale = 1;
    await G.closePool("s_guard_batch");
  });

  it("outcomeUnknown: a cut commit, auto-committed write, DDL or PL/SQL is unknown; a query, a plain write in a transaction and a rollback are not", async () => {
    timeScale = 0.01;
    const cases: Array<[string, keyof StubConn, unknown[], boolean]> = [
      ["commit", "commit", [], true],
      ["select with autoCommit on", "execute", ["SELECT 1 FROM DUAL", [], { autoCommit: true }], false],
      ["with-clause query", "execute", ["  (WITH x AS (SELECT 1 FROM DUAL) SELECT * FROM x)", [], { autoCommit: true }], false],
      ["insert, autoCommit", "execute", ["INSERT INTO T VALUES (1)", [], { autoCommit: true }], true],
      ["update, no autoCommit", "execute", ["UPDATE T SET A = 1", [], { autoCommit: false }], false],
      ["insert, no options", "execute", ["INSERT INTO T VALUES (1)"], false],
      ["PL/SQL block", "execute", ["BEGIN x; END;"], true],
      ["DDL", "execute", ["create table t (a number)"], true],
      ["executeMany insert, autoCommit", "executeMany", ["INSERT INTO T VALUES (:1)", [[1]], { autoCommit: true }], true],
      ["rollback", "rollback", [], false],
      ["a call without SQL text", "execute", [], false],
    ];
    for (const [label, method, args, unknown] of cases) {
      const name = `s_guard_amb_${label.replace(/\W+/g, "_")}`;
      const h = hung(name, method);
      await G.withConnection(name, async () => 1);
      h.armed.on = true;
      const err = (await G.withConnection(name, (k: StubConn) => (k[method] as (...a: unknown[]) => Promise<unknown>)(...args)).catch((e: MiraDbError) => e)) as MiraDbError;
      expect([label, err.outcomeUnknown]).toEqual([label, unknown]);
      expect([label, err.code]).toEqual([label, unknown ? "MIRA_OUTCOME_UNKNOWN" : "MIRA_CALL_TIMEOUT"]);
      expect(err.message.endsWith(unknown ? "[MIRA_OUTCOME_UNKNOWN]" : "[MIRA_CALL_TIMEOUT]")).toBe(true);
      expect(G.errorKind(err)).toBe("connectivity");
      await G.closePool(name);
    }
    timeScale = 1;
  });

  it("outcomeUnknown survives a callback that rewraps the cut error, and a driver ORA-03113 on a commit is unknown too", async () => {
    timeScale = 0.01;
    const h = hung("s_guard_rewrap", "commit");
    await G.withConnection("s_guard_rewrap", async () => 1);
    h.armed.on = true;
    const err = (await G.withConnection("s_guard_rewrap", async (k: StubConn) => {
      try { await k.commit(); } catch (e) { throw new Error(`save failed: ${(e as Error).message}`); }
    }).catch((e: MiraDbError) => e)) as MiraDbError;
    expect(err).toMatchObject({ outcomeUnknown: true, code: "MIRA_OUTCOME_UNKNOWN", kind: "connectivity" });

    // The driver itself rejects a commit because the link died: the commit may or may not have happened.
    const lost = conn({ commit: async () => { throw new Error("ORA-03113: end-of-file on communication channel"); } });
    register("s_guard_lost", { getConnection: async () => lost }, { callTimeout: 50 });
    const e2 = (await G.withConnection("s_guard_lost", (k: StubConn) => k.commit()).catch((e: MiraDbError) => e)) as MiraDbError;
    expect(e2).toMatchObject({ outcomeUnknown: true, code: "MIRA_OUTCOME_UNKNOWN", kind: "connectivity" });
    // A failed SELECT, or a statement error on a commit, is not.
    const e3 = (await G.withConnection("s_guard_lost", (k: StubConn) => { lost.execute = async () => { throw new Error("ORA-03113: gone"); }; return k.execute("SELECT 1 FROM DUAL"); }).catch((e: MiraDbError) => e)) as MiraDbError;
    expect(e3.outcomeUnknown).toBe(false);
    lost.commit = async () => { throw new Error("ORA-02091: transaction rolled back"); };
    const e4 = (await G.withConnection("s_guard_lost", (k: StubConn) => k.commit()).catch((e: MiraDbError) => e)) as MiraDbError;
    expect(e4.outcomeUnknown).toBe(false);
    timeScale = 1;
    await G.closePool("s_guard_rewrap");
    await G.closePool("s_guard_lost");
  });

  it("the bound follows conn.callTimeout when the callback changes it (0 = no bound); an unreadable session falls back to the pool's value", async () => {
    timeScale = 0.1; // callTimeout 50 -> bound 1050 ms -> 105 ms
    const c = conn({ execute: async () => { await wait(130); return { rows: [] }; } } as never) as K;
    register("s_guard_limit", { getConnection: async () => c }, { callTimeout: 50 });
    await expect(G.withConnection("s_guard_limit", (k: StubConn) => k.execute("SELECT 1 FROM DUAL"))).rejects.toThrow(/did not finish within/); // the pool's value: cut
    const raised = await G.withConnection("s_guard_limit", (k: K) => { k.callTimeout = 2000; return k.execute("SELECT 1 FROM DUAL"); }); // 3000 ms -> 300 ms
    expect(raised).toEqual({ rows: [] });
    const off = await G.withConnection("s_guard_limit", (k: K) => { k.callTimeout = 0; return k.execute("SELECT 1 FROM DUAL"); });
    expect(off).toEqual({ rows: [] });

    const closes: unknown[] = [];
    const unreadable = conn({ close: async (o?: unknown) => void closes.push(o ?? "plain") } as never);
    Object.defineProperty(unreadable, "callTimeout", { get: () => { throw new Error("DPI-1010: not connected"); }, set: () => {} });
    register("s_guard_unreadable", { getConnection: async () => unreadable }, { callTimeout: 50 });
    expect(await G.withConnection("s_guard_unreadable", (k: StubConn) => k.execute("SELECT 1 FROM DUAL"))).toEqual({ rows: [] });
    expect(closes.at(-1)).toEqual({ drop: true }); // the reset threw: dropped, not returned
    timeScale = 1;
    await G.closePool("s_guard_limit");
    await G.closePool("s_guard_unreadable");
  });

  it("a release that never returns is cut at the bound, logged, and the connection counts as a zombie until it ends", async () => {
    timeScale = 0.01;
    const h = hang<void>();
    const state = { hangClose: false, failClose: false };
    const c = conn({
      close: () => (state.hangClose ? h.p : state.failClose ? Promise.reject(new Error("NJS-500: gone")) : Promise.resolve()),
    } as never) as K;
    register("s_guard_release", { getConnection: async () => c }, { callTimeout: 50 });
    await G.withConnection("s_guard_release", async () => 1);
    state.hangClose = true;
    const t = performance.now();
    let out: unknown;
    const seen = await captureLog(async () => { out = await G.withConnection("s_guard_release", async () => "done"); });
    expect(out).toBe("done");
    expect(performance.now() - t).toBeLessThan(1000);
    expect(seen.some((m) => m.includes("Returning a connection") && m.includes("[MIRA_CLOSE_TIMEOUT]"))).toBe(true);
    const during = (await G.getPoolStats()).pools as Record<string, { zombieConnections: number }>;
    expect(during.s_guard_release.zombieConnections).toBe(1);
    expect((await G.getPoolStats()).abandoned.zombies).toBe(1);
    h.release();
    for (let i = 0; i < 100 && (await G.getPoolStats()).abandoned.zombies > 0; i++) await wait(5);
    expect((await G.getPoolStats()).abandoned.zombies).toBe(0);

    // A release that fails (not hangs) is logged and does not replace the result.
    state.hangClose = false;
    state.failClose = true;
    const seen2 = await captureLog(async () => { out = await G.withConnection("s_guard_release", async () => "still done"); });
    expect(out).toBe("still done");
    expect(seen2.some((m) => m.includes("Close failed") && m.includes("NJS-500"))).toBe(true);
    timeScale = 1;
    state.failClose = false;
    await G.closePool("s_guard_release");
  });

  it("a pool without callTimeout is left alone: no wrappers, no bound, an inert guard", async () => {
    const c = conn() as K;
    const own = c.execute;
    register("s_guard_none", { getConnection: async () => c }); // no callTimeout
    expect(await G.withConnection("s_guard_none", async (k: StubConn) => k.execute === own)).toBe(true);
    // The inert guard reports nothing was cut, and a plain failure is not outcome-unknown.
    const err = (await G.withConnection("s_guard_none", async () => { throw new Error("ORA-00942: no table"); }).catch((e: MiraDbError) => e)) as MiraDbError;
    expect(err).toMatchObject({ kind: "statement", outcomeUnknown: false });
    expect(err.code).toBeUndefined();
    await G.closePool("s_guard_none");
  });
});

// ── streams (3.1, step 5) ──────────────────────────────────────────────────────
describe("unit/adapter: query streams are bounded by the guard (3.1)", () => {
  let S: Adapter;
  beforeAll(async () => { S = await loadAdapter(makeDriver()); });
  afterAll(async () => { await S.closeAll(); });

  /** What node-oracledb's QueryStream does that matters here: a fetch per _read, and a _destroy that waits for a fetch in flight. */
  class StubStream extends Readable {
    reads = 0;
    fetching = false;
    hangRead = Infinity; // the n-th _read never answers
    hangClose = false; // _destroy never calls back
    destroyCalls = 0;
    constructor(readonly rows = 5) { super({ objectMode: true }); }
    async _read() {
      this.reads++;
      if (this.reads === this.hangRead) {
        this.fetching = true;
        await new Promise<never>(() => {});
      }
      this.push(this.reads <= this.rows ? { n: this.reads } : null);
    }
    async _destroy(err: Error | null, cb: (e?: Error | null) => void) {
      this.destroyCalls++;
      if (this.hangClose) return;
      if (this.fetching) await new Promise((r) => this.once("_doneFetching", r));
      cb(err);
    }
  }
  const streamConn = (stream: StubStream, closes: unknown[]) =>
    conn({ queryStream: () => stream, close: async (o?: unknown) => void closes.push(o ?? "plain") } as never);
  /** Reads a stream to its end; resolves with what it saw. */
  const consume = (stream: Readable) =>
    new Promise<{ rows: unknown[]; error?: Error }>((resolve) => {
      const rows: unknown[] = [];
      let error: Error | undefined;
      stream.on("data", (r) => rows.push(r));
      stream.on("error", (e) => { error = e; });
      stream.on("close", () => resolve({ rows, error }));
    });

  it("tripwire: the driver's QueryStream still has the _read and _destroy the guard patches", () => {
    const QueryStream = require(`${require("node:path").dirname(require.resolve("oracledb"))}/lib/queryStream.js`);
    expect(typeof QueryStream.prototype._read).toBe("function");
    expect(typeof QueryStream.prototype._destroy).toBe("function");
  });

  it("a healthy stream is read to its end and its connection goes back", async () => {
    const closes: unknown[] = [];
    const stream = new StubStream(3);
    register("s_stream_ok", { getConnection: async () => streamConn(stream, closes) }, { callTimeout: 5000 });
    const out = await S.withConnection("s_stream_ok", (k: never) => consume((k as { queryStream(): Readable }).queryStream()));
    expect(out.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(out.error).toBeUndefined();
    expect(closes.at(-1)).toBe("plain");
    await S.closePool("s_stream_ok");
  });

  it("a fetch that never answers fails the stream with 'error' + 'close' inside the bound; the connection is dropped", async () => {
    timeScale = 0.01;
    const closes: unknown[] = [];
    const stream = new StubStream(10);
    stream.hangRead = 2;
    register("s_stream_hang", { getConnection: async () => streamConn(stream, closes) }, { callTimeout: 50 });
    await S.withConnection("s_stream_hang", async () => 1);
    const t = performance.now();
    const out = await S.withConnection("s_stream_hang", (k: never) => consume((k as { queryStream(): Readable }).queryStream()));
    expect(performance.now() - t).toBeLessThan(1500);
    expect(out.rows.length).toBeGreaterThanOrEqual(1);
    expect(out.error).toBeInstanceOf(MiraDbError);
    expect(out.error).toMatchObject({ code: "MIRA_CALL_TIMEOUT", outcomeUnknown: false });
    expect(closes.at(-1)).toEqual({ drop: true });
    expect(stream.destroyCalls).toBe(1); // the driver's own close was started in the background
    timeScale = 1;
    await S.closePool("s_stream_hang");
  });

  it("destroy() on a stream whose close never answers returns at the bound", async () => {
    timeScale = 0.01;
    const closes: unknown[] = [];
    const stream = new StubStream(10);
    register("s_stream_close", { getConnection: async () => streamConn(stream, closes) }, { callTimeout: 50 });
    await S.withConnection("s_stream_close", async () => 1);
    const t = performance.now();
    const out = await S.withConnection("s_stream_close", async (k: never) => {
      const s = (k as { queryStream(): Readable }).queryStream();
      const done = new Promise<{ error?: Error }>((resolve) => {
        let error: Error | undefined;
        s.on("error", (e) => { error = e; });
        s.on("close", () => resolve({ error }));
      });
      await new Promise((r) => s.once("readable", r)); // a row has arrived
      stream.hangClose = true;
      s.destroy();
      return done;
    });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(out.error).toBeInstanceOf(MiraDbError);
    expect(closes.at(-1)).toEqual({ drop: true });
    timeScale = 1;
    await S.closePool("s_stream_close");
  });

  it("a consumer that stops reading is never timed out: the bound runs only while Mira waits on the database", async () => {
    timeScale = 0.01; // bound ~ 10 ms
    const closes: unknown[] = [];
    const stream = new StubStream(1000);
    register("s_stream_paused", { getConnection: async () => streamConn(stream, closes) }, { callTimeout: 50 });
    await S.withConnection("s_stream_paused", async () => 1);
    let errored = false;
    const rows = await S.withConnection("s_stream_paused", async (k: never) => {
      const s = (k as { queryStream(): Readable }).queryStream();
      s.on("error", () => { errored = true; });
      await new Promise((r) => s.once("readable", r)); // buffers up, then _read stops being called
      await wait(150); // 15 x the bound, with nobody reading
      const first = s.read();
      s.destroy();
      await new Promise((r) => s.once("close", r));
      return first;
    });
    expect(errored).toBe(false);
    expect(rows).toEqual({ n: 1 });
    expect(closes.at(-1)).toBe("plain"); // not dropped
    timeScale = 1;
    await S.closePool("s_stream_paused");
  });

  it("a destroy on a connection that is already dead finishes at once", async () => {
    timeScale = 0.01;
    const closes: unknown[] = [];
    const stream = new StubStream(10);
    stream.hangClose = true;
    register("s_stream_dead", { getConnection: async () => ({ ...streamConn(stream, closes), execute: () => new Promise(() => {}) }) }, { callTimeout: 50 });
    await S.withConnection("s_stream_dead", async () => 1);
    const out = await S.withConnection("s_stream_dead", async (k: never) => {
      const kk = k as { queryStream(): Readable; execute(sql: string): Promise<unknown> };
      await kk.execute("SELECT 1 FROM DUAL").catch(() => {}); // cut: the connection is dead
      const s = kk.queryStream();
      s.on("error", () => {});
      const closed = new Promise((r) => s.once("close", r));
      s.destroy(new Error("stop"));
      await closed;
      return s.destroyed;
    });
    expect(out).toBe(true);
    timeScale = 1;
    await S.closePool("s_stream_dead");
  });
});

// ── health monitor: stale records, busy pools, half-open (3.1, step 6) ─────────
describe("unit/adapter: health records, saturation and the half-open breaker (3.1)", () => {
  let H: Adapter;
  beforeAll(async () => { H = await loadAdapter(makeDriver()); });
  afterAll(async () => { await H.closeAll(); });

  function hang<T>() {
    let release!: (v: T) => void;
    let fail!: (e: Error) => void;
    const p = new Promise<T>((r, j) => { release = r; fail = j; });
    return { p, release, fail };
  }
  const metric = (name: string) => H.getHealthMetrics()[name] as { healthy: boolean; state: string; saturated: boolean; consecutiveFailures: number; halfOpenInFlight: number } | undefined;
  async function until(cond: () => boolean, tries = 200) {
    for (let i = 0; i < tries && !cond(); i++) await wait(5);
    expect(cond()).toBe(true);
  }
  /** Runs a check of `name` within a millisecond or two, without leaving the monitor's own cadence scaled. */
  function nudgeNow(name: string) {
    timeScale = 0.001;
    H.nudgePoolHealth(name);
    timeScale = 1;
  }
  const checkOf = (name: string, into: unknown[]) => H.onPoolHealthCheck((c) => { if (c.name === name) into.push(c); });

  it("a check that outlives its pool records nothing: no stale record, no NJS-503 for a re-registered pool", async () => {
    for (const how of ["succeeds", "fails"] as const) {
      const name = `s_stale_${how}`;
      const pingStarted = hang<void>();
      const pingResult = hang<void>();
      let slow = false;
      register(name, {
        getConnection: async () => conn({ ping: () => { if (!slow) return Promise.resolve(); pingStarted.release(); return pingResult.p; } }),
      }, { connectTimeout: 20_000 });
      await H.withConnection(name, async () => 1);
      slow = true;
      timeScale = 0.001; // the nudge fires at once; the check's bound is 20 ms
      H.nudgePoolHealth(name);
      timeScale = 1;
      await pingStarted.p; // the check is in flight
      await H.closePool(name); // forgets the record
      if (how === "succeeds") pingResult.release(); else pingResult.fail(new Error("ORA-03113: gone"));
      await wait(30);
      expect(metric(name)).toBeUndefined(); // nothing resurrected
      slow = false;
      expect(await H.withConnection(name, async () => "served")).toBe("served");
      await H.closePool(name);
    }
  });

  it("a check for a pool nobody monitors does nothing", async () => {
    const seen: unknown[] = [];
    const off = checkOf("s_never_monitored", seen);
    await H.nudgePoolHealth("s_never_monitored");
    await wait(300);
    off();
    expect(seen).toEqual([]);
    expect(metric("s_never_monitored")).toBeUndefined();
  });

  it("a pool that is busy, not down, is saturated: it does not count against the breaker", async () => {
    // Full, and a call finished while the check waited: busy.
    const checks: Array<{ ok: boolean; saturated?: boolean }> = [];
    const off = checkOf("s_busy_progress", checks);
    const first = hang<void>();
    let hangNext = false;
    register("s_busy_progress", {
      stats: { connectionsInUse: 10, poolMax: 10 },
      getConnection: async () => {
        if (!hangNext) return conn();
        hangNext = false;
        first.release();
        return new Promise<StubConn>(() => {}); // the check's acquire waits in the queue
      },
    }, { connectTimeout: 60_000 });
    await H.withConnection("s_busy_progress", async () => 1);
    hangNext = true;
    timeScale = 0.002; // nudge at once; the check gives up after 120 ms
    H.nudgePoolHealth("s_busy_progress");
    await first.p; // the check's acquire is waiting; its bound is already armed
    timeScale = 1;
    await H.withConnection("s_busy_progress", async () => 1); // a call finishes meanwhile
    await until(() => checks.length > 0);
    expect(checks[0]).toEqual({ name: "s_busy_progress", ok: true, saturated: true });
    expect(metric("s_busy_progress")).toMatchObject({ healthy: true, state: "closed", saturated: true, consecutiveFailures: 0 });

    // A later check that passes clears the flag.
    nudgeNow("s_busy_progress");
    await until(() => metric("s_busy_progress")?.saturated === false, 400);
    off();
    await H.closePool("s_busy_progress");

    // The driver says the queue timed out (NJS-040), and the pool has live connections (guarded, no zombies): busy.
    const checks2: Array<{ ok: boolean; saturated?: boolean }> = [];
    const off2 = checkOf("s_busy_driver", checks2);
    let full = false;
    register("s_busy_driver", {
      stats: { connectionsInUse: 10, poolMax: 10 },
      getConnection: async () => { if (full) throw new Error("NJS-040: connection request timeout. Request exceeded queueTimeout of 60"); return conn(); },
    }, { callTimeout: 1000 });
    await H.withConnection("s_busy_driver", async () => 1);
    full = true;
    nudgeNow("s_busy_driver");
    await until(() => checks2.length > 0);
    expect(checks2[0]).toMatchObject({ ok: true, saturated: true });
    off2();
    await H.closePool("s_busy_driver");
  });

  it("a full pool that is not serving (no call finished, no live connection to show for it) is down", async () => {
    const checks: Array<{ ok: boolean; saturated?: boolean }> = [];
    const off = checkOf("s_busy_down", checks);
    let full = false;
    register("s_busy_down", {
      stats: { connectionsInUse: 10, poolMax: 10 },
      getConnection: async () => { if (full) throw new Error("NJS-040: connection request timeout"); return conn(); },
    }); // no callTimeout: nothing says the connections in use are alive
    await H.withConnection("s_busy_down", async () => 1);
    full = true;
    nudgeNow("s_busy_down");
    await until(() => checks.length > 0);
    expect(checks[0]).toEqual({ name: "s_busy_down", ok: false });
    expect(metric("s_busy_down")).toMatchObject({ consecutiveFailures: 1, saturated: false });
    off();
    await H.closePool("s_busy_down");
  });

  it("half-open: a passing check admits 3 calls at a time; 3 successes close the breaker; healthy flips only twice", async () => {
    const changes: unknown[] = [];
    const off = H.onPoolHealthChange((c) => { if (c.name === "s_half") changes.push(c); });
    register("s_half");
    await H.withConnection("s_half", async () => 1);
    H.__setPoolHealthForTest("s_half", false);
    expect(metric("s_half")).toMatchObject({ healthy: false, state: "open" });
    nudgeNow("s_half");
    await until(() => metric("s_half")?.state === "half-open");
    expect(H.isPoolHealthy("s_half")).toBe(false); // half-open is not healthy
    expect(H.allPoolsHealthy()).toBe(false);

    const gate = hang<void>();
    const inside = [1, 2, 3].map(() => H.withConnection("s_half", async () => { await gate.p; return "in"; }));
    await wait(10);
    expect(metric("s_half")?.halfOpenInFlight).toBe(3);
    const fourth = await H.withConnection("s_half", async () => 4).catch((e: MiraDbError) => e);
    expect(fourth).toMatchObject({ code: "MIRA_CIRCUIT_OPEN" });
    expect((fourth as Error).message).toContain("NJS-503");
    gate.release();
    expect(await Promise.all(inside)).toEqual(["in", "in", "in"]);
    expect(metric("s_half")).toMatchObject({ state: "closed", healthy: true, consecutiveFailures: 0 });
    expect(H.isPoolHealthy("s_half")).toBe(true);
    expect(changes).toEqual([{ name: "s_half", healthy: false }, { name: "s_half", healthy: true }]);
    off();
    await H.closePool("s_half");
  });

  it("half-open: a connectivity failure re-opens; a busy pool or a statement error does not; the next failing check re-opens; a probe closes", async () => {
    let up = true;
    register("s_half2", { getConnection: async () => { if (!up) throw new Error("ORA-12541: no listener"); return conn(); } });
    await H.withConnection("s_half2", async () => 1);
    const reachHalfOpen = async () => {
      H.__setPoolHealthForTest("s_half2", false);
      nudgeNow("s_half2");
      await until(() => metric("s_half2")?.state === "half-open");
    };
    // A permit that ends in a busy-pool error is given back; it is neither a success nor a failure.
    await reachHalfOpen();
    await expect(H.withConnection("s_half2", async () => { throw new Error("NJS-040: queue timeout"); })).rejects.toThrow(/NJS-040/);
    expect(metric("s_half2")).toMatchObject({ state: "half-open", halfOpenInFlight: 0 });
    // A statement error means the database answered: it counts as a success.
    await expect(H.withConnection("s_half2", async () => { throw new Error("ORA-00942: no table"); })).rejects.toThrow(/ORA-00942/);
    expect(metric("s_half2")).toMatchObject({ state: "half-open", halfOpenInFlight: 0 });
    // A connectivity failure puts it back.
    await expect(H.withConnection("s_half2", async () => { throw new Error("ORA-03113: gone"); })).rejects.toThrow(/ORA-03113/);
    expect(metric("s_half2")?.state).toBe("open");
    H.recordProbeSuccess("s_half2"); // straight to closed
    expect(metric("s_half2")).toMatchObject({ state: "closed", healthy: true });

    // The next check failing while half-open re-opens without waiting for 3.
    await reachHalfOpen();
    up = false;
    nudgeNow("s_half2");
    await until(() => metric("s_half2")?.state === "open");
    // A check passing while half-open closes it.
    up = true;
    await reachHalfOpen();
    nudgeNow("s_half2");
    await until(() => metric("s_half2")?.state === "closed");
    await H.closePool("s_half2");
  });
});

// ── opening without waiting, creation hygiene, pool replacement (3.1, steps 8-10) ─
describe("unit/adapter: a pool that is opening, creation hygiene and pool replacement (3.1)", () => {
  let O: Adapter;
  beforeAll(async () => { O = await loadAdapter(makeDriver()); });
  afterAll(async () => { await O.closeAll(); });

  const never = () => new Promise<never>(() => {});
  function hang<T>() {
    let release!: (v: T) => void;
    let fail!: (e: Error) => void;
    const p = new Promise<T>((r, j) => { release = r; fail = j; });
    return { p, release, fail };
  }
  const metric = (name: string) => O.getHealthMetrics()[name] as { healthy: boolean; state: string; consecutiveFailures: number } | undefined;
  async function until(cond: () => boolean | Promise<boolean>, tries = 300) {
    for (let i = 0; i < tries && !(await cond()); i++) await wait(5);
    expect(await cond()).toBe(true);
  }
  const abandoned = async () => (await O.getPoolStats()).abandoned;
  const poolStat = async (name: string) => ((await O.getPoolStats()).pools as Record<string, Record<string, unknown>>)[name];
  const captureLog = async (fn: () => Promise<void>) => {
    const before = getLogger();
    const seen: string[] = [];
    setLogger({ info() {}, warn: (m: string) => void seen.push(String(m)), error() {} });
    try { await fn(); } finally { setLogger(before); }
    return seen;
  };

  it("a caller waits at most connectTimeout for a pool that is still opening; stats() and checks never wait for it", async () => {
    const opening = hang<void>();
    register("s_opening", { create: () => opening.p }, { connectTimeout: 20_000 });
    const checks: unknown[] = [];
    const off = O.onPoolHealthCheck((c) => { if (c.name === "s_opening") checks.push(c); });
    timeScale = 0.01; // the caller's 20 s bound -> 200 ms; an opening step's 40 s -> 400 ms
    const waited = await O.withConnection("s_opening", async () => 1).catch((e: MiraDbError) => e);
    expect(waited).toBeInstanceOf(MiraDbError);
    expect(waited).toMatchObject({ code: "MIRA_POOL_OPENING", kind: "connectivity", connectionName: "s_opening" });
    expect((waited as Error).message).toContain("[MIRA_POOL_OPENING]");
    O.nudgePoolHealth("s_opening"); // a check with a pending entry: nothing to ping, nothing emitted
    const t = performance.now();
    expect(await poolStat("s_opening")).toEqual({ opening: true }); // does not wait for the creation
    expect(performance.now() - t).toBeLessThan(100);
    await wait(60);
    expect(checks).toEqual([]);
    expect(metric("s_opening")?.state ?? "closed").toBe("closed");
    timeScale = 1;
    opening.release(); // the opening went on: the next caller is served
    await until(async () => (await poolStat("s_opening"))?.opening === undefined);
    expect(await O.withConnection("s_opening", async () => "served")).toBe("served");
    off();
    await O.closePool("s_opening");
  });

  it("every failed attempt counts: the breaker opens without a check waiting for the creation, and a pool that comes up closes it again", async () => {
    let up = false;
    const closes: number[] = [];
    register("s_cold", { create: () => { if (!up) throw new Error("ORA-12541: TNS:no listener"); }, close: async () => void closes.push(1) });
    timeScale = 0.001;
    const err = await O.withConnection("s_cold", async () => 1).catch((e: unknown) => e);
    // the whole creation failed: a proper error, connectivity, with the cause kept
    expect(err).toBeInstanceOf(MiraDbError);
    expect(err).toMatchObject({ kind: "connectivity", connectionName: "s_cold" });
    expect((err as MiraDbError).message).toContain('Could not create pool "s_cold" after 4 attempts');
    expect(((err as MiraDbError).originalError as Error).message).toContain("ORA-12541");
    expect(O.errorKind(err)).toBe("connectivity");
    expect(metric("s_cold")).toMatchObject({ state: "open", healthy: false });
    expect(metric("s_cold")!.consecutiveFailures).toBe(4); // one per attempt; the attempts themselves did it
    up = true; // eviction after the cool-down; a check opens the pool; the pool coming up nudges; two checks close the breaker
    await until(() => metric("s_cold")?.state === "closed");
    timeScale = 1;
    expect(await O.withConnection("s_cold", async () => "back")).toBe("back");
    await O.closePool("s_cold");

    // Attempts that failed before a pool came up do not stay on the record.
    let tries = 0;
    register("s_cold2", { create: () => { if (++tries < 3) throw new Error("ORA-12541: TNS:no listener"); } });
    timeScale = 0.001;
    expect(await O.withConnection("s_cold2", async () => "ok")).toBe("ok");
    timeScale = 1;
    expect(metric("s_cold2")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    await O.closePool("s_cold2");
  });

  it("retries open with poolMin 0 and restore the configured poolMin in the background; a failed restore is logged", async () => {
    const mins: Array<number | undefined> = [];
    const restores: unknown[] = [];
    let tries = 0;
    register("s_min", {
      create: (cfg) => { mins.push(cfg.poolMin); if (++tries < 3) throw new Error("ORA-12541: TNS:no listener"); },
      reconfigure: async (o) => void restores.push(o),
    }, { poolMin: 4 });
    timeScale = 0.001;
    await O.withConnection("s_min", async () => 1);
    timeScale = 1;
    expect(mins).toEqual([4, 0, 0]); // attempt 0 as configured, the retries with none
    await until(() => restores.length === 1);
    expect(restores).toEqual([{ poolMin: 4 }]);
    await until(async () => (await abandoned()).pools === 0); // the restore is counted while it runs, then not
    await O.closePool("s_min");

    // A healthy first attempt keeps its poolMin and restores nothing.
    const seen: Array<number | undefined> = [];
    const again: unknown[] = [];
    register("s_min_ok", { create: (cfg) => void seen.push(cfg.poolMin), reconfigure: async (o) => void again.push(o) }, { poolMin: 4 });
    await O.withConnection("s_min_ok", async () => 1);
    expect(seen).toEqual([4]);
    expect(again).toEqual([]);
    await O.closePool("s_min_ok");

    // A restore that fails is logged; the pool is up regardless.
    let n = 0;
    register("s_min_fail", {
      create: () => { if (++n < 2) throw new Error("ORA-12541: TNS:no listener"); },
      reconfigure: async () => { throw new Error("NJS-082: pool is reconfiguring"); },
    }, { poolMin: 3 });
    timeScale = 0.001;
    const warned = await captureLog(async () => {
      await O.withConnection("s_min_fail", async () => 1);
      await until(() => true);
      await wait(20);
    });
    timeScale = 1;
    expect(warned.some((m) => m.includes('Pool "s_min_fail" came up, but restoring its poolMin failed: NJS-082'))).toBe(true);
    await O.closePool("s_min_fail");
  });

  it("at most 2 abandoned opening steps per pool: further attempts are deferred, createPool is not called again", async () => {
    const hangs: Array<ReturnType<typeof hang<void>>> = [];
    let closes = 0;
    register("s_cap", { create: () => { const h = hang<void>(); hangs.push(h); return h.p; }, close: async () => void closes++ }, { connectTimeout: 10 });
    timeScale = 0.01;
    const [r] = await O.initializePools(["s_cap"]);
    timeScale = 1;
    expect(r.error).toContain("[MIRA_CREATE_DEFERRED]");
    expect(hangs).toHaveLength(2);
    expect((await abandoned()).pools).toBe(2);
    expect(metric("s_cap")!.consecutiveFailures).toBe(4); // deferred attempts count too
    for (const h of hangs) h.release();
    await until(() => closes === 2);
    await until(async () => (await abandoned()).pools === 0); // back to nothing once they end
    await O.closePool("s_cap");
  });

  // ── replacement ──────────────────────────────────────────────────────────────
  /**
   * A pool whose connections answer, except the one that arm() asked for: the next connection
   * borrowed from the pool that is current then hangs on execute, ping and close. (One call, so a
   * health check running in between cannot borrow a second stuck connection by accident.)
   */
  function replaceable(name: string, extraCfg: Record<string, unknown> = {}, poolMax = 2) {
    const stuck = { armed: false, alias: "", failAcquire: false };
    const hungCloses: Array<ReturnType<typeof hang<void>>> = [];
    const aliases: string[] = [];
    const poolCloses: number[] = [];
    let queued: ReturnType<typeof hang<StubConn>> | undefined;
    register(name, {
      stats: { poolMax },
      create: (cfg) => void aliases.push(cfg.poolAlias),
      close: async () => { poolCloses.push(1); queued?.fail(new Error("NJS-064: connection pool is closing")); },
      getConnection: async function (this: { poolAlias: string }) {
        if (queued && !queued.settled) { const q = queued; q.settled = true; return q.p; }
        if (stuck.failAcquire) throw new Error("ORA-12541: TNS:no listener");
        if (!stuck.armed || this.poolAlias !== stuck.alias) return conn();
        stuck.armed = false;
        const h = hang<void>();
        hungCloses.push(h);
        return conn({ execute: never, ping: never, close: () => h.p } as never);
      },
    }, { callTimeout: 50, connectTimeout: 10, ...extraCfg });
    const arm = () => { stuck.armed = true; stuck.alias = aliases.at(-1) ?? ""; };
    return { stuck, arm, hungCloses, aliases, poolCloses, queueNext: () => { queued = Object.assign(hang<StubConn>(), { settled: false }); return queued; } };
  }
  /** One call on a connection that never answers: cut by the guard, its connection a zombie. */
  const cut = (name: string, r: { arm(): void }) => { r.arm(); return O.withConnection(name, (k: StubConn) => k.execute("SELECT 1 FROM DUAL")).catch((e: MiraDbError) => e); };

  it("zombies filling the pool replace it: a queued caller of the old pool gets a connectivity error, the next caller a new pool, zombies are counted out in their own epoch", async () => {
    const r = replaceable("s_repl");
    timeScale = 0.01; // callTimeout 50 -> bound 1050 ms -> ~10 ms
    await O.withConnection("s_repl", async () => 1); // up (alias 1)
    expect(r.aliases).toHaveLength(1);
    const q = r.queueNext();
    const queuedCaller = O.withConnection("s_repl", async () => 1).catch((e: MiraDbError) => e);
    await wait(5);
    const first = await cut("s_repl", r);
    expect(first).toMatchObject({ code: "MIRA_CALL_TIMEOUT" });
    expect(await poolStat("s_repl")).toMatchObject({ zombieConnections: 1, replacements: 0 }); // one of two
    const warned = await captureLog(async () => { await cut("s_repl", r); }); // the second fills the pool
    timeScale = 1;
    expect(warned.some((m) => m.includes('Pool "s_repl" replaced (zombies): 2 connection(s)'))).toBe(true);
    // The caller that was queued on the old pool: a clear connectivity-class error, not a hang.
    const queuedErr = (await queuedCaller) as MiraDbError;
    expect(queuedErr).toBeInstanceOf(MiraDbError);
    expect(queuedErr.kind).toBe("connectivity");
    expect(queuedErr.message).toContain("NJS-064");
    expect(r.poolCloses.length).toBeGreaterThanOrEqual(1); // the old pool is closing
    expect(q.settled).toBe(true);

    expect(await O.withConnection("s_repl", async () => "new pool")).toBe("new pool");
    expect(r.aliases).toHaveLength(2); // a new pool, with a new alias
    expect(r.aliases[0]).not.toBe(r.aliases[1]);
    const st = await poolStat("s_repl");
    expect(st).toMatchObject({ replacements: 1 });
    expect(st.zombieConnections).toBeGreaterThanOrEqual(2); // the retired two (and a check's) are still reported
    expect((await abandoned()).zombies).toBe(st.zombieConnections);
    for (const h of r.hungCloses) h.release();
    await until(async () => (await abandoned()).zombies === 0); // each ended in the epoch it began in: no negative count
    expect(await poolStat("s_repl")).toMatchObject({ zombieConnections: 0, replacements: 1 });
    // A later zombie of the new pool is its own: one stuck connection of two does not replace it.
    await cut("s_repl", r);
    expect(await poolStat("s_repl")).toMatchObject({ zombieConnections: 1, replacements: 1 });
    for (const h of r.hungCloses) h.release();
    await until(async () => (await abandoned()).zombies === 0);
    await O.closePool("s_repl");
  });

  it("a breaker that opens while a connection is stuck replaces the pool", async () => {
    const r = replaceable("s_repl_breaker", {}, 10);
    timeScale = 0.01;
    await O.withConnection("s_repl_breaker", async () => 1);
    await cut("s_repl_breaker", r); // one zombie: far from poolMax 10
    expect(await poolStat("s_repl_breaker")).toMatchObject({ zombieConnections: 1, replacements: 0 });
    r.stuck.failAcquire = true; // every check now fails at once
    timeScale = 1;
    const nudgeNow = () => { timeScale = 0.001; O.nudgePoolHealth("s_repl_breaker"); timeScale = 1; };
    for (let i = 0; i < 3; i++) {
      const before = metric("s_repl_breaker")?.consecutiveFailures ?? 0;
      nudgeNow();
      await until(() => (metric("s_repl_breaker")?.consecutiveFailures ?? 0) > before);
    }
    expect(metric("s_repl_breaker")?.state).toBe("open");
    await until(() => r.poolCloses.length >= 1); // opened with a stuck connection: the pool was replaced
    expect(r.poolCloses).toHaveLength(1);
    r.stuck.failAcquire = false;
    for (const h of r.hungCloses) h.release();
    await O.closePool("s_repl_breaker");
  });

  it("no replacement at the cap of abandoned closes, for a pool closed meanwhile, or during shutdown", async () => {
    // Cap: poolMax 1, every close of a replaced pool hangs past its bound -> 2 abandoned pools, then no more replacing.
    const r = replaceable("s_repl_cap", {}, 1);
    const closeHangs: Array<ReturnType<typeof hang<void>>> = [];
    let hangCloses = true;
    scripts.s_repl_cap.close = () => { if (!hangCloses) return Promise.resolve(); const h = hang<void>(); closeHangs.push(h); return h.p; };
    /** A healthy pool up, then one connection of it is cut: a zombie. */
    const zombify = async () => {
      await O.withConnection("s_repl_cap", async () => 1);
      await cut("s_repl_cap", r);
    };
    timeScale = 0.01; // the close bound (10 s + 2 x 10 ms) -> ~100 ms, the call bound ~10 ms
    const base = (await abandoned()).pools;
    for (let round = 1; round <= 2; round++) {
      await zombify(); // 1 zombie >= poolMax 1: replaced
      await until(() => closeHangs.length === round);
      expect((await poolStat("s_repl_cap"))?.replacements ?? round).toBe(round);
    }
    await until(async () => (await abandoned()).pools === base + 2, 100); // both hung closes passed their bound
    await zombify(); // a third zombie would replace again, but 2 closes are unfinished
    const capped = await poolStat("s_repl_cap");
    expect(capped.replacements).toBe(2); // not 3
    expect(capped.zombieConnections as number).toBeGreaterThanOrEqual(3); // 2 retired + the live one (+ a check's)
    expect(closeHangs).toHaveLength(2);
    timeScale = 1;
    for (const h of closeHangs) h.release();
    for (const h of r.hungCloses) h.release();
    await until(async () => (await abandoned()).pools === base);
    hangCloses = false; // the pool still registered closes normally
    await O.closePool("s_repl_cap");

    // A pool closed while a call is in flight: its zombie replaces nothing (no registered pool).
    const c = replaceable("s_repl_closed", {}, 1);
    timeScale = 0.01;
    await O.withConnection("s_repl_closed", async () => 1);
    const created = c.aliases.length;
    c.arm();
    await O.withConnection("s_repl_closed", async (k: StubConn) => {
      await O.closePool("s_repl_closed");
      await k.execute("SELECT 1 FROM DUAL").catch(() => {});
    }).catch(() => {});
    timeScale = 1;
    expect(c.aliases).toHaveLength(created); // nothing was opened
    expect(((await O.getPoolStats()).pools as Record<string, unknown>).s_repl_closed).toBeUndefined();
    for (const h of c.hungCloses) h.release();

    // Shutdown: the zombie of a pool being closed replaces nothing.
    const S = await loadAdapter(makeDriver());
    const d = replaceable("s_repl_down", {}, 1);
    timeScale = 0.01;
    await S.withConnection("s_repl_down", async () => 1);
    d.arm();
    await S.withConnection("s_repl_down", async (k: StubConn) => {
      const closing = S.closeAll();
      await k.execute("SELECT 1 FROM DUAL").catch(() => {});
      await closing;
    }).catch(() => {});
    timeScale = 1;
    expect(d.aliases).toHaveLength(1);
    for (const h of d.hungCloses) h.release();
  });
});

// ── Thick pool counts ──────────────────────────────────────────────────────────
// In Thick mode connectionsInUse / connectionsOpen are OCI reads that wait on the pool's
// mutex, which a native operation hung on a dead link holds forever: one such read froze the
// whole process (chaos suite, health monitor's busy check). Mira must count in JS and ask the
// driver only while none of its pool operations is in flight.
describe("Thick pool counts never wait on the driver", () => {
  const captureWarnings = async (fn: () => Promise<unknown>) => {
    const before = getLogger();
    setLogger({ info() {}, warn() {}, error() {} });
    try {
      await fn();
    } finally {
      setLogger(before);
    }
  };
  it("counts connections in JS, reads the driver only while nothing is in flight, and says when counts are approximate", async () => {
    let reads = 0;
    let nextConn: () => Promise<StubConn> = async () => conn();
    const pool = {
      poolAlias: "",
      queueLength: 0,
      get poolMin() { reads++; return 1; },
      get poolMax() { reads++; return 10; },
      get connectionsOpen() { reads++; return 3; },
      get connectionsInUse() { reads++; return 99; },
      getConnection: () => nextConn(),
      close: async () => {},
      reconfigure: async () => {},
    };
    const a = await loadAdapter(makeDriver({ oracleClientVersion: 1906000000, createPool: async () => pool }));
    register("s_tally", {}, { poolMin: 2, poolMax: 4, connectTimeout: 300, queueTimeout: 0 });
    const usage = async () => ((await a.getPoolStats()).pools as Record<string, Record<string, unknown>>).s_tally;
    try {
      await a.withConnection("s_tally", async () => 1);
      // Idle: the driver is asked for connectionsOpen; in-use and limits come from Mira.
      reads = 0;
      let s = await usage();
      expect(s).toMatchObject({ connectionsOpen: 3, connectionsInUse: 0, poolMin: 2, poolMax: 4 });
      expect(s.countsApproximate).toBeUndefined();
      expect(reads).toBe(1);

      // A connection held by a caller counts as in use; nothing in flight, so still exact.
      let releaseHeld!: () => void;
      const held = a.withConnection("s_tally", () => new Promise<void>((r) => (releaseHeld = r)));
      await wait(10);
      expect(await usage()).toMatchObject({ connectionsInUse: 1, connectionsOpen: 3 });

      // A getConnection that never returns (a stalled link): the driver is not touched any more.
      let finishHung!: (c: StubConn) => void;
      nextConn = () => new Promise<StubConn>((r) => (finishHung = r));
      const stuck = a.withConnection("s_tally", async () => 1).catch((e: Error) => e);
      await wait(10);
      reads = 0;
      s = await usage();
      expect(reads).toBe(0);
      expect(s).toMatchObject({ connectionsInUse: 1, connectionsOpen: 3, countsApproximate: true });
      expect(((await stuck) as MiraDbError).code).toBe("MIRA_ACQUIRE_TIMEOUT");

      // A close that fails leaves the connection with the driver: still counted.
      nextConn = async () => conn({ close: async () => { throw new Error("DPI-1010: not connected"); } });
      finishHung(conn()); // the late arrival is closed by the orphan guard
      await wait(10);
      await captureWarnings(() => a.withConnection("s_tally", async () => 1));
      releaseHeld();
      await held;
      expect(await usage()).toMatchObject({ connectionsInUse: 1, connectionsOpen: 3 });

      // A failed getConnection and a reconfigure settle their tally too.
      nextConn = async () => { throw new Error("ORA-00942: no such table"); };
      await a.withConnection("s_tally", async () => 1).catch(() => {});
      await pool.reconfigure();
      reads = 0;
      expect((await usage()).countsApproximate).toBeUndefined();
      expect(reads).toBe(1);
    } finally {
      await a.closeAll();
      delete conns.s_tally;
    }
  });

  it("Thin pools keep the driver's own numbers (they are plain JS there)", async () => {
    const a = await loadAdapter(makeDriver());
    register("s_tally_thin", { stats: { connectionsOpen: 5, connectionsInUse: 2, poolMin: 1, poolMax: 7 } });
    try {
      await a.withConnection("s_tally_thin", async () => 1);
      const s = ((await a.getPoolStats()).pools as Record<string, Record<string, unknown>>).s_tally_thin;
      expect(s).toMatchObject({ connectionsOpen: 5, connectionsInUse: 2, poolMin: 1, poolMax: 7 });
    } finally {
      await a.closeAll();
      delete conns.s_tally_thin;
    }
  });
});

// node-oracledb 7.0.1 reads a connection's service/instance names for its trace context at the start
// of every call while a trace handler is installed; on a broken Thick connection that read throws, so
// close() never gives the session back. Mira's own closes run with tracing off for their start.
describe("connection closes run untraced", () => {
  it("every close starts with no trace handler installed, and the handler is back right after (also when the close throws)", async () => {
    const handler = { isEnabled: () => true };
    let current: unknown = handler;
    const seen: unknown[] = [];
    const traceHandler = { getTraceInstance: () => current, setTraceInstance: (h: unknown) => void (current = h) };
    const tracedConn = (fail: boolean) =>
      conn({
        close: () => {
          seen.push(current);
          if (fail) throw new Error("DPI-1010: not connected"); // a synchronous throw still restores the handler
          return Promise.resolve();
        },
      });
    let failNext = false;
    const a = await loadAdapter(makeDriver({ traceHandler }));
    register("s_untraced", { getConnection: async () => tracedConn(failNext) });
    const before = getLogger();
    setLogger({ info() {}, warn() {}, error() {} });
    try {
      await a.withConnection("s_untraced", async () => 1);
      failNext = true;
      await a.withConnection("s_untraced", async () => 1);
      expect(seen.length).toBeGreaterThanOrEqual(3); // creation warm-up + two releases
      expect(seen.every((h) => h === undefined)).toBe(true);
      expect(current).toBe(handler);
    } finally {
      setLogger(before);
      await a.closeAll();
      delete conns.s_untraced;
    }
  });
});
