

/**
 * @fileoverview Oracle pool / driver messages.
 * Mostly logger text. The ones Mira also THROWS (a bound that fired, an open
 * breaker) end with " [MIRA_CODE]" (see src/driver/errors.ts), so the code
 * survives anything that rebuilds an error from its message.
 */

const oracleMessages = {
  SESSION_TZ_IGNORED:
    "ORA_SDTZ is not an offset (+08:00), a region (Asia/Manila), LOCAL or DBTIMEZONE; Mira leaves the session time zone at the client's default.",
  POOL_READY: (name: unknown, pool: { poolMin: number; poolMax: number }) =>
    `Pool "${name}" ready (min=${pool.poolMin}, max=${pool.poolMax}).`,
  /**
   * Thick mode runs each database call on one of the runtime's native worker threads, shared by
   * every pool. Node sizes them by UV_THREADPOOL_SIZE (default 4). Bun honours the same variable
   * (measured: a value of 2 or more is used; 1 is ignored) and, unset, uses one thread per CPU core.
   */
  THREAD_BUDGET: (runtime: "node" | "bun", needed: number, threads: number, fromEnv: boolean) =>
    `The registered pools can need ${needed} worker threads at once (every pool's poolMax, plus 3 per pool for its health check and pool creation, plus 2), but Thick mode on ${runtime === "bun" ? "Bun" : "Node"} runs every database call on one of ${threads} (${fromEnv ? "UV_THREADPOOL_SIZE" : runtime === "bun" ? "UV_THREADPOOL_SIZE not set; Bun uses one thread per CPU core" : "UV_THREADPOOL_SIZE not set; Node's default is 4"}). Calls that wait on a row lock or on a link that stopped answering keep their thread: with fewer threads than that, every pool's calls queue behind them and the process can hang with no error. Set UV_THREADPOOL_SIZE=${needed} or more before the process starts, or use Thin mode.`,
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
    `Pool "${name}" circuit open (NJS-503): marked unhealthy after repeated ping failures — failing fast. [MIRA_CIRCUIT_OPEN]`,
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
  POOL_OPEN_TIMED_OUT: (name: unknown, ms: unknown) =>
    `Timed out opening pool "${name}" after ${ms} ms (the database did not answer). [MIRA_POOL_OPEN_TIMEOUT]`,
  HEALTH_CHECK_TIMED_OUT: (name: unknown, ms: unknown) =>
    `Timed out checking pool "${name}" after ${ms} ms (the database did not answer). [MIRA_CHECK_TIMEOUT]`,
  CALL_TIMED_OUT: (name: unknown, ms: unknown) =>
    `A call on "${name}" did not finish within ${ms} ms (the database stopped answering); the connection was dropped. [MIRA_CALL_TIMEOUT]`,
  CALL_OUTCOME_UNKNOWN: (name: unknown, ms: unknown) =>
    `A call on "${name}" did not finish within ${ms} ms (the database stopped answering) while it could have committed; the connection was dropped and the outcome is unknown: check before repeating it. [MIRA_OUTCOME_UNKNOWN]`,
  CONNECTION_DEAD: (name: unknown) =>
    `The connection from "${name}" was dropped after an earlier call on it timed out; this call was not sent. [MIRA_CONNECTION_DEAD]`,
  RELEASE_TIMED_OUT: (name: unknown, ms: unknown) =>
    `Returning a connection to "${name}" did not finish within ${ms} ms (the database stopped answering); it is abandoned and keeps closing in the background. [MIRA_CLOSE_TIMEOUT]`,
  BREAKER_HALF_OPEN: (name: unknown) =>
    `Pool "${name}" answered a health check: letting a few calls through to test it (half-open).`,
  HEALTH_CHECK_SATURATED: (name: unknown) =>
    `Health check of pool "${name}" found it busy, not down (every connection is in use and the pool is still serving): not counted as a failure.`,
  /**
   * Thrown when Mira's own acquire bound (queueTimeout + connectTimeout) fires:
   * the driver should have answered with NJS-040 by then, so it is stuck.
   * The prefix `Timed out getting connection from "<name>"` is matched by logs
   * and tests; keep it.
   */
  ACQUIRE_TIMED_OUT: (name: unknown, ms: unknown) =>
    `Timed out getting connection from "${name}" after ${ms} ms (the driver did not answer). [MIRA_ACQUIRE_TIMEOUT]`,
  /** A caller gave up waiting for a pool that is still opening (the creation keeps going). */
  POOL_STILL_OPENING: (name: unknown, ms: unknown) =>
    `Pool "${name}" is still opening after ${ms} ms (the database did not answer); the attempt continues in the background. [MIRA_POOL_OPENING]`,
  POOL_CREATE_DEFERRED: (name: unknown, n: unknown) =>
    `Not opening pool "${name}" again yet: ${n} earlier attempts are still unfinished in the background. [MIRA_CREATE_DEFERRED]`,
  POOL_REPLACED: (name: unknown, reason: unknown, zombies: unknown) =>
    `Pool "${name}" replaced (${reason}): ${zombies} connection(s) are stuck on a link that stopped answering; the old pool is closing in the background and the next call opens a new one.`,
  POOL_RECONFIGURE_FAILED: (name: unknown, err: unknown) =>
    `Pool "${name}" came up, but restoring its poolMin failed: ${err}`,
  POOL_CLOSE_TIMED_OUT: (name: unknown, ms: unknown) =>
    `Pool "${name}" did not close within ${ms} ms (the database did not answer); it is abandoned and keeps closing in the background. [MIRA_CLOSE_TIMEOUT]`,
  ACQUIRE_ORPHAN_CLOSED: (name: unknown) =>
    `Discarded a connection from "${name}" that arrived after its acquire had already failed.`,
  ROLLBACK_FAILED: (name: unknown, err: unknown) => `Rollback failed on "${name}": ${err}`,
  BATCH_OP_FAILED: (i: unknown, err: unknown) => `Batch op ${i} failed: ${err}`,
};

export { oracleMessages };
