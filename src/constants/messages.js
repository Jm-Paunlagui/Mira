// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Oracle
// ─────────────────────────────────────────────────────────────────────────────
const oracleMessages = {
    ORACLE_INSTANT_CLIENT_NOT_SET:
        "ORACLE_INSTANT_CLIENT not set — skipping validation.",
    ORACLE_CLIENT_PATH_NOT_FOUND: (clientPath) =>
        `Oracle client path not found: ${clientPath}`,
    ORACLE_FILES_MISSING: (missing, clientPath) =>
        `Missing Oracle files [${missing.join(", ")}] in ${clientPath}`,
    ORACLE_CLIENT_VALIDATED: (clientPath) =>
        `Oracle client validated: ${clientPath}`,
    ORACLE_CLIENT_PREPENDED_PATH: (clientPath) =>
        `Oracle client prepended to PATH: ${clientPath}`,
    ENV_LOADED_FROM: (filePath) => `Env loaded from: ${filePath}`,
    COULD_NOT_READ_ENV: (filePath, err) =>
        `Could not read .env at ${filePath}: ${err}`,
    NO_ENV_FOUND: "No .env found in compiled environment.",
    ORACLE_CLIENT_INITIALISED_ENV:
        "Oracle client initialised from ORACLE_INSTANT_CLIENT.",
    ORACLE_CLIENT_INITIALISED_PATH:
        "Oracle client initialised from system PATH.",
    ORACLE_CLIENT_INIT_WARN: (err) => `Oracle client init: ${err}`,
    ORACLEDB_DRIVER_LOADED: "oracledb driver loaded.",
    ORACLEDB_DRIVER_FAILED: (err) => `Failed to load oracledb: ${err}`,
    POOL_CREATING: (name) => `Creating pool \"${name}\"…`,
    POOL_READY: (name, pool) =>
        `Pool \"${name}\" ready (min=${pool.poolMin}, max=${pool.poolMax}).`,
    POOL_FAILED: (name, attempt, max, err) =>
        `Pool \"${name}\" failed (attempt ${attempt}/${max}): ${err}`,
    POOL_RETRYING: (name, delay) => `Retrying pool \"${name}\" in ${delay}ms…`,
    POOL_COULD_NOT_CREATE: (name, max, err) =>
        `Could not create pool \"${name}\" after ${max} attempts: ${err}`,
    POOL_HEALTH_CHECK_FAILED: (name, failures) =>
        `Pool \"${name}\" health check failed (consecutive failures: ${failures}).`,
    POOL_MARKED_UNHEALTHY: (name, max) =>
        `Pool \"${name}\" marked UNHEALTHY after ${max} failures.`,
    POOL_RECOVERED: (name, failures) =>
        `Pool \"${name}\" RECOVERED after ${failures} consecutive failures.`,
    POOL_CLOSED: (name) => `Pool \"${name}\" closed.`,
    POOL_CLOSE_ERROR: (name, err) => `Pool \"${name}\" close error: ${err}`,
    SHUTDOWN_ALREADY: "Shutdown already in progress.",
    CLOSING_ALL_POOLS: "Closing all Oracle pools…",
    ALL_POOLS_CLOSED: "All Oracle pools closed.",
    SIGNAL_RECEIVED: (sig) => `${sig} received — shutting down.`,
    UNCATCHED_EXCEPTION: "Uncaught exception",
    UNHANDLED_REJECTION: "Unhandled rejection",
    OP_FAILED: (name, ms, err) => `Op failed on \"${name}\" (${ms}ms): ${err}`,
    DB_OP_FAILED: (name, err) => `DB op failed [${name}]: ${err}`,
    CLOSE_FAILED: (name, err) => `Close failed for \"${name}\": ${err}`,
    SLOW_OP: (name, ms) => `Slow op on \"${name}\": ${ms}ms`,
    POOL_UNHEALTHY_ATTEMPT: (name) =>
        `Pool \"${name}\" is unhealthy — attempting anyway.`,
    ROLLBACK_FAILED: (name, err) => `Rollback failed on \"${name}\": ${err}`,
    BATCH_OP_FAILED: (i, err) => `Batch op ${i} failed: ${err}`,
    DEV_PLACEHOLDER_CONFIG: (name, missing) =>
        `Dev mode: placeholder config for \"${name}\". Missing: ${missing}`,
    MISSING_CONFIG_FIELDS: (name, missing) =>
        `Missing config fields for \"${name}\": ${missing}`,
};
// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Oracle Mongo Wrapper
// ─────────────────────────────────────────────────────────────────────────────
const oracleMongoWrapperMessages = {
    // ── Error formatter ──────────────────────────────────────────────────────
    /** Standard catch-block error: [scope] msg\nSQL: ...\nBinds: ... */
    wrapError: (scope, err, sql, binds) =>
        `[${scope}] ${err.message}\nSQL: ${sql}${binds !== undefined ? `\nBinds: ${JSON.stringify(binds)}` : ""}`,

    // ── Privilege / DCL ──────────────────────────────────────────────────────
    INSUFFICIENT_PRIVILEGES: (scope, requiredPrivilege, err, sql) =>
        `[${scope}] Insufficient privileges. ${requiredPrivilege}\nOriginal: ${err.message}\nSQL: ${sql}`,
    DCL_GRANT_INSUFFICIENT: (err, sql) =>
        `[OracleDCL.grant] Insufficient privileges to GRANT. Requires GRANT OPTION or DBA role.\nOriginal: ${err.message}\nSQL: ${sql}`,
    DCL_REVOKE_INSUFFICIENT: (err, sql) =>
        `[OracleDCL.revoke] Insufficient privileges to REVOKE. Requires GRANT OPTION or DBA role.\nOriginal: ${err.message}\nSQL: ${sql}`,

    // ── Privilege requirement descriptions ───────────────────────────────────
    PRIV_PLAN_TABLE: "Requires SELECT on PLAN_TABLE and EXECUTE on DBMS_XPLAN.",
    PRIV_DBMS_STATS:
        "Requires EXECUTE on DBMS_STATS (typically granted via DBA role or explicit GRANT).",
    PRIV_CREATE_MVIEW: "Requires CREATE MATERIALIZED VIEW privilege.",
    PRIV_REFRESH_MVIEW: "Requires EXECUTE on DBMS_MVIEW.",
    PRIV_DROP_MVIEW: "Requires DROP MATERIALIZED VIEW privilege.",

    // ── Validation messages ──────────────────────────────────────────────────
    CREATEDB_INVALID_CONNECTION_NAME:
        "createDb: connectionName must be a non-empty string",
    MERGE_BINDS_KEY_COLLISION: (key) =>
        `Bind key collision: "${key}" exists in both bind objects.`,
    FILTER_UNSUPPORTED_OPERATOR: (op) =>
        `[filterParser] Unsupported operator: ${op}`,
    UPDATE_EMPTY: "[updateParser] Update object must not be empty.",
    UPDATE_RENAME_NOT_SUPPORTED:
        "[updateParser] $rename is not supported. Use ALTER TABLE to rename columns.",
    UPDATE_UNSUPPORTED_OPERATOR: (op) =>
        `[updateParser] Unsupported update operator: ${op}`,
    UPDATE_NO_OPERATOR:
        "[updateParser] Update object must contain at least one operator ($set, $inc, etc.).",
    QUERY_BUILDER_CHAIN_AFTER_TERMINAL:
        "Cannot chain after terminal method has been called.",
    INSERT_MANY_EMPTY:
        "[OracleCollection.insertMany] Documents array must not be empty.",
    BULK_WRITE_EMPTY:
        "[OracleCollection.bulkWrite] Operations must be a non-empty array.",
    BULK_WRITE_UNKNOWN_OP: (keys) =>
        `[OracleCollection.bulkWrite] Unknown operation type: ${JSON.stringify(keys)}`,
    SCHEMA_ALTER_TABLE_UNKNOWN_OP:
        "[OracleSchema.alterTable] Unknown operation.",
    SCHEMA_CREATE_VIEW_INVALID_INPUT:
        "[OracleSchema.createView] Expected a QueryBuilder or SQL string.",
    PERF_EXPLAIN_PLAN_INVALID_INPUT:
        "[performance.explainPlan] Expected a QueryBuilder or SQL string.",
    PERF_CREATE_MVIEW_INVALID_INPUT:
        "[performance.createMaterializedView] Expected a QueryBuilder or SQL string.",
    SET_OP_COLUMN_COUNT_MISMATCH:
        "[SetResultBuilder] Column counts differ between queries",
};

module.exports = { oracleMessages, oracleMongoWrapperMessages };
