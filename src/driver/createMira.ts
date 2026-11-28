/**
 * ============================================================================
 * createMira.ts — Config-object entry point (the 3.0 API, available from 2.2)
 * ============================================================================
 *
 * The app passes its pools in; Mira reads no environment variable for them.
 *
 *   const mira = createMira({
 *     pools: {
 *       appDb:     { user, password, connectString: "db:1521/APP", poolMax: 20 },
 *       reporting: { user: rptUser, password: rptPw, connectString: "rpt:1521/RPT" },
 *     },
 *     defaultPool: "appDb",
 *   });
 *   const users = mira.collection("USERS");              // appDb
 *   const sales = mira.collection("SALES", "reporting"); // pool name type-checked
 *   await mira.close();                                  // closes these two pools only
 *
 * `driver` (Thin / Thick) and `logger` are process-wide: the Oracle Client
 * loads once per process, and the adapter has one log sink. A driver setting
 * that differs from one already in force, or a second, different logger while
 * another instance's is set, is refused rather than silently overridden.
 *
 * Each pool is added to the process-wide registry under its name, so everything
 * that takes a db handle (OracleCollection, OracleSchema, Transaction, models)
 * works with mira.db(). Two live instances cannot use the same pool name.
 * ============================================================================
 */

import * as config from "./oracle";
import database from "./registry";
import { defineConfig } from "../config/defineConfig";
import { getLogger, setLogger } from "../shared/log";
import type { MiraConfig, ResolvedMiraConfig } from "../config/types";
import { miraConfigMessages as MSG } from "../shared/messages/miraConfig.messages";
import { createDb, type DbConnection, type MiraDb } from "./db";
import { OracleCollection, forgetSuppliedIds } from "../core/OracleCollection";
import { OracleSchema } from "../schema/OracleSchema";
import { OracleDCL } from "../schema/OracleDCL";
import { Transaction } from "../core/Transaction";

/** What createMira() returns. `P` is the union of the configured pool names. */
interface Mira<P extends string = string> {
  /** The validated, frozen config. */
  readonly config: ResolvedMiraConfig<P>;
  /** Db handle for a pool (default: config.defaultPool). Its closePool() closes this instance; after close() it refuses work. */
  db(pool?: P): MiraDb;
  /** A table on a pool. */
  collection(table: string, pool?: P): OracleCollection;
  /** DDL helper on a pool. */
  schema(pool?: P): OracleSchema;
  /** GRANT / REVOKE helper on a pool. */
  dcl(pool?: P): OracleDCL;
  /** Transaction manager on a pool. */
  transaction(pool?: P): Transaction;
  /** Opens this instance's pools now (they open lazily otherwise). A pool that fails is reported (success: false, error), not thrown. */
  open(): Promise<Array<{ name: P; success: boolean; error?: string }>>;
  /**
   * Usage of this instance's pools (open / in use / queued …, plus `abandonedCalls`,
   * `abandonedPools` and `zombieConnections`: native work Mira gave up waiting for and
   * that is still running; `replacements`: how often the pool was replaced because its
   * connections were stuck on a link that stopped answering)
   * and their health records. A pool that is still opening is `{ opening: true }` (stats()
   * never waits for it); one whose opening failed is `{ error }`. In Thick mode, while a pool
   * operation is in flight, `connectionsOpen` is the last value read safely and `countsApproximate` is true. `abandoned` is process-wide:
   * the same counters summed over every pool name, closed pools included.
   */
  stats(): Promise<{ timestamp: string; pools: Record<string, unknown>; healthMetrics: Record<string, unknown>; abandoned: MiraAbandoned }>;
  /** The circuit breaker and health monitor, for this instance's pools. */
  readonly health: MiraHealth<P>;
  /**
   * Closes this instance's pools (in parallel) and removes them from the registry. Idempotent.
   * A pool that does not close within 10 s + 2 x connectTimeout (a database that stopped
   * answering) is abandoned: close() returns, the pool keeps closing in the background, and
   * `stats().abandoned.pools` counts it until it ends.
   */
  close(): Promise<void>;
  /** True after close(). */
  readonly closed: boolean;
}

/** Native work Mira stopped waiting for and that is still running (see Mira.stats). `zombies`: connections dropped or released while a call on them was still hung. */
type MiraAbandoned = { calls: number; pools: number; zombies: number };

/**
 * Health of a Mira instance's pools. The monitor pings each open pool (every 30 s,
 * every 5 s while one is failing or while watched); three failed checks open a
 * pool's circuit breaker, so withConnection fails fast with NJS-503. After an outage the
 * first passing check half-opens it: 3 calls at a time are let through, and 3 successes
 * (or the next passing check, or a probe) close it; a connectivity failure opens it again.
 * A check that fails only because the pool is busy (every connection in use, calls still
 * finishing) is not a failure: it is reported as `saturated`.
 */
interface MiraHealth<P extends string = string> {
  /** This pool's breaker is closed (default: config.defaultPool). False after close(). */
  isHealthy(pool?: P): boolean;
  /** Every pool of this instance is healthy. */
  allHealthy(): boolean;
  /**
   * Health records of this instance's checked pools: `healthy` (breaker closed), `state`
   * ("closed" | "open" | "half-open"), `lastCheck`, `consecutiveFailures`, and `saturated`
   * (the last check found the pool busy, not down).
   */
  metrics(): Record<string, unknown>;
  /** Called when one of this instance's pools turns healthy or unhealthy. Returns an unsubscribe function. */
  onChange(listener: (change: { name: P; healthy: boolean }) => void): () => void;
  /** Called after every check of one of this instance's pools. Returns an unsubscribe function. */
  onCheck(listener: (check: { name: P; ok: boolean; saturated?: boolean }) => void): () => void;
  /** Process-wide: check every 5 s instead of 30 s (e.g. while a readiness stream has listeners). */
  watch(on: boolean): void;
  /** Your own probe reached the pool: close its breaker now instead of at the next check. */
  recordProbeSuccess(pool?: P): void;
  /** Check this pool soon, outside the regular cadence (debounced). */
  nudge(pool?: P): void;
}

/**
 * Validates `input`, registers its pools, and returns the Mira API bound to them.
 * Pools open lazily on first use.
 *
 * @throws {MiraConfigError} for an invalid config.
 * @throws {Error} when a pool name is already open or held by another live instance.
 */
function createMira<P extends string>(input: MiraConfig<P> | ResolvedMiraConfig<P>): Mira<P> {
  const resolved = defineConfig(input as MiraConfig<P>);
  const names = resolved.poolNames;

  for (const name of names) {
    if (config.isPoolOpen(name)) throw new Error(MSG.MIRA_POOL_ALREADY_OPEN(name));
  }
  const { logger } = resolved;
  const priorLogger = getLogger();
  if (logger !== undefined && priorLogger !== null && priorLogger !== logger) throw new Error(MSG.LOGGER_CONFLICT);
  const done: string[] = [];
  try {
    for (const name of names) {
      database.registerConnection(name, resolved.pools[name]);
      done.push(name);
    }
    if (resolved.driver) config.configureDriver(resolved.driver);
  } catch (err) {
    for (const name of done) database.unregisterConnection(name);
    throw err;
  }
  // Set after the pools register, so a refused config leaves the logger as it was.
  const ownsLogger = logger !== undefined && priorLogger === null;
  if (ownsLogger) setLogger(logger);

  let closed = false;
  const handles = new Map<string, MiraDb>();
  const unsubscribes = new Set<() => void>();
  let watching = false;
  const pick = (pool: P | undefined): P => {
    const name = pool ?? resolved.defaultPool;
    if (!names.includes(name)) throw new Error(MSG.MIRA_UNKNOWN_POOL(name, names));
    return name;
  };
  const only = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([k]) => names.includes(k as P)));
  const subscribe = <E extends { name: string }>(on: (fn: (e: E) => void) => () => void, listener: (e: E & { name: P }) => void) => {
    const off = on((e) => {
      if (names.includes(e.name as P)) listener(e as E & { name: P });
    });
    const unsubscribe = () => {
      off();
      unsubscribes.delete(unsubscribe);
    };
    unsubscribes.add(unsubscribe);
    return unsubscribe;
  };
  const health: MiraHealth<P> = {
    isHealthy: (pool) => !closed && config.isPoolHealthy(pick(pool)),
    allHealthy: () => names.every((n) => !closed && config.isPoolHealthy(n)),
    metrics: () => only(config.getHealthMetrics()),
    onChange: (listener) => subscribe(config.onPoolHealthChange, listener),
    onCheck: (listener) => subscribe(config.onPoolHealthCheck, listener),
    watch: (on) => {
      watching = Boolean(on);
      config.setPoolHealthWatched(watching);
    },
    recordProbeSuccess: (pool) => config.recordProbeSuccess(pick(pool)),
    nudge: (pool) => config.nudgePoolHealth(pick(pool)),
  };

  const closeAndUnregister = async (name: P) => {
    await config.closePool(name);
    database.unregisterConnection(name);
    forgetSuppliedIds(name); // a later pool of this name may reach another database or user
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const off of [...unsubscribes]) off();
    if (watching) health.watch(false);
    // In parallel: each pool is bounded on its own, so one that will not close does not hold the others up.
    await Promise.allSettled(names.map(closeAndUnregister));
    handles.clear();
    if (ownsLogger && getLogger() === logger) setLogger(null);
  };

  const db = (pool: P = resolved.defaultPool): MiraDb => {
    if (closed) throw new Error(MSG.MIRA_CLOSED);
    if (!names.includes(pool)) throw new Error(MSG.MIRA_UNKNOWN_POOL(pool, names));
    let handle = handles.get(pool);
    if (!handle) {
      const base = createDb(pool);
      // A handle kept after close() reports unhealthy and refuses work with MIRA_CLOSED,
      // instead of reaching a pool name that is no longer registered.
      const live = <T>(run: () => Promise<T>): Promise<T> => (closed ? Promise.reject(new Error(MSG.MIRA_CLOSED)) : run());
      handle = {
        ...base,
        withConnection: <T>(cb: (conn: DbConnection) => T | Promise<T>) => live(() => base.withConnection(cb)),
        withTransaction: <T>(cb: (conn: DbConnection) => T | Promise<T>) => live(() => base.withTransaction(cb)),
        withBatchConnection: (ops: ((...args: unknown[]) => unknown)[]) => live(() => base.withBatchConnection(ops)),
        isHealthy: () => !closed && base.isHealthy(),
        // The bare handle's closePool() would close every pool in the process; here it closes this instance.
        closePool: close,
      };
      handles.set(pool, handle);
    }
    return handle;
  };

  return {
    config: resolved,
    db,
    collection: (table, pool) => new OracleCollection(table, db(pool)),
    schema: (pool) => new OracleSchema(db(pool)),
    dcl: (pool) => new OracleDCL(db(pool)),
    transaction: (pool) => new Transaction(db(pool)),
    open: async () => {
      if (closed) throw new Error(MSG.MIRA_CLOSED);
      return (await config.initializePools([...names])) as Array<{ name: P; success: boolean; error?: string }>;
    },
    stats: async () => {
      const all = await config.getPoolStats();
      return { timestamp: all.timestamp, pools: only(all.pools), healthMetrics: only(all.healthMetrics), abandoned: all.abandoned };
    },
    health,
    close,
    get closed() {
      return closed;
    },
  };
}

export { createMira };
export type { Mira, MiraHealth, MiraAbandoned };
