/**
 * Stage 14 — Internal audit. Tests an auditor runs over the year: the
 * first-digit (Benford) distribution of sales, a journal header with no lines,
 * and supplier payments split to stay under the approval limit.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";
import { APPROVAL_LIMIT, E, d, firstDigit, periodOf, splitRuns } from "../lib/enterprise";

export async function auditStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);

  // Benford: how often each leading digit starts a sale total.
  const benford = await sim.mira(() =>
    coll(T.ORDERS).aggregate([{ $project: { FD: { $substr: ["$TOTAL", 1, 1] } } }, { $group: { _id: "$FD", N: { $count: "*" } } }, { $sort: { FD: 1 } }]),
  );
  const want: Record<string, number> = {};
  for (const o of model.orders) want[firstDigit(o.total)] = (want[firstDigit(o.total)] ?? 0) + 1;
  sim.eq("Benford: leading-digit counts of every sale total", Object.fromEntries(benford.map((r) => [String(r.FD), Number(r.N)])), want);

  // A journal header someone saved without any lines (anti-join via $notExists).
  const orphan = model.nextJid++;
  await coll(E.JOURNALS).insertOne({ JOURNAL_ID: orphan, JDATE: d(2026, 12, 31), PERIOD: periodOf(d(2026, 12, 31)), SOURCE: "MANUAL", REF: "Header only", STATUS: "draft" });
  const empty = await sim.mira(() => coll(E.JOURNALS).find({ $notExists: { collection: E.LINES, match: { JOURNAL_ID: "$JOURNAL_ID" } } }).project({ JOURNAL_ID: 1 }).toArray<{ JOURNAL_ID: number }>());
  sim.eq("journals without lines: only the header saved on its own", empty.map((r) => Number(r.JOURNAL_ID)), [orphan]);

  // Split payments: consecutive small payments to one supplier, a few days apart, that together pass the limit.
  const split = await sim.mira(() =>
    coll(E.AP_PAY).aggregate([
      {
        $matchRecognize: {
          partitionBy: ["SUPPLIER"],
          orderBy: { PDATE: 1, PAY_ID: 1 },
          measures: { FIRST_ID: { $first: "$PAY_ID" }, LAST_ID: { $last: "$PAY_ID" }, N: { $count: "*" }, TOTAL: { $sum: "$AMOUNT" } },
          pattern: "A B+",
          define: {
            A: { $lt: ["$AMOUNT", APPROVAL_LIMIT / 100] },
            B: { $and: [{ $lt: ["$AMOUNT", APPROVAL_LIMIT / 100] }, { $lte: [{ $subtract: ["$PDATE", { $prev: "$PDATE" }] }, 3] }] },
          },
        },
      },
      { $match: { TOTAL: { $gt: APPROVAL_LIMIT / 100 } } },
      { $sort: { SUPPLIER: 1, FIRST_ID: 1 } },
    ]),
  );
  sim.eq(
    "split payments ($matchRecognize): runs of sub-limit payments that together pass the limit",
    split.map((r) => ({ supplier: r.SUPPLIER, first: Number(r.FIRST_ID), last: Number(r.LAST_ID), n: Number(r.N), total: Math.round(Number(r.TOTAL) * 100) })),
    splitRuns(),
  );
}
