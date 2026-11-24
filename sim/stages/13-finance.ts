/**
 * Stage 13 — Treasury and management reporting: import invoices converted at
 * the exchange rate in force on their date, the bank-loan schedule and the
 * depreciation schedule (both checked against what the ledger posted), sales
 * CUBE / GROUPING SETS, and a bonus pool split across branches to the cent.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { STORES, T, type State } from "../lib/data";
import { DEPRECIATION_MONTHLY, E, FX, IMPORTS, LOAN, allocate, amortize, convert, iso } from "../lib/enterprise";

export async function financeStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const schema = new api.OracleSchema(db);
  const coll = (t: string) => new api.OracleCollection(t, db);
  const lines = coll(E.LINES);
  const postedOnly = { $lookup: { from: E.JOURNALS, localField: "JOURNAL_ID", foreignField: "JOURNAL_ID", as: "j", joinType: "inner", select: ["STATUS", "JDATE"] } };

  // ── Foreign currency ───────────────────────────────────────────────────────
  await schema.createTable(E.FX, { CCY: { type: "CHAR(3)" }, RDATE: { type: "DATE" }, RATE: { type: "NUMBER(12,6)" } });
  await schema.createTable(E.IMPORTS, { INV_NO: { type: "VARCHAR2(10)", primaryKey: true }, CCY: { type: "CHAR(3)" }, IDATE: { type: "DATE" }, AMOUNT: { type: "NUMBER(14,2)" } });
  await coll(E.FX).insertMany(FX, { returning: [] });
  await coll(E.IMPORTS).insertMany(IMPORTS.map((x) => ({ ...x, AMOUNT: x.AMOUNT / 100 })), { returning: [] });
  const fx = await sim.viaSql("conversion at the rate in force on the invoice date", "the latest rate on or before a date needs a correlated subquery with a <= condition (or KEEP (DENSE_RANK LAST)); Mira's correlated subqueries only take equality", () =>
    raw<{ INV_NO: string; PHP: string | null }>(
      `SELECT i.INV_NO,
              ROUND(i.AMOUNT * (SELECT MAX(r.RATE) KEEP (DENSE_RANK LAST ORDER BY r.RDATE)
                                  FROM "${E.FX}" r WHERE r.CCY = i.CCY AND r.RDATE <= i.IDATE), 2) AS PHP
         FROM "${E.IMPORTS}" i ORDER BY i.INV_NO`,
    ),
  );
  sim.eq("FX: each import in pesos at the rate in force that day; no JPY rate → no amount", fx.map((r) => [r.INV_NO, r.PHP == null ? null : cents(r.PHP)]), IMPORTS.map((x) => [x.INV_NO, convert(x)]));

  // ── Loan schedule (recursive) vs what the ledger posted ─────────────────────
  const sched = await sim.viaSql("loan amortization schedule", "a running balance where each row depends on the previous row's result needs a recursive WITH carrying expressions (or MODEL)", () =>
    raw<{ N: number; INTEREST: number; PRINCIPAL: number; BAL: number }>(
      `WITH pay AS (SELECT ROUND(:p * :r / (1 - POWER(1 + :r, -:m))) AS PMT FROM DUAL),
            a (N, BAL, INTEREST, PRINCIPAL) AS (
              SELECT 0, :p, 0, 0 FROM DUAL
              UNION ALL
              SELECT a.N + 1,
                     a.BAL - CASE WHEN a.N + 1 = :m THEN a.BAL ELSE (SELECT PMT FROM pay) - ROUND(a.BAL * :r) END,
                     ROUND(a.BAL * :r),
                     CASE WHEN a.N + 1 = :m THEN a.BAL ELSE (SELECT PMT FROM pay) - ROUND(a.BAL * :r) END
                FROM a WHERE a.N < :m)
       SELECT N, INTEREST, PRINCIPAL, BAL FROM a WHERE N > 0 ORDER BY N`,
      { p: LOAN.PRINCIPAL, r: LOAN.RATE_MONTH, m: LOAN.MONTHS },
    ),
  );
  const loan = amortize();
  sim.eq("loan: interest, principal and balance for all 12 instalments", sched.map((r) => [Number(r.N), Number(r.INTEREST), Number(r.PRINCIPAL), Number(r.BAL)]), loan.rows.map((r) => [r.n, r.interest, r.principal, r.balance]));
  const loanGl = await sim.mira(() => lines.aggregate([postedOnly, { $match: { STATUS: "posted", ACCOUNT_CODE: { $in: ["2400", "5400"] }, DEBIT: { $gt: 0 } } }, { $group: { _id: "$ACCOUNT_CODE", D: { $sum: "$DEBIT" } } }, { $sort: { ACCOUNT_CODE: 1 } }]));
  sim.eq("ledger: principal repaid and interest expensed match the schedule", loanGl.map((r) => [r.ACCOUNT_CODE, cents(r.D)]), [["2400", LOAN.PRINCIPAL], ["5400", loan.rows.reduce((s, r) => s + r.interest, 0)]]);
  sim.eq("loan account is fully repaid", model.gl.filter((l) => l.acct === "2400" && l.status === "posted").reduce((s, l) => s + l.dr - l.cr, 0), 0);

  // ── Depreciation schedule (row generator) vs the ledger ────────────────────
  const dep = await sim.viaSql("depreciation schedule (month-end dates)", "a row generator (CONNECT BY LEVEL) and date functions (ADD_MONTHS, LAST_DAY) are not exposed", () =>
    raw<{ D: string }>(`SELECT TO_CHAR(LAST_DAY(ADD_MONTHS(DATE '2026-01-01', LEVEL - 1)), 'YYYY-MM-DD') AS D FROM DUAL CONNECT BY LEVEL <= 12`),
  );
  const depGl = await sim.mira(() => lines.aggregate([postedOnly, { $match: { STATUS: "posted", ACCOUNT_CODE: "5300", DEBIT: { $gt: 0 } } }, { $sort: { JDATE: 1 } }]));
  sim.eq("depreciation: one 2,000.00 charge on each month-end of the schedule", depGl.map((r) => [iso(r.JDATE as Date), cents(r.DEBIT)]), dep.map((r) => [r.D, DEPRECIATION_MONTHLY]));

  // ── Sales CUBE and GROUPING SETS ───────────────────────────────────────────
  const orders = coll(T.ORDERS);
  const sum = (f: (o: (typeof model.orders)[number]) => boolean) => model.orders.filter(f).reduce((s, o) => s + o.total, 0);
  const keyOf = (r: Record<string, unknown>) => `${r.STORE_ID ?? "*"}|${r.QUARTER ?? "*"}`;
  const cube = await sim.mira(() => orders.aggregate([{ $group: { _id: { $cube: ["STORE_ID", "QUARTER"] }, T: { $sum: "$TOTAL" } } }]));
  const cubeWant: Record<string, number> = { "*|*": sum(() => true) };
  for (const o of model.orders) {
    cubeWant[`${o.storeId}|${o.quarter}`] = sum((x) => x.storeId === o.storeId && x.quarter === o.quarter);
    cubeWant[`${o.storeId}|*`] = sum((x) => x.storeId === o.storeId);
    cubeWant[`*|${o.quarter}`] = sum((x) => x.quarter === o.quarter);
  }
  sim.eq("CUBE: sales by branch × quarter with every subtotal and the grand total", Object.fromEntries(cube.map((r) => [keyOf(r), cents(r.T)])), cubeWant);
  const gs = await sim.mira(() => orders.aggregate([{ $group: { _id: { $groupingSets: [["STORE_ID"], ["QUARTER"], []] }, T: { $sum: "$TOTAL" } } }]));
  sim.eq(
    "GROUPING SETS: per branch, per quarter and overall (no branch × quarter rows)",
    Object.fromEntries(gs.map((r) => [keyOf(r), cents(r.T)])),
    Object.fromEntries(Object.entries(cubeWant).filter(([k]) => k.includes("*"))),
  );

  // ── Bonus pool split across branches to the cent ───────────────────────────
  const POOL = 100_000_00;
  // Largest remainder: floor every exact share, then hand the leftover cents to the
  // largest remainders (ties to the lower branch id).
  const split = await sim.mira(() =>
    coll(T.ORDERS).aggregate([
      { $group: { _id: "$STORE_ID", W: { $sum: "$TOTAL" } } },
      { $addFields: { EXACT: { $divide: [{ $mul: [POOL, "$W"] }, { $window: { fn: "SUM", field: "W" } }] } } },
      { $addFields: { BASE: { $floor: "$EXACT" }, REM: { $subtract: ["$EXACT", { $floor: "$EXACT" }] } } },
      { $addFields: { RN: { $window: { fn: "ROW_NUMBER", orderBy: { REM: -1, STORE_ID: 1 } } }, SUMBASE: { $window: { fn: "SUM", field: "BASE" } } } },
      { $addFields: { PART: { $add: ["$BASE", { $cond: { if: { $lte: ["$RN", { $subtract: [POOL, "$SUMBASE"] }] }, then: 1, else: 0 } }] } } },
      { $sort: { STORE_ID: 1 } },
    ]),
  );
  const want = allocate(POOL, STORES.map((s) => [String(s.STORE_ID), sum((o) => o.storeId === s.STORE_ID)]));
  sim.eq("allocation: each branch's share (largest remainder)", split.map((r) => [String(r.STORE_ID), Number(r.PART)]), [...want]);
  sim.eq("allocation: the parts add up to the pool exactly", split.reduce((s, r) => s + Number(r.PART), 0), POOL);
}
