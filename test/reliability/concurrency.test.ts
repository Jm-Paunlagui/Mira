/**
 * RELIABILITY — concurrency gives the same answers as running one query at a time.
 *
 * Typed tables, include() relations, withCTE / withRecursiveCTE and aggregate
 * pipelines are each run once sequentially (the baseline, itself checked against
 * an in-memory model of the seeded rows), then 50 times concurrently with mixed
 * shapes and bind values. Every concurrent result must equal its own baseline
 * exactly: no rows from another statement, no child on the wrong parent, no bind
 * value leaking between queries. Writes on disjoint rows run beside reads, and the
 * final table must equal the model. After each block no connection is checked out.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { defineTable, t, relations, hasMany, hasOne, belongsTo, withCTE, withRecursiveCTE } from "../../src";
import { db, schema, coll, dropIfExists, appDbInUse, recordMetric, timeIt } from "../helpers/db";

const ITEM = "MIRA_RL_CC_ITEM";
const PARENT = "MIRA_RL_CC_PARENT";
const CHILD = "MIRA_RL_CC_CHILD";
const EMP = "MIRA_RL_CC_EMP";

/** Jobs in flight at once. 50 = every job concurrently (the pool queues what it cannot serve at once). */
const CONC = 50;
const N = 50;

const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "reliability", metric, value, unit, note });

/** Run `n` jobs with at most `k` in flight; rejects if any job rejects (after all settle). */
async function bounded<T>(n: number, k: number, job: (i: number) => Promise<T>): Promise<T[]> {
  const out: PromiseSettledResult<T>[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(k, n) }, async () => {
      for (let i = next++; i < n; i = next++) out[i] = await job(i).then((value) => ({ status: "fulfilled", value }) as const, (reason) => ({ status: "rejected", reason }) as const);
    }),
  );
  const failed = out.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (failed.length) throw new Error(`${failed.length}/${n} concurrent jobs failed; first: ${String(failed[0].reason)}`);
  return out.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** Run each job once, one after another (the baseline). */
async function sequential<T>(n: number, job: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await job(i));
  return out;
}

type PoolStat = { connectionsInUse?: number; queueLength?: number; poolMax?: number };
const poolStat = async () => ((await db.getPoolStats()).pools.appDb ?? {}) as PoolStat;

/**
 * Wraps a job so its start and its end sample the pool (without waiting on the sample). The
 * peak of connections in use plus requests queued proves the statements really
 * overlapped in the database, not only in JavaScript.
 */
function sampled<T>(job: (i: number) => Promise<T>) {
  const peak = { busy: 0 };
  const samples: Promise<void>[] = [];
  const sample = () => void samples.push(poolStat().then((s) => void (peak.busy = Math.max(peak.busy, (s.connectionsInUse ?? 0) + (s.queueLength ?? 0)))));
  const wrapped = async (i: number) => {
    sample();
    const r = await job(i);
    sample();
    return r;
  };
  return { wrapped, peak: async () => (await Promise.all(samples), peak.busy) };
}

/** Baseline sequentially, then concurrently; returns both, asserts real overlap, records wall time and peak. */
async function compare<T>(label: string, job: (i: number) => Promise<T>) {
  const seq = await sequential(N, job);
  const s = sampled(job);
  const [conc, ms] = await timeIt(() => bounded(N, CONC, s.wrapped));
  const peak = await s.peak();
  m(`concurrency: ${label} (${N} jobs, ${CONC} in flight)`, Math.round(ms), "ms");
  m(`concurrency: ${label} peak pool busy`, peak, "count", "connections in use + queued, sampled at each job start");
  expect(peak).toBeGreaterThan(1);
  return { seq, conc };
}

// ── Model helpers ─────────────────────────────────────────────────────────────

type Dir = 1 | -1;
const by = <R>(...keys: [keyof R, Dir][]) => (a: R, b: R) => {
  for (const [k, d] of keys) {
    const x = a[k] as unknown as number | string;
    const y = b[k] as unknown as number | string;
    if (x < y) return -d;
    if (x > y) return d;
  }
  return 0;
};
const pick = <R extends object, K extends keyof R>(r: R, ...ks: K[]) => Object.fromEntries(ks.map((k) => [k, r[k]])) as Pick<R, K>;

// ── Scenario 1: a typed table ─────────────────────────────────────────────────

const CATS = ["A", "B", "C", "Z"] as const;
const Items = defineTable(ITEM, {
  ID: t.number(10).primaryKey(),
  CAT: t.text(5),
  QTY: t.number(6),
  PRICE: t.money(),
  NAME: t.text(30),
  NOTE: t.text(20).nullable(),
});
type Item = { ID: number; CAT: string; QTY: number; PRICE: string; NAME: string; NOTE: string | null };
const itemRow = (id: number): Item => ({
  ID: id,
  CAT: CATS[id % 4],
  QTY: (id * 37) % 100,
  PRICE: `${((id * 13) % 50) + 1}.5`, // always >= 1.5: Oracle's text for it has the leading digit
  NAME: `item-${String(id).padStart(4, "0")}`,
  NOTE: id % 5 === 0 ? null : `n${id % 3}`,
});
/** The in-memory model of ITEM, kept in step with every write. */
const items = new Map<number, Item>();
const all = () => [...items.values()];

/** One read shape per i % 10, its parameters varied by i; each with the model's answer. */
function itemRead(i: number, only?: (r: Item) => boolean): { run: () => Promise<unknown>; model: () => unknown } {
  const p = Math.floor(i / 10) % 5;
  const on = Items.on(db);
  const rows = () => all().filter((r) => !only || only(r));
  const cat = only ? "Z" : CATS[p % 4];
  switch (i % 10) {
    case 0:
      return { run: () => on.find({ CAT: cat }).sort({ ID: 1 }).toArray(), model: () => rows().filter((r) => r.CAT === cat).sort(by<Item>(["ID", 1])) };
    case 1:
      return {
        run: () => on.find({ CAT: cat, QTY: { $gte: p * 20 } }).sort({ QTY: -1, ID: 1 }).limit(7).toArray(),
        model: () => rows().filter((r) => r.CAT === cat && r.QTY >= p * 20).sort(by<Item>(["QTY", -1], ["ID", 1])).slice(0, 7),
      };
    case 2:
      return {
        run: () => on.find({ CAT: cat, NOTE: null }).sort({ ID: -1 }).project({ ID: 1, NAME: 1 }).toArray(),
        model: () => rows().filter((r) => r.CAT === cat && r.NOTE === null).sort(by<Item>(["ID", -1])).map((r) => pick(r, "ID", "NAME")),
      };
    case 3:
      return {
        run: () => on.find({ CAT: cat, PRICE: { $gt: 10 + p * 5 } }).sort({ PRICE: 1, ID: 1 }).project({ ID: 1, PRICE: 1 }).toArray(),
        model: () =>
          rows()
            .filter((r) => r.CAT === cat && Number(r.PRICE) > 10 + p * 5)
            .sort((a, b) => Number(a.PRICE) - Number(b.PRICE) || a.ID - b.ID)
            .map((r) => pick(r, "ID", "PRICE")),
      };
    case 4:
      return {
        run: () => on.find({ CAT: cat, QTY: { $lt: 60 } }).sort({ NAME: 1 }).skip(p).limit(4).toArray(),
        model: () => rows().filter((r) => r.CAT === cat && r.QTY < 60).sort(by<Item>(["NAME", 1])).slice(p, p + 4),
      };
    case 5: {
      const ids = [p * 4 + 3, p * 4 + 7, p * 4 + 11, p * 4 + 15, 9999];
      return {
        run: () => on.find({ CAT: cat, ID: { $in: ids } }).sort({ ID: 1 }).toArray(),
        model: () => rows().filter((r) => r.CAT === cat && ids.includes(r.ID)).sort(by<Item>(["ID", 1])),
      };
    }
    case 6:
      return { run: () => on.countDocuments({ CAT: cat, QTY: { $gte: p * 15 } }), model: () => rows().filter((r) => r.CAT === cat && r.QTY >= p * 15).length };
    case 7: {
      const id = p * 8 + 3; // 3, 11, 19, 27, 35: all CAT "Z"
      return { run: () => on.findOne({ CAT: cat, ID: id }), model: () => rows().find((r) => r.CAT === cat && r.ID === id) ?? null };
    }
    case 8:
      return {
        run: async () => (await on.distinct("NOTE", { CAT: cat, QTY: { $gte: p * 10 } })).map(String).sort(),
        model: () => [...new Set(rows().filter((r) => r.CAT === cat && r.QTY >= p * 10).map((r) => r.NOTE))].map(String).sort(),
      };
    default:
      return {
        run: () =>
          on
            .find({ CAT: cat, $or: [{ QTY: { $lt: 20 + p * 10 } }, { NOTE: "n1" }] })
            .sort({ ID: 1 })
            .project({ ID: 1, QTY: 1, NOTE: 1 })
            .toArray(),
        model: () =>
          rows()
            .filter((r) => r.CAT === cat && (r.QTY < 20 + p * 10 || r.NOTE === "n1"))
            .sort(by<Item>(["ID", 1]))
            .map((r) => pick(r, "ID", "QTY", "NOTE")),
      };
  }
}

// ── Scenario 2: relations ─────────────────────────────────────────────────────

// Both tables have a GRP column, so the parent filter and the include's where
// filter the same column name: their binds must stay apart.
const Parents = defineTable(PARENT, { ID: t.number(10).primaryKey(), NAME: t.text(20), GRP: t.number(2) });
const Children = defineTable(CHILD, {
  ID: t.number(10).primaryKey(),
  PARENT_ID: t.number(10).references(Parents, "ID"),
  POS: t.number(3),
  GRP: t.number(2),
  LABEL: t.text(20),
  AMT: t.money(),
});
const ParentsR = relations(Parents, {
  kids: hasMany(Children, { foreignKey: "PARENT_ID" }),
  top: hasOne(Children, { foreignKey: "PARENT_ID" }),
});
const ChildrenR = relations(Children, { parent: belongsTo(Parents, { foreignKey: "PARENT_ID" }) });

type Par = { ID: number; NAME: string; GRP: number };
type Kid = { ID: number; PARENT_ID: number; POS: number; GRP: number; LABEL: string; AMT: string };
const PARENTS: Par[] = Array.from({ length: 15 }, (_, k) => ({ ID: k + 1, NAME: `p${k + 1}`, GRP: (k + 1) % 3 }));
const KIDS: Kid[] = [];
for (const p of PARENTS) {
  // Parent n has n % 6 children (0..5); inserted in reverse POS order so the sort matters.
  const n = p.ID % 6;
  for (let j = n - 1; j >= 0; j--) KIDS.push({ ID: KIDS.length + 1, PARENT_ID: p.ID, POS: j, GRP: (p.ID + j) % 3, LABEL: `c${p.ID}-${j}`, AMT: `${j + 1}.25` });
}
const kidsOf = (pid: number) => KIDS.filter((k) => k.PARENT_ID === pid);

function includeRead(i: number): { run: () => Promise<unknown>; model: () => unknown } {
  const g = i % 3;
  const h = Math.floor(i / 3) % 3;
  const lim = (i % 4) + 1;
  switch (Math.floor(i / 9) % 4) {
    case 0:
      return {
        run: () => ParentsR.on(db).find({ GRP: g }).sort({ ID: 1 }).include("kids", { where: { GRP: h }, sort: { POS: 1 } }).toArray(),
        model: () =>
          PARENTS.filter((p) => p.GRP === g).map((p) => ({ ...p, kids: kidsOf(p.ID).filter((k) => k.GRP === h).sort(by<Kid>(["POS", 1])) })),
      };
    case 1:
      return {
        run: () => ParentsR.on(db).find({ GRP: { $ne: g } }).sort({ ID: -1 }).include("kids", { sort: { POS: -1 }, limit: lim }).toArray(),
        model: () =>
          PARENTS.filter((p) => p.GRP !== g)
            .sort(by<Par>(["ID", -1]))
            .map((p) => ({ ...p, kids: kidsOf(p.ID).sort(by<Kid>(["POS", -1])).slice(0, lim) })),
      };
    case 2: {
      const ids = [g + 1, g + 4, g + 7, g + 10, h + 12];
      return {
        run: () =>
          ParentsR.on(db)
            .find({ ID: { $in: ids }, GRP: { $gte: 0 } })
            .sort({ ID: 1 })
            .project({ ID: 1, NAME: 1 })
            .include("top", { where: { GRP: h }, sort: { POS: -1 } })
            .include("kids", { where: { POS: { $gte: lim - 1 } }, sort: { ID: 1 } })
            .toArray(),
        model: () =>
          PARENTS.filter((p) => ids.includes(p.ID))
            .sort(by<Par>(["ID", 1]))
            .map((p) => ({
              ID: p.ID,
              NAME: p.NAME,
              top: kidsOf(p.ID).filter((k) => k.GRP === h).sort(by<Kid>(["POS", -1]))[0] ?? null,
              kids: kidsOf(p.ID).filter((k) => k.POS >= lim - 1).sort(by<Kid>(["ID", 1])),
            })),
      };
    }
    default:
      return {
        run: () => ChildrenR.on(db).find({ GRP: g, POS: { $lte: lim } }).sort({ ID: 1 }).include("parent").toArray(),
        model: () =>
          KIDS.filter((k) => k.GRP === g && k.POS <= lim)
            .sort(by<Kid>(["ID", 1]))
            .map((k) => ({ ...k, parent: PARENTS.find((p) => p.ID === k.PARENT_ID) })),
      };
  }
}

// ── Scenario 3: CTEs ──────────────────────────────────────────────────────────

/** Binary org tree: 31 employees, ID n reports to floor(n / 2). */
const EMPS = Array.from({ length: 31 }, (_, k) => ({ ID: k + 1, MANAGER_ID: k === 0 ? null : Math.floor((k + 1) / 2), NAME: `e${k + 1}` }));
type EmpRow = (typeof EMPS)[number] & { LVL: number };
function subtree(root: number): EmpRow[] {
  const out: EmpRow[] = [];
  let level = EMPS.filter((e) => e.ID === root);
  for (let lvl = 1; level.length; lvl++) {
    out.push(...level.map((e) => ({ ...e, LVL: lvl })));
    const ids = new Set(level.map((e) => e.ID));
    level = EMPS.filter((e) => e.MANAGER_ID !== null && ids.has(e.MANAGER_ID));
  }
  return out.sort(by<EmpRow>(["LVL", 1], ["ID", 1]));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await dropIfExists(ITEM, CHILD, PARENT, EMP);
  await Items.create(db);
  await Parents.create(db);
  await Children.create(db);
  await schema.createTable(EMP, { ID: { type: "NUMBER", primaryKey: true }, MANAGER_ID: { type: "NUMBER" }, NAME: { type: "VARCHAR2(20)" } });

  for (let id = 1; id <= 80; id++) items.set(id, itemRow(id));
  await Items.on(db).insertMany(all(), { returning: [] });
  await Parents.on(db).insertMany(PARENTS, { returning: [] });
  await Children.on(db).insertMany(KIDS, { returning: [] });
  await coll(EMP).insertMany(EMPS, { returning: [] });
}, 30000);
afterAll(() => dropIfExists(ITEM, CHILD, PARENT, EMP));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reliability: concurrency gives the sequential answer", () => {
  it("typed table: 50 concurrent mixed reads (filters, sort, limit, skip, projection, count, distinct) equal the sequential baseline", async () => {
    const jobs = Array.from({ length: N }, (_, i) => itemRead(i));
    const { seq, conc } = await compare("typed reads", (i) => jobs[i].run());
    expect(seq).toEqual(jobs.map((j) => j.model()));
    expect(conc).toEqual(seq);
    expect(await appDbInUse()).toBe(0);
  }, 30000);

  it("typed table: writes on disjoint rows beside reads of untouched rows; reads equal the baseline, final table equals the model", async () => {
    // Readers only see CAT "Z" (ID % 4 === 3); writers only touch other rows, and insert CAT "A".
    const isZ = (r: Item) => r.CAT === "Z";
    const reads = Array.from({ length: N }, (_, i) => itemRead(i, isZ));
    const baseline = await sequential(N, (i) => reads[i].run());
    expect(baseline).toEqual(reads.map((r) => r.model()));

    const targets = [...items.keys()].filter((id) => id % 4 !== 3).slice(0, N); // 50 non-Z rows, one writer each
    const on = Items.on(db);
    const write = (k: number): Promise<unknown> => {
      const id = targets[k];
      switch (k % 3) {
        case 0:
          return on.updateOne({ ID: id }, { $set: { QTY: 500 + id, NOTE: `w${id}` } });
        case 1:
          return on.deleteOne({ ID: id });
        default:
          return on.insertOne({ ...itemRow(1000 + id), CAT: "A" }, { returning: [] });
      }
    };
    // Interleave: even jobs read, odd jobs write.
    const [out, ms] = await timeIt(() => bounded(2 * N, CONC, (j) => (j % 2 === 0 ? reads[j / 2].run() : write((j - 1) / 2))));
    m("concurrency: disjoint writes + reads (100 jobs)", Math.round(ms), "ms");
    expect(out.filter((_, j) => j % 2 === 0)).toEqual(baseline);

    targets.forEach((id, k) => {
      if (k % 3 === 0) items.set(id, { ...items.get(id)!, QTY: 500 + id, NOTE: `w${id}` });
      else if (k % 3 === 1) items.delete(id);
      else items.set(1000 + id, { ...itemRow(1000 + id), CAT: "A" });
    });
    expect(await on.find({}).sort({ ID: 1 }).toArray()).toEqual(all().sort(by<Item>(["ID", 1])));
    expect(await appDbInUse()).toBe(0);
  }, 30000);

  it("aggregate: 50 concurrent pipelines with different $match values each equal their own baseline", async () => {
    const job = (i: number) => {
      const cats = [CATS[i % 4], CATS[(i + 1 + Math.floor(i / 4)) % 4]];
      const q = (i * 7) % 90;
      return {
        run: () =>
          Items.on(db).aggregate<{ CAT: string; N: number; Q: number }>([
            { $match: { CAT: { $in: cats }, QTY: { $gte: q } } },
            { $group: { _id: { CAT: "$CAT" }, N: { $sum: 1 }, Q: { $sum: "$QTY" } } },
            { $sort: { CAT: 1 } },
          ]),
        model: () => {
          const g = new Map<string, { CAT: string; N: number; Q: number }>();
          for (const r of all().filter((r) => cats.includes(r.CAT as never) && r.QTY >= q)) {
            const e = g.get(r.CAT) ?? { CAT: r.CAT, N: 0, Q: 0 };
            e.N++;
            e.Q += r.QTY;
            g.set(r.CAT, e);
          }
          return [...g.values()].sort(by<{ CAT: string }>(["CAT", 1]));
        },
      };
    };
    const jobs = Array.from({ length: N }, (_, i) => job(i));
    const { seq, conc } = await compare("aggregate", (i) => jobs[i].run());
    expect(seq).toEqual(jobs.map((j) => j.model()));
    expect(conc).toEqual(seq);
    expect(await appDbInUse()).toBe(0);
  }, 30000);

  it("include(): 50 concurrent hasMany / hasOne / belongsTo queries equal the sequential baseline; every child sits on its own parent", async () => {
    const jobs = Array.from({ length: N }, (_, i) => includeRead(i));
    const { seq, conc } = await compare("include", (i) => jobs[i].run());
    expect(seq).toEqual(jobs.map((j) => j.model()));
    expect(conc).toEqual(seq);
    // No child attached to the wrong parent, in any concurrent result.
    for (const rows of conc as Record<string, unknown>[][])
      for (const r of rows) {
        for (const k of (r.kids as Kid[] | undefined) ?? []) expect(k.PARENT_ID).toBe(r.ID as number);
        if (r.top) expect((r.top as Kid).PARENT_ID).toBe(r.ID as number);
        if (r.parent) expect((r.parent as Par).ID).toBe(r.PARENT_ID as number);
      }
    expect(await appDbInUse()).toBe(0);
  }, 30000);

  it("withCTE: 50 concurrent two-CTE joins with different bind values each equal their own baseline", async () => {
    const job = (i: number) => {
      const g = i % 3;
      const h = Math.floor(i / 3) % 3;
      const p = Math.floor(i / 9) % 5;
      return {
        run: () =>
          withCTE(db, {
            // Both CTEs filter GRP: each keeps its own value.
            PA: coll(PARENT).find({ GRP: g }).project({ ID: 1, NAME: 1 }),
            KB: coll(CHILD).find({ GRP: h, POS: { $gte: p } }).project({ PARENT_ID: 1, POS: 1, LABEL: 1 }),
          })
            .from("PA")
            .join({ from: "KB", localField: "ID", foreignField: "PARENT_ID" })
            .sort({ ID: 1, POS: 1 })
            .toArray(),
        model: () =>
          PARENTS.filter((pa) => pa.GRP === g)
            .flatMap((pa) => KIDS.filter((k) => k.PARENT_ID === pa.ID && k.GRP === h && k.POS >= p).map((k) => ({ ID: pa.ID, NAME: pa.NAME, PARENT_ID: k.PARENT_ID, POS: k.POS, LABEL: k.LABEL })))
            .sort(by<{ ID: number; POS: number }>(["ID", 1], ["POS", 1])),
      };
    };
    const jobs = Array.from({ length: N }, (_, i) => job(i));
    const { seq, conc } = await compare("withCTE", (i) => jobs[i].run());
    expect(seq).toEqual(jobs.map((j) => j.model()));
    expect(conc).toEqual(seq);
    expect(await appDbInUse()).toBe(0);
  }, 30000);

  it("withRecursiveCTE: 50 concurrent subtree walks from different roots each equal their own baseline", async () => {
    const roots = Array.from({ length: N }, (_, i) => (i * 11) % 31 + 1);
    const run = (i: number) =>
      withRecursiveCTE(db, "T", { anchor: coll(EMP).find({ ID: roots[i] }), recursive: { collection: EMP, joinOn: { MANAGER_ID: "$T.ID" } } })
        .sort({ LVL: 1, ID: 1 })
        .toArray();
    const { seq, conc } = await compare("withRecursiveCTE", run);
    expect(seq).toEqual(roots.map(subtree));
    expect(conc).toEqual(seq);
    expect(await appDbInUse()).toBe(0);
  }, 30000);
});
