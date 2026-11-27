/**
 * @fileoverview Messages for the createMira() config layer (src/config/defineConfig.ts,
 * src/config/fromEnv.ts, src/driver/createMira.ts).
 *
 * These are thrown. They name config keys and environment variable names,
 * never a value: a value may be a password.
 */

const miraConfigMessages = {
  INVALID_CONFIG: (issues: readonly string[]) =>
    `[mira] Invalid config:\n  - ${issues.join("\n  - ")}`,
  CONFIG_NOT_OBJECT: "config must be an object with a `pools` object",
  POOLS_EMPTY: "pools must name at least one pool",
  POOL_NAME_INVALID: (name: string) =>
    `pool name "${name.slice(0, 80)}" must be a letter followed by up to 63 letters, digits or _`,
  POOL_NOT_OBJECT: (name: string) => `pools.${name} must be an object`,
  POOL_UNKNOWN_KEY: (name: string, key: string) =>
    `pools.${name}.${key.slice(0, 80)} is not a pool option`,
  POOL_FIELD_REQUIRED: (name: string, key: string) =>
    `pools.${name}.${key} must be a non-empty string`,
  POOL_FIELD_INT: (name: string, key: string, min: number) =>
    min === -Infinity
      ? `pools.${name}.${key} must be an integer`
      : `pools.${name}.${key} must be an integer >= ${min}`,
  POOL_MIN_ABOVE_MAX: (name: string) => `pools.${name}.poolMin must not exceed poolMax`,
  DEFAULT_POOL_REQUIRED: "defaultPool is required when there is more than one pool",
  DEFAULT_POOL_UNKNOWN: (name: unknown) =>
    `defaultPool "${String(name).slice(0, 80)}" is not one of the pools`,

  DRIVER_NOT_OBJECT: "driver must be an object",
  DRIVER_UNKNOWN_KEY: (key: string) => `driver.${key.slice(0, 80)} is not a driver option`,
  DRIVER_MODE_INVALID: 'driver.mode must be "auto", "thin" or "thick"',
  DRIVER_LIBDIR_INVALID: "driver.libDir must be a non-empty string",
  LOGGER_INVALID: "logger must have info, warn and error functions (debug optional), or be false",

  DRIVER_ALREADY_INITIALISED: (was: string, asked: string) =>
    `[mira] The Oracle driver is already initialised as ${was}; it cannot change to ${asked} in this process. Set the driver before the first pool opens.`,
  LOGGER_CONFLICT:
    "[mira] Another logger is already set (by setLogger or a live createMira instance). Pass the same logger, or close that instance first.",

  ENV_PREFIX_INVALID: (prefix: unknown) =>
    `env prefix "${String(prefix).slice(0, 80)}" must be upper case letters, digits and _, starting with a letter`,
  ENV_REQUIRED: (name: string) => `${name} is not set`,
  ENV_CONNECT_REQUIRED: (prefix: string) =>
    `set ${prefix}_CONNECT_STRING, or ${prefix}_HOST and ${prefix}_SERVICE`,
  ENV_INT: (name: string) => `${name} must be a whole number`,

  MIRA_CLOSED: "[mira] This Mira instance is closed; create a new one with createMira().",
  MIRA_UNKNOWN_POOL: (name: unknown, names: readonly string[]) =>
    `[mira] Unknown pool "${String(name).slice(0, 80)}". This instance has: ${names.join(", ")}`,
  MIRA_POOL_ALREADY_OPEN: (name: string) =>
    `[mira] Pool "${name}" is already open in this process. Use another name, or close it first.`,
};

export { miraConfigMessages };
