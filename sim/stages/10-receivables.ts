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

  // Receipts applied to the oldest invoice first.
  const fifo = await sim.viaSql("receipts applied oldest invoice first (FIFO)", "needs a running total of invoices compared with total receipts and GREATEST/LEAST arithmetic; Mira's $window gives the running total but there is no GREATEST/LEAST or column-to-column expression", () =>
    raw<{ INV_NO: number; OPEN_AMT: string }>(
      `WITH i AS (SELECT INV_NO, CUSTOMER, AMOUNT,
                         SUM(AMOUNT) OVER (PARTITION BY CUSTOMER ORDER BY INV_NO ROWS UNBOUNDED PRECEDING) AS CUM_END
                    FROM "${E.AR_INV}"),
            p AS (SELECT CUSTOMER, SUM(AMOUNT) AS PAID FROM "${E.AR_RCPT}" GROUP BY CUSTOMER)
       SELECT i.INV_NO,
              i.AMOUNT - LEAST(i.AMOUNT, GREATEST(0, NVL(p.PAID, 0) - (i.CUM_END - i.AMOUNT))) AS OPEN_AMT
         FROM i LEFT JOIN p ON p.CUSTOMER = i.CUSTOMER
        ORDER BY i.INV_NO`,
    ),
  );
  sim.eq("FIFO application: open amount of every invoice", fifo.map((r) => [Number(r.INV_NO), cents(r.OPEN_AMT)]), AR_INVOICES.map((x) => [x.INV_NO, open.get(x.INV_NO)]));

  // Aging buckets as of year end.
  const aging = await sim.viaSql("aging buckets as of a date", "days past due needs date arithmetic (DATE - DATE) in a projection; Mira's pipeline has only $dateToString", () =>
    raw<{ BUCKET: string; N: number; OPEN_AMT: string }>(
      `WITH i AS (SELECT INV_NO, CUSTOMER, AMOUNT, DUE_DATE,
                         SUM(AMOUNT) OVER (PARTITION BY CUSTOMER ORDER BY INV_NO ROWS UNBOUNDED PRECEDING) AS CUM_END
                    FROM "${E.AR_INV}"),
            p AS (SELECT CUSTOMER, SUM(AMOUNT) AS PAID FROM "${E.AR_RCPT}" GROUP BY CUSTOMER),
            o AS (SELECT i.DUE_DATE, i.AMOUNT - LEAST(i.AMOUNT, GREATEST(0, NVL(p.PAID, 0) - (i.CUM_END - i.AMOUNT))) AS OPEN_AMT
                    FROM i LEFT JOIN p ON p.CUSTOMER = i.CUSTOMER)
       SELECT CASE WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 0 THEN 'current'
                   WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 30 THEN '1-30'
                   WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 60 THEN '31-60'
                   WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 90 THEN '61-90' ELSE '90+' END AS BUCKET,
              COUNT(*) AS N, SUM(OPEN_AMT) AS OPEN_AMT
         FROM o WHERE OPEN_AMT > 0
        GROUP BY CASE WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 0 THEN 'current'
                      WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 30 THEN '1-30'
                      WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 60 THEN '31-60'
                      WHEN TO_DATE(:asof, 'YYYY-MM-DD') - DUE_DATE <= 90 THEN '61-90' ELSE '90+' END
        ORDER BY 1`,
      { asof: iso(AS_OF) },
    ),
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
