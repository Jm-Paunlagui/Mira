

/**
 * @fileoverview Oracle pool / driver log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const oracleMessages = {
  SESSION_TZ_IGNORED:
    "ORA_SDTZ is not an offset (+08:00), a region (Asia/Manila), LOCAL or DBTIMEZONE; Mira leaves the session time zone at the client's default.",
  POOL_READY: (name: unknown, pool: { poolMin: number; poolMax: number }) =>
    `Pool "${name}" ready (min=${pool.poolMin}, max=${pool.poolMax}).`,
  THREADPOOL_TOO_SMALL: (name: unknown, poolMax: unknown, threads: unknown, fromEnv: boolean) =>
    `Pool "${name}" can open ${poolMax} connections, but Thick mode runs each call on one of ${threads} worker threads (UV_THREADPOOL_SIZE${fromEnv ? "" : " not set; Node's default is 4"}). Calls waiting on row locks can hold every thread and hang the process: set UV_THREADPOOL_SIZE=${poolMax} or more before the process starts.`,
  POOL_FAILED: (name: unknown, attempt: unknown, max: unknown, err: unknown) =>
    `Pool "${name}" failed (attempt ${attempt}/${max}): ${err}`,
  POOL_RETRYING: (name: unknown, delay: unknown) => `Retrying pool "${name}" in ${delay}ms…`,
  POOL_COULD_NOT_CREATE: (name: unknown, max: unknown, err: unknown) =>
    `Could not create pool "${name}" after ${max} attempts: ${err}`,
  POOL_HEALTH_CHECK_FAILED: (name: unknown, failures: unknown) =>
    `Pool "${name}" health check failed (consecutive failures: ${failures}).`,
  POOL_MARKED_UNHEALTHY: (name: unknown, max: unknown) =>
    `Pool "${name}" marked UNHEALTHY after ${max} failures.`,
  /**
   * Thrown (not just logged) by withConnection when the health monitor has
   * marked a pool unhealthy and the caller did not opt out via
   * `{ bypassBreaker: true }` — the circuit-breaker fail-fast path.
   *
   * ⚠ The literal `NJS-503` token MUST stay in this string: the shared
   * ErrorHandlerMiddleware `/NJS-\d+/` classifier reads it and routes to
   * NJS_MAP[503] → 503 DatabaseUnavailableError. Removing/altering the token
   * silently downgrades a breaker-open rejection to a generic 500.
   *
   * @param {string} name - Connection/pool name.
   * @returns {string}
   */
  POOL_CIRCUIT_OPEN: (name: string): string =>
    `Pool "${name}" circuit open (NJS-503): marked unhealthy after repeated ping failures — failing fast.`,
  POOL_RECOVERED: (name: unknown, failures: unknown) =>
    `Pool "${name}" RECOVERED after ${failures} consecutive failures.`,
  POOL_CREATE_FAILED_EVICTED: (name: unknown, ms: unknown) =>
    `Pool "${name}" creation failed — cached failure evicted after ${ms}ms; the next acquire will retry creation.`,
  POOL_CLOSED: (name: unknown) => `Pool "${name}" closed.`,
  POOL_CLOSED_DURING_CREATE: (name: unknown) => `Pool "${name}" was closed while it was being created; not retrying.`,
  POOL_CLOSE_ERROR: (name: unknown, err: unknown) => `Pool "${name}" close error: ${err}`,
  SHUTDOWN_ALREADY: "Shutdown already in progress.",
  CLOSING_ALL_POOLS: "Closing all Oracle pools…",
  ALL_POOLS_CLOSED: "All Oracle pools closed.",
  OP_FAILED: (name: unknown, ms: unknown, err: unknown) => `Op failed on "${name}" (${ms}ms): ${err}`,
  DB_OP_FAILED: (name: unknown, err: unknown) => `DB op failed [${name}]: ${err}`,
  CLOSE_FAILED: (name: unknown, err: unknown) => `Close failed for "${name}": ${err}`,
  SLOW_OP: (name: unknown, ms: unknown) => `Slow op on "${name}": ${ms}ms`,
  ACQUIRE_RETRY: (name: unknown, attempt: unknown, max: unknown, err: unknown) =>
    `Connection acquire failed on "${name}" (attempt ${attempt}/${max}), retrying: ${err}`,
  ACQUIRE_ORPHAN_CLOSED: (name: unknown) =>
    `Discarded a connection from "${name}" that arrived after its acquire had already failed.`,
  ROLLBACK_FAILED: (name: unknown, err: unknown) => `Rollback failed on "${name}": ${err}`,
  BATCH_OP_FAILED: (i: unknown, err: unknown) => `Batch op ${i} failed: ${err}`,
};

export { oracleMessages };
