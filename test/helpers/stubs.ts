/**
 * Test doubles for deterministic error-path coverage.
 *
 * Every wrapper class takes its db handle (and OracleCollection / QueryBuilder an
 * optional session connection) by injection, so a stub connection can make any
 * statement fail on cue — no need to break the real database to reach a catch.
 */
import { EventEmitter } from "node:events";
import { oracledb } from "../../src/config/adapters/oracle";

export type ExecCall = { sql: string; binds: unknown; opts: unknown };
type Handler = (sql: string, binds: unknown) => unknown;

/** An Error shaped like a node-oracledb failure. */
export function oraError(code: number, msg = "stub failure") {
  return Object.assign(new Error(`ORA-${String(code).padStart(5, "0")}: ${msg}`), { errorNum: code });
}

/**
 * A fake DbConnection. `handler` decides each execute(): return a result object
 * or throw. Default: throw ORA-00942 for everything.
 */
export function stubConn(handler: Handler = () => { throw oraError(942, "table or view does not exist"); }) {
  const calls: ExecCall[] = [];
  const conn = {
    calls,
    async execute(sql: string, binds: unknown = {}, opts: unknown = {}) {
      calls.push({ sql, binds, opts });
      return handler(sql, binds);
    },
    async executeMany(sql: string, binds: unknown, opts: unknown = {}) {
      calls.push({ sql, binds, opts });
      return handler(sql, binds);
    },
    queryStream(sql: string, binds: unknown) {
      calls.push({ sql, binds, opts: {} });
      const em = Object.assign(new EventEmitter(), { pause() {}, resume() {}, destroy() {} });
      setTimeout(() => {
        try {
          const r = handler(sql, binds) as { rows?: unknown[] } | undefined;
          for (const row of r?.rows ?? []) em.emit("data", row);
          em.emit("end");
        } catch (e) {
          em.emit("error", e);
        }
      }, 0);
      return em;
    },
    async commit() {},
    async rollback() {},
    async close() {},
  };
  return conn;
}

/** A fake db handle (same shape createDb returns) running every callback on `conn`. */
export function stubDb(conn = stubConn()) {
  return {
    connectionName: "stub",
    conn,
    withConnection: async <T>(cb: (c: never) => T | Promise<T>) => cb(conn as never),
    withTransaction: async <T>(cb: (c: never) => T | Promise<T>) => cb(conn as never),
    withBatchConnection: async () => [],
    closePool: async () => {},
    getPoolStats: async () => ({}),
    isHealthy: () => true,
    oracledb,
  };
}
