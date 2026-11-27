/**
 * @fileoverview Builds a `createMira()` config from environment variables. Opt-in:
 * nothing in Mira calls it unless the app does.
 *
 * Each pool reads the variables under its own prefix (default: one pool
 * `appDb` under `MIRA_DB`):
 *
 *   <P>_USER, <P>_PASSWORD                    required
 *   <P>_CONNECT_STRING                        or <P>_HOST + <P>_SERVICE (+ <P>_PORT, default 1521)
 *   <P>_POOL_MIN, <P>_POOL_MAX, <P>_POOL_INCREMENT, <P>_QUEUE_MAX,
 *   <P>_QUEUE_TIMEOUT (ms), <P>_POOL_TIMEOUT (s), <P>_CONNECT_TIMEOUT (ms),
 *   <P>_POOL_PING_INTERVAL (s), <P>_STMT_CACHE_SIZE  optional whole numbers
 *
 * Process-wide, read when set: MIRA_DRIVER_MODE (auto | thin | thick) and
 * MIRA_DRIVER_LIB_DIR (Instant Client directory).
 *
 * A blank variable counts as unset. A number that does not parse is an error,
 * not a silent default. The 2.x variables (APP_DB_USERNAME, DB_HOST …) are not
 * read here; they still drive createDb("appDb").
 */

import { miraConfigMessages as MSG } from "../constants/messages/miraConfig.messages";
import { defineConfig, MiraConfigError } from "./defineConfig";
import type { DriverMode, PoolConfig, ResolvedMiraConfig } from "./types";

interface FromEnvOptions<P extends string> {
  /** Pool name → variable prefix. Default `{ appDb: "MIRA_DB" }`. */
  pools?: Record<P, string>;
  /** Default pool; required with more than one pool. */
  defaultPool?: NoInfer<P>;
  /** Where to read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
}

const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;

const INT_VARS = Object.freeze({
  POOL_MIN: "poolMin",
  POOL_MAX: "poolMax",
  POOL_INCREMENT: "poolIncrement",
  QUEUE_MAX: "queueMax",
  QUEUE_TIMEOUT: "queueTimeout",
  POOL_TIMEOUT: "poolTimeout",
  CONNECT_TIMEOUT: "connectTimeout",
  POOL_PING_INTERVAL: "poolPingInterval",
  STMT_CACHE_SIZE: "stmtCacheSize",
} satisfies Record<string, keyof PoolConfig>);

function readPool(prefix: string, env: Record<string, string | undefined>, issues: string[]): PoolConfig {
  const get = (suffix: string) => {
    const v = env[`${prefix}_${suffix}`]?.trim();
    return v ? v : undefined;
  };
  const user = get("USER");
  const password = get("PASSWORD");
  if (!user) issues.push(MSG.ENV_REQUIRED(`${prefix}_USER`));
  if (!password) issues.push(MSG.ENV_REQUIRED(`${prefix}_PASSWORD`));

  let connectString = get("CONNECT_STRING");
  if (!connectString) {
    const host = get("HOST");
    const service = get("SERVICE");
    if (host && service) connectString = `${host}:${get("PORT") ?? "1521"}/${service}`;
    else issues.push(MSG.ENV_CONNECT_REQUIRED(prefix));
  }

  const pool = { user, password, connectString } as PoolConfig;
  for (const [suffix, key] of Object.entries(INT_VARS)) {
    const raw = get(suffix);
    if (raw === undefined) continue;
    if (/^-?\d+$/.test(raw)) pool[key] = Number(raw);
    else issues.push(MSG.ENV_INT(`${prefix}_${suffix}`));
  }
  return pool;
}

/**
 * Reads pool configs from environment variables and validates them.
 *
 * @throws {MiraConfigError} naming every missing or malformed variable.
 * @example
 *   const mira = createMira(fromEnv());                       // MIRA_DB_* → appDb
 *   const mira = createMira(fromEnv({
 *     pools: { appDb: "MIRA_DB", reporting: "MIRA_RPT" },
 *     defaultPool: "appDb",
 *   }));
 */
function fromEnv<P extends string = "appDb">(options: FromEnvOptions<P> = {}): ResolvedMiraConfig<P> {
  const env = options.env ?? process.env;
  const prefixes = options.pools ?? ({ appDb: "MIRA_DB" } as Record<P, string>);
  const issues: string[] = [];
  const pools = {} as Record<P, PoolConfig>;
  for (const [name, prefix] of Object.entries(prefixes) as [P, string][]) {
    if (!PREFIX_RE.test(prefix)) issues.push(MSG.ENV_PREFIX_INVALID(prefix));
    else pools[name] = readPool(prefix, env, issues);
  }
  if (issues.length) throw new MiraConfigError(issues);
  const mode = env.MIRA_DRIVER_MODE?.trim();
  const libDir = env.MIRA_DRIVER_LIB_DIR?.trim();
  const driver = mode || libDir ? { ...(mode && { mode: mode as DriverMode }), ...(libDir && { libDir }) } : undefined;
  return defineConfig({ pools, defaultPool: options.defaultPool, ...(driver && { driver }) });
}

export { fromEnv };
export type { FromEnvOptions };
