/**
 * Stage 10 — Receivables and payables. Three corporate accounts are invoiced
 * monthly and pay irregularly; suppliers are paid, once twice by mistake.
 *
 * Checks: balance per customer, receipts applied to the oldest invoice first
 * (FIFO), aging buckets as of year end, the invoice-number gap, and duplicate
 * supplier payments, each against the JS model.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import type { State } from "../lib/data";
import { AP_PAYMENTS, AR_INVOICES, AR_RECEIPTS, AS_OF, E, agingBucket, fifoOpen, iso } from "../lib/enterprise";

export async function receivablesStage(sim: Sim, ctx: Ctx, _state: State) {
  const { api, db, raw } = ctx;
  const schema = new api.OracleSchema(db);
  const coll = (t: string) => new api.OracleCollection(t, db);
  const inv = coll(E.AR_INV);
  const rcpt = coll(E.AR_RCPT);

  await schema.createTable(E.AR_INV, {
    INV_NO: { type: "NUMBER", primaryKey: true },
    CUSTOMER: { type: "VARCHAR2(20)", notNull: true },
    INV_DATE: { type: "DATE", notNull: true },
    DUE_DATE: { type: "DATE", notNull: true },
    AMOUNT: { type: "NUMBER(14,2)", notNull: true, check: "AMOUNT > 0" },
  });
  await schema.createTable(E.AR_RCPT, { RCPT_ID: { type: "NUMBER", primaryKey: true }, CUSTOMER: { type: "VARCHAR2(20)" }, RDATE: { type: "DATE" }, AMOUNT: { type: "NUMBER(14,2)" } });
  await schema.createTable(E.AP_PAY, { PAY_ID: { type: "NUMBER", primaryKey: true }, SUPPLIER: { type: "VARCHAR2(20)" }, INV_REF: { type: "VARCHAR2(20)" }, PDATE: { type: "DATE" }, AMOUNT: { type: "NUMBER(14,2)" } });
  await inv.insertMany(AR_INVOICES.map((x) => ({ ...x, AMOUNT: x.AMOUNT / 100 })), { returning: [] });
  await rcpt.insertMany(AR_RECEIPTS.map((x) => ({ ...x, AMOUNT: x.AMOUNT / 100 })), { returning: [] });
  await coll(E.AP_PAY).insertMany(AP_PAYMENTS.map((x) => ({ ...x, AMOUNT: x.AMOUNT / 100 })), { returning: [] });
  sim.eq("invoice dates round-trip as calendar dates", (await inv.find({}).sort({ INV_NO: 1 }).project({ INV_DATE: 1 }).toArray<{ INV_DATE: Date }>()).map((r) => iso(r.INV_DATE)), AR_INVOICES.map((x) => iso(x.INV_DATE)));

  // Balance per customer: invoiced minus received, as two aggregates through Mira.
  const billed = await sim.mira(() => inv.aggregate([{ $group: { _id: "$CUSTOMER", T: { $sum: "$AMOUNT" } } }, { $sort: { CUSTOMER: 1 } }]));
  const paid = await sim.mira(() => rcpt.aggregate([{ $group: { _id: "$CUSTOMER", T: { $sum: "$AMOUNT" } } }, { $sort: { CUSTOMER: 1 } }]));
  const open = fifoOpen();
  const custs = ["ACME", "GLOBEX", "INITECH"];
  const owed = (c: string) => AR_INVOICES.filter((x) => x.CUSTOMER === c).reduce((s, x) => s + (open.get(x.INV_NO) ?? 0), 0);
  sim.eq(
    "customer balance = invoiced − received",
    custs.map((c) => [c, cents(billed.find((r) => r.CUSTOMER === c)?.T) - cents(paid.find((r) => r.CUSTOMER === c)?.T)]),
    custs.map((c) => [c, owed(c)]),
  );

  // Receipts applied to the oldest invoice first: running total of each customer's invoices,
  // their total receipts joined from a grouped pipeline, then LEAST / GREATEST per invoice.
  const openStages = [
    { $addFields: { CUM_END: { $window: { fn: "SUM", field: "AMOUNT", partitionBy: "CUSTOMER", orderBy: { INV_NO: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } } } },
    { $lookup: { from: E.AR_RCPT, pipeline: [{ $group: { _id: "$CUSTOMER", PAID: { $sum: "$AMOUNT" } } }], localField: "CUSTOMER", foreignField: "CUSTOMER", as: "p", joinType: "left", select: ["PAID"] } },
    { $addFields: { OPEN_AMT: { $subtract: ["$AMOUNT", { $min: ["$AMOUNT", { $max: [0, { $subtract: [{ $ifNull: ["$PAID", 0] }, { $subtract: ["$CUM_END", "$AMOUNT"] }] }] }] }] } } },
  ];
  const fifo = await sim.mira(() => inv.aggregate([...openStages, { $sort: { INV_NO: 1 } }]));
  sim.eq("FIFO application: open amount of every invoice", fifo.map((r) => [Number(r.INV_NO), cents(r.OPEN_AMT)]), AR_INVOICES.map((x) => [x.INV_NO, open.get(x.INV_NO)]));

  // Aging buckets as of year end: days past due ($dateDiff) into buckets ($switch).
  const aging = await sim.mira(() =>
    inv.aggregate([
      ...openStages,
      { $match: { OPEN_AMT: { $gt: 0 } } },
      { $addFields: { LATE: { $dateDiff: { startDate: "$DUE_DATE", endDate: AS_OF, unit: "day" } } } },
      {
        $addFields: {
          BUCKET: {
            $switch: {
              branches: [
                { case: { $lte: ["$LATE", 0] }, then: "current" },
                { case: { $lte: ["$LATE", 30] }, then: "1-30" },
                { case: { $lte: ["$LATE", 60] }, then: "31-60" },
                { case: { $lte: ["$LATE", 90] }, then: "61-90" },
              ],
              default: "90+",
            },
          },
        },
      },
      { $group: { _id: "$BUCKET", N: { $count: "*" }, OPEN_AMT: { $sum: "$OPEN_AMT" } } },
      { $sort: { BUCKET: 1 } },
    ]),
  );
  const want: Record<string, [number, number]> = {};
  for (const x of AR_INVOICES) {
    const o = open.get(x.INV_NO)!;
    if (o <= 0) continue;
    const b = agingBucket(x);
    want[b] = [(want[b]?.[0] ?? 0) + 1, (want[b]?.[1] ?? 0) + o];
  }
  sim.eq("aging: open invoices and amounts per bucket at 31 Dec", Object.fromEntries(aging.map((r) => [r.BUCKET, [Number(r.N), cents(r.OPEN_AMT)]])), want);

  // The missing invoice number: LAG through Mira's window functions.
  const gaps = await sim.mira(() =>
    inv.aggregate([
      { $project: { INV_NO: 1, PREV: { $window: { fn: "LAG", field: "INV_NO", orderBy: { INV_NO: 1 } } } } },
      { $addFields: { STEP: { $subtract: ["$INV_NO", "$PREV"] } } },
      { $match: { STEP: { $gt: 1 } } },
    ]),
  );
  sim.eq("invoice-number gap: 5009 was never issued (found after 5008)", gaps.map((r) => [Number(r.PREV), Number(r.INV_NO)]), [[5008, 5010]]);

  // Duplicate supplier payments: same supplier, invoice and amount paid more than once.
  const dups = await sim.mira(() =>
    coll(E.AP_PAY).aggregate([{ $group: { _id: { SUPPLIER: "$SUPPLIER", INV_REF: "$INV_REF", AMOUNT: "$AMOUNT" }, N: { $count: "*" } } }, { $having: { N: { $gt: 1 } } }]),
  );
  sim.eq("duplicate payments: FreshFarm FF-102 paid twice", dups.map((r) => [r.SUPPLIER, r.INV_REF, cents(r.AMOUNT), Number(r.N)]), [["FreshFarm", "FF-102", 512_500, 2]]);
}
