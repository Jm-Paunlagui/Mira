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

/**
 * How node-oracledb runs. Process-wide: the first pool fixes it.
 * - `"auto"` (default): try Thick mode from `libDir` or
 *   the system library path; fall back to Thin.
 * - `"thin"`: never load an Oracle Client.
 * - `"thick"`: load the Oracle Client or fail.
 */
type DriverMode = "auto" | "thin" | "thick";

interface DriverOptions {
  mode?: DriverMode;
  /** Oracle Instant Client directory for Thick mode. Default: the system library path. */
  libDir?: string;
  /**
   * Where node-oracledb's Thick binary (oracledb/build/Release) is, when it is not
   * beside the installed package — e.g. staged next to a `bun build --compile`
   * executable, whose baked-in paths point at the build machine.
   */
  binaryDir?: string;
}

/**
 * Where Mira's log lines go. Any object with these methods works (console,
 * pino, winston). Mira's pool-lifecycle "info" lines go to `debug`, which
 * may be left out.
 */
interface MiraLogger {
  debug?(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** What `createMira()` / `defineConfig()` accept. `P` is the union of pool names. */
interface MiraConfig<P extends string = string> {
  /** Pools by name. A name is a letter followed by up to 63 letters, digits or `_`. */
  pools: Record<P, PoolConfig>;
  /** Pool used when a call names none. Required when there is more than one pool. */
  defaultPool?: NoInfer<P>;
  /** Thin / Thick mode. Left out: whatever configureDriver() set, else "auto". */
  driver?: DriverOptions;
  /** Log sink; `false` silences Mira. Left out: the console, warnings and errors only. */
  logger?: MiraLogger | false;
}

/** A validated config: frozen, with `defaultPool` filled in. */
interface ResolvedMiraConfig<P extends string = string> {
  readonly pools: Readonly<Record<P, Readonly<PoolConfig>>>;
  readonly defaultPool: P;
  readonly poolNames: readonly P[];
  readonly driver?: Readonly<DriverOptions>;
  readonly logger?: MiraLogger | false;
}

export type { PoolConfig, MiraConfig, ResolvedMiraConfig, DriverMode, DriverOptions, MiraLogger };
