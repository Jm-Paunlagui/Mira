/**
 * @fileoverview Validates a `createMira()` config and fills in its defaults.
 *
 * Every problem is collected and thrown together as one MiraConfigError, so a
 * bad config is fixed in one pass. Messages name keys, never values (a value
 * may be a password). Unknown pool keys are refused: a typo such as `poolmax`
 * would otherwise silently fall back to the default.
 */

import { miraConfigMessages as MSG } from "../constants/messages/miraConfig.messages";
import type { DriverOptions, MiraConfig, PoolConfig, ResolvedMiraConfig } from "./types";
import { isMiraLogger } from "./log";

/** A pool name: a letter, then up to 63 letters, digits or `_`. */
const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const STRING_FIELDS = ["user", "password", "connectString"] as const;

/** Integer fields and the smallest value each accepts (-Infinity: any integer). */
const INT_FIELDS = Object.freeze({
  poolMin: 0,
  poolMax: 1,
  poolIncrement: 1,
  queueMax: 0,
  queueTimeout: 0,
  poolTimeout: 0,
  connectTimeout: 1,
  poolPingInterval: -Infinity,
  stmtCacheSize: 0,
} satisfies Record<Exclude<keyof PoolConfig, (typeof STRING_FIELDS)[number]>, number>);

const KNOWN_KEYS = new Set<string>([...STRING_FIELDS, ...Object.keys(INT_FIELDS)]);

/** Thrown by defineConfig / fromEnv / createMira for a config that cannot work. */
class MiraConfigError extends Error {
  /** One line per problem found. */
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(MSG.INVALID_CONFIG(issues));
    this.name = "MiraConfigError";
    this.issues = Object.freeze([...issues]);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkPool(name: string, pool: unknown, issues: string[]): void {
  if (!isPlainObject(pool)) {
    issues.push(MSG.POOL_NOT_OBJECT(name));
    return;
  }
  for (const key of Object.keys(pool)) {
    if (!KNOWN_KEYS.has(key)) issues.push(MSG.POOL_UNKNOWN_KEY(name, key));
  }
  for (const key of STRING_FIELDS) {
    const v = pool[key];
    if (typeof v !== "string" || v.trim() === "") issues.push(MSG.POOL_FIELD_REQUIRED(name, key));
  }
  for (const [key, min] of Object.entries(INT_FIELDS)) {
    const v = pool[key];
    if (v === undefined) continue;
    if (!Number.isSafeInteger(v) || (v as number) < min) issues.push(MSG.POOL_FIELD_INT(name, key, min));
  }
  const { poolMin, poolMax } = pool;
  if (Number.isSafeInteger(poolMin) && Number.isSafeInteger(poolMax) && (poolMin as number) > (poolMax as number)) {
    issues.push(MSG.POOL_MIN_ABOVE_MAX(name));
  }
}

const DRIVER_MODES = new Set(["auto", "thin", "thick"]);

/** Pushes one issue per problem with a `driver` option object. */
function checkDriver(driver: unknown, issues: string[]): void {
  if (!isPlainObject(driver)) {
    issues.push(MSG.DRIVER_NOT_OBJECT);
    return;
  }
  for (const key of Object.keys(driver)) {
    if (key !== "mode" && key !== "libDir") issues.push(MSG.DRIVER_UNKNOWN_KEY(key));
  }
  if (driver.mode !== undefined && !DRIVER_MODES.has(driver.mode as string)) issues.push(MSG.DRIVER_MODE_INVALID);
  if (driver.libDir !== undefined && (typeof driver.libDir !== "string" || driver.libDir.trim() === "")) {
    issues.push(MSG.DRIVER_LIBDIR_INVALID);
  }
}

/**
 * Validates `config` and returns a frozen copy with `defaultPool` filled in.
 * With one pool, that pool is the default; with more, `defaultPool` is required.
 *
 * @throws {MiraConfigError} listing every problem found.
 * @example
 *   const config = defineConfig({
 *     pools: { appDb: { user: "APP", password: secret, connectString: "db:1521/APP" } },
 *   });
 */
function defineConfig<P extends string>(config: MiraConfig<P>): ResolvedMiraConfig<P> {
  const issues: string[] = [];
  const pools: unknown = isPlainObject(config) ? config.pools : undefined;
  if (!isPlainObject(pools)) throw new MiraConfigError([MSG.CONFIG_NOT_OBJECT]);

  const names = Object.keys(pools) as P[];
  if (names.length === 0) issues.push(MSG.POOLS_EMPTY);
  for (const name of names) {
    if (!POOL_NAME_RE.test(name)) issues.push(MSG.POOL_NAME_INVALID(name));
    else checkPool(name, pools[name], issues);
  }

  let defaultPool = config.defaultPool as P | undefined;
  if (defaultPool === undefined) {
    if (names.length > 1) issues.push(MSG.DEFAULT_POOL_REQUIRED);
    else defaultPool = names[0];
  } else if (!names.includes(defaultPool)) {
    issues.push(MSG.DEFAULT_POOL_UNKNOWN(defaultPool));
  }

  if (config.driver !== undefined) checkDriver(config.driver, issues);
  if (config.logger !== undefined && !isMiraLogger(config.logger)) issues.push(MSG.LOGGER_INVALID);

  if (issues.length) throw new MiraConfigError(issues);

  const frozen = {} as Record<P, Readonly<PoolConfig>>;
  for (const name of names) frozen[name] = Object.freeze({ ...(pools[name] as PoolConfig) });
  return Object.freeze({
    pools: Object.freeze(frozen),
    defaultPool: defaultPool as P,
    poolNames: Object.freeze([...names]),
    ...(config.driver !== undefined && { driver: Object.freeze({ ...config.driver }) as Readonly<DriverOptions> }),
    ...(config.logger !== undefined && { logger: config.logger }),
  });
}

export { defineConfig, checkDriver, MiraConfigError, POOL_NAME_RE };
