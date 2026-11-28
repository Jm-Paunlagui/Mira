/**
 * RELIABILITY — long soak: resources and latency stay flat over many operations.
 *
 * reliability.test.ts already has a 3,000-op sequential soak that checks errors
 * and latency drift on the shared appDb pool. This one adds RESOURCE checks: it
 * drives a realistic mix of Mira's public API through 8 concurrent workers on a
 * pool of its own, and samples JS heap, RSS, pool stats and SERVER-SIDE open
 * cursors of exactly that pool's sessions every 1/20 of the run.
 *
 * Length: MIRA_SOAK_OPS (default 3,000 — every CI run; 30,000 for a local long run).
 *
 * Workload (one op = one public-API call; slot = op index % 16):
 *   findOne by PK · find+sort+limit · countDocuments $in · insertOne ·
 *   insertMany(3) · updateOne $inc · deleteOne · aggregate $group ·
 *   withTransaction(insert + $inc + delete) · forEach over 200 rows ·
 *   a duplicate-key insertOne on every other slot-13 op (1 in 32 ops) — a deliberate
 *   ORA-00001 so the error path is part of the soak. Inserts and deletes balance,
 *   so the table stays ~1,000 rows and latency cannot drift from data growth.
 *
 * Own pool ("soakDb", same credentials as appDb): poolMin 1, poolMax 8,
 * poolIncrement 1, 8 workers. The pool grows 1 → 8 during warm-up (exercised),
 * then all 8 sessions stay busy, so none idles past poolTimeout (30 s) and the
 * session set stays fixed — a requirement for comparing cursor counts.
 * Server-side cursors are read per session: at each sample the workers are
 * paused between windows, the sampler borrows every open connection at once
 * (held behind a barrier so each borrower is a distinct session) and reads
 * SID, SESSIONID and V$MYSTAT 'opened cursors current' on it. Other test files
 * and agents may hold MIRA sessions; those SIDs are never counted.
 *
 * Pass rules. The first 1/3 of the samples is warm-up (pool growth, JIT,
 * statement caches filling) and is discarded. Over the rest (the "measured
 * window", ≈ 2/3 of the ops: 1,950 ops at the default 3,000) a least-squares
 * slope per op is fitted and projected across the window:
 *
 *   heapUsed (after Bun.gc(true))  projected growth < 1 MiB.
 *       A 1 KB-per-op leak is 1,950 × 1,024 B ≈ 1.9 MiB over the window at
 *       3,000 ops — about 2× the bound, so it fails. At 30,000 ops the window is
 *       19,950 ops and the same leak is ≈ 19.5 MiB (19×). Leak-free, the heap still
 *       settles after warm-up: measured +0.32–0.46 MiB at 3,000 ops (≈ 200 B/op, decaying
 *       to ≈ 10 B/op over 30,000), so the bound sits ≥ 2× above that and ≈ 2× below a
 *       1 KB/op leak (which would read ≈ 2.4 MiB with the settling on top).
 *   opened cursors current, summed over the pool's 8 sessions  projected growth < 16
 *       (2 per session). Cursors the statement cache holds (stmtCacheSize 50 per
 *       connection) are flat once each session has run each distinct statement;
 *       the only legitimate late additions are a session meeting a rare statement
 *       (the 1-in-32 duplicate insert, the 30 s health-check ping) for the first
 *       time after warm-up: ≤ 2 distinct statements × 8 sessions = 16 worst case.
 *       One leaked cursor per op is +1,950 (and ORA-01000 long before);
 *       one leaked cursor per 100 ops is +19.5 — both fail. Measured leak-free: ~11
 *       per session, ~90 in total, projected growth 1.4–3.8 in either mode and length.
 *       V$OPEN_CURSOR rows for the same SIDs (includes the server's session cursor
 *       cache) are recorded, not asserted.
 *   per-session ceiling: no session holds more than stmtCacheSize + 10 cursors.
 *       A leak-free session is capped by its statement cache; 1 leak per op puts
 *       ~375 ops' worth on each session at 3,000 ops and fails immediately.
 *   RSS projected growth < 32 MiB.
 *       RSS is page-granular and the allocator does not return pages, so it is
 *       a gross check for NATIVE leaks the JS heap cannot see (Thick-mode OCI
 *       handles): it catches ≥ 17 KB/op at 3,000 ops and ≥ 1.7 KB/op at 30,000.
 *   connectionsOpen ≤ poolMax at every sample; connectionsInUse === 0 at the end.
 *   p95 of the last window ≤ 2 × p95 of the first measured window.
 *   Errors: every duplicate-key op fails and no other op does. The dup-key message is
 *   NOT required to read ORA-00001 here (it is counted and recorded): under Bun + Thick
 *   it is sometimes overwritten, a defect with its own DEFECT tests at the end of this file.
 *
 * No sleeps: sampling happens at window boundaries, when every worker has
 * finished its ops; nothing waits for time to pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createMira } from "../../src";
import database from "../../src/driver/registry";
import { schema, dropIfExists, recordMetric, percentile } from "../helpers/db";

const T = "MIRA_RL_SK_ITEM";
const OPS = Math.max(320, Number(process.env.MIRA_SOAK_OPS) || 3000);
const WORKERS = 8;
const POOL_MAX = 8;
const STMT_CACHE = 50; // POOL_DEFAULTS.stmtCacheSize (src/driver/oracle.ts)
const SAMPLES = 20;
const WARMUP = Math.ceil(SAMPLES / 3); // samples 0..WARMUP-1 are discarded
const SEED = 1000;
const GROUPS = ["A", "B", "C", "D", "E"];

/* Bounds — the header comment carries the arithmetic. */
const HEAP_GROWTH_MAX = 1024 * 1024;
const RSS_GROWTH_MAX = 32 * 1024 * 1024;
const CURSOR_GROWTH_MAX = 2 * POOL_MAX;
const CURSOR_PER_SESSION_MAX = STMT_CACHE + 10;

const app = database.getConnectionConfig("appDb");
const mira = createMira({
  pools: {
    soakDb: {
      user: String(app.user),
      password: String(app.password),
      connectString: String(app.connectString),
      poolMin: 1,
      poolMax: POOL_MAX,
      poolIncrement: 1,
      queueMax: 64,
    },
  },
});
const sdb = mira.db();
const items = mira.collection(T);
const tx = mira.transaction();

const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "reliability", metric, value, unit, note });

type PoolStat = { connectionsOpen?: number; connectionsInUse?: number; poolMax?: number };
const poolStat = async () => ((await sdb.getPoolStats()).pools.soakDb ?? {}) as PoolStat;

type Session = { key: string; cursors: number };
type Sample = {
  ops: number;
  heap: number;
  rss: number;
  open: number;
  inUse: number;
  sessions: Session[];
  cursors: number;
  openCursorRows: number;
  p95: number;
  /** Diagnostics for a latency failure (recorded, not asserted): */
  p50: number;
  max: number;
  /** Longest event-loop stall seen while the window ran: a JS-side pause (GC, a sync call) vs a database-side one. */
  loopLagMax: number;
};

/**
 * Event-loop lag: a 10 ms tick that measures how late it fires. A stall that every worker
 * sees at once is either the JS thread being blocked (lag ≈ the stall) or the database
 * pausing (lag ≈ 0); this tells the two apart when a latency check fails.
 */
let loopLagMax = 0;
function startLagProbe(): () => void {
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    loopLagMax = Math.max(loopLagMax, now - last - 10);
    last = now;
  }, 10);
  return () => clearInterval(tick);
}

/**
 * Reads every open session of the soak pool: borrows connectionsOpen connections at
 * once and holds each until all have arrived, so the pool cannot hand one session out
 * twice. Runs only between windows, when no worker holds a connection.
 */
async function readSessions(): Promise<{ sessions: Session[]; openCursorRows: number }> {
  const n = Math.max(1, (await poolStat()).connectionsOpen ?? 1);
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  const sessions = await Promise.all(
    Array.from({ length: n }, () =>
      sdb.withConnection(async (c) => {
        const r = await c.execute<{ SID: string; AUD: string; CUR: number }>(
          `SELECT SYS_CONTEXT('USERENV','SID') AS SID, SYS_CONTEXT('USERENV','SESSIONID') AS AUD,
                  (SELECT m.VALUE FROM V$MYSTAT m JOIN V$STATNAME s ON s.STATISTIC# = m.STATISTIC#
                    WHERE s.NAME = 'opened cursors current') AS CUR
             FROM DUAL`,
          {},
          { outFormat: sdb.oracledb.OUT_FORMAT_OBJECT },
        );
        if (++arrived === n) release();
        await all;
        const row = r.rows![0];
        return { sid: row.SID, key: `${row.SID}:${row.AUD}`, cursors: Number(row.CUR) };
      }),
    ),
  );
  const sids = sessions.map((s) => s.sid).join(",");
  const oc = await sdb.withConnection((c) =>
    c.execute<{ N: number }>(
      `SELECT COUNT(*) AS N FROM V$OPEN_CURSOR WHERE USER_NAME = USER AND INSTR(',' || :sids || ',', ',' || SID || ',') > 0`,
      { sids },
      { outFormat: sdb.oracledb.OUT_FORMAT_OBJECT },
    ),
  );
  return { sessions: sessions.map(({ key, cursors }) => ({ key, cursors })), openCursorRows: Number(oc.rows![0].N) };
}

/** Least-squares slope of y over x, and the growth it projects across x's span. */
function fit(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, growth: slope * (xs[n - 1] - xs[0]) };
}

// ── Workload ──────────────────────────────────────────────────────────────────

let nextId = 1_000_000;
/** IDs this soak inserted and has not deleted yet (deletes take from the front). */
const live: number[] = [];
let plannedFailures = 0;

const seedId = (i: number) => (i * 7919) % SEED + 1;

/** Runs op `i`; resolves on success, rejects on failure (the deliberate one included). */
async function op(i: number): Promise<unknown> {
  const g = GROUPS[i % GROUPS.length];
  switch (i % 16) {
    case 0:
    case 11:
      return items.findOne({ ID: seedId(i) });
    case 1:
      return items.find({ GRP: g }).sort({ QTY: -1, ID: 1 }).limit(10).toArray();
    case 2:
      return items.countDocuments({ GRP: { $in: ["A", "C", g] } });
    case 3: {
      const id = nextId++;
      await items.insertOne({ ID: id, GRP: g, QTY: 1, NAME: `n${id}` }, { returning: [] });
      return live.push(id);
    }
    case 4: {
      const ids = [nextId++, nextId++, nextId++];
      await items.insertMany(ids.map((id) => ({ ID: id, GRP: g, QTY: 2, NAME: `m${id}` })), { returning: [] });
      return live.push(...ids);
    }
    case 5:
    case 14:
      return items.updateOne({ ID: seedId(i) }, { $inc: { QTY: 1 } });
    case 6:
    case 10:
    case 12:
    case 15:
      return items.deleteOne({ ID: live.shift() ?? -1 });
    case 7:
      return items.aggregate([{ $group: { _id: "$GRP", total: { $sum: "$QTY" }, n: { $sum: 1 } } }]);
    case 8: {
      const id = nextId++;
      const gone = live.shift() ?? -1;
      return tx.withTransaction(async (s) => {
        const c = s.collection(T);
        await c.insertOne({ ID: id, GRP: g, QTY: 3, NAME: `t${id}` }, { returning: [] });
        await c.updateOne({ ID: seedId(i) }, { $inc: { QTY: -1 } });
        await c.deleteOne({ ID: gone });
      }).then(() => live.push(id));
    }
    case 9: {
      const from = (i * 31) % (SEED - 200) + 1;
      let rows = 0;
      await items.find({ ID: { $gte: from, $lt: from + 200 } }).forEach(() => {
        rows++;
      });
      if (rows !== 200) throw new Error(`forEach saw ${rows} rows, expected 200`);
      return rows;
    }
    default: // 13
      if (i % 32 === 13) return items.insertOne({ ID: seedId(i), GRP: g, QTY: 0, NAME: "dup" }, { returning: [] }); // ORA-00001
      return items.countDocuments({ GRP: { $in: ["B", "D", g] } });
  }
}

/**
 * Failures, counted without keeping the Error objects: holding ~1 error (with its stack)
 * per 32 ops would itself grow the heap and be read as a Mira leak.
 */
const failures = { expected: 0, misreported: 0, unexpected: 0, firstUnexpected: [] as string[] };

/** Runs ops [from, to) with WORKERS in flight; returns the window's latencies. */
async function runWindow(from: number, to: number) {
  loopLagMax = 0;
  const lat: number[] = [];
  let next = from;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let i = next++; i < to; i = next++) {
        const t0 = performance.now();
        try {
          await op(i);
        } catch (e) {
          // Expected = the duplicate-key slot failing. Mira's collection layer rethrows
          // driver errors as new Error(text) without errorNum or cause, so the ORA code can
          // only be read from the message — and under Bun + Thick that message is sometimes
          // overwritten by a forEach stream's late close (DPI-1039 / NJS-003). That defect has
          // its own test below; here a dup-slot failure counts as the planned failure and a
          // wrong message is counted ("misreported") and recorded. Any failure on another
          // slot is unexpected and fails the soak.
          const msg = String(e);
          if (i % 32 === 13) {
            failures.expected++;
            if (!/ORA-00001:/.test(msg)) failures.misreported++;
          } else if (++failures.unexpected <= 3)
            failures.firstUnexpected.push(`op ${i} (slot ${i % 16}${i % 32 === 13 ? ", duplicate-key" : ""}) :: ${msg.slice(0, 400)}`);
        }
        lat.push(performance.now() - t0);
      }
    }),
  );
  return lat;
}

async function takeSample(ops: number, lat: number[]): Promise<Sample> {
  const lagMax = loopLagMax; // the window's, before the sampler's own work
  const sorted = [...lat].sort((a, b) => a - b);
  const stat = await poolStat();
  const { sessions, openCursorRows } = await readSessions();
  Bun.gc(true);
  const mem = process.memoryUsage();
  return {
    ops,
    heap: mem.heapUsed,
    rss: mem.rss,
    open: stat.connectionsOpen ?? 0,
    inUse: stat.connectionsInUse ?? 0,
    sessions,
    cursors: sessions.reduce((a, s) => a + s.cursors, 0),
    openCursorRows,
    p95: percentile(sorted, 95),
    p50: percentile(sorted, 50),
    max: sorted[sorted.length - 1] ?? 0,
    loopLagMax: lagMax,
  };
}

/** Lowest connectionsInUse seen over up to 2 s (the 30 s health ping may hold one briefly). */
async function soakInUse(): Promise<number> {
  let lowest = Infinity;
  for (const deadline = Date.now() + 2000; ; ) {
    lowest = Math.min(lowest, (await poolStat()).connectionsInUse ?? 0);
    if (lowest === 0 || Date.now() >= deadline) return lowest;
    await new Promise((r) => setImmediate(r));
  }
}

beforeAll(async () => {
  await dropIfExists(T);
  await schema.createTable(T, {
    ID: { type: "NUMBER", primaryKey: true },
    GRP: { type: "VARCHAR2(10)", notNull: true },
    QTY: { type: "NUMBER", default: "0" },
    NAME: { type: "VARCHAR2(100)" },
  });
  await items.createIndex({ GRP: 1 });
  await items.insertMany(
    Array.from({ length: SEED }, (_, k) => ({ ID: k + 1, GRP: GROUPS[k % GROUPS.length], QTY: 100, NAME: `s${k + 1}` })),
    { returning: [] },
  );
  for (let i = 0; i < OPS; i++) if (i % 32 === 13) plannedFailures++;
});

afterAll(async () => {
  await dropIfExists(T);
  await mira.close();
});

describe("reliability: long soak, resources stay flat", () => {
  it(
    `soak: ${OPS.toLocaleString("en-US")} mixed ops × ${WORKERS} workers — heap, RSS, server cursors, pool and p95 flat; zero connections left checked out`,
    async () => {
      const samples: Sample[] = [];
      const t0 = performance.now();
      const stopLagProbe = startLagProbe();
      try {
        for (let w = 0; w < SAMPLES; w++) {
          const from = Math.floor((w * OPS) / SAMPLES);
          const to = Math.floor(((w + 1) * OPS) / SAMPLES);
          samples.push(await takeSample(to, await runWindow(from, to)));
        }
      } finally {
        stopLagProbe();
      }
      const wallMs = performance.now() - t0;

      const measured = samples.slice(WARMUP);
      const xs = measured.map((s) => s.ops);
      const series = {
        heapUsed: { ys: measured.map((s) => s.heap), unit: "bytes" },
        rss: { ys: measured.map((s) => s.rss), unit: "bytes" },
        cursors: { ys: measured.map((s) => s.cursors), unit: "count" },
        openCursorRows: { ys: measured.map((s) => s.openCursorRows), unit: "count" },
        connectionsOpen: { ys: measured.map((s) => s.open), unit: "count" },
        p95: { ys: measured.map((s) => s.p95), unit: "ms" },
      };
      const fits: Record<string, ReturnType<typeof fit>> = {};
      const tag = `soak ${OPS} ops (${sdb.oracledb.thin ? "thin" : "thick"})`;
      for (const [name, { ys, unit }] of Object.entries(series)) {
        fits[name] = fit(xs, ys);
        const note = `measured window ops ${xs[0]}..${xs[xs.length - 1]}, warm-up ${WARMUP}/${SAMPLES} samples discarded`;
        m(`${tag}: ${name} start`, ys[0], unit, note);
        m(`${tag}: ${name} end`, ys[ys.length - 1], unit, note);
        m(`${tag}: ${name} slope`, fits[name].slope, `${unit}/op`, note);
        m(`${tag}: ${name} projected growth`, fits[name].growth, unit, note);
      }
      m(`${tag}: wall time`, wallMs, "ms");
      m(`${tag}: deliberate failures`, failures.expected, "count", "duplicate-key insertOne, ORA-00001");
      m(`${tag}: deliberate failures misreported`, failures.misreported, "count", "dup-key error whose message is not ORA-00001 (see the DEFECT test on forEach)");
      if (process.env.MIRA_SOAK_DEBUG)
        console.log(
          JSON.stringify(
            samples.map(({ sessions, ...s }) => ({ ...s, perSession: sessions.map((x) => x.cursors) })),
          ),
        );

      // Errors: only the planned duplicate-key inserts failed, and every one of them did.
      expect(failures.firstUnexpected).toEqual([]);
      expect(failures.unexpected).toBe(0);
      expect(failures.expected).toBe(plannedFailures);

      // The session set is fixed through the measured window, so cursor sums compare like with like.
      const keys = (s: Sample) => s.sessions.map((x) => x.key).sort().join(" ");
      for (const s of measured) expect(keys(s)).toBe(keys(measured[0]));

      // Pool.
      for (const s of samples) expect(s.open).toBeLessThanOrEqual(POOL_MAX);
      expect(await soakInUse()).toBe(0);

      // Server-side cursors.
      expect(fits.cursors.growth).toBeLessThan(CURSOR_GROWTH_MAX);
      for (const s of measured) for (const x of s.sessions) expect(x.cursors).toBeLessThanOrEqual(CURSOR_PER_SESSION_MAX);

      // Memory.
      expect(fits.heapUsed.growth).toBeLessThan(HEAP_GROWTH_MAX);
      expect(fits.rss.growth).toBeLessThan(RSS_GROWTH_MAX);

      // Latency. On a failure, print every window so the stall can be placed: event-loop lag
      // near the stall means the JS thread was blocked; lag near 0 means the database paused.
      const last = measured[measured.length - 1];
      if (last.p95 > 2 * measured[0].p95)
        console.log(
          `soak latency by window (ms):\n${samples
            .map((s, w) => `  w${w}${w < WARMUP ? " (warm-up)" : ""}: ops≤${s.ops} p50=${s.p50.toFixed(2)} p95=${s.p95.toFixed(2)} max=${s.max.toFixed(1)} loopLag=${s.loopLagMax.toFixed(1)}`)
            .join("\n")}`,
        );
      m(`${tag}: worst event-loop lag in a window`, Math.max(...samples.map((s) => s.loopLagMax)), "ms", "diagnostic: a JS-side pause vs a database-side one");
      expect(last.p95).toBeLessThanOrEqual(2 * measured[0].p95);
    },
    Math.max(120_000, OPS * 20),
  );
});

/**
 * forEach (src/core/QueryBuilder.ts) resolves on the query stream's "end" event, so
 * withConnection releases the connection while node-oracledb is still closing the
 * stream's ResultSet in the background. node-oracledb wants the connection kept until
 * "close". The late close then runs on a connection already back in the pool — possibly
 * lent to the next borrower — and fails there (DPI-1039 / NJS-003 / DPI-1010).
 *
 * Seen in this soak under Bun + Thick: about 1 duplicate-key failure in 500 reports
 * "DPI-1039: statement was already closed C001…) violated" or "NJS-003: invalid or
 * closed connection" instead of ORA-00001 — the stream's error text written over the
 * ORA-00001 message (the tail of the original survives). Reproduced without Mira, with
 * raw node-oracledb 7.0.1 on Bun 1.4.5 Thick: release on "end" → misreported errors;
 * release on "close" → none; Node 26 → none either way.
 */
describe("reliability: forEach hands its connection back only after the stream has closed", () => {
  it("DEFECT: forEach releases its connection only after the query stream emits 'close'", async () => {
    // Spy on the driver's Connection: count a release (close()) of a connection whose
    // queryStream has not emitted "close" yet.
    const proto = sdb.oracledb.Connection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const { queryStream, close } = proto;
    const openStreams = new WeakMap<object, number>();
    let streams = 0;
    let earlyReleases = 0;
    proto.queryStream = function (this: object, ...a: unknown[]) {
      const s = queryStream.apply(this, a) as import("node:stream").Readable;
      streams++;
      openStreams.set(this, (openStreams.get(this) ?? 0) + 1);
      s.once("close", () => openStreams.set(this, (openStreams.get(this) ?? 1) - 1));
      return s;
    };
    proto.close = function (this: object, ...a: unknown[]) {
      if ((openStreams.get(this) ?? 0) > 0) earlyReleases++;
      return close.apply(this, a);
    };
    try {
      for (let k = 0; k < 50; k++) {
        let rows = 0;
        await items.find({ ID: { $gte: 1, $lte: 200 } }).forEach(() => {
          rows++;
        });
        expect(rows).toBe(200);
      }
    } finally {
      proto.queryStream = queryStream;
      proto.close = close;
    }
    m("forEach: connection released before the stream closed", earlyReleases, "count", "out of 50 forEach calls");
    expect(streams).toBe(50); // the spy saw every stream, so 0 below means something
    expect(earlyReleases).toBe(0);
  });

  it(
    "DEFECT: a duplicate-key error reads ORA-00001 while forEach streams run beside it (Bun + Thick: overwritten by DPI-1039 / NJS-003)",
    async () => {
      const N = 4000;
      let next = 0;
      let dups = 0;
      let wrong = 0;
      const firstWrong: string[] = [];
      await Promise.all(
        Array.from({ length: WORKERS }, async () => {
          for (let i = next++; i < N; i = next++) {
            if (i % 2) {
              await items.find({ ID: { $gte: 1, $lte: 200 } }).forEach(() => {});
              continue;
            }
            try {
              await items.insertOne({ ID: seedId(i), GRP: "A", QTY: 0, NAME: "dup" }, { returning: [] });
            } catch (e) {
              dups++;
              const msg = String(e);
              if (!/ORA-00001: unique constraint/.test(msg) && ++wrong <= 3) firstWrong.push(msg.split("\n")[0].slice(0, 200));
            }
          }
        }),
      );
      m(`dup-key errors misreported beside forEach (${sdb.oracledb.thin ? "thin" : "thick"})`, wrong, "count", `of ${N / 2} duplicate-key inserts`);
      expect(dups).toBe(N / 2);
      expect(firstWrong).toEqual([]);
      expect(wrong).toBe(0);
    },
    60_000,
  );
});
