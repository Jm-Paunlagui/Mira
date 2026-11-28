/**
 * Oracle Adapter
 * Merges: oracleEnvironment.js + oracleLoader.js + oracleConnectionPool.js
 *
 * Pools are lazy — created on first use, by name, from the registry that
 * createMira() fills (src/driver/registry.ts). Mira reads no environment
 * variable for them.
 *
 * Public API:
 *   withConnection(name, cb)          acquire → run → release
 *   withTransaction(name, cb)         same, wrapped in BEGIN/COMMIT/ROLLBACK
 *   withBatchConnection(name, ops[])  many ops on one shared connection
 *   closeAll()                        graceful shutdown
 *   getPoolStats()                    monitoring snapshot
 *   isPoolHealthy(name)               health probe
 *   getHealthMetrics()                full health object
 *   errorKind(err)                    "connectivity" | "saturation" | "timeout" | "statement" (internal)
 *
 * Errors: what Mira throws from a database operation is a MiraDbError
 * (src/driver/errors.ts) with a kind, a Mira code when the failure is Mira's own,
 * and outcomeUnknown. Every wait on the database is bounded (call, acquire, pool
 * open, health check, pool close); what a bound abandons is counted in a ledger
 * that getPoolStats() reports as `abandoned`.
 *
 * There are no built-in pools: every name comes from a createMira() config.
 */


import { EventEmitter } from "events";
import { availableParallelism } from "os";
import database from "./registry";
// Captured at load, not per call: freshOracleAdapter.js relies on it (see database.ts).
const { getConnectionConfig, getConnectionNames } = database;
import { log } from "../shared/log";
import { oracleMessages, miraConfigMessages } from "../shared/messages";
import { checkDriver, MiraConfigError } from "../config/defineConfig";
import type { DriverMode, DriverOptions } from "../config/types";
import { MiraDbError, CODE_KIND, type MiraErrorKind, type MiraErrorCode } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Driver loader  (was: oracleLoader.js)
// ─────────────────────────────────────────────────────────────────────────────

/** binaryDir for initOracleClient, when configureDriver() was given one (compiled executables). */
function _binaryOpts(): { binaryDir?: string } {
    return _driverOptions.binaryDir ? { binaryDir: _driverOptions.binaryDir } : {};
}

/** The node-oracledb module. */
type OracleDb = typeof import("oracledb");

/**
 * The session time zone the caller chose with ORA_SDTZ: undefined when unset
 * (sessions follow the process's zone), null when it is not a value Mira will
 * put into SQL (sessions are left as the client opens them; a warning says so).
 * Resolved once by initDriver().
 */
let _sessionTimeZoneOverride: string | null | undefined;
/** An offset (+08:00), a region (Asia/Manila), LOCAL or DBTIMEZONE: no quote or space can get in. */
const SESSION_TZ_RE = /^[A-Za-z0-9_+\-/:]{1,64}$/;

/** Reads the caller's ORA_SDTZ once. Mira never writes ORA_SDTZ itself. */
function _resolveSessionTimeZone() {
    const own = process.env.ORA_SDTZ?.trim();
    _sessionTimeZoneOverride = own ? (SESSION_TZ_RE.test(own) ? own : null) : undefined;
    if (_sessionTimeZoneOverride === null) log().warning(oracleMessages.SESSION_TZ_IGNORED);
}

/** The process's current UTC offset as Oracle writes it: +08:00, -05:00, +05:30. */
function _processUtcOffset(): string {
    const minutes = -new Date().getTimezoneOffset();
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The process's IANA zone (Asia/Manila, America/New_York) when it is one Oracle can take; else null. */
function _processRegion(): string | null {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.includes("/") && SESSION_TZ_RE.test(zone) ? zone : null;
}

/**
 * Pool sessionCallback: runs once per NEW pooled session (not per checkout) and
 * sets its time zone to the process's (or to the caller's ORA_SDTZ).
 *
 * node-oracledb turns a JS Date into a timestamp in the PROCESS's zone, and
 * Oracle reads that timestamp in the SESSION's zone; when the two differ, a Date
 * written to a TIMESTAMP WITH (LOCAL) TIME ZONE column moves by the difference.
 * Thick mode opens sessions in the C runtime's zone, which differs whenever the
 * JS zone was changed (bun test forces UTC); forcing +00:00, as 2.x did, was right
 * only for a process on UTC.
 *
 * Thin mode gets the region (America/New_York), so a Date from the other side
 * of a daylight-saving change converts with its own offset; if the server does
 * not know the region, the offset. Thick mode gets the offset: a region makes it
 * fetch with the client's time-zone file, which fails (ORA-01805) when that file
 * differs from the server's. In a zone with daylight saving, a Thick-mode Date
 * from the other season therefore moves by an hour: run such a process on UTC.
 */
function _setSessionTimeZone(conn: import("oracledb").Connection, _requestedTag: string, done: (err?: Error) => void): void {
    const alter = (zone: string) => conn.execute(`ALTER SESSION SET TIME_ZONE = '${zone}'`);
    const offset = _processUtcOffset();
    const region = _driverInfo?.mode === "thin" ? _processRegion() : null;
    const run = _sessionTimeZoneOverride
        ? alter(_sessionTimeZoneOverride)
        : region
          ? alter(region).catch(() => alter(offset))
          : alter(offset);
    run.then(() => done(), (err: Error) => done(err));
}

/** "auto": try Thick mode from libDir or the system library path; a failure leaves Thin mode. */
function _initOracleClient(db: OracleDb, libDir?: string) {
    if (db.oracleClientVersion) return;
    try {
        if (libDir) {
            db.initOracleClient({ libDir, ..._binaryOpts() });
            log().notice(`Oracle client initialised from ${libDir}.`);
        } else {
            db.initOracleClient(_binaryOpts());
            log().notice("Oracle client initialised from system PATH.");
        }
    } catch (err) {
        if (err.message.includes("NJS-077")) return;
        // No client on the library path is the ordinary Thin-mode case: a notice, first line only.
        // A libDir the app named that fails to load is worth a warning.
        if (libDir) log().warning(`Oracle client init from ${libDir} failed; using Thin mode: ${err.message}`);
        else log().notice(`No Oracle Client on the library path; using Thin mode (${String(err.message).split("\n")[0].slice(0, 120)}).`);
    }
}

// The module is loaded here; nothing is initialised until the first pool (initDriver).
// Loading it is side-effect free and gives db.oracledb its constants.
const oracledb: OracleDb = require("oracledb") as OracleDb;

/** What configureDriver() asked for; read by initDriver(). */
let _driverOptions: { mode: DriverMode; libDir?: string; binaryDir?: string } = { mode: "auto" };
/** Set once initDriver() has run. */
let _driverInfo: Readonly<{ mode: "thin" | "thick"; clientVersion?: number }> | null = null;

/**
 * Chooses Thin or Thick mode for this process. Must run before the first pool
 * opens. After that, options compatible with the running driver ("auto", or
 * the mode that loaded, with no other libDir or binaryDir) are accepted and anything else
 * throws, because the Oracle Client cannot be unloaded.
 * @param {DriverOptions} [options]
 * @throws {MiraConfigError} for an invalid option.
 * @throws {Error} when the driver is already initialised differently.
 */
function configureDriver(options: DriverOptions = {}): void {
    const issues: string[] = [];
    checkDriver(options, issues);
    if (issues.length) throw new MiraConfigError(issues);
    const next = { mode: options.mode ?? "auto", libDir: options.libDir, binaryDir: options.binaryDir };
    if (_driverInfo) {
        // Compatible with what is running: "auto" or the mode that loaded, and no other libDir.
        const modeOk = next.mode === "auto" || next.mode === _driverInfo.mode;
        const dirOk = next.libDir === undefined || next.libDir === _driverOptions.libDir;
        const binOk = next.binaryDir === undefined || next.binaryDir === _driverOptions.binaryDir;
        if (!modeOk || !dirOk || !binOk) {
            const show = (mode: string, o: { libDir?: string; binaryDir?: string }) => {
                const dirs = [o.libDir, o.binaryDir && `binaryDir ${o.binaryDir}`].filter(Boolean);
                return dirs.length ? `${mode} (${dirs.join(", ")})` : mode;
            };
            throw new Error(miraConfigMessages.DRIVER_ALREADY_INITIALISED(show(_driverInfo.mode, _driverOptions), show(next.mode, next)));
        }
        return;
    }
    _driverOptions = next;
}

/**
 * Initialises node-oracledb once, as configureDriver() asked: session time
 * zone, the money-safe fetch handler, and (auto / thick) the Oracle Client.
 * Runs by itself before the first pool; call it at startup to fail fast.
 * @returns {{ mode: "thin" | "thick", clientVersion?: number }}
 * @throws {Error} in "thick" mode when the Oracle Client cannot load.
 */
function initDriver(): Readonly<{ mode: "thin" | "thick"; clientVersion?: number }> {
    if (_driverInfo) return _driverInfo;
    const { mode, libDir } = _driverOptions;
    try {
        // Session time zone: each pooled session is set to the process's own zone
        // (see _setSessionTimeZone); an ORA_SDTZ the caller set wins.
        _resolveSessionTimeZone();

        // Applied driver-wide so EVERY query (wrapper methods and raw conn.execute alike)
        // gets exact decimal strings for scaled NUMBER columns. It used to live only in
        // EXECUTE_OPTIONS, which no wrapper query passes — money silently arrived as
        // IEEE doubles (123456789012345.6789 → 123456789012345.67).
        oracledb.fetchTypeHandler = moneySafeFetchTypeHandler;
        oracledb.fetchArraySize = 1000; // Reduce internal round-trips for bulk reads (default: 100)

        if (mode === "auto") {
            // Thick when a client can load (it supports every password verifier;
            // Thin rejects some, e.g. 0x939), else Thin.
            _initOracleClient(oracledb, libDir);
        } else if (mode === "thick" && !oracledb.oracleClientVersion) {
            try {
                oracledb.initOracleClient({ ...(libDir && { libDir }), ..._binaryOpts() });
            } catch (err) {
                if (!err.message.includes("NJS-077")) throw err;
            }
        }

        const version = oracledb.oracleClientVersion;
        _driverInfo = Object.freeze({ mode: version ? "thick" : "thin", ...(version && { clientVersion: version }) } as const);
        log().notice(`oracledb driver loaded (${version ? "Thick" : "Thin"} mode).`);
        return _driverInfo;
    } catch (err) {
        log().critical(`Failed to load oracledb: ${err.message}`);
        throw err;
    }
}

const OUT_FORMAT_OBJECT = oracledb.OUT_FORMAT_OBJECT;
// node-oracledb names this constant SYSDBA; "SYSDBA_PRIVILEGE" does not exist on the driver (it was always undefined).
const SYSDBA_PRIVILEGE = oracledb.SYSDBA;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Pool management  (was: oracleConnectionPool.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pool defaults. `connectTimeout` is in MILLISECONDS here (the app's own acquire-race timer uses it
 * as ms); it is converted by {@link toDriverConnectTimeoutSec} before createPool, because node-oracledb
 * reads it as SECONDS. Thick mode ignores it entirely: sqlnet.ora / the connect descriptor govern.
 */
const POOL_DEFAULTS = Object.freeze({
    poolMin: 10,
    poolMax: 50,
    poolIncrement: 5,
    poolTimeout: 30,
    // Safety floor (B6). node-oracledb's own default is 500, which means the
    // queue effectively never sheds and callers pile up unbounded on an
    // exhausted pool until queueTimeout fires one at a time. Any pool that does
    // not set its own queueMax in database.js inherits this bounded floor. Every
    // registry entry SHOULD still set a deliberate per-pool queueMax — the
    // per-pool value overrides this via {...POOL_DEFAULTS, ...dbConfig} in
    // _createPool. This is only the last line of defence for an unconfigured pool.
    queueMax: 40,
    queueTimeout: 15000,
    poolPingInterval: 30,
    connectTimeout: 15000,
    // No callTimeout here: node-oracledb takes it per CONNECTION, not in createPool().
    // A pool's `callTimeout` (default 0: no limit) is applied to each borrowed
    // connection by withConnection; see _applySessionLimits.
    stmtCacheSize: 50,
    homogeneous: true,
    externalAuth: false,
    events: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-SAFE FETCH
// ─────────────────────────────────────────────────────────────────────────────
// node-oracledb returns a NUMBER as a JavaScript double by default. A
// NUMBER(19,4) money value or a NUMBER(19,8) rate is therefore ALREADY ROUNDED
// before any application code — or the exact-decimal `utils/money.js` type — can
// see it. This handler intercepts every scaled NUMBER column at fetch time and
// asks the driver to hand it back as a STRING, which `Money.from(string)` then
// parses without loss.
//
// SELECTION IS ON `scale > 0`, DERIVED FROM THE SCHEMA — NOT A COLUMN LIST.
//   - money  → NUMBER(19,4) → scale 4 → returned as string ✓
//   - rate   → NUMBER(19,8) → scale 8 → returned as string ✓
//   - IDs, counts, STATUS_CODE → NUMBER (scale 0) → left as JS numbers ✓
// So integer keys and flags keep their ergonomic numeric type; only values that
// actually carry decimals are protected.
//
// BLAST RADIUS IS ZERO ON TODAY'S SCHEMA. CATHERINE declares no scaled NUMBER
// column yet, so this handler is inert until a copier creates a money/rate
// column — at which point it activates automatically. That is exactly why it
// ships now (a dormant guard) rather than later (a behavioural change to live
// code).
//
// It also means the legacy `convertTypes`/`rowToDoc` helpers in
// `src/shared/utils.ts` must NOT re-coerce these strings back to
// numbers — they are fenced off there (they would undo this protection).
//
// LOBS ARE FETCHED AS PLAIN VALUES (2.0.1).
//   - CLOB / NCLOB → string, BLOB → Buffer
// A driver Lob is a locator tied to the connection that fetched it, and every
// wrapper call releases its connection before returning. Thin mode happened to
// keep such a Lob readable; Thick mode (OCI) refuses with NJS-003. Materialising
// the value at fetch time behaves the same in both modes.
function moneySafeFetchTypeHandler(metaData: import("oracledb").Metadata<unknown>) {
    if (metaData.dbType === oracledb.DB_TYPE_NUMBER && (metaData.scale ?? 0) > 0) {
        return { type: oracledb.STRING };
    }
    if (metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB) {
        return { type: oracledb.STRING };
    }
    if (metaData.dbType === oracledb.DB_TYPE_BLOB) {
        return { type: oracledb.BUFFER };
    }
    return undefined; // default handling for everything else
}

// oracledb.fetchTypeHandler is set to this handler by initDriver(), before the first pool.

const EXECUTE_OPTIONS = Object.freeze({
    outFormat: OUT_FORMAT_OBJECT,
    autoCommit: true,
    fetchArraySize: 1000,
    fetchTypeHandler: moneySafeFetchTypeHandler,
});

const poolRegistry = new Map(); // name → Promise<Pool>
// Every pool name that has ever been requested. The health monitor iterates
// THIS set, not poolRegistry: a pool whose creation failed (and whose registry
// entry was evicted so it can retry) must stay monitored, otherwise it is never
// health-checked, isHealthy() stays true and ORACLE_POOL_DOWN never fires.
const _monitoredNames = new Set<string>();
// How long a rejected pool-creation promise stays cached before the registry
// entry is evicted so the next caller (or the next monitor tick) retries.
const POOL_CREATE_COOLDOWN_MS = 5000;
let isShuttingDown = false;

// ── Health monitor ────────────────────────────────────────────────────────────

/**
 * Pings every monitored pool and drives the circuit breaker in withConnection.
 *
 * Emits `"change"` with `{ name, healthy }` whenever a pool's breaker flips, so
 * the readiness push stream (services/HealthStreamHub.js) can tell clients at once.
 * Cadence: `_checkIntervalMs` while every pool is clean; `_recoveryIntervalMs`
 * while any pool has a failure on record, so an outage is confirmed and a
 * recovery is noticed in seconds rather than in 30 s steps.
 */
/**
 * The breaker of one pool. closed: calls go through. open: calls fail at once (NJS-503).
 * half-open: a check passed after an outage, so a few calls (HALF_OPEN_PERMITS at a time)
 * are let through to test the pool; HALF_OPEN_SUCCESSES of them succeeding, or the next
 * check passing, closes it; a failure opens it again.
 */
type BreakerState = "closed" | "open" | "half-open";
/** Health record kept per monitored pool. `healthy` is true exactly when `state` is "closed". */
type PoolHealth = {
    healthy: boolean;
    state: BreakerState;
    lastCheck: Date | null;
    consecutiveFailures: number;
    /** The last check found the pool busy (every connection in use, still serving), not down: it did not count as a failure. */
    saturated: boolean;
    halfOpenInFlight: number;
    halfOpenSuccesses: number;
};
/** Callers let through at once while half-open. */
const HALF_OPEN_PERMITS = 3;
/** Admitted calls that must succeed to close a half-open breaker. */
const HALF_OPEN_SUCCESSES = 3;
/** What admit() decided: pass (closed), permit (a half-open test call: report it to settle()), reject. */
type Admission = "pass" | "permit" | "reject";
/** Calls that finished work on a pool, per name: a check that fails while this grew was not stuck on zombies. */
const _progress = new Map<string, number>();
/** A connection went back to its pool normally: the pool is serving. */
function _noteProgress(name: string): void {
    _progress.set(name, (_progress.get(name) ?? 0) + 1);
}

class PoolHealthMonitor extends EventEmitter {
    declare _gap: number;
    declare _nudges: Map<string, ReturnType<typeof setTimeout>>;
    declare _inFlight: Set<unknown>;
    declare _stopped: boolean;
    declare _timer: ReturnType<typeof setTimeout> | null;
    declare _watched: boolean;
    declare _watchedIntervalMs: number;
    declare _recoveryIntervalMs: number;
    declare _checkIntervalMs: number;
    declare _maxFailures: number;
    declare _metrics: Map<string, PoolHealth>;
    constructor() {
        super();
        this._metrics = new Map();
        this._maxFailures = 3;
        this._checkIntervalMs = 30_000;
        this._recoveryIntervalMs = 5_000;
        // Cadence while a readiness stream is open (services/HealthStreamHub.js):
        // clients are told within seconds, without waiting for traffic.
        this._watchedIntervalMs = 5_000;
        this._watched = false;
        this._timer = null;
        this._stopped = false;
        this._inFlight = new Set();
        this._nudges = new Map();
    }

    /**
     * Opens or closes a pool's breaker. Never creates a record: a record that was
     * forgotten (its pool closed) stays gone, so a check that outlived its pool
     * cannot bring back a stale, unhealthy one.
     * @param {string} name
     * @param {boolean} healthy
     * @returns {void}
     */
    _setHealthy(name: string, healthy: boolean): void {
        this._setState(name, healthy ? "closed" : "open");
    }

    /**
     * The single writer of a breaker's state. `healthy` follows it (closed is healthy);
     * `"change"` is emitted only when `healthy` flips, so open -> half-open is silent.
     */
    _setState(name: string, state: BreakerState): void {
        const meta = this._metrics.get(name);
        if (!meta || meta.state === state) return;
        const wasHealthy = meta.healthy;
        meta.state = state;
        meta.healthy = state === "closed";
        if (state === "half-open") {
            meta.halfOpenInFlight = 0;
            meta.halfOpenSuccesses = 0;
            log().notice(oracleMessages.BREAKER_HALF_OPEN(name));
        }
        if (wasHealthy === meta.healthy) return;
        try {
            this.emit("change", { name, healthy: meta.healthy });
        } catch (e) {
            log().warning(`Pool health listener failed for "${name}": ${e.message}`);
        }
    }

    /**
     * The breaker gate of withConnection. "pass": closed. "permit": half-open and fewer than
     * HALF_OPEN_PERMITS test calls in flight; the caller must report it with settle().
     * "reject": open, or half-open and full.
     */
    admit(name: string): Admission {
        const meta = this._metrics.get(name);
        if (!meta || meta.state === "closed") return "pass";
        if (meta.state === "half-open" && meta.halfOpenInFlight < HALF_OPEN_PERMITS) {
            meta.halfOpenInFlight++;
            return "permit";
        }
        return "reject";
    }

    /**
     * Reports how an admitted call ended. Only a "permit" matters. A call that worked (or failed
     * on its statement: the database answered) is a success, HALF_OPEN_SUCCESSES of them close the
     * breaker. A connectivity failure opens it again. Anything else (busy pool, a driver timeout)
     * just gives the permit back.
     */
    settle(name: string, admission: Admission, kind: MiraErrorKind | "ok"): void {
        const meta = this._metrics.get(name);
        if (admission !== "permit" || !meta || meta.state !== "half-open") return;
        meta.halfOpenInFlight = Math.max(0, meta.halfOpenInFlight - 1);
        if (kind === "connectivity") {
            this._setState(name, "open");
        } else if (kind === "ok" || kind === "statement") {
            meta.halfOpenSuccesses++;
            if (meta.halfOpenSuccesses >= HALF_OPEN_SUCCESSES) this._close(name, meta);
        }
    }

    /** half-open -> closed: the pool is back. */
    _close(name: string, meta: PoolHealth): void {
        log().notice(oracleMessages.POOL_RECOVERED(name, meta.consecutiveFailures));
        meta.consecutiveFailures = 0;
        this._setState(name, "closed");
    }

    /**
     * Records a successful bypass-breaker readiness probe. A real `SELECT 1`
     * through the pool is the same evidence a monitor ping gives, so the
     * breaker closes now instead of on the next monitor tick: "ready" must
     * never be reported while withConnection would still fail fast (NJS-503).
     * @param {string} name
     * @returns {void}
     */
    recordProbeSuccess(name: string): void {
        const meta = this._ensure(name);
        if (!meta.healthy) {
            log().notice(
                oracleMessages.POOL_RECOVERED(name, meta.consecutiveFailures),
            );
        }
        meta.consecutiveFailures = 0;
        meta.saturated = false;
        meta.lastCheck = new Date();
        this._setHealthy(name, true);
    }

    /** Emits `"check"` `{ name, ok }` (plus `saturated: true` for a busy pool) after every check; a listener fault never reaches the monitor. */
    _emitCheck(name: unknown, ok: unknown, saturated = false) {
        try {
            this.emit("check", saturated ? { name, ok, saturated } : { name, ok });
        } catch (e) {
            log().warning(`Pool health listener failed for "${name}": ${e.message}`);
        }
    }

    /** @returns {boolean} true while any monitored pool has a failure on record. */
    _anyFailing(): boolean {
        for (const m of this._metrics.values()) {
            if (!m.healthy || m.consecutiveFailures > 0) return true;
        }
        return false;
    }

    /** The health record for `name`, created healthy on first use. */
    _ensure(name: string): PoolHealth {
        let meta = this._metrics.get(name);
        if (!meta) {
            meta = { healthy: true, state: "closed", lastCheck: null, consecutiveFailures: 0, saturated: false, halfOpenInFlight: 0, halfOpenSuccesses: 0 };
            this._metrics.set(name, meta);
        }
        return meta;
    }

    /**
     * One health check: borrows a connection from the pool and pings it, each step bounded by
     * connectTimeout. The record is captured first and compared after every await: a check
     * that outlives its pool (closePool forgot the record) records nothing.
     */
    async checkPool(name: string) {
        if (!_monitoredNames.has(name)) return;
        // A check never waits for a pool to open. No pool: start opening one and leave (every
        // failed attempt records itself). A pool still opening, or one whose opening failed and is
        // cooling down, is not checked: its attempts are the evidence.
        const entry = poolRegistry.get(name);
        if (!entry) {
            _getOrCreatePool(name).catch(_ignore);
            return;
        }
        const settled = _poolSettled.get(entry);
        if (!settled?.ok) return;
        const meta = this._metrics.get(name) ?? this._ensure(name);
        const progress = _progress.get(name) ?? 0;
        let pool: import("oracledb").Pool | undefined;
        try {
            pool = settled.pool;
            await _pingPool(name, pool);
        } catch (err) {
            if (this._metrics.get(name) === meta) this._recordFailure(name, meta, err, pool, progress);
            return;
        }
        if (this._metrics.get(name) === meta) this._recordSuccess(name, meta);
    }

    /** A check passed: open -> half-open, half-open -> closed; any outcome clears `saturated`. */
    _recordSuccess(name: string, meta: PoolHealth): void {
        meta.lastCheck = new Date();
        meta.saturated = false;
        if (meta.state === "open") {
            this._setState(name, "half-open");
        } else if (meta.state === "half-open") {
            this._close(name, meta);
        } else {
            meta.consecutiveFailures = 0;
        }
        this._emitCheck(name, true);
    }

    /**
     * A check failed. A pool that is merely busy (full, or the check timed out queueing, while
     * calls still finish or connections are live) is not down: that is recorded as saturated.
     * Anything else counts; MAX failures open a closed breaker, one failure re-opens a half-open one.
     */
    _recordFailure(name: string, meta: PoolHealth, err: unknown, pool: import("oracledb").Pool | undefined, progressAtStart: number): void {
        if (_isBusyNotDown(name, err, pool, progressAtStart)) {
            this._recordSaturated(name, meta);
            return;
        }
        meta.saturated = false;
        meta.consecutiveFailures++;
        meta.lastCheck = new Date();
        log().warning(oracleMessages.POOL_HEALTH_CHECK_FAILED(name, meta.consecutiveFailures));
        if (meta.state === "half-open") {
            this._setState(name, "open");
        } else if (meta.state === "closed" && meta.consecutiveFailures >= this._maxFailures) {
            // O5: ORACLE_POOL_DOWN rule delivers the email; tap must not double-notify
            log().critical(oracleMessages.POOL_MARKED_UNHEALTHY(name, this._maxFailures), { _noNotify: true });
            this._setState(name, "open");
            // Open with connections stuck on a dead link: only a new pool (new sockets) can recover.
            _maybeReplacePool(name, "breaker");
        }
        this._emitCheck(name, false);
        // The next tick was scheduled before this result arrived; switch
        // to the fast cadence now rather than one slow interval later.
        if (this._timer && !this._stopped && this._gap > this._recoveryIntervalMs) {
            clearTimeout(this._timer);
            this._schedule();
        }
    }

    /**
     * An attempt to open the pool failed (no pool to check yet): it counts like a failed check, so a
     * pool that cannot open opens the breaker after the same 3 failures, without any check waiting
     * for the creation. Records nothing for a pool that is no longer monitored (closed).
     */
    _recordAttemptFailure(name: string, err: unknown): void {
        if (!_monitoredNames.has(name)) return;
        this._recordFailure(name, this._ensure(name), err, undefined, 0);
    }

    /**
     * A pool opened. Failed attempts before it no longer count; a breaker that is not closed gets
     * a check now (its first success moves it to half-open) instead of waiting for the next tick.
     */
    _noteCreated(name: string): void {
        const meta = this._metrics.get(name);
        if (!meta || !_monitoredNames.has(name)) return;
        if (meta.state === "closed") meta.consecutiveFailures = 0;
        else this.nudge(name);
    }

    /** The check found the pool busy: not a failure, not a success; the counters stay as they are. */
    _recordSaturated(name: string, meta: PoolHealth): void {
        meta.saturated = true;
        meta.lastCheck = new Date();
        log().notice(oracleMessages.HEALTH_CHECK_SATURATED(name));
        this._emitCheck(name, true, true);
    }

    start() {
        if (this._timer) return;
        this._stopped = false;
        this._schedule();
    }

    /**
     * Self-rescheduling tick: the next gap depends on whether anything is
     * failing or a readiness stream is watching. The tick does not wait for
     * the checks; a pool whose previous check is still running is skipped, so
     * a hung acquire never stacks checks or stalls the other pools.
     */
    _schedule() {
        let gap = this._checkIntervalMs;
        if (this._anyFailing()) gap = this._recoveryIntervalMs;
        else if (this._watched) gap = this._watchedIntervalMs;
        this._gap = gap;
        this._timer = setTimeout(() => {
            for (const name of _monitoredNames) this._runCheck(name);
            if (!this._stopped) this._schedule();
        }, gap);
        if (this._timer.unref) this._timer.unref();
    }

    /** Runs one check unless one is already in flight for `name`. */
    _runCheck(name: string) {
        if (this._inFlight.has(name)) return;
        this._inFlight.add(name);
        this.checkPool(name)
            .catch((e) => log().warning(`Health check "${name}": ${e.message}`))
            .finally(() => this._inFlight.delete(name));
    }

    /**
     * Checks `name` soon, outside the regular cadence. Called when a real
     * query hits a connection-class failure, so an outage is confirmed in
     * seconds instead of waiting for the next tick. Debounced per pool.
     * @param {string} name
     * @returns {void}
     */
    nudge(name: string): void {
        if (this._stopped || this._nudges.has(name)) return;
        const t = setTimeout(() => {
            this._nudges.delete(name);
            this._runCheck(name);
        }, 250);
        if (t.unref) t.unref();
        this._nudges.set(name, t);
    }

    /** Drops `name`'s health record and pending nudge (its pool was closed on purpose). */
    forget(name: string): void {
        this._metrics.delete(name);
        const t = this._nudges.get(name);
        if (t) clearTimeout(t);
        this._nudges.delete(name);
    }

    stop() {
        this._stopped = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        for (const t of this._nudges.values()) clearTimeout(t);
        this._nudges.clear();
    }

    /**
     * While a readiness stream has subscribers, healthy pools are checked
     * every `_watchedIntervalMs` instead of every `_checkIntervalMs`.
     * @param {boolean} watched
     * @returns {void}
     */
    setWatched(watched: boolean): void {
        const next = Boolean(watched);
        if (this._watched === next) return;
        this._watched = next;
        if (this._timer && !this._stopped) {
            clearTimeout(this._timer);
            this._schedule();
        }
    }

    /** @returns {boolean} true when every monitored pool's breaker is closed. */
    allHealthy(): boolean {
        for (const m of this._metrics.values()) if (!m.healthy) return false;
        return true;
    }

    isHealthy(name: string) {
        return this._metrics.get(name)?.healthy ?? true;
    }

    getMetrics() {
        const out: Record<string, unknown> = {};
        for (const [n, m] of this._metrics) out[n] = { ...m };
        return out;
    }
}

const healthMonitor = new PoolHealthMonitor();
healthMonitor.start();

/**
 * Driver errors that mean "the database cannot be reached" (listener down,
 * connection lost, session gone, the pool closed under the caller: NJS-064/065, as a
 * replaced pool does to a caller still holding it) rather than a bad statement. Only these (and
 * the timeout class) nudge the health monitor; an ORA-00942 says nothing about
 * connectivity. Mira's own bounds are not here: they carry a [MIRA_CODE] token
 * (see CODE_KIND) and the timeout and saturation driver codes have their own
 * patterns below.
 */
const CONNECTIVITY_ERROR_RE =
    /ORA-(12541|12514|12170|12537|12547|12560|03113|03114|03135|12528|01033|01034|01089)|NJS-(064|065|500|501|503|510|521)|DPI-1080/;
/** The pool is full or its queue is: busy, not unreachable. */
const SATURATION_RE = /NJS-040|NJS-076/;
/** The driver's own call timeout fired. */
const TIMEOUT_RE = /DPI-1067|NJS-123|ORA-03156/;
/** The code Mira appends to every message it throws on its own. */
const MIRA_CODE_RE = /\[(MIRA_[A-Z_]+)\]/;

/** `err` and what it wraps (originalError, cause), at most 5 objects, each once. */
function _errorChain(err: unknown): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = [];
    const queue: unknown[] = [err];
    while (queue.length && chain.length < 5) {
        const current = queue.shift();
        if (!current || typeof current !== "object") continue;
        const link = current as Record<string, unknown>; // a non-null object (checked above)
        if (chain.includes(link)) continue;
        chain.push(link);
        queue.push(link.originalError, link.cause);
    }
    return chain;
}

/** The message of a chain link, or "". */
function _messageOf(link: Record<string, unknown>): string {
    return typeof link.message === "string" ? link.message : "";
}

/** The first Mira code in `err`'s chain: a MiraDbError's own, else a [MIRA_CODE] token in a message. */
function _firstMiraCode(err: unknown): MiraErrorCode | undefined {
    const chain = _errorChain(err);
    for (const link of chain) if (link instanceof MiraDbError && link.code) return link.code;
    const token = MIRA_CODE_RE.exec(chain.map(_messageOf).join("\n"))?.[1];
    return token && Object.hasOwn(CODE_KIND, token) ? (token as MiraErrorCode) : undefined;
}

/**
 * What sort of failure `err` is, by the first rule that matches: a MiraDbError in
 * its chain gives its kind; a Mira code in a message gives that code's kind; the
 * driver's pool-full codes are "saturation"; its call-timeout codes "timeout";
 * its link and session codes "connectivity"; anything else is a "statement" failure.
 * @param {unknown} err
 * @returns {MiraErrorKind}
 */
function errorKind(err: unknown): MiraErrorKind {
    const chain = _errorChain(err);
    for (const link of chain) if (link instanceof MiraDbError) return link.kind;
    const code = _firstMiraCode(err);
    if (code) return CODE_KIND[code];
    const text = chain.map(_messageOf).join("\n");
    if (SATURATION_RE.test(text)) return "saturation";
    if (TIMEOUT_RE.test(text)) return "timeout";
    if (CONNECTIVITY_ERROR_RE.test(text)) return "connectivity";
    return "statement";
}

/** A MiraDbError for one of Mira's own codes; its kind comes from CODE_KIND. */
function _miraError(code: MiraErrorCode, message: string, connectionName?: string): MiraDbError {
    return new MiraDbError(message, { kind: CODE_KIND[code], code, connectionName });
}

/** A factory for _bounded's `fail`: builds the error when (not before) the bound fires. */
function _failWith(code: MiraErrorCode, message: string, connectionName?: string): () => Error {
    return () => _miraError(code, message, connectionName);
}

// ── Abandoned native work: one ledger ─────────────────────────────────────────
// A bound that fires does not cancel the native call it gave up on: it ends when
// the driver gives up (on a dead link, after TCP does, ~15 min). The ledger counts
// what is still running, per pool name, so stats() can show it and later steps can
// cap it. It survives closePool(): a closed pool's hung close is still running.

/** Abandoned work of one pool name: calls (backstops, acquire orphans, checks), pools (opens, closes), zombie connections. */
type Abandoned = { calls: number; pools: number; zombies: number };
/**
 * What the ledger keeps per pool name. `zombies` are the stuck connections of the CURRENT
 * pool (they decide a replacement); a replaced pool's are moved to `retired` (still running,
 * still reported) and `epoch` moves on, so a zombie's end is counted where it was counted in.
 */
type LedgerEntry = Abandoned & { retired: number; epoch: number; replacements: number; opens: number };
/** A pool name's abandoned work as stats() reports it: retired zombies included. */
function _reported(e: LedgerEntry): Abandoned {
    return { calls: e.calls, pools: e.pools, zombies: e.zombies + e.retired };
}
/**
 * What a bound counts when it gives up: the pool name and which counter. "open" is a pool
 * counter too (`pools`), and also counts toward the cap on unfinished opening steps, which must
 * not be filled by closes of replaced pools: a link that came back has to be able to open a pool.
 */
type Track = { name: string; kind: "call" | "pool" | "open" };
const _abandoned = new Map<string, LedgerEntry>();

/** The ledger entry of `name`, created at zero. */
function _ledger(name: string): LedgerEntry {
    let entry = _abandoned.get(name);
    if (!entry) {
        entry = { calls: 0, pools: 0, zombies: 0, retired: 0, epoch: 0, replacements: 0, opens: 0 };
        _abandoned.set(name, entry);
    }
    return entry;
}
/** Counts one more abandoned call or pool operation for `track` (no-op without one). */
function _abandonUp(track?: Track): void {
    _count(track, 1);
}
/** The abandoned operation ended: counts it out. */
function _abandonDown(track?: Track): void {
    _count(track, -1);
}
function _count(track: Track | undefined, by: 1 | -1): void {
    if (!track) return;
    const entry = _ledger(track.name);
    if (track.kind === "call") entry.calls += by;
    else entry.pools += by;
    if (track.kind === "open") entry.opens += by;
}
/** Process-wide totals, closed pool names included. */
function _abandonedTotals(): Abandoned {
    const total = { calls: 0, pools: 0, zombies: 0 };
    for (const e of _abandoned.values()) {
        const r = _reported(e);
        total.calls += r.calls;
        total.pools += r.pools;
        total.zombies += r.zombies;
    }
    return total;
}

/** What _bounded can do besides racing. */
type BoundOpts<T> = {
    /** Gets what `work` resolves to after the bound fired (to close a pool or connection nobody holds). */
    onLate?: (value: T) => unknown;
    /** Runs the moment the bound fires, before the caller sees the error; must not throw. */
    onTimeout?: () => void;
    /** Counts the abandoned work in the ledger until `work` (and `onLate`) settle. */
    track?: Track;
};

/**
 * Races `work` against a timer. On timeout it rejects with `fail()`; whatever
 * `work` resolves to later is handed to `opts.onLate`, a later rejection is
 * swallowed, and `opts.track` counts the work as abandoned until it settles. The
 * losing native call is not cancelled: it ends when the driver gives up on it.
 * The timer never outlives the race.
 */
async function _bounded<T>(work: Promise<T>, ms: number, fail: () => Error, opts: BoundOpts<T> = {}): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    opts.onTimeout?.();
                    reject(fail());
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (timedOut) _abandon(work, opts);
    }
}

/** What happens to work a bound gave up on: it is counted until it settles, and its late result is handed on. */
function _abandon<T>(work: Promise<T>, opts: BoundOpts<T>): void {
    _abandonUp(opts.track);
    work
        .then(opts.onLate ?? _ignore, _ignore)
        .catch(_ignore)
        .finally(() => _abandonDown(opts.track));
}

/** Swallows a rejection nobody waits for (a background close). */
function _ignore(): void {}
/** Closes a pool that arrived after nobody wanted it, without waiting (the promise lets a ledger count the close). */
function _closePoolQuietly(pool: import("oracledb").Pool): Promise<void> {
    return pool.close(0).catch(_ignore);
}
/** Returns a connection that arrived after nobody wanted it, without waiting. */
function _closeConnQuietly(conn: import("oracledb").Connection): Promise<void> {
    return _closeConn(conn, false).catch(_ignore);
}
/**
 * One more connection whose close has not finished. Returns the epoch it was counted in (for
 * _zombieDown). When the stuck connections fill the pool, only a new pool can serve: it is replaced.
 */
function _zombieUp(name: string): number {
    const entry = _ledger(name);
    entry.zombies++;
    const epoch = entry.epoch;
    _maybeReplacePool(name, "zombies");
    return epoch;
}
/** A zombie's close finished (or failed): the slot is free again, in the epoch it was counted in. */
function _zombieDown(name: string, epoch: number): void {
    const entry = _ledger(name);
    if (entry.epoch === epoch) entry.zombies--;
    else entry.retired--;
}
/**
 * Drops a connection whose round trip hung, without waiting (the close may never
 * finish: node-oracledb serialises it behind the hung call). The connection counts
 * as a zombie in the ledger until the drop settles.
 */
function _dropConnQuietly(name: string, conn: import("oracledb").Connection): void {
    const down = _zombieDown.bind(null, name, _zombieUp(name));
    _closeConn(conn, true).then(down, down);
}

// ── Pool counts that never wait on the driver ─────────────────────────────────
// In Thick mode pool.connectionsInUse / connectionsOpen are OCI attribute reads, and OCI
// takes the session pool's mutex for them. A native pool operation hung on a link that
// stopped answering (dropping a session, opening one) holds that mutex, so the read blocks
// the JS thread itself: no timer fires again and the whole process stops (found in the
// chaos suite: the health monitor's busy check froze Bun for good). Thick pools are
// therefore counted in JS: every getConnection and every connection close is tallied, and
// the driver is asked only while none of them is in flight. Thin pools answer from JS anyway.

/** A Thick pool's tally: native pool operations in flight, connections handed out, and the last counts read safely. */
type PoolTally = { pending: number; inUse: number; open: number };
const _tallies = new WeakMap<object, PoolTally>();

/** True in Thick mode (an Oracle Client is loaded). */
function _isThick(): boolean {
    return Boolean(oracledb.oracleClientVersion);
}

/** One pool operation more in flight, until `work` settles; `done` runs when it succeeds. */
function _tracked<T>(tally: PoolTally, work: Promise<T>, done: (value: T) => void): Promise<T> {
    tally.pending++;
    return work.then(
        (value) => {
            tally.pending--;
            done(value);
            return value;
        },
        (err) => {
            tally.pending--;
            throw err;
        },
    );
}

/** Counts `conn` as handed out until a close of it succeeds (a failed close leaves it with the driver). */
function _tallyConnection(tally: PoolTally, conn: import("oracledb").Connection): void {
    tally.inUse++;
    const c = conn as unknown as { close: (...a: unknown[]) => Promise<void> };
    const close = c.close.bind(conn);
    let counted = true;
    const released = () => {
        if (counted) tally.inUse--;
        counted = false;
    };
    c.close = (...args: unknown[]) => _tracked(tally, close(...args), released);
}

/** Nothing to record when an operation that hands nothing out (reconfigure, close) settles. */
function _noTally(): void {}

/** Thick only: tallies `pool`'s getConnection, reconfigure and close calls, and its connections' closes. Returns the pool. */
function _instrumentPool<T extends import("oracledb").Pool>(pool: T): T {
    if (!_isThick()) return pool;
    const tally: PoolTally = { pending: 0, inUse: 0, open: 0 };
    _tallies.set(pool, tally);
    const p = pool as unknown as { getConnection: (...a: unknown[]) => Promise<import("oracledb").Connection> };
    const getConnection = p.getConnection.bind(pool);
    p.getConnection = (...args: unknown[]) => _tracked(tally, getConnection(...args), _tallyConnection.bind(null, tally));
    const q = pool as unknown as Record<"reconfigure" | "close", (...a: unknown[]) => Promise<void>>;
    for (const method of ["reconfigure", "close"] as const) {
        const original = q[method]?.bind(pool);
        if (original) q[method] = (...args: unknown[]) => _tracked(tally, original(...args), _noTally);
    }
    return pool;
}

/**
 * Open / in-use counts and limits of `pool` without risking a wait on a hung native call.
 * Thin (or an uninstrumented pool): the driver's own numbers. Thick: the JS tally, poolMin /
 * poolMax from the config, and connectionsOpen as last read while nothing was in flight
 * (`exact` false when it could not be read now).
 */
function _poolCounts(name: string, pool: import("oracledb").Pool): { open: number; inUse: number; min: number; max: number; exact: boolean } {
    const tally = _tallies.get(pool);
    if (!tally) return { open: pool.connectionsOpen, inUse: pool.connectionsInUse, min: pool.poolMin, max: pool.poolMax, exact: true };
    const cfg = _configOf(name);
    const min = Number(cfg.poolMin ?? POOL_DEFAULTS.poolMin);
    const max = Number(cfg.poolMax ?? POOL_DEFAULTS.poolMax);
    const exact = tally.pending === 0;
    if (exact) tally.open = pool.connectionsOpen;
    return { open: Math.max(tally.open, tally.inUse), inUse: tally.inUse, min, max, exact };
}

/** One bounded health probe: borrow a connection, ping it, give it back. Throws on any failure. */
async function _pingPool(name: string, pool: import("oracledb").Pool): Promise<void> {
    // Bounded: on a stalled link getConnection / ping never return, and a
    // check that never finishes never opens the breaker.
    const checkMs = _connectTimeoutMs(_configOf(name));
    const timedOut = _failWith("MIRA_CHECK_TIMEOUT", oracleMessages.HEALTH_CHECK_TIMED_OUT(name, checkMs), name);
    const track = { name, kind: "call" } as const;
    let conn: import("oracledb").Connection | undefined;
    try {
        conn = await _bounded(pool.getConnection(), checkMs, timedOut, { onLate: _closeConnQuietly, track });
        await _bounded(conn.ping(), checkMs, timedOut, { track });
    } catch (err) {
        // A connection whose ping hung is dropped, not returned to the pool.
        if (conn) _dropConnQuietly(name, conn);
        conn = undefined;
        throw err;
    } finally {
        // Release on every path: a ping that rejects (half-dead network)
        // must not leave the connection checked out, one leak per tick.
        if (conn) {
            await _closeConn(conn, false).catch((e: Error) => log().warning(oracleMessages.CLOSE_FAILED(name, e.message)));
        }
    }
}

/**
 * True when a failed health check says "busy", not "down": the pool is full (the driver said
 * NJS-040/076, or the check timed out queueing on a pool with every connection in use) AND it
 * is still serving: calls finished since the check began, or fewer connections are stuck on a
 * dead link (zombies) than are in use. A pool whose connections are all zombies is down.
 */
function _isBusyNotDown(name: string, err: unknown, pool: import("oracledb").Pool | undefined, progressAtStart: number): boolean {
    if (!pool) return false;
    const counts = _poolCounts(name, pool);
    const full = errorKind(err) === "saturation" || (_firstMiraCode(err) === "MIRA_CHECK_TIMEOUT" && counts.inUse >= counts.max);
    if (!full) return false;
    const guarded = Number(_configOf(name).callTimeout) > 0;
    return (_progress.get(name) ?? 0) > progressAtStart || (guarded && _ledger(name).zombies < counts.inUse);
}

// ── The per-connection guard ──────────────────────────────────────────────────
// A pool's callTimeout is applied to every connection withConnection borrows. The
// driver's own timeout is not enough: on a link that stopped answering, Thin sends a
// break and then waits for its reply forever, and Thick over a stall never returns.
// SessionGuard puts a JS bound (callTimeout + 1 s, read when each call starts) on
// every round trip, and it does what the bound alone cannot:
//   - calls on one connection run one after another (node-oracledb takes a
//     per-connection lock anyway), and the bound starts when a call starts, not
//     while it waits for its turn: a Promise.all of healthy calls is never cut;
//   - a cut call kills the connection: later calls fail at once (MIRA_CONNECTION_DEAD)
//     instead of queueing behind a call that may never end, and the connection is
//     dropped, never returned to the pool;
//   - a cut that could have committed (a commit, an auto-committed write, DDL,
//     PL/SQL) is MIRA_OUTCOME_UNKNOWN; a cut that could not have is MIRA_CALL_TIMEOUT.
// Streams are guarded the same way (see _guardedQueryStream).

/** The round trips a guard times: the four connection methods and one stream fetch. */
type GuardedMethod = "execute" | "executeMany" | "commit" | "rollback" | "fetch" | "streamClose";
// Arguments are whatever the driver method takes: any is the honest type of a pass-through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GuardFn = (...args: any[]) => unknown;
type GuardCall = { method: GuardedMethod; thisArg: unknown; original: GuardFn; args: unknown[] };
/** These wait for the previous call on the connection. A stream close is not queued: it is how a hang is escaped. */
const QUEUED_METHODS: ReadonlySet<GuardedMethod> = new Set<GuardedMethod>(["execute", "executeMany", "commit", "rollback", "fetch"]);
/** Connection methods the guard wraps, in addition to queryStream. */
const GUARDED_CONNECTION_METHODS = ["execute", "executeMany", "commit", "rollback"] as const;

/** A SELECT or WITH query: it cannot commit. */
const QUERY_RE = /^\s*\(*\s*(SELECT|WITH)\b/i;
/** Statements that commit on their own (DDL) or may run anything (PL/SQL). */
const SELF_COMMIT_RE = /^\s*(BEGIN|DECLARE|CALL|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|RENAME|COMMENT|PURGE|FLASHBACK|ANALYZE|AUDIT|NOAUDIT)\b/i;

/**
 * True when cutting this call off leaves it unknown whether it took effect: a commit, an
 * auto-committed write, DDL or a PL/SQL block. A plain write inside a transaction is not:
 * the dropped session's transaction can never commit. Pure.
 */
function _isAmbiguous(method: GuardedMethod, args: unknown[]): boolean {
    if (method === "commit") return true;
    if (method !== "execute" && method !== "executeMany") return false;
    const sql = typeof args[0] === "string" ? args[0] : "";
    if (QUERY_RE.test(sql)) return false;
    const options = args[2] as { autoCommit?: unknown } | undefined;
    return (options?.autoCommit ?? oracledb.autoCommit) === true || SELF_COMMIT_RE.test(sql);
}

/** True for an error that says a write may or may not have happened. */
function _isUnknownLink(link: Record<string, unknown>): boolean {
    return link.outcomeUnknown === true;
}

/** What withConnection needs from a guard (real or inert). */
interface Guard {
    /** A call on this connection was cut: it must be dropped. */
    dead(): boolean;
    /** A write may or may not have reached the database. */
    outcomeUnknown(): boolean;
    /** What the guard cut a call for, if it did. */
    code(): MiraErrorCode | undefined;
    /** Puts the connection's own methods back. */
    release(): void;
    /** Closes (or drops) the connection; false when the close was abandoned. */
    close(conn: import("oracledb").Connection, drop: boolean): Promise<boolean>;
}

/** The guard of a pool without callTimeout: it does nothing, as documented (0 = no limits). */
class InertGuard implements Guard {
    dead(): boolean {
        return false;
    }
    outcomeUnknown(): boolean {
        return false;
    }
    code(): MiraErrorCode | undefined {
        return undefined;
    }
    release(): void {}
    async close(conn: import("oracledb").Connection, drop: boolean): Promise<boolean> {
        await _closeConn(conn, drop);
        return true;
    }
}
const NO_GUARD: Guard = new InertGuard();
/** The live guard of each borrowed connection, for code that gets only the connection. */
const _guards = new WeakMap<object, SessionGuard>();
/** True when a call on `conn` was cut: the session is gone, its transaction with it. */
function _isConnDead(conn: object): boolean {
    return _guards.get(conn)?.dead() ?? false;
}

class SessionGuard implements Guard {
    readonly name: string;
    readonly _conn: import("oracledb").Connection;
    /** The pool's callTimeout, ms: the fallback when the connection's own cannot be read. */
    readonly _poolMs: number;
    _tail: Promise<unknown> = Promise.resolve();
    _dead = false;
    _unknown = false;
    _code: MiraErrorCode | undefined;
    _cutAmbiguous = false;
    _releaseTimedOut = false;
    readonly _saved: Array<{ m: string; own: boolean; value: unknown }> = [];

    /** Sets the connection's callTimeout and wraps its round-trip methods (and queryStream). */
    constructor(name: string, conn: import("oracledb").Connection, callTimeoutMs: number) {
        this.name = name;
        this._conn = conn;
        this._poolMs = callTimeoutMs;
        conn.callTimeout = callTimeoutMs;
        const target = conn as unknown as Record<string, unknown>;
        for (const m of GUARDED_CONNECTION_METHODS) {
            const original = target[m];
            if (typeof original !== "function") continue;
            this._save(target, m);
            target[m] = _guardedCall.bind(null, this, m, conn, original as GuardFn);
        }
        const queryStream = target.queryStream;
        if (typeof queryStream === "function") {
            this._save(target, "queryStream");
            target.queryStream = _guardedQueryStream.bind(null, this, conn, queryStream as GuardFn);
        }
        _guards.set(conn, this);
    }

    /** Remembers what to put back: an own property is restored, a prototype method is uncovered by deleting ours. */
    _save(target: Record<string, unknown>, m: string): void {
        this._saved.push({ m, own: Object.prototype.hasOwnProperty.call(target, m), value: target[m] });
    }

    /** The bound for a call starting now: the connection's callTimeout (a callback may have changed it) + 1 s; 0 = none. */
    limitMs(): number {
        let ms = this._poolMs;
        try {
            const own = this._conn.callTimeout;
            if (typeof own === "number") ms = own;
        } catch {
            // A session that is already gone cannot be read: the pool's value stands.
        }
        return ms > 0 ? ms + 1000 : 0;
    }

    dead(): boolean {
        return this._dead;
    }
    outcomeUnknown(): boolean {
        return this._unknown;
    }
    code(): MiraErrorCode | undefined {
        return this._code;
    }

    /** Runs a call: queued behind the previous one (except a stream close), bounded from when it starts. */
    run(call: GuardCall): Promise<unknown> {
        if (!QUEUED_METHODS.has(call.method)) return this._call(call);
        const job = this._tail.then(this._call.bind(this, call));
        this._tail = job.then(_ignore, _ignore);
        return job;
    }

    async _call(call: GuardCall): Promise<unknown> {
        if (this._dead) throw this._deadError();
        const ms = this.limitMs();
        try {
            const work = Promise.resolve(call.original.apply(call.thisArg, call.args));
            if (ms <= 0) return await work;
            const fail = this._cutError.bind(this, ms);
            return await _bounded(work, ms, fail, { onTimeout: this._onTimeout.bind(this, call), track: { name: this.name, kind: "call" } });
        } catch (err) {
            this._noteFailure(call, err);
            throw err;
        }
    }

    _deadError(): MiraDbError {
        return _miraError("MIRA_CONNECTION_DEAD", oracleMessages.CONNECTION_DEAD(this.name), this.name);
    }

    /** The bound fired: the connection is dead; remember whether the call could have committed. */
    _onTimeout(call: GuardCall): void {
        this._dead = true;
        this._cutAmbiguous = _isAmbiguous(call.method, call.args);
        this._unknown = this._unknown || this._cutAmbiguous;
        this._code = this._code ?? (this._cutAmbiguous ? "MIRA_OUTCOME_UNKNOWN" : "MIRA_CALL_TIMEOUT");
    }

    /** The error of the call the bound just cut (built after _onTimeout ran). */
    _cutError(ms: number): MiraDbError {
        const unknown = this._cutAmbiguous;
        const text = unknown ? oracleMessages.CALL_OUTCOME_UNKNOWN(this.name, ms) : oracleMessages.CALL_TIMED_OUT(this.name, ms);
        return new MiraDbError(text, {
            kind: "connectivity",
            code: unknown ? "MIRA_OUTCOME_UNKNOWN" : "MIRA_CALL_TIMEOUT",
            outcomeUnknown: unknown,
            connectionName: this.name,
        });
    }

    /** The driver itself rejected a call: if it could have committed and the link failed, the outcome is unknown. */
    _noteFailure(call: GuardCall, err: unknown): void {
        if (!_isAmbiguous(call.method, call.args)) return;
        const kind = errorKind(err);
        if (kind !== "connectivity" && kind !== "timeout") return;
        this._unknown = true;
        this._code = this._code ?? "MIRA_OUTCOME_UNKNOWN";
    }

    /** Puts the connection's own methods back; the guard stays usable for streams that outlive the borrow. */
    release(): void {
        const target = this._conn as unknown as Record<string, unknown>;
        for (const { m, own, value } of this._saved) {
            if (own) target[m] = value;
            else delete target[m];
        }
        _guards.delete(this._conn);
    }

    /**
     * Gives the connection back (or drops it) for at most callTimeout + 1 s, so a hung
     * release cannot hold the caller. A close that outlasts the bound is abandoned: the
     * connection is a zombie until it ends. Called after release(), so the close does
     * not go through the wrapper.
     */
    async close(conn: import("oracledb").Connection, drop: boolean): Promise<boolean> {
        const ms = this._poolMs + 1000;
        const work = _closeConn(conn, drop);
        try {
            await _bounded(work, ms, _failWith("MIRA_CLOSE_TIMEOUT", oracleMessages.RELEASE_TIMED_OUT(this.name, ms), this.name), { onTimeout: this._onReleaseTimeout.bind(this, work) });
            return true;
        } catch (err) {
            if (!this._releaseTimedOut) throw err;
            log().warning(oracleMessages.RELEASE_TIMED_OUT(this.name, ms));
            return false;
        }
    }

    /** The release hung: the connection is a zombie until the close settles. */
    _onReleaseTimeout(work: Promise<unknown>): void {
        this._releaseTimedOut = true;
        const down = _zombieDown.bind(null, this.name, _zombieUp(this.name));
        work.then(down, down);
    }
}

/** node-oracledb's trace hook registry (oracledb.traceHandler). */
type TraceRegistry = { getTraceInstance(): unknown; setTraceInstance(handler: unknown): void };

/**
 * conn.close(), or conn.close({ drop: true }), with node-oracledb's tracing off for that call.
 *
 * node-oracledb 7.0.1: while any trace handler is installed (Mira's onQuery installs one, and so
 * do tracing libraries), each call first reads the connection's service, instance and PDB names
 * for the trace context. In Thick mode those reads throw DPI-1010 on a connection whose link
 * broke, so close() fails with NJS-003 before it gives the session back, and the session stays
 * checked out of the pool for good: one lost slot per broken connection, until the pool is full.
 * The driver decides whether to trace when a call starts, so tracing is off only for that
 * synchronous start; nobody else's calls can run in between.
 */
function _closeConn(conn: import("oracledb").Connection, drop: boolean): Promise<void> {
    const trace = (oracledb as unknown as { traceHandler?: TraceRegistry }).traceHandler;
    const handler = trace?.getTraceInstance();
    if (!handler) return drop ? conn.close({ drop: true }) : conn.close();
    trace!.setTraceInstance(undefined);
    try {
        return drop ? conn.close({ drop: true }) : conn.close();
    } finally {
        trace!.setTraceInstance(handler);
    }
}

/** The connection method `m` as the guard runs it. */
function _guardedCall(guard: SessionGuard, method: GuardedMethod, conn: unknown, original: GuardFn, ...args: unknown[]): Promise<unknown> {
    return guard.run({ method, thisArg: conn, original, args });
}

// ── Streams ───────────────────────────────────────────────────────────────────
// conn.queryStream() returns a Readable whose `_read` fetches a batch from the
// database and whose `_destroy` waits for a fetch in flight. On a stalled link the
// fetch never returns, and neither would destroy(): a stream consumer would hang with
// its connection checked out. The guard puts its own `_read` and `_destroy` on the
// stream (the standard Readable hooks, not driver internals): each fetch is a bounded
// call, so the timer runs only while Mira waits on the database (a paused consumer
// cannot trip it); a failed fetch destroys the stream; destroy returns within the
// bound whether or not the driver's close does.

/** The part of a driver stream the guard patches. */
type GuardedStream = { _read: GuardFn; _destroy: GuardFn; destroy(err?: Error): unknown };

/** conn.queryStream(...) with its fetches and its close guarded. */
function _guardedQueryStream(guard: SessionGuard, conn: unknown, original: GuardFn, ...args: unknown[]): unknown {
    const stream = original.apply(conn, args) as GuardedStream;
    stream._read = _guardedRead.bind(null, guard, stream, stream._read);
    stream._destroy = _guardedDestroy.bind(null, guard, stream, stream._destroy);
    return stream;
}

/** One fetch, queued and bounded; a failure destroys the stream with that error. */
function _guardedRead(guard: SessionGuard, stream: GuardedStream, original: GuardFn, size?: unknown): void {
    guard.run({ method: "fetch", thisArg: stream, original, args: [size] }).catch(stream.destroy.bind(stream));
}

/** The driver's callback-style _destroy as a promise (it resolves with the error to report, if any). */
function _destroyAsPromise(this: unknown, original: GuardFn, err: unknown): Promise<unknown> {
    return new Promise((resolve) => original.call(this, err, resolve));
}

/** What destroy() reports when the close failed or was cut: the stream's own error, else the close's. */
function _failDestroy(done: (e?: unknown) => void, err: unknown, closeErr: unknown): void {
    done(err ?? closeErr);
}

/**
 * Closes the stream's result set within the bound. A connection that is already dead
 * is not asked to close anything: the driver's close keeps running in the background and
 * the stream is finished at once.
 */
function _guardedDestroy(guard: SessionGuard, stream: GuardedStream, original: GuardFn, err: unknown, done: (e?: unknown) => void): void {
    if (guard.dead()) {
        Promise.resolve(original.call(stream, err, _ignore)).catch(_ignore);
        done(err);
        return;
    }
    guard.run({ method: "streamClose", thisArg: stream, original: _destroyAsPromise, args: [original, err] }).then(done, _failDestroy.bind(null, done, err));
}

/**
 * Applies the pool's callTimeout to a connection just borrowed: the driver's
 * conn.callTimeout, plus a SessionGuard (a JS bound on each round trip, callTimeout + 1 s,
 * which is what bounds Thin on a link that stopped answering). A call that hits the bound
 * kills the connection: it is dropped instead of going back to the pool. `release()`
 * removes the wrappers. Without a callTimeout this does nothing.
 */
function _applySessionLimits(name: string, conn: import("oracledb").Connection, cfg: Record<string, unknown>): Guard {
    const callTimeout = cfg.callTimeout;
    if (typeof callTimeout !== "number" || callTimeout <= 0) return NO_GUARD;
    return new SessionGuard(name, conn, callTimeout);
}

/** A pool's connectTimeout in ms, from the registry (the live pool object does not expose it). */
function _connectTimeoutMs(cfg: Record<string, unknown>): number {
    const v = cfg.connectTimeout;
    return typeof v === "number" && v > 0 ? v : POOL_DEFAULTS.connectTimeout;
}

// ── Pool lifecycle ────────────────────────────────────────────────────────────

function _validateConfig(config: import("oracledb").PoolAttributes, name: unknown) {
    const missing = (["user", "password", "connectString"] as const).filter(
        (k) => !config[k],
    );
    if (!missing.length) return;
    throw new Error(
        `Missing config fields for "${name}": ${missing.join(", ")}`,
    );
}

/**
 * Converts the app's millisecond connect timeout to the whole seconds node-oracledb expects
 * (Thin: sessionAtts `connectTimeout * 1000`). Rounds up, floor 1 s. Non-finite or <= 0 falls
 * back to the POOL_DEFAULTS value. Pure.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {number} Whole seconds, >= 1.
 */
function toDriverConnectTimeoutSec(ms: number): number {
    const n = Number(ms);
    const safeMs = Number.isFinite(n) && n > 0 ? n : POOL_DEFAULTS.connectTimeout;
    return Math.max(1, Math.ceil(safeMs / 1000));
}

/**
 * Thick mode runs each database call on one of the runtime's native worker threads, and every
 * pool shares them. A call waiting on a row lock (or on a link that stopped answering) keeps its
 * thread; with fewer threads than such calls, the transaction holding the lock, or another pool's
 * query, never gets one and the process hangs with no error (seen on a 4-core CI runner). Thin
 * mode does not use these threads.
 *
 * Measured (Thick, N connections each running DBMS_SESSION.SLEEP(1) at once): Node runs
 * UV_THREADPOOL_SIZE of them in parallel (default 4). Bun honours the same variable for a
 * value of 2 or more (1 is ignored) and, unset, runs one per CPU core.
 */
function _runtime(): "node" | "bun" {
    return process.versions.bun ? "bun" : "node";
}

/** The worker threads Thick mode has on `runtime`: UV_THREADPOOL_SIZE when valid, else the runtime's default. */
function _workerThreads(runtime: "node" | "bun"): { threads: number; fromEnv: boolean } {
    const configured = Number(process.env.UV_THREADPOOL_SIZE);
    const fromEnv = Number.isInteger(configured) && configured > (runtime === "bun" ? 1 : 0);
    const fallback = runtime === "bun" ? availableParallelism() : 4;
    return { threads: fromEnv ? configured : fallback, fromEnv };
}

/**
 * Worker threads the registered pools can hold at once: every pool's poolMax, plus 3 per pool
 * (its health check and the ABANDONED_CREATE_CAP creation steps), plus 2.
 */
function _threadBudget(): number {
    const names = getConnectionNames();
    let needed = 2;
    for (const n of names) needed += (Number(getConnectionConfig(n).poolMax) || POOL_DEFAULTS.poolMax) + 3;
    return needed;
}

/** The largest need already warned about: a later pool that raises it warns again, nothing else does. */
let _lastWarnedNeed = 0;

/** Thick only: warns once (again only when a new pool raises the need) when the pools can outgrow the worker threads. */
function _checkThreadBudget(): void {
    if (!oracledb.oracleClientVersion) return;
    const needed = _threadBudget();
    const runtime = _runtime();
    const { threads, fromEnv } = _workerThreads(runtime);
    if (needed <= threads || needed <= _lastWarnedNeed) return;
    _lastWarnedNeed = needed;
    log().warning(oracleMessages.THREAD_BUDGET(runtime, needed, threads, fromEnv));
}

/**
 * Bumped by closePool(name): a creation of `name` that started before the close
 * stops retrying, so close() does not wait out every retry of a pool that cannot
 * come up (4 attempts with backoff, each up to its connect timeout).
 */
const _poolGeneration = new Map<string, number>();
const _generationOf = (name: string) => _poolGeneration.get(name) ?? 0;

/**
 * Opening steps (createPool, the warm-up connection, its ping) that Mira gave up on are still
 * running in the driver; at most this many per pool name may be left running (closes of replaced
 * pools do not count here, they have their own cap on replacing). While that many are,
 * the next attempt is deferred (MIRA_CREATE_DEFERRED): a stalled link must not collect an
 * ever-growing pile of half-open pools and sessions.
 */
const ABANDONED_CREATE_CAP = 2;

/**
 * Gives a pool opened by a retry (attempt >= 1, which opened with poolMin 0) its configured
 * poolMin back, in the background. Never rejects; counted as abandoned pool work while it runs.
 */
async function _restorePoolMin(name: string, pool: import("oracledb").Pool, poolMin: number): Promise<void> {
    const track = { name, kind: "pool" } as const;
    _abandonUp(track);
    try {
        await pool.reconfigure({ poolMin });
    } catch (e) {
        log().warning(oracleMessages.POOL_RECONFIGURE_FAILED(name, e.message));
    } finally {
        _abandonDown(track);
    }
}

/** What a pool that could not be created is for a caller: the database cannot be used (connectivity). */
function _couldNotCreate(name: string, attempts: number, err: Error): MiraDbError {
    return new MiraDbError(oracleMessages.POOL_COULD_NOT_CREATE(name, attempts, err.message), {
        kind: "connectivity",
        code: _firstMiraCode(err),
        connectionName: name,
        originalError: err,
    });
}

async function _createPool(name: string, dbConfig: import("oracledb").PoolAttributes, attempt = 0, generation = _generationOf(name)) {
    const MAX_RETRIES = 3;
    const delay = Math.min(1000 * 2 ** attempt, 10_000);

    initDriver();
    _validateConfig(dbConfig, name);

    // Unique alias per attempt to avoid NJS-046 collisions
    const poolAlias = `${name}_pool_${Date.now()}_${attempt}`;
    const config = {
        ...POOL_DEFAULTS,
        ...dbConfig,
        poolAlias,
        ...(_sessionTimeZoneOverride !== null && { sessionCallback: _setSessionTimeZone }),
    };
    // App config is ms; the driver wants seconds (the acquire race elsewhere stays ms).
    config.connectTimeout = toDriverConnectTimeoutSec(config.connectTimeout);
    // A per-connection setting (applied on every checkout), not a pool attribute.
    delete (config as Record<string, unknown>).callTimeout;
    // A retry does not open the whole warm pool again over a link that just failed: poolMin 0,
    // restored once the pool is up (attempt 0 keeps the configured poolMin).
    const wantedMin = Number(config.poolMin) || 0;
    if (attempt > 0) config.poolMin = 0;

    // Safe log — no credentials
    const logSafe = { ...config };
    delete logSafe.password;
    delete logSafe.user;
    log().info(`Creating pool "${name}"…`);

    // Opening is bounded in JS as well as by the driver: Thick mode does not apply
    // connectTimeout, so a database that accepts the TCP connection and then stops
    // answering (a stalled link) would hold createPool() / the first connection forever.
    // Each step gets twice the connect timeout; a step that finishes late is closed.
    const openMs = 2 * _connectTimeoutMs(dbConfig as Record<string, unknown>);
    const timedOut = _failWith("MIRA_POOL_OPEN_TIMEOUT", oracleMessages.POOL_OPEN_TIMED_OUT(name, openMs), name);
    const track = { name, kind: "open" } as const;
    let pool;
    try {
        if (_ledger(name).opens >= ABANDONED_CREATE_CAP) {
            throw _miraError("MIRA_CREATE_DEFERRED", oracleMessages.POOL_CREATE_DEFERRED(name, _ledger(name).opens), name);
        }
        pool = _instrumentPool(await _bounded(oracledb.createPool(config), openMs, timedOut, { onLate: _closePoolQuietly, track }));
        const conn = await _bounded(pool.getConnection(), openMs, timedOut, { onLate: _closeConnQuietly, track });
        try {
            await _bounded(conn.ping(), openMs, timedOut, { track });
        } catch (err) {
            _dropConnQuietly(name, conn);
            throw err;
        }
        await _closeConn(conn, false);

        const ready = _poolCounts(name, pool);
        log().notice(oracleMessages.POOL_READY(name, { poolMin: ready.min, poolMax: ready.max }));
        if (attempt > 0 && wantedMin > 0) void _restorePoolMin(name, pool, wantedMin);
        healthMonitor._noteCreated(name);
        return pool;
    } catch (err) {
        // Destroy the partially-created pool. Not awaited: each attempt has its own
        // alias, and in Thick mode a close queued behind hung native connects (a
        // stalled link holds libuv's worker threads) would block the retry forever.
        if (pool) _closePoolQuietly(pool);

        // A pool closed while it was being created does not retry: close() waits on this promise.
        if (_generationOf(name) !== generation) throw new Error(oracleMessages.POOL_CLOSED_DURING_CREATE(name));
        // Each failed attempt counts toward the breaker, so a pool that cannot open opens it
        // without a health check waiting for the creation (a stopping process records nothing).
        if (!isShuttingDown) healthMonitor._recordAttemptFailure(name, err);
        // A stopping process does not keep retrying: closeAll() would wait
        // its per-pool guard on a creation nobody needs any more.
        if (attempt < MAX_RETRIES && !isShuttingDown) {
            log().warning(
                oracleMessages.POOL_FAILED(
                    name,
                    attempt + 1,
                    MAX_RETRIES + 1,
                    err.message,
                ),
            );
            log().warning(oracleMessages.POOL_RETRYING(name, delay));
            await _sleep(_jitter(delay));
            if (isShuttingDown) {
                throw new Error("App is shutting down — no new connections.");
            }
            if (_generationOf(name) !== generation) throw new Error(oracleMessages.POOL_CLOSED_DURING_CREATE(name));
            return _createPool(name, dbConfig, attempt + 1, generation);
        }
        throw _couldNotCreate(name, MAX_RETRIES + 1, err);
    }
}

/** How a pool creation ended: the pool, or why not. Recorded when it settles, so callers can read it without waiting. */
type PoolSettled = { ok: true; pool: import("oracledb").Pool } | { ok: false; error: unknown };
const _poolSettled = new WeakMap<Promise<import("oracledb").Pool>, PoolSettled>();

/** Remembers how `p` ended (before anything that awaits it resumes). */
function _recordSettled(p: Promise<import("oracledb").Pool>): void {
    p.then(_settledOk.bind(null, p), _settledFailed.bind(null, p));
}
function _settledOk(p: Promise<import("oracledb").Pool>, pool: import("oracledb").Pool): void {
    _poolSettled.set(p, { ok: true, pool });
}
function _settledFailed(p: Promise<import("oracledb").Pool>, error: unknown): void {
    _poolSettled.set(p, { ok: false, error });
}

/**
 * The pool of `name` for a caller: the open pool at once, the opening's own error if it failed,
 * and for an opening still in progress at most connectTimeout of waiting (MIRA_POOL_OPENING; the
 * opening goes on). initializePools() is what waits for a whole opening, on purpose.
 */
async function _awaitPool(name: string): Promise<import("oracledb").Pool> {
    const p = _getOrCreatePool(name);
    const settled = _poolSettled.get(p);
    if (settled) {
        if (settled.ok) return settled.pool;
        throw settled.error;
    }
    const ms = _connectTimeoutMs(_configOf(name));
    return _bounded(p, ms, _failWith("MIRA_POOL_OPENING", oracleMessages.POOL_STILL_OPENING(name, ms), name));
}

function _getOrCreatePool(name: string): Promise<import("oracledb").Pool> {
    if (isShuttingDown)
        return Promise.reject(
            new Error("App is shutting down — no new connections."),
        );
    if (!poolRegistry.has(name)) {
        const config = getConnectionConfig(name); // throws if name unknown
        _monitoredNames.add(name);
        const p = _createPool(name, config);
        _checkThreadBudget(); // after _createPool: its initDriver() has run, so Thick is known
        _recordSettled(p);
        poolRegistry.set(name, p);
        // A rejected creation must not be cached forever: evict it after a
        // short cool-down so the next caller / monitor tick retries creation.
        p.catch(() => {
            const t = setTimeout(() => {
                if (poolRegistry.get(name) === p) {
                    poolRegistry.delete(name);
                    log().info(
                        oracleMessages.POOL_CREATE_FAILED_EVICTED(
                            name,
                            POOL_CREATE_COOLDOWN_MS,
                        ),
                    );
                }
            }, POOL_CREATE_COOLDOWN_MS);
            t.unref?.();
        });
    }
    return poolRegistry.get(name);
}

// ── Eager pool initialization ──────────────────────────────────────────────────

/**
 * Pre-create registered pools at startup (default: every one; createMira().open()
 * passes its own). Logs each pool's config (sans credentials) and result.
 * Non-fatal — a pool that fails will retry lazily on first use.
 * @param {string[]} [names]
 */
async function initializePools(names: string[] = getConnectionNames()) {
    log().notice(
        `Initializing ${names.length} database pool(s): ${names.join(", ")}`,
    );

    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const name of names) {
        try {
            const config = getConnectionConfig(name);

            // Log config metadata (no credentials)
            const safeCfg = { ...POOL_DEFAULTS, ...config };
            delete safeCfg.password;
            delete safeCfg.user;
            log().notice(`Creating ${name} pool with configuration:`, safeCfg);

            const pool = await _getOrCreatePool(name);
            log().notice(
                `${name} pool created successfully with ${_poolCounts(name, pool).min}-${_poolCounts(name, pool).max} connections`,
            );
            results.push({ name, success: true });
        } catch (err) {
            // Clear registry so the pool can retry lazily on first use
            poolRegistry.delete(name);

            // Structured error with type, hint, and origin
            const isNJS116 = err.message.includes("NJS-116");
            const isNJS046 = err.message.includes("NJS-046");
            const hint = isNJS116
                ? "The DB password verifier is not supported in Thin mode. Use Thick mode (configureDriver({ mode: \"thick\", libDir })), or reset the DB user password with a compatible verifier."
                : isNJS046
                  ? "Pool alias collision during retry. The previous pool was not fully cleaned up."
                  : "Check DB credentials, network connectivity, and Oracle client installation.";

            log().critical(`Failed to initialize pool "${name}"`, {
                error: err.message,
                type: err.constructor.name,
                stack: err.stack,
                hint,
                pool: name,
            });
            results.push({ name, success: false, error: err.message });
        }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length) {
        log().warning(
            `${failed.length}/${names.length} pool(s) failed to initialize: ${failed.map((f) => f.name).join(", ")}. They will retry on first use.`,
        );
    } else {
        log().notice(`All ${names.length} pool(s) initialized successfully.`);
    }
    return results;
}

// ── Connection helpers ────────────────────────────────────────────────────────

/** Acquire attempts before a transient connect failure is surfaced to the caller. */
const ACQUIRE_MAX_ATTEMPTS = 3;
/** Base backoff between acquire attempts; doubles per attempt (150ms, 300ms). */
const ACQUIRE_BASE_DELAY_MS = 150;

/**
 * Gets a connection from `pool`, retrying transient CONNECT-time failures.
 *
 * Scope is deliberately the acquire ONLY — never the caller's callback.
 * `withTransaction` routes through `withConnection`, so re-running a callback
 * could replay a partially-applied write; a failed `getConnection()` has by
 * definition executed nothing.
 *
 * This exists because ORA-12516 / ORA-12537 arrive in bursts from the listener
 * (no ready handler, or the server process dies mid-handshake) and clear within
 * milliseconds — measured 23–488 ms per failure. One immediate retry on a fresh
 * connection turns those into a served request instead of a 500.
 *
 * The orphan guard matters as much as the retry: `Promise.race` does not cancel
 * the losing promise, so a `getConnection()` that resolves AFTER the timeout
 * fired hands back a connection nobody holds a reference to. It is checked out
 * of the pool and never closed — and `poolTimeout` only reaps IDLE connections,
 * so it is leaked for the process's lifetime. Under exactly the conditions that
 * cause the timeout, that leak compounds until the pool is exhausted.
 *
 * @param {string} connectionName Key from database.js registry (for logs)
 * @param {object} pool           oracledb pool
 * @returns {Promise<object>} An open connection the caller must close.
 */
async function _acquireConnection(connectionName: string, pool: import("oracledb").Pool): Promise<import("oracledb").Connection> {
    // The bound is read back from the registry: `pool.connectTimeout` / `queueTimeout`
    // are not properties node-oracledb exposes on the live pool object.
    const boundMs = _acquireBoundMs(getConnectionConfig(connectionName) as unknown as Record<string, unknown>);
    const timedOut = _failWith("MIRA_ACQUIRE_TIMEOUT", oracleMessages.ACQUIRE_TIMED_OUT(connectionName, boundMs), connectionName);
    const late = { onLate: _closeOrphanedAcquire(connectionName), track: { name: connectionName, kind: "call" } as const };

    // Every pass either returns a connection or throws on the last / a
    // non-transient attempt, so the loop needs no exit condition.
    for (let attempt = 1; ; attempt++) {
        try {
            return await _bounded(pool.getConnection(), boundMs, timedOut, late);
        } catch (err) {
            // The orphan guard (see the note above) is _bounded's onLate. A Mira
            // bound is never retried: it means the driver itself is stuck, and
            // each retry would queue another waiter behind it.
            const isLastAttempt = attempt >= ACQUIRE_MAX_ATTEMPTS;
            if (isLastAttempt || !_isTransientDbError(err)) throw err;

            log().warning(
                oracleMessages.ACQUIRE_RETRY(
                    connectionName,
                    attempt,
                    ACQUIRE_MAX_ATTEMPTS,
                    err.message,
                ),
            );
            await _sleep(_jitter(ACQUIRE_BASE_DELAY_MS * 2 ** (attempt - 1)));
        }
    }
}

/**
 * How long Mira waits for pool.getConnection(): the driver's own queue wait
 * (queueTimeout) plus connectTimeout for a connect, so the driver's NJS-040 wins
 * on a saturated pool and Mira's bound fires only when the driver itself is stuck.
 * queueTimeout 0 means the driver queue never times out: connectTimeout alone.
 */
function _acquireBoundMs(cfg: Record<string, unknown>): number {
    const queue = typeof cfg.queueTimeout === "number" ? cfg.queueTimeout : POOL_DEFAULTS.queueTimeout;
    return _connectTimeoutMs(cfg) + (queue > 0 ? queue : 0);
}

/**
 * onLate for an acquire that lost its race: the connection arrives after nobody
 * holds a reference to it, checked out of the pool and never closed. poolTimeout
 * only reaps IDLE connections, so it would leak for the process's lifetime, and
 * under exactly the conditions that cause the timeout the leak compounds until the
 * pool is exhausted. A failing close is logged, not thrown.
 */
function _closeOrphanedAcquire(connectionName: string) {
    return async (conn: import("oracledb").Connection) => {
        try {
            await _closeConn(conn, false);
            log().warning(oracleMessages.ACQUIRE_ORPHAN_CLOSED(connectionName));
        } catch (e) {
            log().warning(oracleMessages.CLOSE_FAILED(connectionName, e.message));
        }
    };
}

/**
 * Acquire a connection → run callback → release.
 * @param {string}   connectionName  Key from database.js registry
 * @param {Function} callback        async (conn) => result
 * @param {object}   [opts]          Optional flags.
 * @param {boolean}  [opts.bypassBreaker=false]  When true, skip the circuit-breaker
 *   health gate and attempt the acquire regardless of pool health. Reserved for
 *   the readiness probe, whose entire job is to report pool health directly.
 */
async function withConnection<T>(connectionName: string, callback: (conn: import("./db").DbConnection) => T | Promise<T>, opts: { bypassBreaker?: boolean; } = {}): Promise<T> {
    if (typeof callback !== "function")
        throw new TypeError("withConnection: callback must be a function.");

    // Circuit breaker: once the health monitor has marked a pool unhealthy
    // (repeated ping failures), fail fast instead of piling more acquires onto
    // a dead pool. The NJS-503 token in the message routes this to a 503
    // DatabaseUnavailableError via ErrorHandlerMiddleware's NJS classifier.
    // A half-open breaker lets a few calls through to test the pool: such a call
    // ("permit") reports how it ended, in the finally below.
    const admission: Admission = opts.bypassBreaker ? "pass" : healthMonitor.admit(connectionName);
    if (admission === "reject") {
        throw _miraError("MIRA_CIRCUIT_OPEN", oracleMessages.POOL_CIRCUIT_OPEN(connectionName), connectionName);
    }

    let pool;
    try {
        pool = await _awaitPool(connectionName);
    } catch (err) {
        healthMonitor.settle(connectionName, admission, "connectivity"); // a pool that cannot open is not a success
        throw err;
    }
    const start = Date.now();
    let conn;
    let guard: Guard = NO_GUARD;
    let ended: MiraErrorKind | "ok" = "ok";

    try {
        conn = await _acquireConnection(connectionName, pool);
        guard = _applySessionLimits(connectionName, conn, getConnectionConfig(connectionName) as unknown as Record<string, unknown>);

        const result = await callback(conn);
        const elapsed = Date.now() - start;
        if (elapsed > 5_000)
            log().warning(oracleMessages.SLOW_OP(connectionName, elapsed));
        return result;
    } catch (err) {
        // A deliberate AppError from the callback (e.g. a 409 thrown inside
        // withTransaction) is already classified; wrapping it would downgrade
        // it to a generic 500. Only driver/ORA/NJS failures are wrapped below.
        if (err.isOperational) throw err;

        // A connection-class failure on real traffic: check the pool now so
        // the breaker (and the readiness stream) learn of an outage in seconds.
        // A readiness probe (bypassBreaker) is itself a check: no nudge.
        const kind = errorKind(err);
        ended = kind;
        if (!opts.bypassBreaker && (kind === "connectivity" || kind === "timeout")) {
            healthMonitor.nudge(connectionName);
        }

        // A readiness probe (bypassBreaker) is unauthenticated: its failures
        // stay off the critical-email tap so callers cannot spend the hourly
        // budget. Outage alerting is delivered by the ORACLE_POOL_DOWN rule.
        log().critical(
            oracleMessages.OP_FAILED(
                connectionName,
                Date.now() - start,
                err.message,
            ),
            opts.bypassBreaker ? { _noNotify: true } : {},
        );
        // The guard remembers what it cut, so the error says so even when a
        // collection method rewrapped it inside the callback.
        throw new MiraDbError(oracleMessages.DB_OP_FAILED(connectionName, err.message), {
            kind,
            code: guard.code() ?? _firstMiraCode(err),
            outcomeUnknown: guard.outcomeUnknown() || _errorChain(err).some(_isUnknownLink),
            connectionName,
            durationMs: Date.now() - start,
            originalError: err,
        });
    } finally {
        if (conn) await _releaseConnection(connectionName, conn, guard);
        healthMonitor.settle(connectionName, admission, ended);
    }
}

/**
 * Gives a borrowed connection back. Session settings a callback changed must not follow
 * the pooled connection to its next borrower (a leftover callTimeout aborts someone
 * else's long query). On a session that is already gone (Thick mode closes it when a
 * call timeout cannot be interrupted: NJS-500 / ORA-03156), the reset itself throws
 * DPI-1010. That must neither replace the caller's error nor skip the release: the
 * connection is dropped from the pool instead of returned to it. A connection whose call
 * was cut is dropped without waiting (its round trip may never finish); a live one is
 * closed within the guard's bound. Only a normal return counts as progress for the
 * health monitor. Never throws.
 */
async function _releaseConnection(name: string, conn: import("oracledb").Connection, guard: Guard): Promise<void> {
    guard.release(); // first, so the close below does not go through the wrapper
    let drop = false;
    try {
        if (conn.callTimeout) conn.callTimeout = 0;
    } catch {
        drop = true;
    }
    try {
        if (guard.dead()) _dropConnQuietly(name, conn);
        else if ((await guard.close(conn, drop)) && !drop) _noteProgress(name);
    } catch (e) {
        log().warning(oracleMessages.CLOSE_FAILED(name, e.message));
    }
}

/**
 * Same as withConnection but wrapped in BEGIN / COMMIT / ROLLBACK.
 * @param {string}   connectionName
 * @param {Function} callback  async (conn) => result
 */
async function withTransaction<T>(connectionName: string, callback: (conn: import("./db").DbConnection) => T | Promise<T>): Promise<T> {
    return withConnection(connectionName, async (conn) => {
        try {
            const result = await callback(conn);
            await conn.commit();
            return result;
        } catch (err) {
            // A dropped session is rolled back by the server: asking it to would
            // only wait out the bound a second time.
            if (!_isConnDead(conn)) {
                try {
                    await conn.rollback();
                } catch (e) {
                    log().warning(
                        oracleMessages.ROLLBACK_FAILED(connectionName, e.message),
                    );
                }
            }
            throw err;
        }
    });
}

/**
 * Run an array of operations on one shared connection.
 * @param {string}     connectionName
 * @param {Function[]} operations  array of async (conn) => result
 * @returns {Promise<Array<{ success, result?, error?, index }>>}
 */
async function withBatchConnection(connectionName: string, operations: ((...args: unknown[]) => unknown)[]): Promise<Array<{ success: boolean; result?: unknown; error?: string; index: number }>> {
    if (!Array.isArray(operations) || !operations.length)
        throw new TypeError(
            "withBatchConnection: operations must be a non-empty array.",
        );

    return withConnection(connectionName, async (conn) => {
        const FATAL = new Set(["ORA-00028", "ORA-00031"]);
        const results: Array<{ success: boolean; result?: unknown; error?: string; index: number }> = [];
        for (let i = 0; i < operations.length; i++) {
            if (typeof operations[i] !== "function") {
                results.push({
                    success: false,
                    error: `Op ${i} is not a function.`,
                    index: i,
                });
                continue;
            }
            try {
                results.push({
                    success: true,
                    result: await operations[i](conn),
                    index: i,
                });
            } catch (err) {
                log().warning(oracleMessages.BATCH_OP_FAILED(i, err.message));
                results.push({ success: false, error: err.message, index: i });
                // Nothing after a lost link can work: stop instead of running the rest into it.
                if ((err.code && FATAL.has(err.code)) || _isConnDead(conn) || errorKind(err) === "connectivity") throw err;
            }
        }
        return results;
    });
}

// ── Stats & monitoring ────────────────────────────────────────────────────────

async function getPoolStats() {
    const stats = {
        timestamp: new Date().toISOString(),
        healthMetrics: healthMonitor.getMetrics(),
        pools: {} as Record<string, unknown>,
        abandoned: _abandonedTotals(),
    };
    for (const [name, poolPromise] of poolRegistry) {
        // Never waits for an opening: a pool still opening is reported as such, a failed one by its error.
        const settled = _poolSettled.get(poolPromise);
        if (!settled) {
            stats.pools[name] = { opening: true };
            continue;
        }
        try {
            if (!settled.ok) throw settled.error;
            const pool = settled.pool as import("oracledb").Pool & { queueLength: number };
            const { open, inUse, min, max, exact } = _poolCounts(name, pool);
            const utilPct = open > 0 ? Math.round((inUse / open) * 100) : 0;
            const capPct = max > 0 ? Math.round((open / max) * 100) : 0;
            stats.pools[name] = {
                poolMin: min,
                poolMax: max,
                connectionsOpen: open,
                ...(!exact && { countsApproximate: true }),
                connectionsInUse: inUse,
                connectionsAvailable: Math.max(0, open - inUse),
                queueLength: pool.queueLength,
                utilizationPct: `${utilPct}%`,
                capacityPct: `${capPct}%`,
                isHighUtilization: utilPct > 80,
                isNearCapacity: capPct > 90,
                abandonedCalls: _ledger(name).calls,
                abandonedPools: _ledger(name).pools,
                zombieConnections: _reported(_ledger(name)).zombies,
                replacements: _ledger(name).replacements,
                recommendation:
                    utilPct > 80
                        ? "Increase poolMax"
                        : utilPct < 20
                          ? "Pool oversized"
                          : "Optimal",
            };
        } catch (err) {
            stats.pools[name] = { error: err.message };
        }
    }
    return stats;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function closeAll() {
    if (isShuttingDown) {
        log().warning(oracleMessages.SHUTDOWN_ALREADY);
        return;
    }
    isShuttingDown = true;
    healthMonitor.stop();
    log().notice(oracleMessages.CLOSING_ALL_POOLS);
    const closures: Promise<void>[] = [];
    for (const [name, poolPromise] of poolRegistry) closures.push(_closeOne(name, poolPromise));
    await Promise.allSettled(closures);
    poolRegistry.clear();
    _monitoredNames.clear();
    log().notice(oracleMessages.ALL_POOLS_CLOSED);
}

/**
 * Closes ONE pool and stops monitoring it; the other pools keep running. The
 * next request for `name` creates the pool again (unlike closeAll, this is not
 * a shutdown). A pool whose creation failed is dropped without a close. Gives up
 * on a pool that will not close after {@link _closeBoundMs}: the close keeps
 * running in the background and is counted as abandoned.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function closePool(name: string): Promise<void> {
    _poolGeneration.set(name, _generationOf(name) + 1); // a creation in progress stops retrying
    const poolPromise = poolRegistry.get(name);
    poolRegistry.delete(name);
    _monitoredNames.delete(name);
    healthMonitor.forget(name);
    if (!poolPromise) return;
    await _closeOne(name, poolPromise);
}

/**
 * Waits for a pool's creation, then drains and closes it, for at most
 * {@link _closeBoundMs}. Never rejects: a failed close is logged, and a close
 * that outlasts the bound is abandoned (counted in the ledger until it ends).
 * On a link that stopped answering, pool.close() never returns by itself.
 */
async function _closeOne(name: string, poolPromise: Promise<import("oracledb").Pool>): Promise<void> {
    const boundMs = _closeBoundMs(_configOf(name));
    const timedOut = _failWith("MIRA_CLOSE_TIMEOUT", oracleMessages.POOL_CLOSE_TIMED_OUT(name, boundMs), name);
    try {
        await _bounded(poolPromise.then(_closeDrained), boundMs, timedOut, { track: { name, kind: "pool" } });
        log().notice(oracleMessages.POOL_CLOSED(name));
    } catch (e) {
        const bounded = e instanceof MiraDbError && e.code === "MIRA_CLOSE_TIMEOUT";
        log().warning(bounded ? e.message : oracleMessages.POOL_CLOSE_ERROR(name, e.message));
    }
}

// ── Pool replacement ──────────────────────────────────────────────────────────
// A connection whose call hung is dropped, but its close queues behind the hung call
// (node-oracledb serialises them), so on a link that stopped answering the slot stays
// "in use" until TCP gives up (~15 min). When such zombies fill the pool, or the breaker
// opens with any of them, only new sockets can recover: the pool is replaced.

/**
 * Replaces the pool of `name` when zombies justify it: "zombies" (a connection just became one)
 * needs every connection of the pool stuck; "breaker" (the breaker just opened) needs any.
 * Only a pool that is open and still the registered one is replaced, never during a shutdown,
 * and never while ABANDONED_CREATE_CAP closes of earlier pools are still unfinished.
 */
function _maybeReplacePool(name: string, reason: "zombies" | "breaker"): void {
    if (isShuttingDown) return;
    const entry = poolRegistry.get(name);
    const settled = entry && _poolSettled.get(entry);
    if (!settled?.ok) return;
    const ledger = _ledger(name);
    const justified = reason === "breaker" ? ledger.zombies > 0 : ledger.zombies >= _poolCounts(name, settled.pool).max;
    if (justified && ledger.pools < ABANDONED_CREATE_CAP) _replacePool(name, entry, reason);
}

/**
 * Drops the registered pool: the next caller or check opens a new one (a new alias, new sockets).
 * Callers still holding the old pool keep their live connections, which return to it while it
 * drains; once it is closed they fail with the driver's own NJS-064/065, a connectivity error.
 * The zombies move to `retired` (still reported, no longer deciding anything).
 */
function _replacePool(name: string, entry: Promise<import("oracledb").Pool>, reason: string): void {
    poolRegistry.delete(name);
    const ledger = _ledger(name);
    log().warning(oracleMessages.POOL_REPLACED(name, reason, ledger.zombies));
    ledger.replacements++;
    ledger.retired += ledger.zombies;
    ledger.zombies = 0;
    ledger.epoch++;
    _abandonPool(name, entry);
}

/** Closes a replaced pool in the background (bounded, and counted as abandoned if it outlasts the bound). */
function _abandonPool(name: string, entry: Promise<import("oracledb").Pool>): void {
    void _closeOne(name, entry);
}

/** Drains a pool for 10 s, then closes it. */
function _closeDrained(pool: import("oracledb").Pool): Promise<void> {
    return pool.close(10);
}

/** drain (10 s) + 2 x connectTimeout, the same shape as the open bound. */
function _closeBoundMs(cfg: Record<string, unknown>): number {
    return 10_000 + 2 * _connectTimeoutMs(cfg);
}

/** A pool's registered config, or {} for a name that is no longer registered. */
function _configOf(name: string): Record<string, unknown> {
    try {
        return getConnectionConfig(name) as unknown as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** True while `name` has a pool created or being created. */
function isPoolOpen(name: string): boolean {
    return poolRegistry.has(name);
}

// Signal / exception handlers are in server.ts — not duplicated here.

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
// ── Transient DB error classification ─────────────────────────────────────────
// Inlined from CATHERINE's RetryPolicy.classifyDbError so Mira stays a standalone
// library. An acquire is retried only for network/session churn; a unique-key
// violation (ORA-00001) or a killed session (ORA-00028/00031) never is.
// Walks err.originalError (capped at 5 links) so wrapped errors classify too.
const TRANSIENT_DB_ORA_CODES = new Set([
    3113, 3114, 12170, 12541, 12514, 12560, 1013,
    12516, // listener has no ready/registered handler for the service
    12518, // listener could not hand off the client connection
    12520, // listener could not find a handler for the requested server type
    12537, // TNS:connection closed — server process died during handshake
]);
const NON_TRANSIENT_DB_ORA_CODES = new Set([1, 28, 31]);
const TRANSIENT_DB_SYSTEM_CODES = new Set(["ECONNRESET", "ETIMEDOUT"]);
const TRANSIENT_DB_STRING_PATTERNS = [
    // "Timed out getting connection" is deliberately absent: it is Mira's own acquire
    // bound (MIRA_ACQUIRE_TIMEOUT), which means the driver is stuck, and a retry
    // would queue another waiter behind it.
    // NJS-040 (queue timeout) is deliberately absent: it means the pool is
    // saturated, and retrying it stretches queueTimeout ~3x and adds load.
    /NJS-(500|501|503|510)/,
];

/** ORA number from the driver's errorNum, else parsed out of "ORA-XXXXX" in the message. */
function _oraCode(err: Record<string, unknown>): number | null {
    if (typeof err.errorNum === "number") return err.errorNum;
    if (typeof err.message === "string") {
        const match = err.message.match(/ORA-0*(\d+)/i);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

/** True for a MiraDbError or an error whose message carries a [MIRA_CODE] token. */
function _isMiraOwn(link: Record<string, unknown>): boolean {
    return link instanceof MiraDbError || MIRA_CODE_RE.test(_messageOf(link));
}

/**
 * True when `err` (or an error it wraps) is a transient connectivity failure.
 * @param {*} err
 * @returns {boolean}
 */
function _isTransientDbError(err: unknown): boolean {
    const chain = _errorChain(err);
    // One of Mira's own bounds (or a pool that could not open) is never retried here.
    if (chain.some(_isMiraOwn)) return false;
    const codes = chain.map(_oraCode);
    if (codes.some((c) => c !== null && NON_TRANSIENT_DB_ORA_CODES.has(c))) return false;
    if (codes.some((c) => c !== null && TRANSIENT_DB_ORA_CODES.has(c))) return true;
    return chain.some(
        (e) =>
            (typeof e.code === "string" && TRANSIENT_DB_SYSTEM_CODES.has(e.code)) ||
            (typeof e.message === "string" &&
                TRANSIENT_DB_STRING_PATTERNS.some((re) => re.test(e.message as string))), // narrowed by the typeof check
    );
}

/**
 * Full jitter: returns a random value in the half-open interval [0, delayMs).
 * Callers MUST pass the already-capped delay (e.g. `Math.min(base, cap)`) so
 * the cap is preserved — jittering WITHIN the cap keeps the ceiling intact.
 * Never wrap this in a Math.min against the cap; that would reintroduce
 * thundering-herd synchronisation at the ceiling.
 * @param {number} delayMs - The already-capped upper bound for the sleep.
 * @returns {number} A random delay in [0, delayMs).
 */
function _jitter(delayMs: number): number {
    return Math.random() * delayMs;
}

// Logging helpers are defined at top to avoid TDZ when module initializes

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Exports
// ─────────────────────────────────────────────────────────────────────────────

// After closeAll() the pools are gone for good (getPool refuses while shutting down), so
// no pool is healthy any more, including one that was never created.
const __export_isPoolHealthy = (name: string) => !isShuttingDown && healthMonitor.isHealthy(name);
const __export_getHealthMetrics = () => healthMonitor.getMetrics();
const __export___setPoolHealthForTest = (name: string, healthy: unknown) => {
        if (process.env.NODE_ENV !== "test") {
            throw new Error(
                "__setPoolHealthForTest is a test-only seam and must not be called outside NODE_ENV=test.",
            );
        }
        healthMonitor._ensure(name); // the seam may name a pool no check has seen yet
        healthMonitor._setHealthy(name, Boolean(healthy));
    };
const __export_onPoolHealthChange = (fn: (change: { name: string; healthy: boolean }) => void) => {
        healthMonitor.on("change", fn);
        return () => healthMonitor.off("change", fn);
    };
const __export_allPoolsHealthy = () => healthMonitor.allHealthy();
const __export_recordProbeSuccess = (name: string) => healthMonitor.recordProbeSuccess(name);
const __export_nudgePoolHealth = (name: string) => healthMonitor.nudge(name);
const __export_onPoolHealthCheck = (fn: (check: { name: string; ok: boolean; saturated?: boolean }) => void) => {
        healthMonitor.on("check", fn);
        return () => healthMonitor.off("check", fn);
    };
const __export_setPoolHealthWatched = (watched: boolean) => healthMonitor.setWatched(watched);
export { errorKind, configureDriver, initDriver, toDriverConnectTimeoutSec, POOL_DEFAULTS, withConnection, withTransaction, withBatchConnection, initializePools, closeAll, closePool, isPoolOpen, getPoolStats, __export_isPoolHealthy as isPoolHealthy, __export_getHealthMetrics as getHealthMetrics, __export___setPoolHealthForTest as __setPoolHealthForTest, __export_onPoolHealthChange as onPoolHealthChange, __export_allPoolsHealthy as allPoolsHealthy, __export_recordProbeSuccess as recordProbeSuccess, __export_nudgePoolHealth as nudgePoolHealth, __export_onPoolHealthCheck as onPoolHealthCheck, __export_setPoolHealthWatched as setPoolHealthWatched, oracledb, OUT_FORMAT_OBJECT, SYSDBA_PRIVILEGE, EXECUTE_OPTIONS, moneySafeFetchTypeHandler };
