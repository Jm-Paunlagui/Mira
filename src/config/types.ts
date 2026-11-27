/**
 * @fileoverview Config types for `createMira()` (3.0 config API, shipped early in 2.2).
 *
 * A pool is described by plain values the app passes in. Mira reads no
 * environment variable for these pools; `fromEnv()` is the opt-in reader.
 *
 * Units follow the 2.x registry in database.ts: `queueTimeout` and
 * `connectTimeout` are MILLISECONDS, `poolTimeout` and `poolPingInterval` are
 * SECONDS (the adapter converts `connectTimeout` to seconds for the driver).
 */

/** One connection pool. Fields left out fall back to the adapter's POOL_DEFAULTS. */
interface PoolConfig {
  /** Oracle username. */
  user: string;
  /** Oracle password. */
  password: string;
  /** Easy Connect (`host:1521/service`), a TNS descriptor, or a tnsnames alias. */
  connectString: string;
  /** Connections kept open. Default 10. */
  poolMin?: number;
  /** Most connections the pool opens. Default 50. */
  poolMax?: number;
  /** Connections opened at a time when the pool grows. Default 5. */
  poolIncrement?: number;
  /** Most callers waiting for a connection; one more fails with NJS-076. 0 disables queuing. Default 40. */
  queueMax?: number;
  /** Milliseconds a caller waits in the queue. 0 waits forever. Default 15000. */
  queueTimeout?: number;
  /** Seconds an idle connection above poolMin stays open. 0 keeps it. Default 30. */
  poolTimeout?: number;
  /** Milliseconds to open one connection (Thin mode). Default 15000. */
  connectTimeout?: number;
  /** Seconds of idleness before a connection is pinged on checkout; negative never pings. Default 30. */
  poolPingInterval?: number;
  /** Statements cached per connection. Default 50. */
  stmtCacheSize?: number;
}

/** What `createMira()` / `defineConfig()` accept. `P` is the union of pool names. */
interface MiraConfig<P extends string = string> {
  /** Pools by name. A name is a letter followed by up to 63 letters, digits or `_`. */
  pools: Record<P, PoolConfig>;
  /** Pool used when a call names none. Required when there is more than one pool. */
  defaultPool?: NoInfer<P>;
}

/** A validated config: frozen, with `defaultPool` filled in. */
interface ResolvedMiraConfig<P extends string = string> {
  readonly pools: Readonly<Record<P, Readonly<PoolConfig>>>;
  readonly defaultPool: P;
  readonly poolNames: readonly P[];
}

export type { PoolConfig, MiraConfig, ResolvedMiraConfig };
