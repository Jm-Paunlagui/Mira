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
 * Each pool is added to the same registry createDb() uses, so everything that
 * takes a db handle (OracleCollection, OracleSchema, Transaction, models)
 * works with mira.db(). A name that is a 2.x built-in (appDb, appDbBulk)
 * replaces the env-driven entry until close(), as long as that pool has not
 * been opened yet in this process.
 * ============================================================================
 */

import config from "../config";
import database from "./registry";
import { defineConfig } from "../config/defineConfig";
import { getLogger, setLogger } from "../shared/log";
import type { MiraConfig, ResolvedMiraConfig } from "../config/types";
import { miraConfigMessages as MSG } from "../shared/messages/miraConfig.messages";
import { createDb, type WrapperDb } from "./db";
import { OracleCollection } from "../core/OracleCollection";
import { OracleSchema } from "../schema/OracleSchema";
import { OracleDCL } from "../schema/OracleDCL";
import { Transaction } from "../core/Transaction";

/** What createMira() returns. `P` is the union of the configured pool names. */
interface Mira<P extends string = string> {
  /** The validated, frozen config. */
  readonly config: ResolvedMiraConfig<P>;
  /** Db handle for a pool (default: config.defaultPool). Its closePool() closes this instance. */
  db(pool?: P): WrapperDb;
  /** A table on a pool. */
  collection(table: string, pool?: P): OracleCollection;
  /** DDL helper on a pool. */
  schema(pool?: P): OracleSchema;
  /** GRANT / REVOKE helper on a pool. */
  dcl(pool?: P): OracleDCL;
  /** Transaction manager on a pool. */
  transaction(pool?: P): Transaction;
  /** Closes this instance's pools and removes them from the registry. Idempotent. */
  close(): Promise<void>;
  /** True after close(). */
  readonly closed: boolean;
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
  const handles = new Map<string, WrapperDb>();

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const name of names) {
      await config.closePool(name);
      database.unregisterConnection(name);
    }
    handles.clear();
    if (ownsLogger && getLogger() === logger) setLogger(null);
  };

  const db = (pool: P = resolved.defaultPool): WrapperDb => {
    if (closed) throw new Error(MSG.MIRA_CLOSED);
    if (!names.includes(pool)) throw new Error(MSG.MIRA_UNKNOWN_POOL(pool, names));
    let handle = handles.get(pool);
    if (!handle) {
      // createDb's closePool() would close every pool in the process; here it closes this instance.
      handle = { ...createDb(pool), closePool: close };
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
    close,
    get closed() {
      return closed;
    },
  };
}

export { createMira };
export type { Mira };
