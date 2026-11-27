/**
 * UNIT — the pool registry (src/driver/registry.ts) and the connect-string
 * builders (src/config/connectString.ts). Registry tests use a fresh copy of
 * the module, so the shared registry the adapter reads is never touched.
 */
import { describe, it, expect } from "bun:test";
import { buildSimpleConnectString, buildTNSConnectString } from "../../src/config/connectString";

describe("unit: connect-string builders", () => {
  it("Easy Connect and the TNS descriptor", () => {
    expect(buildSimpleConnectString("h", 1521, "svc")).toBe("h:1521/svc");
    expect(buildTNSConnectString("h", 1521, "SID")).toBe(
      "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(LOAD_BALANCE=yes)(CONNECT_DATA=(SERVER=DEDICATED)(SID=SID)(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))",
    );
  });
});

describe("unit: pool registry", () => {
  it("starts empty: nothing is built in and no env variable is read", async () => {
    const m = await import("../../src/driver/registry.ts?empty");
    expect(m.getConnectionNames()).toEqual([]);
    expect(() => m.getConnectionConfig("appDb")).toThrow('Unknown connection "appDb". Registered: (none)');
  });

  it("register adds a copy; a second registration of a live name is refused; unregister removes it", async () => {
    const m = await import("../../src/driver/registry.ts?add");
    const entry = { user: "u", password: "p", connectString: "h:1/s", poolMax: 3 };
    m.registerConnection("extraDb", entry);
    expect(m.getConnectionConfig("extraDb")).toEqual(entry);
    expect(m.getConnectionConfig("extraDb")).not.toBe(entry);
    expect(m.getConnectionNames()).toEqual(["extraDb"]);
    expect(() => m.registerConnection("extraDb", {})).toThrow('Connection "extraDb" is already registered by a live createMira() instance. Close that instance first.');
    m.registerConnection("other", {});
    expect(() => m.getConnectionConfig("nope")).toThrow('Unknown connection "nope". Registered: extraDb, other');
    expect(m.unregisterConnection("extraDb")).toBe(true);
    expect(m.unregisterConnection("extraDb")).toBe(false);
    expect(() => m.getConnectionConfig("extraDb")).toThrow(/Unknown connection "extraDb"/);
    expect(m.default.connections).toBe(m.connections);
  });

  it("refuses bad names; lookups see own keys only; long names are cut in messages", async () => {
    const m = await import("../../src/driver/registry.ts?names");
    for (const bad of ["", "1x", "a-b", "__proto__", "appDb' OR '1'='1", 5 as unknown as string]) {
      expect(() => m.registerConnection(bad, {})).toThrow(/^Invalid connection name/);
    }
    for (const inherited of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => m.getConnectionConfig(inherited)).toThrow(`Unknown connection "${inherited}"`);
    }
    expect(() => m.getConnectionConfig("x".repeat(200))).toThrow(`Unknown connection "${"x".repeat(80)}"`);
  });
});
