/**
 * Oracle Adapter
 * Merges: oracleEnvironment.js + oracleLoader.js + oracleConnectionPool.js
 *
 * Pools are lazy — created on first use, registered by name from database.js.
 * Adding a new DB never requires touching this file.
 *
 * Public API:
 *   withConnection(name, cb)          acquire → run → release
 *   withTransaction(name, cb)         same, wrapped in BEGIN/COMMIT/ROLLBACK
 *   withBatchConnection(name, ops[])  many ops on one shared connection
 *   closeAll()                        graceful shutdown
 *   getPoolStats()                    monitoring snapshot
 *   isPoolHealthy(name)               health probe
 *   getHealthMetrics()                full health object
 *
 * Backward-compatible shorthands (drop-in for old imports):
 *   withDbConnection(cb)      → withConnection('userAccount', cb)
 *   withDbConnectionUnit(cb)  → withConnection('unitInventory', cb)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getConnectionConfig } = require("../database");
const { logger } = require("../../utils/logger");
const { oracleMessages } = require("../../constants/messages");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Oracle client environment  (was: oracleEnvironment.js)
// ─────────────────────────────────────────────────────────────────────────────

function validateOracleClient() {
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    if (!clientPath) {
        logger.warn(oracleMessages.ORACLE_INSTANT_CLIENT_NOT_SET);
        return false;
    }
    if (!fs.existsSync(clientPath)) {
        logger.error(oracleMessages.ORACLE_CLIENT_PATH_NOT_FOUND(clientPath));
        return false;
    }

    const required = ["oci.dll", "oraociei23.dll"];
    const missing = required.filter(
        (f) => !fs.existsSync(path.join(clientPath, f)),
    );
    if (missing.length) {
        logger.warn(oracleMessages.ORACLE_FILES_MISSING(missing, clientPath));
        return false;
    }

    logger.info(oracleMessages.ORACLE_CLIENT_VALIDATED(clientPath));
    return true;
}

function setupOracleEnvironment() {
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    if (!clientPath || !fs.existsSync(clientPath)) return;
    const current = process.env.PATH || "";
    if (!current.includes(clientPath)) {
        process.env.PATH = `${clientPath};${current}`;
        logger.info(`Oracle client prepended to PATH: ${clientPath}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Driver loader  (was: oracleLoader.js)
// ─────────────────────────────────────────────────────────────────────────────

const isCompiled = typeof process.pkg !== "undefined";

function _loadEnvForCompiled() {
    if (!isCompiled) return;
    const candidates = [
        path.join(process.cwd(), ".env"),
        path.join(__dirname, "../../../.env"),
        path.join(path.dirname(process.execPath), ".env"),
    ];
    for (const filePath of candidates) {
        if (!fs.existsSync(filePath)) continue;
        try {
            const lines = fs.readFileSync(filePath, "utf8").split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (
                    !trimmed ||
                    trimmed.startsWith("#") ||
                    !trimmed.includes("=")
                )
                    continue;
                const eqIdx = trimmed.indexOf("=");
                const key = trimmed.slice(0, eqIdx).trim();
                const value = trimmed.slice(eqIdx + 1).trim();
                if (!process.env[key]) process.env[key] = value;
            }
            logger.info(`Env loaded from: ${filePath}`);
            return;
        } catch (err) {
            logger.warn(`Could not read .env at ${filePath}: ${err.message}`);
        }
    }
    logger.warn("No .env found in compiled environment.");
}

function _initOracleClient(db) {
    if (db.oracleClientVersion) return;
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    const isValid = validateOracleClient();
    try {
        if (isValid && clientPath) {
            db.initOracleClient({ libDir: clientPath });
            logger.info(
                "Oracle client initialised from ORACLE_INSTANT_CLIENT.",
            );
        } else {
            db.initOracleClient();
            logger.info("Oracle client initialised from system PATH.");
        }
    } catch (err) {
        if (!err.message.includes("NJS-077"))
            logger.warn(`Oracle client init: ${err.message}`);
    }
}

let oracledb;
try {
    if (isCompiled) {
        logger.info(
            "Compiled exe detected — bootstrapping Oracle environment.",
        );
        _loadEnvForCompiled();
        setupOracleEnvironment();
    }
    oracledb = require("oracledb");
    if (isCompiled) _initOracleClient(oracledb);
    logger.info("oracledb driver loaded.");
} catch (err) {
    logger.error(`Failed to load oracledb: ${err.message}`);
    throw err;
}

oracledb.fetchArraySize = 1000; // Reduce internal round-trips for bulk reads (default: 100)

const OUT_FORMAT_OBJECT = oracledb.OUT_FORMAT_OBJECT;
const SYSDBA_PRIVILEGE = oracledb.SYSDBA_PRIVILEGE;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Pool management  (was: oracleConnectionPool.js)
// ─────────────────────────────────────────────────────────────────────────────

const POOL_DEFAULTS = {
    poolMin: 10,
    poolMax: 50,
    poolIncrement: 5,
    poolTimeout: 30,
    queueTimeout: 15000,
    poolPingInterval: 30,
    connectTimeout: 15000,
    callTimeout: 60000,
    stmtCacheSize: 50,
    homogeneous: true,
    externalAuth: false,
    events: false,
};

const EXECUTE_OPTIONS = Object.freeze({
    outFormat: OUT_FORMAT_OBJECT,
    autoCommit: true,
    fetchArraySize: 1000,
});

const poolRegistry = new Map(); // name → Promise<Pool>
let isShuttingDown = false;

// ── Health monitor ────────────────────────────────────────────────────────────

class PoolHealthMonitor {
    constructor() {
        this._metrics = new Map();
        this._maxFailures = 3;
        this._checkIntervalMs = 30_000;
        this._timer = null;
    }

    _ensure(name) {
        if (!this._metrics.has(name))
            this._metrics.set(name, {
                healthy: true,
                lastCheck: null,
                consecutiveFailures: 0,
            });
    }

    async checkPool(name) {
        this._ensure(name);
        const meta = this._metrics.get(name);
        try {
            const pool = await _getOrCreatePool(name);
            const conn = await pool.getConnection();
            await conn.ping();
            await conn.close();
            // Log once when a pool recovers after failures to avoid log spam during outages
            if (
                !meta.healthy &&
                meta.consecutiveFailures >= this._maxFailures
            ) {
                logger.info(
                    oracleMessages.POOL_RECOVERED(
                        name,
                        meta.consecutiveFailures,
                    ),
                );
            }
            meta.healthy = true;
            meta.lastCheck = new Date();
            meta.consecutiveFailures = 0;
        } catch {
            meta.consecutiveFailures++;
            meta.lastCheck = new Date();
            logger.warn(
                oracleMessages.POOL_HEALTH_CHECK_FAILED(
                    name,
                    meta.consecutiveFailures,
                ),
            );
            if (meta.consecutiveFailures >= this._maxFailures) {
                if (meta.healthy) {
                    logger.error(
                        oracleMessages.POOL_MARKED_UNHEALTHY(
                            name,
                            this._maxFailures,
                        ),
                    );
                }
                meta.healthy = false;
            }
        }
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            for (const name of poolRegistry.keys())
                this.checkPool(name).catch((e) =>
                    logger.error(`Health check "${name}": ${e.message}`),
                );
        }, this._checkIntervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    isHealthy(name) {
        return this._metrics.get(name)?.healthy ?? true;
    }

    getMetrics() {
        const out = {};
        for (const [n, m] of this._metrics) out[n] = { ...m };
        return out;
    }
}

const healthMonitor = new PoolHealthMonitor();
healthMonitor.start();

// ── Pool lifecycle ────────────────────────────────────────────────────────────

function _validateConfig(config, name) {
    const missing = ["user", "password", "connectString"].filter(
        (k) => !config[k],
    );
    if (!missing.length) return;
    const isPlaceholder =
        config.user && String(config.user).includes("placeholder");
    if (process.env.NODE_ENV === "development" && isPlaceholder) {
        logger.warn(
            `Dev mode: placeholder config for "${name}". Missing: ${missing.join(", ")}`,
        );
        return;
    }
    throw new Error(
        `Missing config fields for "${name}": ${missing.join(", ")}`,
    );
}

async function _createPool(name, dbConfig, attempt = 0) {
    const MAX_RETRIES = 3;
    const delay = Math.min(1000 * 2 ** attempt, 10_000);

    _validateConfig(dbConfig, name);

    const config = { ...POOL_DEFAULTS, ...dbConfig, poolAlias: `${name}_pool` };

    // Safe log — no credentials
    const logSafe = { ...config };
    delete logSafe.password;
    delete logSafe.user;
    logger.info(`Creating pool "${name}"…`);

    try {
        if (isCompiled)
            config.connectString = config.connectString
                .replace(/\s+/g, " ")
                .trim();

        const pool = await oracledb.createPool(config);
        const conn = await pool.getConnection();
        await conn.ping();
        await conn.close();

        logger.info(oracleMessages.POOL_READY(name, pool));
        return pool;
    } catch (err) {
        logger.error(
            oracleMessages.POOL_FAILED(
                name,
                attempt + 1,
                MAX_RETRIES + 1,
                err.message,
            ),
        );
        if (attempt < MAX_RETRIES) {
            logger.info(oracleMessages.POOL_RETRYING(name, delay));
            await _sleep(delay);
            return _createPool(name, dbConfig, attempt + 1);
        }
        throw new Error(
            oracleMessages.POOL_COULD_NOT_CREATE(
                name,
                MAX_RETRIES + 1,
                err.message,
            ),
        );
    }
}

function _getOrCreatePool(name) {
    if (isShuttingDown)
        return Promise.reject(
            new Error("App is shutting down — no new connections."),
        );
    if (!poolRegistry.has(name)) {
        const config = getConnectionConfig(name); // throws if name unknown
        poolRegistry.set(name, _createPool(name, config));
    }
    return poolRegistry.get(name);
}

// ── Connection helpers ────────────────────────────────────────────────────────

/**
 * Acquire a connection → run callback → release.
 * @param {string}   connectionName  Key from database.js registry
 * @param {Function} callback        async (conn) => result
 */
async function withConnection(connectionName, callback) {
    if (typeof callback !== "function")
        throw new TypeError("withConnection: callback must be a function.");

    if (!healthMonitor.isHealthy(connectionName))
        logger.warn(
            `Pool "${connectionName}" is unhealthy — attempting anyway.`,
        );

    const pool = await _getOrCreatePool(connectionName);
    const start = Date.now();
    let conn;

    try {
        conn = await Promise.race([
            pool.getConnection(),
            _timeout(
                POOL_DEFAULTS.connectTimeout,
                `Timed out getting connection from "${connectionName}"`,
            ),
        ]);

        const result = await callback(conn);
        const elapsed = Date.now() - start;
        if (elapsed > 5_000)
            logger.warn(oracleMessages.SLOW_OP(connectionName, elapsed));
        return result;
    } catch (err) {
        logger.error(
            oracleMessages.OP_FAILED(
                connectionName,
                Date.now() - start,
                err.message,
            ),
        );
        throw Object.assign(
            new Error(oracleMessages.DB_OP_FAILED(connectionName, err.message)),
            {
                originalError: err,
                connectionName,
                durationMs: Date.now() - start,
            },
        );
    } finally {
        if (conn) {
            try {
                await conn.close();
            } catch (e) {
                logger.error(
                    oracleMessages.CLOSE_FAILED(connectionName, e.message),
                );
            }
        }
    }
}

/**
 * Same as withConnection but wrapped in BEGIN / COMMIT / ROLLBACK.
 * @param {string}   connectionName
 * @param {Function} callback  async (conn) => result
 */
async function withTransaction(connectionName, callback) {
    return withConnection(connectionName, async (conn) => {
        try {
            const result = await callback(conn);
            await conn.commit();
            return result;
        } catch (err) {
            try {
                await conn.rollback();
            } catch (e) {
                logger.error(
                    oracleMessages.ROLLBACK_FAILED(connectionName, e.message),
                );
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
async function withBatchConnection(connectionName, operations) {
    if (!Array.isArray(operations) || !operations.length)
        throw new TypeError(
            "withBatchConnection: operations must be a non-empty array.",
        );

    return withConnection(connectionName, async (conn) => {
        const FATAL = new Set(["ORA-00028", "ORA-00031"]);
        const results = [];
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
                logger.error(oracleMessages.BATCH_OP_FAILED(i, err.message));
                results.push({ success: false, error: err.message, index: i });
                if (err.code && FATAL.has(err.code)) throw err;
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
        pools: {},
    };
    for (const [name, poolPromise] of poolRegistry) {
        try {
            const pool = await poolPromise;
            const open = pool.connectionsOpen,
                inUse = pool.connectionsInUse;
            const utilPct = open > 0 ? Math.round((inUse / open) * 100) : 0;
            const capPct =
                pool.poolMax > 0 ? Math.round((open / pool.poolMax) * 100) : 0;
            stats.pools[name] = {
                poolMin: pool.poolMin,
                poolMax: pool.poolMax,
                connectionsOpen: open,
                connectionsInUse: inUse,
                connectionsAvailable: Math.max(0, open - inUse),
                queueLength: pool.queueLength,
                utilizationPct: `${utilPct}%`,
                capacityPct: `${capPct}%`,
                isHighUtilization: utilPct > 80,
                isNearCapacity: capPct > 90,
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
        logger.warn(oracleMessages.SHUTDOWN_ALREADY);
        return;
    }
    isShuttingDown = true;
    healthMonitor.stop();
    logger.info(oracleMessages.CLOSING_ALL_POOLS);
    const closures = [];
    for (const [name, poolPromise] of poolRegistry) {
        closures.push(
            Promise.race([
                poolPromise.then((p) => p.close(10)),
                _timeout(30_000, `Shutdown timeout for "${name}"`),
            ])
                .then(() => logger.info(oracleMessages.POOL_CLOSED(name)))
                .catch((e) =>
                    logger.error(
                        oracleMessages.POOL_CLOSE_ERROR(name, e.message),
                    ),
                ),
        );
    }
    await Promise.allSettled(closures);
    poolRegistry.clear();
    logger.info(oracleMessages.ALL_POOLS_CLOSED);
}

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => {
    process.once(sig, async () => {
        logger.info(oracleMessages.SIGNAL_RECEIVED(sig));
        try {
            await closeAll();
            process.exit(0);
        } catch {
            process.exit(1);
        }
    });
});
process.once("uncaughtException", async (e) => {
    logger.error(oracleMessages.UNCATCHED_EXCEPTION, e);
    await closeAll();
    process.exit(1);
});
process.once("unhandledRejection", async (r) => {
    logger.error(oracleMessages.UNHANDLED_REJECTION, r);
    await closeAll();
    process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function _timeout(ms, msg) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(msg)), ms),
    );
}

// Logging helpers are defined at top to avoid TDZ when module initializes

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    // Core
    withConnection,
    withTransaction,
    withBatchConnection,

    // Pool management
    closeAll,
    getPoolStats,
    isPoolHealthy: (name) => healthMonitor.isHealthy(name),
    getHealthMetrics: () => healthMonitor.getMetrics(),

    // Environment helpers
    validateOracleClient,
    setupOracleEnvironment,

    // Raw driver & constants
    oracledb,
    OUT_FORMAT_OBJECT,
    SYSDBA_PRIVILEGE,
    EXECUTE_OPTIONS,
};
