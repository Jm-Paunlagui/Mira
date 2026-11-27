/**
 * @fileoverview Where Mira's log lines go.
 *
 * Default: the console, warnings and errors only (`warning` → console.warn,
 * `critical` → console.error); pool-lifecycle notices are dropped. Mira writes
 * no file. setLogger() swaps in any object with info / warn / error (and
 * optionally debug), or `false` for silence.
 *
 * Callers write `log().warning(msg)`.
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
const CONSOLE_DEFAULT: AdapterLog = Object.freeze({
  info: noop,
  notice: noop,
  warning: (...a: unknown[]) => console.warn("[mira]", ...a),
  critical: (...a: unknown[]) => console.error("[mira]", ...a),
});

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
 * Sets the process-wide log sink. `null` goes back to the console default.
 * @throws {TypeError} for anything that is not a logger, `false` or `null`.
 */
function setLogger(logger: MiraLogger | false | null): void {
  if (logger !== null && !isMiraLogger(logger)) {
    throw new TypeError("[mira] logger must have info, warn and error functions (debug optional), or be false.");
  }
  current = logger;
  sink = logger === null ? null : logger === false ? SILENT : mapLogger(logger);
}

/** The logger last passed to setLogger (null: the console default). */
function getLogger(): MiraLogger | false | null {
  return current;
}

/** The current sink. */
function log(): AdapterLog {
  return sink ?? CONSOLE_DEFAULT;
}

export { log, setLogger, getLogger, isMiraLogger };
export type { AdapterLog };
