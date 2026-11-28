/**
 * RELIABILITY — time-zone / daylight-saving soak: ~1,900 Date round trips across
 * a whole year and both America/New_York daylight-saving changes, in four date
 * column types, written three ways (insertMany, insertOne, raw executeMany), read
 * back with find().toArray() and matched by Date equality and range filters.
 *
 * What is expected comes from Mira's documented behaviour (src/driver/oracle.ts,
 * the comment above _setSessionTimeZone; docs/MIGRATION-3.0.md "Session time zone"):
 *
 * - Thin mode: the session gets the process's IANA region, so a Date keeps its
 *   instant in every date column type, whatever the season.
 * - Thick mode: the session gets the process's CURRENT UTC offset. node-oracledb
 *   writes a Date as the process's wall clock, which Oracle reads in that fixed
 *   offset, so a Date written to TIMESTAMP WITH (LOCAL) TIME ZONE moves by
 *   (its own offset − today's offset): exactly one hour for a Date from the other
 *   season, nothing for a Date from this season. TIMESTAMP and DATE hold a wall
 *   clock, which the same process reads back in its own zone: no move.
 * - With no daylight saving (UTC, Asia/Manila) both reduce to "exact everywhere".
 *
 * The expectations are a model of that, evaluated per value. The process zone is
 * fixed for the run (bun test forces TZ=UTC unless TZ is set), so the same file
 * passes under any zone: run it with TZ=UTC, TZ=Asia/Manila and TZ=America/New_York.
 *
 * The hour that repeats when clocks go back (01:00–02:00 local, twice) is checked
 * separately: there a wall clock names two instants, and the documented "keeps its
 * instant" does not hold. Those tests are named DEFECT: and fail only in zones
 * with daylight saving.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, schema, coll, dropIfExists, rawExec, recordMetric } from "../helpers/db";

const T = "MIRA_RL_TZ_SOAK";
const H = 3_600_000;
const COLS = ["TSZ", "LTZ", "TS", "D"] as const;
type Col = (typeof COLS)[number];
const TYPE: Record<Col, string> = { TSZ: "TIMESTAMP WITH TIME ZONE", LTZ: "TIMESTAMP WITH LOCAL TIME ZONE", TS: "TIMESTAMP", D: "DATE" };
type Row = { SRC: string; I: number; OV: number } & Record<Col, Date>;
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "reliability", metric, value, unit, note });

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tzEnv = process.env.TZ ?? "(unset: bun test forces UTC)";

// ── The instants (the same set in every zone) ────────────────────────────────
// Every 6 h through 2026 with a varying millisecond part (TIMESTAMP(3) keeps it,
// DATE drops it), plus every minute within ±2 h of each America/New_York change:
// 2026-03-08 07:00Z (02:00 EST → 03:00 EDT) and 2026-11-01 06:00Z (02:00 EDT → 01:00 EST).
const SPRING = Date.UTC(2026, 2, 8, 7);
const FALL = Date.UTC(2026, 10, 1, 6);
const instants: Date[] = [];
for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 6 * H) instants.push(new Date(t + ((instants.length * 37) % 1000)));
for (const tr of [SPRING, FALL]) for (let min = -120; min <= 120; min++) instants.push(new Date(tr + min * 60_000 + (min === 0 ? 0 : 500)));

/** The process zone's UTC offset at an instant, in ms east of UTC. */
const off = (t: number) => -new Date(t).getTimezoneOffset() * 60_000;
/** The process's wall clock at an instant, as ms. */
const wall = (t: number) => t + off(t);
/** True when the instant's local wall clock also names the instant an hour away (the repeated hour). */
const repeated = (t: number) => wall(t) === wall(t + H) || wall(t) === wall(t - H);
const secondOf = (t: number) => Math.floor(t / 1000) * 1000;
const hasDst = instants.some((d) => off(d.getTime()) !== off(instants[0].getTime()));

let thick = false;
/** Today's offset: what a Thick-mode session is set to. */
let nowOff = 0;

/** What the documented behaviour says a Date reads back as, without DATE's truncation. */
function moved(t: number, col: Col): number {
  return thick && (col === "TSZ" || col === "LTZ") ? t + off(t) - nowOff : t;
}
/** What the documented behaviour says a written instant reads back as. */
const expected = (t: number, col: Col) => moved(col === "D" ? secondOf(t) : t, col);

let rows: Row[] = [];
/** Index → the sources that wrote it. */
const sources = new Map<number, string[]>();

beforeAll(async () => {
  await dropIfExists(T);
  await schema.createTable(T, {
    SRC: { type: "VARCHAR2(4)" },
    I: { type: "NUMBER(6)" },
    OV: { type: "NUMBER(1)" },
    TSZ: { type: "TIMESTAMP(3) WITH TIME ZONE" },
    LTZ: { type: "TIMESTAMP(3) WITH LOCAL TIME ZONE" },
    TS: { type: "TIMESTAMP(3)" },
    D: { type: "DATE" },
  });
  thick = !!db.oracledb.oracleClientVersion; // the driver is initialised by now (the first pool opened)
  nowOff = off(Date.now());

  const doc = (src: string, i: number) => {
    const d = instants[i];
    (sources.get(i) ?? sources.set(i, []).get(i)!).push(src);
    return { SRC: src, I: i, OV: repeated(d.getTime()) ? 1 : 0, TSZ: d, LTZ: d, TS: d, D: d };
  };
  await coll(T).insertMany(instants.map((_, i) => doc("many", i)), { returning: [] });
  for (let i = 0; i < instants.length; i += 7) await coll(T).insertOne(doc("one", i));
  const raw = instants.map((_, i) => doc("raw", i));
  await db.withConnection((c) =>
    c.executeMany(`INSERT INTO "${T}" (SRC, I, OV, TSZ, LTZ, TS, D) VALUES (:SRC, :I, :OV, :TSZ, :LTZ, :TS, :D)`, raw, { autoCommit: true }),
  );
  rows = await coll(T).find({}).toArray<Row>();
}, 60_000);
afterAll(() => dropIfExists(T));

/** Every (row, column) whose read-back differs from the model, as readable lines. */
function mismatches(pick: (r: Row) => boolean, cols: readonly Col[] = COLS) {
  const out: string[] = [];
  for (const r of rows.filter(pick))
    for (const c of cols) {
      const t = instants[r.I].getTime();
      const got = r[c].getTime();
      if (got !== expected(t, c)) out.push(`${r.SRC} ${c} ${instants[r.I].toISOString()}: expected ${new Date(expected(t, c)).toISOString()}, got ${r[c].toISOString()} (${(got - expected(t, c)) / H} h)`);
    }
  return { count: out.length, sample: out.slice(0, 6) };
}

/** Rows whose documented read-back of `col` satisfies `test`, among rows matching `pick`. */
const countModel = (col: Col, pick: (r: Row) => boolean, test: (v: number) => boolean) =>
  rows.filter((r) => pick(r) && test(expected(instants[r.I].getTime(), col))).length;

describe(`reliability: time-zone soak (process zone ${zone}, TZ=${tzEnv})`, () => {
  it("covers ~1,900 instants spanning both daylight-saving changes, written three ways", () => {
    expect(instants.length).toBeGreaterThanOrEqual(1500);
    expect(new Set(instants.map((d) => d.getTime())).size).toBe(instants.length);
    const perSource = (s: string) => rows.filter((r) => r.SRC === s).length;
    expect([perSource("many"), perSource("one"), perSource("raw")]).toEqual([instants.length, Math.ceil(instants.length / 7), instants.length]);
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: values checked`, rows.length * COLS.length, "count");
  });

  it("the session time zone is the documented one: the region in Thin mode, today's offset in Thick mode", async () => {
    const r = await rawExec<{ STZ: string }>(`SELECT SESSIONTIMEZONE AS STZ FROM DUAL`);
    const sign = nowOff < 0 ? "-" : "+";
    const abs = Math.abs(nowOff) / 60_000;
    const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    expect(r.rows?.[0]?.STZ).toBe(!thick && zone.includes("/") ? zone : offset);
  });

  it("outside the repeated hour every Date reads back as documented, in every column type and every write path", () => {
    expect(mismatches((r) => r.OV === 0)).toEqual({ count: 0, sample: [] });

    // Thick mode, daylight-saving zone: the documented move, asserted exactly (not "within an hour").
    let shifted = 0;
    const shiftedIn = new Set<string>();
    for (const r of rows.filter((x) => x.OV === 0))
      for (const c of COLS) {
        const t = instants[r.I].getTime();
        const delta = r[c].getTime() - (c === "D" ? secondOf(t) : t);
        if (delta === 0) continue;
        expect(Math.abs(delta)).toBe(H);
        expect(delta).toBe(off(t) - nowOff); // the other season, by exactly its offset difference
        shifted++;
        shiftedIn.add(c);
      }
    const otherSeason = rows.filter((r) => r.OV === 0 && off(instants[r.I].getTime()) !== nowOff).length;
    if (!hasDst) expect(otherSeason).toBe(0); // UTC, Asia/Manila: one offset all year
    expect(shifted).toBe(thick ? otherSeason * 2 : 0);
    expect([...shiftedIn].sort()).toEqual(thick && otherSeason ? ["LTZ", "TSZ"] : []);
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: values moved by exactly 1 h (documented)`, shifted, "count", [...shiftedIn].sort().map((c) => TYPE[c]).join(", ") || "none");
  });

  it("a Date filter matches its own rows: countDocuments({ COL: date }) in every column type", async () => {
    const sample = instants.map((_, i) => i).filter((i) => !repeated(instants[i].getTime()) && (i % 29 === 0 || (i >= 1460 && i % 5 === 0)));
    const got: string[] = [];
    const want: string[] = [];
    for (const i of sample)
      for (const c of COLS) {
        const t = c === "D" ? secondOf(instants[i].getTime()) : instants[i].getTime();
        const n = await coll(T).countDocuments({ OV: 0, [c]: new Date(t) });
        got.push(`${c} ${instants[i].toISOString()} ${n}`);
        want.push(`${c} ${instants[i].toISOString()} ${countModel(c, (r) => r.OV === 0, (v) => v === moved(t, c))}`);
      }
    expect(got).toEqual(want);
    expect(want.every((w) => !w.endsWith(" 0"))).toBe(true); // every probe found something
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: Date equality filters`, got.length, "count");
  }, 30_000);

  it("a $gte/$lt range over a season, a change, or the year counts the documented rows", async () => {
    const ranges: [string, number, number][] = [
      ["year", Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)],
      ["winter → summer", Date.UTC(2026, 0, 15), Date.UTC(2026, 5, 15)],
      ["summer → winter", Date.UTC(2026, 5, 15, 3, 0, 0, 250), Date.UTC(2026, 11, 15)],
      ["spring change ±2 h", SPRING - 2 * H, SPRING + 2 * H],
      ["spring change, 30 min across", SPRING - 15 * 60_000, SPRING + 15 * 60_000 + 250],
      ["fall change ±2 h", FALL - 2 * H, FALL + 2 * H],
      ["fall change, after it", FALL + H + 60_000, FALL + 2 * H + 1],
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const [name, lo, hi] of ranges) {
      for (const t of [lo, hi]) expect(repeated(t)).toBe(false);
      for (const c of COLS) {
        const n = await coll(T).countDocuments({ OV: 0, [c]: { $gte: new Date(lo), $lt: new Date(hi) } });
        const a = moved(lo, c);
        const b = moved(hi, c);
        got.push(`${name} ${c} ${n}`);
        want.push(`${name} ${c} ${countModel(c, (r) => r.OV === 0, (v) => v >= a && v < b)}`);
      }
    }
    expect(got).toEqual(want);
    expect(want.every((w) => !w.endsWith(" 0"))).toBe(true);
  }, 30_000);

  // ── The repeated hour (only exists in a zone with daylight saving) ───────────
  // Measured under America/New_York (2026-11-01, 05:00Z–07:00Z):
  //   Thin  TSZ          : the first 01:xx (EDT) is stored as the second (EST), +1 h.
  //   Thin  LTZ, TS, DATE: the second 01:xx (EST) reads back as the first (EDT), −1 h.
  //   Thick TS, DATE     : the same −1 h on the second 01:xx (this season's instants).
  //   Thick TSZ, LTZ     : as documented (the first 01:xx moves +1 h with its season).

  it("DEFECT: a Date in the hour repeated when clocks go back keeps its instant in TIMESTAMP and DATE (both modes)", () => {
    const found = mismatches((r) => r.OV === 1, ["TS", "D"]);
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: repeated hour, TIMESTAMP/DATE values off by 1 h`, found.count, "count");
    expect(found).toEqual({ count: 0, sample: [] });
  });

  it("DEFECT: Thin mode, a Date in the repeated hour keeps its instant in TIMESTAMP WITH (LOCAL) TIME ZONE", () => {
    // In Thick mode the model's documented one-hour move applies here too, and holds.
    const found = mismatches((r) => r.OV === 1, ["TSZ", "LTZ"]);
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: repeated hour, TSZ/LTZ values off the documented value`, found.count, "count");
    expect(found).toEqual({ count: 0, sample: [] });
  });

  it("DEFECT: a Date filter on an instant in the repeated hour matches its own rows only", async () => {
    const sample = instants.map((_, i) => i).filter((i) => repeated(instants[i].getTime()) && i % 3 === 0);
    if (hasDst) expect(sample.length).toBeGreaterThan(0);
    const got: string[] = [];
    const want: string[] = [];
    let overMatched = 0;
    for (const i of sample)
      for (const c of COLS) {
        const t = c === "D" ? secondOf(instants[i].getTime()) : instants[i].getTime();
        const n = await coll(T).countDocuments({ [c]: new Date(t) });
        const w = countModel(c, () => true, (v) => v === moved(t, c));
        if (n !== w) overMatched++;
        got.push(`${c} ${instants[i].toISOString()} ${n}`);
        want.push(`${c} ${instants[i].toISOString()} ${w}`);
      }
    m(`tz soak ${zone} ${thick ? "thick" : "thin"}: repeated-hour filters off the documented count`, overMatched, "count");
    expect(got).toEqual(want);
  }, 30_000);
});
