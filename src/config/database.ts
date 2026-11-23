

// Environment variables are loaded once at process startup by server.ts (and by
// each standalone script in scripts/, which call dotenv.config before requiring
// this module). Config files MUST NOT call dotenv themselves — re-loading .env on
// every require re-injects values the caller deliberately unset (e.g. unit tests
// that delete an env var to assert a default). See Backend CLAUDE.md
// "Environment Variables".

// const isDevelopment = process.env.NODE_ENV === "development";

function buildSimpleConnectString(host: unknown, port: unknown, service: unknown) {
    return `${host}:${port}/${service}`;
}

/**
 * Parses a whole number >= 0, falling back on anything else. Unlike the
 * `parseInt(x, 10) || fallback` idiom, an explicit 0 is kept.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : fallback;
}

function buildTNSConnectString(host: unknown, port: unknown, sid: unknown) {
    return (
        `(DESCRIPTION=` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(LOAD_BALANCE=yes)` +
        `(CONNECT_DATA=(SERVER=DEDICATED)(SID=${sid})` +
        `(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))`
    );
}

/**
 * Connection registry.
 *
 * HOW TO ADD A NEW CONNECTION:
 *   1. Add env vars to .env
 *   2. Add one entry here
 *   3. Use it: withConnection('yourKey', callback)
 *   — No other file needs to change.
 *
 * Per-entry fields:
 *   user           {string}  Oracle username
 *   password       {string}  Oracle password
 *   connectString  {string}  Oracle connect string
 *   poolMin        {number}  optional — overrides global default
 *   poolMax        {number}  optional — overrides global default
 *   queueMax       {number}  optional — bounds the acquire queue (NJS-076 when full)
 *   poolTimeout    {number}  optional — idle seconds above poolMin before close (0 = never)
 */
const appDbCredentials = {
    user: process.env.APP_DB_USERNAME,
    password: process.env.APP_DB_PASSWORD,
    connectString: buildTNSConnectString(
        process.env.DB_HOST,
        process.env.DB_PORT,
        process.env.DB_APP_SERVICE_NAME,
    ),
};

const connections = {
    // ── appDb — the standalone template connection (T_USERS_DEV / T_ADMINS_DEV /
    //    T_AUDIT_LOGS_DEV). This is the only connection a fresh project needs.
    //    Skipped entirely when DEMO_MODE=true (no Oracle pool is opened).
    appDb: {
        ...appDbCredentials,
        poolMin: parseInt(process.env.APP_POOL_MIN ?? "", 10) || 5,
        poolMax: parseInt(process.env.APP_POOL_MAX ?? "", 10) || 20,
        queueMax: parseInt(process.env.APP_QUEUE_MAX ?? "", 10) || 40,
        poolTimeout: nonNegativeInt(process.env.APP_POOL_TIMEOUT, 30),
    },

    // ── appDbBulk — same credentials, separate pool for long-hold work (export,
    //    backup, purge, restore) so it cannot starve interactive traffic.
    appDbBulk: {
        ...appDbCredentials,
        poolMin: parseInt(process.env.APP_BULK_POOL_MIN ?? "", 10) || 1,
        poolMax: parseInt(process.env.APP_BULK_POOL_MAX ?? "", 10) || 6,
        queueMax: parseInt(process.env.APP_BULK_QUEUE_MAX ?? "", 10) || 24,
        queueTimeout: parseInt(process.env.APP_BULK_QUEUE_TIMEOUT ?? "", 10) || 30000,
        // ms (app acquire race); converted to whole seconds for the driver in adapters/oracle.js.
        connectTimeout: parseInt(process.env.APP_BULK_CONNECT_TIMEOUT ?? "", 10) || 20000,
    },

    // ── Add new connections below ──────────────────────────────────────────
    // reportingDb: {
    //     user:          process.env.RPT_DB_USERNAME,
    //     password:      process.env.RPT_DB_PASSWORD,
    //     connectString: buildSimpleConnectString(
    //         process.env.RPT_DB_HOST,
    //         process.env.RPT_DB_PORT,
    //         process.env.RPT_DB_SERVICE_NAME,
    //     ),
    //     poolMax: 10,
    // },
};

function getConnectionConfig(name: string) {
    const config = connections[name as keyof typeof connections];
    if (!config) {
        const available = Object.keys(connections).join(", ");
        throw new Error(
            `Unknown connection "${name}". Registered: ${available}`,
        );
    }
    return config;
}

function getConnectionNames() {
    return Object.keys(connections);
}

/**
 * Named pool keys — single source of truth for pool name strings.
 * Import this into health.route.js and any other file that references pool names
 * to avoid magic strings.
 */
const POOL_NAMES = Object.freeze(Object.keys(connections));

/**
 * Pools whose SATURATION (NJS-076) makes /health/ready answer 503.
 *
 * Every pool must answer with a closed breaker for /ready to be 200; this list
 * only decides which pools may not be saturated. `appDbBulk` is excluded: it is
 * the load-shedding bulkhead, so a saturated bulk pool is the design working,
 * not the service being unready.
 */
const READINESS_GATING_POOLS = Object.freeze(["appDb"]);

// FAIL-CLOSED: a gating pool that is not a registered pool is a config error.
for (const p of READINESS_GATING_POOLS) {
  if (!POOL_NAMES.includes(p)) {
    throw new Error(
      `Invalid READINESS_GATING_POOLS entry "${p}". Must be one of the registered pools: ${POOL_NAMES.join(", ")}.`,
    );
  }
}

// Default object as well as named exports: the Oracle adapter destructures
// getConnectionConfig from it at load, so test/server/helpers/freshOracleAdapter.js
// can swap the function on this plain object for a fresh adapter copy.
// A named-export binding cannot be reassigned from outside the module.
export default { connections, getConnectionConfig, getConnectionNames, POOL_NAMES, READINESS_GATING_POOLS, buildSimpleConnectString, buildTNSConnectString };
export { connections, getConnectionConfig, getConnectionNames, POOL_NAMES, READINESS_GATING_POOLS, buildSimpleConnectString, buildTNSConnectString };
