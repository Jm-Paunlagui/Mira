/**
 * UNIT — src/shared/log.ts: Mira's log sink. Default is the console, warnings
 * and errors only; setLogger swaps in an app logger (levels mapped) or silence.
 * The sink is process-wide, so each test starts from the default and puts back
 * what the test preload set.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { log, setLogger, getLogger, isMiraLogger } from "../../src/shared/log";

const preload = getLogger();
beforeEach(() => setLogger(null));
afterEach(() => setLogger(preload));

describe("unit: log sink", () => {
  it("defaults to the console: warnings and errors only, prefixed; no files", () => {
    expect(getLogger()).toBeNull();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const info = spyOn(console, "info").mockImplementation(() => {});
    const plain = spyOn(console, "log").mockImplementation(() => {});
    try {
      log().info("pool creating");
      log().notice("pool ready");
      log().warning("retrying", { n: 1 });
      log().critical("down");
      expect(warn.mock.calls).toEqual([["[mira]", "retrying", { n: 1 }]]);
      expect(error.mock.calls).toEqual([["[mira]", "down"]]);
      expect(info).not.toHaveBeenCalled();
      expect(plain).not.toHaveBeenCalled();
    } finally {
      for (const s of [warn, error, info, plain]) s.mockRestore();
    }
  });

  it("maps adapter levels onto an app logger: info→debug, notice→info, warning→warn, critical→error", () => {
    const seen: string[] = [];
    const app = {
      debug: (m: string, ...x: unknown[]) => void seen.push(`debug:${m}:${x.length}`),
      info: (m: string) => void seen.push(`info:${m}`),
      warn: (m: string) => void seen.push(`warn:${m}`),
      error: (m: string) => void seen.push(`error:${m}`),
    };
    setLogger(app);
    expect(getLogger()).toBe(app);
    log().info("a", { meta: 1 });
    log().notice("b");
    log().warning("c");
    log().critical("d");
    expect(seen).toEqual(["debug:a:1", "info:b", "warn:c", "error:d"]);
  });

  it("debug is optional; false silences everything; null restores the default", () => {
    const seen: string[] = [];
    setLogger({ info: () => void seen.push("i"), warn: () => {}, error: () => {} });
    log().info("dropped");
    log().notice("kept");
    expect(seen).toEqual(["i"]);
    setLogger(false);
    expect(getLogger()).toBe(false);
    for (const lvl of ["info", "notice", "warning", "critical"] as const) expect(log()[lvl]("x")).toBeUndefined();
    const sinkWhenFalse = log();
    setLogger(null);
    expect(log()).not.toBe(sinkWhenFalse);
    expect(getLogger()).toBeNull();
  });

  it("refuses anything that is not a logger", () => {
    for (const bad of [true, 0, "console", {}, { info() {}, warn() {} }, { info() {}, warn() {}, error() {}, debug: 1 }, undefined]) {
      expect(isMiraLogger(bad)).toBe(false);
      expect(() => setLogger(bad as never)).toThrow("[mira] logger must have info, warn and error functions (debug optional), or be false.");
    }
    expect(isMiraLogger(console)).toBe(true);
    expect(isMiraLogger(false)).toBe(true);
    expect(getLogger()).toBeNull();
  });
});
