/**
 * INTEGRATION — dates and time zones in both driver modes.
 *
 * node-oracledb Thin mode opens every session in UTC (+00:00). Thick mode opened
 * it in the operating system's zone, and a JS Date written to a TIMESTAMP WITH
 * (LOCAL) TIME ZONE column then moved by that zone's offset (−8 h on a UTC+8
 * machine) — through insertOne, insertMany and the raw driver alike. bun test
 * runs with TZ=UTC, which does not change the Oracle client's zone on Windows,
 * so the shift showed in Thick mode whatever TZ said.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, schema, coll, dropIfExists, rawExec } from "../helpers/db";

const T = "MIRA_TZ_DATES";
const at = new Date("2026-05-06T07:08:09.123Z");

beforeAll(async () => {
  await dropIfExists(T);
  await schema.createTable(T, {
    K: { type: "VARCHAR2(9)" },
    TSZ: { type: "TIMESTAMP(3) WITH TIME ZONE" },
    LTZ: { type: "TIMESTAMP(3) WITH LOCAL TIME ZONE" },
    TS: { type: "TIMESTAMP(3)" },
    D: { type: "DATE" },
  });
});
afterAll(() => dropIfExists(T));

describe("integration: dates and time zones", () => {
  it("DEFECT: a Date keeps its instant in every date column type, written by insertOne, insertMany or raw SQL", async () => {
    await coll(T).insertOne({ K: "one", TSZ: at, LTZ: at, TS: at, D: at });
    await coll(T).insertMany([{ K: "many", TSZ: at, LTZ: at, TS: at, D: at }], { returning: [] });
    await rawExec(`INSERT INTO "${T}" VALUES ('raw', :a, :a, :a, :a)`, { a: at });
    const rows = await coll(T).find({}).sort({ K: 1 }).toArray<{ K: string; TSZ: Date; LTZ: Date; TS: Date; D: Date }>();
    const secondOf = (d: Date) => Math.floor(d.getTime() / 1000) * 1000; // DATE has no fractional seconds
    expect(rows.map((r) => [r.K, r.TSZ.getTime(), r.LTZ.getTime(), r.TS.getTime(), r.D.getTime()])).toEqual(
      ["many", "one", "raw"].map((k) => [k, at.getTime(), at.getTime(), at.getTime(), secondOf(at)]),
    );
  });

  it("DEFECT: the session time zone is +00:00 in both driver modes (Thin's own default)", async () => {
    const r = await rawExec<{ STZ: string; TXT: string }>(`SELECT SESSIONTIMEZONE AS STZ, TO_CHAR(TSZ, 'TZH:TZM') AS TXT FROM "${T}" WHERE K = 'one'`);
    expect(r.rows?.[0]).toEqual({ STZ: "+00:00", TXT: "+00:00" });
  });

  it("a filter with a Date matches the row it wrote", async () => {
    expect(await coll(T).countDocuments({ TSZ: at, LTZ: at, TS: at })).toBe(3);
    expect(await coll(T).countDocuments({ TSZ: { $gt: new Date(at.getTime() - 1) , $lt: new Date(at.getTime() + 1) } })).toBe(3);
  });
});
