/**
 * UNIT — src/shared/log.ts: the adapter's log sink. Default is Mira's own
 * logger; setLogger swaps in an app logger (levels mapped) or silence.
 * Every test puts the default back: the sink is process-wide.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { log, setLogger, getLogger, isMiraLogger } from "../../src/shared/log";
import { logger as miraOwn } from "../../src/utils/logger";

afterEach(() => setLogger(null));

describe("unit: log sink", () => {
  it("defaults to Mira's own logger object (so its call-site capture still works)", () => {
    expect(getLogger()).toBeNull();
    expect(log()).toBe(miraOwn as never);
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
    setLogger(null);
    expect(log()).toBe(miraOwn as never);
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
