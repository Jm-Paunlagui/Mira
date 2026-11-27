/**
 * @fileoverview Where the adapter's log lines go.
 *
 * Default: Mira's own logger (src/utils/logger.ts), loaded on the first log
 * line rather than at import, so an app that sets its own logger first never
 * loads it and gets no ./logs folder. setLogger() swaps in any object with
 * info / warn / error (and optionally debug), or `false` for silence.
 *
 * `log()` returns the sink itself; callers write `log().warning(msg)`. For
 * the default logger that is the logger object, so its call-site capture
 * (which skips logger.ts frames only) still names the adapter function.
 */

import type { MiraLogger } from "../config/types";

/** The four levels the adapter writes. */
type AdapterLog = {
  info(...args: unknown[]): void;
  notice(...args: unknown[]): void;
  warning(...args: unknown[]): void;
  critical(...args: unknown[]): void;
};

const noop = () => {};
const SILENT: AdapterLog = Object.freeze({ info: noop, notice: noop, warning: noop, critical: noop });

let current: MiraLogger | false | null = null;
let sink: AdapterLog | null = null;

/** Adapter level → app logger method: info → debug, notice → info, warning → warn, critical → error. */
function mapLogger(l: MiraLogger): AdapterLog {
  return {
    info: (...a: unknown[]) => l.debug?.(...(a as [string, ...unknown[]])),
    notice: (...a: unknown[]) => l.info(...(a as [string, ...unknown[]])),
    warning: (...a: unknown[]) => l.warn(...(a as [string, ...unknown[]])),
    critical: (...a: unknown[]) => l.error(...(a as [string, ...unknown[]])),
  };
}

/** True for `false` or an object with info / warn / error functions and an optional debug function. */
function isMiraLogger(l: unknown): l is MiraLogger | false {
  if (l === false) return true;
  if (typeof l !== "object" || l === null) return false;
  const o = l as Record<string, unknown>;
  return (
    typeof o.info === "function" &&
    typeof o.warn === "function" &&
    typeof o.error === "function" &&
    (o.debug === undefined || typeof o.debug === "function")
  );
}

/**
 * Sets the process-wide log sink. `null` goes back to Mira's own logger.
 * @throws {TypeError} for anything that is not a logger, `false` or `null`.
 */
function setLogger(logger: MiraLogger | false | null): void {
  if (logger !== null && !isMiraLogger(logger)) {
    throw new TypeError("[mira] logger must have info, warn and error functions (debug optional), or be false.");
  }
  current = logger;
  sink = logger === null ? null : logger === false ? SILENT : mapLogger(logger);
}

/** The logger last passed to setLogger (null: Mira's own). */
function getLogger(): MiraLogger | false | null {
  return current;
}

/** The current sink. */
function log(): AdapterLog {
  return sink ?? (require("../utils/logger") as typeof import("../utils/logger")).logger;
}

export { log, setLogger, getLogger, isMiraLogger };
export type { AdapterLog };
