/**
 * Stage 9 — General ledger. Every event of the year is posted as a balanced
 * double-entry journal: opening capital, customer deposits, opening stock and
 * its supplier payment, every completed till sale (revenue split food / drink,
 * cost of goods at 40%), mid-year purchases, payroll, depreciation and a loan.
 * One draft journal is deliberately unbalanced.
 *
 * Then the accountant's queries, each compared with the JS ledger: unbalanced
 * journals, trial balance, account-tree roll-up, the cash ledger card with a
 * running balance, budget vs actual, ROLLUP subtotals, the quarterly P&L (PIVOT),
 * month-on-month revenue (LAG), and the year-end close into retained earnings.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { CUSTOMERS, PRODUCTS, STORES, T, stockFor, type State } from "../lib/data";
import { ACCOUNTS, CATEGORY, COST, DEPRECIATION_MONTHLY, E, EQUIPMENT, LOAN, OPENING_CASH, PURCHASES, TYPE_OF, amortize, d, periodOf, quarterOf, saleDate } from "../lib/enterprise";

type JLine = { acct: string; dr: number; cr: number };

export async function ledgerStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const schema = new api.OracleSchema(db);
  const coll = (t: string) => new api.OracleCollection(t, db);
  const lines = coll(E.LINES);
  const tx = new api.Transaction(db);

  await schema.createTable(E.ACCOUNTS, {
    CODE: { type: "VARCHAR2(10)", primaryKey: true },
    NAME: { type: "VARCHAR2(40)", notNull: true },
    TYPE: { type: "VARCHAR2(10)", notNull: true, check: "TYPE IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')" },
    PARENT_CODE: { type: "VARCHAR2(10)" },
  });
  await schema.createTable(E.JOURNALS, {
    JOURNAL_ID: { type: "NUMBER", primaryKey: true },
    JDATE: { type: "DATE", notNull: true },
    PERIOD: { type: "VARCHAR2(7)", notNull: true },
    SOURCE: { type: "VARCHAR2(12)" },
    REF: { type: "VARCHAR2(40)" },
    STATUS: { type: "VARCHAR2(8)", default: "'posted'" },
  });
  await schema.createTable(E.LINES, {
    LINE_ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    JOURNAL_ID: { type: "NUMBER", notNull: true, references: { table: E.JOURNALS, column: "JOURNAL_ID" } },
    ACCOUNT_CODE: { type: "VARCHAR2(10)", notNull: true, references: { table: E.ACCOUNTS, column: "CODE" } },
    PERIOD: { type: "VARCHAR2(7)", notNull: true },
    QUARTER: { type: "VARCHAR2(2)", notNull: true },
    DEBIT: { type: "NUMBER(14,2)", default: 0, notNull: true, check: "DEBIT >= 0" },
    CREDIT: { type: "NUMBER(14,2)", default: 0, notNull: true, check: "CREDIT >= 0" },
    // A virtual column: signed amount, debit positive. Mira passes the type text through.
    NET: { type: "NUMBER GENERATED ALWAYS AS (DEBIT - CREDIT) VIRTUAL" },
  });
  await coll(E.ACCOUNTS).insertMany(ACCOUNTS.map(({ CODE, NAME, TYPE, PARENT_CODE }) => ({ CODE, NAME, TYPE, PARENT_CODE })), { returning: [] });

  // ── Posting ────────────────────────────────────────────────────────────────
  type J = { date: Date; source: string; ref: string; status?: "posted" | "draft"; lines: JLine[] };
  let seq = 0;
  /** Post a batch of journals in ONE transaction; mirror them in the model. */
  const post = async (batch: J[]) => {
    const staged = batch.map((j) => ({ ...j, jid: model.nextJid++, status: j.status ?? "posted" }));
    await tx.withTransaction(async (s) => {
      await s.collection(E.JOURNALS).insertMany(staged.map((j) => ({ JOURNAL_ID: j.jid, JDATE: j.date, PERIOD: periodOf(j.date), SOURCE: j.source, REF: j.ref, STATUS: j.status })), { returning: [] });
      await s.collection(E.LINES).insertMany(
        staged.flatMap((j) => j.lines.filter((l) => l.dr || l.cr).map((l) => ({ JOURNAL_ID: j.jid, ACCOUNT_CODE: l.acct, PERIOD: periodOf(j.date), QUARTER: quarterOf(j.date), DEBIT: l.dr / 100, CREDIT: l.cr / 100 }))),
        { returning: [] },
      );
    });
    for (const j of staged) for (const l of j.lines.filter((x) => x.dr || x.cr)) model.gl.push({ jid: j.jid, seq: seq++, date: j.date, acct: l.acct, dr: l.dr, cr: l.cr, status: j.status, source: j.source });
  };

  const deposits = CUSTOMERS.reduce((s, c) => s + c.CREDIT, 0);
  const openingStock = STORES.reduce((s, st) => s + PRODUCTS.reduce((a, p) => a + stockFor(st.STORE_ID, p.SKU) * COST.get(p.SKU)!, 0), 0);
  await post([
    { date: d(2026, 1, 1), source: "OPEN", ref: "Opening capital", lines: [{ acct: "1100", dr: OPENING_CASH, cr: 0 }, { acct: "1500", dr: EQUIPMENT, cr: 0 }, { acct: "3100", dr: 0, cr: OPENING_CASH + EQUIPMENT }] },
    { date: d(2026, 1, 1), source: "DEPOSIT", ref: "Customer prepaid credit", lines: [{ acct: "1100", dr: deposits, cr: 0 }, { acct: "2300", dr: 0, cr: deposits }] },
    { date: d(2026, 1, 1), source: "STOCK", ref: "Opening stock on account", lines: [{ acct: "1300", dr: openingStock, cr: 0 }, { acct: "2100", dr: 0, cr: openingStock }] },
    { date: d(2026, 2, 15), source: "AP", ref: "Pay opening stock", lines: [{ acct: "2100", dr: openingStock, cr: 0 }, { acct: "1100", dr: 0, cr: openingStock }] },
    { date: d(2026, 1, 1), source: "LOAN", ref: "Bank loan drawn", lines: [{ acct: "1100", dr: LOAN.PRINCIPAL, cr: 0 }, { acct: "2400", dr: 0, cr: LOAN.PRINCIPAL }] },
  ]);

  // Every completed sale: deposits used up, revenue by category, cost of goods out of stock.
  await post(
    model.orders.map((o) => {
      const drink = o.lines.filter((l) => CATEGORY.get(l.sku) === "drink").reduce((s, l) => s + l.qty * l.unit, 0);
      const cost = o.lines.reduce((s, l) => s + l.qty * COST.get(l.sku)!, 0);
      return {
        date: saleDate(o.receipt),
        source: "SALE",
        ref: `Receipt ${o.receipt}`,
        lines: [{ acct: "2300", dr: o.total, cr: 0 }, { acct: "4100", dr: 0, cr: o.total - drink }, { acct: "4200", dr: 0, cr: drink }, { acct: "5100", dr: cost, cr: 0 }, { acct: "1300", dr: 0, cr: cost }],
      };
    }),
  );
  await post(PURCHASES.map((p) => ({ date: p.MDATE, source: "STOCK", ref: `Lot ${p.LOT}`, lines: [{ acct: "1300", dr: p.QTY * p.UNIT_COST, cr: 0 }, { acct: "2100", dr: 0, cr: p.QTY * p.UNIT_COST }] })));

  // Payroll from the staff table as it is now (read through Mira), depreciation and loan instalments, monthly.
  const staff = await sim.mira(() => coll(T.EMPLOYEES).aggregate([{ $group: { _id: null, TOTAL: { $sum: "$SALARY" } } }]));
  const payroll = cents(staff[0].TOTAL);
  const loan = amortize();
  const monthly: J[] = [];
  for (let m = 1; m <= 12; m++) {
    const end = new Date(2026, m, 0);
    const inst = loan.rows[m - 1];
    monthly.push({ date: d(2026, m, 28), source: "PAYROLL", ref: `Payroll ${m}`, lines: [{ acct: "5200", dr: payroll, cr: 0 }, { acct: "1100", dr: 0, cr: payroll }] });
    monthly.push({ date: end, source: "DEPR", ref: `Depreciation ${m}`, lines: [{ acct: "5300", dr: DEPRECIATION_MONTHLY, cr: 0 }, { acct: "1510", dr: 0, cr: DEPRECIATION_MONTHLY }] });
    monthly.push({ date: end, source: "LOAN", ref: `Instalment ${m}`, lines: [{ acct: "2400", dr: inst.principal, cr: 0 }, { acct: "5400", dr: inst.interest, cr: 0 }, { acct: "1100", dr: 0, cr: inst.principal + inst.interest }] });
  }
  await post(monthly);
  await post([{ date: d(2026, 12, 31), source: "MANUAL", ref: "Unbalanced draft", status: "draft", lines: [{ acct: "5200", dr: 10_000, cr: 0 }, { acct: "1100", dr: 0, cr: 9_000 }] }]);
  const draftJid = model.nextJid - 1;
  const posted = model.gl.filter((l) => l.status === "posted");
  sim.eq("posting: every line is in the ledger", await ctx.rawCount(E.LINES), model.gl.length);

  // ── Double-entry checks ────────────────────────────────────────────────────
  const unbalanced = await sim.mira(() =>
    lines.aggregate([{ $group: { _id: "$JOURNAL_ID", D: { $sum: "$DEBIT" }, C: { $sum: "$CREDIT" } } }, { $addFields: { DIFF: { $subtract: ["$D", "$C"] } } }, { $match: { DIFF: { $ne: 0 } } }]),
  );
  sim.eq("unbalanced journals: only the deliberate draft (debits ≠ credits)", unbalanced.map((r) => [Number(r.JOURNAL_ID), cents(r.DIFF)]), [[draftJid, 1_000]]);

  const postedOnly = { $lookup: { from: E.JOURNALS, localField: "JOURNAL_ID", foreignField: "JOURNAL_ID", as: "j", joinType: "inner", select: ["STATUS", "JDATE"] } };
  const tb = await sim.mira(() =>
    lines.aggregate([postedOnly, { $match: { STATUS: "posted" } }, { $group: { _id: "$ACCOUNT_CODE", D: { $sum: "$DEBIT" }, C: { $sum: "$CREDIT" } } }, { $sort: { ACCOUNT_CODE: 1 } }]),
  );
  const tbModel = [...new Set(posted.map((l) => l.acct))].sort().map((a) => [a, posted.filter((l) => l.acct === a).reduce((s, l) => s + l.dr, 0), posted.filter((l) => l.acct === a).reduce((s, l) => s + l.cr, 0)]);
  sim.eq("trial balance: debit and credit per account (posted journals)", tb.map((r) => [r.ACCOUNT_CODE, cents(r.D), cents(r.C)]), tbModel);
  sim.eq("trial balance: total debits equal total credits", tb.reduce((s, r) => s + cents(r.D), 0), tb.reduce((s, r) => s + cents(r.C), 0));
  const bal = (a: string) => posted.filter((l) => l.acct === a).reduce((s, l) => s + l.dr - l.cr, 0);

  // ── Chart of accounts tree ─────────────────────────────────────────────────
  const tree = (await sim.mira(() => coll(E.ACCOUNTS).connectBy({ startWith: { PARENT_CODE: null }, connectBy: { PARENT_CODE: "$PRIOR CODE" }, includeLevel: true, orderSiblings: { CODE: 1 } }))) as { CODE: string; LEVEL: number }[];
  const preorder: [string, number][] = [];
  const walk = (parent: string | null, lvl: number) => {
    for (const a of ACCOUNTS.filter((x) => x.PARENT_CODE === parent).sort((x, y) => x.CODE.localeCompare(y.CODE))) {
      preorder.push([a.CODE, lvl]);
      walk(a.CODE, lvl + 1);
    }
  };
  walk(null, 1);
  sim.eq("connectBy: chart of accounts in tree order with levels", tree.map((r) => [r.CODE, Number(r.LEVEL)]), preorder);
  const rollup = await sim.viaSql("balances rolled up the account tree", "connectBy now returns ROOT_<col>, but its rows cannot feed a join or $group: the tree has to be joined to a grouped result (aggregate-then-join)", () =>
    raw<{ ROOT: string; TOTAL: string }>(
      `SELECT t.ROOT, NVL(SUM(b.BAL), 0) AS TOTAL
         FROM (SELECT CONNECT_BY_ROOT CODE AS ROOT, CODE FROM "${E.ACCOUNTS}" CONNECT BY PRIOR CODE = PARENT_CODE) t
         LEFT JOIN (SELECT l.ACCOUNT_CODE, SUM(l.NET) AS BAL FROM "${E.LINES}" l JOIN "${E.JOURNALS}" j ON j.JOURNAL_ID = l.JOURNAL_ID WHERE j.STATUS = 'posted' GROUP BY l.ACCOUNT_CODE) b ON b.ACCOUNT_CODE = t.CODE
        GROUP BY t.ROOT ORDER BY t.ROOT`,
    ),
  );
  const below = (code: string): string[] => [code, ...ACCOUNTS.filter((a) => a.PARENT_CODE === code).flatMap((a) => below(a.CODE))];
  sim.eq("roll-up: every account's balance includes its sub-accounts", rollup.map((r) => [r.ROOT, cents(r.TOTAL)]), ACCOUNTS.map((a) => a.CODE).sort().map((c) => [c, below(c).reduce((s, x) => s + bal(x), 0)]));

  // ── Cash ledger card: running balance in date order ────────────────────────
  const card = await sim.mira(() =>
    lines.aggregate([
      postedOnly,
      { $match: { STATUS: "posted", ACCOUNT_CODE: "1100" } },
      { $project: { LINE_ID: 1, JDATE: 1, NET: 1, RUN: { $window: { fn: "SUM", field: "NET", orderBy: { JDATE: 1, LINE_ID: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } } } },
      { $sort: { JDATE: 1, LINE_ID: 1 } },
    ]),
  );
  let run = 0;
  const cardModel = posted.filter((l) => l.acct === "1100").sort((a, b) => +a.date - +b.date || a.seq - b.seq).map((l) => (run += l.dr - l.cr));
  sim.eq("ledger card: cash running balance after every movement", card.map((r) => cents(r.RUN)), cardModel);
  sim.eq("ledger card: closing cash equals the account balance", cents(card[card.length - 1]?.RUN), bal("1100"));

  // ── Budget vs actual, ROLLUP subtotals ─────────────────────────────────────
  const BUDGET: [string, number][] = [["4100", -40_000_00], ["4200", -8_000_00], ["5100", 18_000_00], ["5200", payroll * 3]];
  await schema.createTable(E.BUDGET, { ACCOUNT_CODE: { type: "VARCHAR2(10)" }, QUARTER: { type: "VARCHAR2(2)" }, AMOUNT: { type: "NUMBER(14,2)" } });
  await coll(E.BUDGET).insertMany(BUDGET.flatMap(([a, amt]) => ["Q1", "Q2", "Q3", "Q4"].map((q) => ({ ACCOUNT_CODE: a, QUARTER: q, AMOUNT: amt / 100 }))), { returning: [] });
  const bva = await sim.mira(() =>
    lines.aggregate([
      postedOnly,
      { $match: { STATUS: "posted", ACCOUNT_CODE: { $in: BUDGET.map(([a]) => a) } } },
      { $group: { _id: { ACCOUNT_CODE: "$ACCOUNT_CODE", QUARTER: "$QUARTER" }, ACT: { $sum: "$NET" } } },
      { $lookup: { from: E.BUDGET, as: "b", joinType: "inner", localField: "ACCOUNT_CODE", foreignField: "ACCOUNT_CODE", on: [{ localField: "ACCOUNT_CODE", foreignField: "ACCOUNT_CODE" }, { localField: "QUARTER", foreignField: "QUARTER" }], select: ["AMOUNT"] } },
      { $addFields: { VAR: { $subtract: ["$ACT", "$AMOUNT"] } } },
      { $sort: { ACCOUNT_CODE: 1, QUARTER: 1 } },
    ]),
  );
  const act = (a: string, q: string) => posted.filter((l) => l.acct === a && quarterOf(l.date) === q).reduce((s, l) => s + l.dr - l.cr, 0);
  const bvaModel = BUDGET.flatMap(([a, amt]) => ["Q1", "Q2", "Q3", "Q4"].filter((q) => posted.some((l) => l.acct === a && quarterOf(l.date) === q)).map((q) => [a, q, act(a, q), act(a, q) - amt]));
  sim.eq("budget vs actual: actual and variance per account per quarter ($group → $lookup on two columns → $addFields)", bva.map((r) => [r.ACCOUNT_CODE, r.QUARTER, cents(r.ACT), cents(r.VAR)]), bvaModel);

  const ru = await sim.mira(() =>
    lines.aggregate([
      postedOnly,
      { $match: { STATUS: "posted" } },
      { $lookup: { from: E.ACCOUNTS, localField: "ACCOUNT_CODE", foreignField: "CODE", as: "a", joinType: "inner", select: ["TYPE"] } },
      { $group: { _id: { $rollup: ["TYPE", "ACCOUNT_CODE"], grouping: true }, BAL: { $sum: "$NET" } } },
    ]),
  );
  const types = [...new Set(posted.map((l) => TYPE_OF.get(l.acct)!))];
  const sub = (t: string) => posted.filter((l) => TYPE_OF.get(l.acct) === t).reduce((s, l) => s + l.dr - l.cr, 0);
  // GROUPING_* flags (not NULL keys) say which rows are subtotals.
  const ruKey = (r: Record<string, unknown>) => `${Number(r.GROUPING_TYPE) ? "*" : r.TYPE}|${Number(r.GROUPING_ACCOUNT_CODE) ? "*" : r.ACCOUNT_CODE}`;
  const ruGot = Object.fromEntries(ru.map((r) => [ruKey(r), cents(r.BAL)]));
  const ruWant: Record<string, number> = { "*|*": 0 };
  for (const t of types) ruWant[`${t}|*`] = sub(t);
  for (const a of new Set(posted.map((l) => l.acct))) ruWant[`${TYPE_OF.get(a)}|${a}`] = bal(a);
  sim.eq("ROLLUP with GROUPING flags: per-account balances, per-type subtotals and a grand total of zero", ruGot, ruWant);

  // ── Quarterly P&L (PIVOT) and month-on-month revenue (LAG) ─────────────────
  const pnl = (await sim.mira(() => lines.pivot({ value: { $sum: "$NET" }, pivotOn: "QUARTER", pivotValues: ["Q1", "Q2", "Q3", "Q4"], groupBy: "ACCOUNT_CODE" }))) as Record<string, unknown>[];
  const pl = ["4100", "4200", "5100", "5200", "5300", "5400"];
  const all = model.gl;
  sim.eq(
    "PIVOT: quarterly P&L per income and expense account",
    pnl.filter((r) => pl.includes(String(r.ACCOUNT_CODE))).sort((a, b) => String(a.ACCOUNT_CODE).localeCompare(String(b.ACCOUNT_CODE))).map((r) => [r.ACCOUNT_CODE, ...["Q1", "Q2", "Q3", "Q4"].map((q) => (r[q] == null ? 0 : cents(r[q])))]),
    pl.map((a) => [a, ...["Q1", "Q2", "Q3", "Q4"].map((q) => all.filter((l) => l.acct === a && quarterOf(l.date) === q).reduce((s, l) => s + l.dr - l.cr, 0))]),
  );
  const mom = await sim.mira(() =>
    lines.aggregate([
      { $match: { ACCOUNT_CODE: { $in: ["4100", "4200"] } } },
      { $group: { _id: "$PERIOD", REV: { $sum: "$CREDIT" } } },
      { $project: { PERIOD: 1, REV: 1, PREV: { $window: { fn: "LAG", field: "REV", orderBy: { PERIOD: 1 } } } } },
      { $sort: { PERIOD: 1 } },
    ]),
  );
  const months = [...new Set(posted.filter((l) => l.acct === "4100" || l.acct === "4200").map((l) => periodOf(l.date)))].sort();
  const revOf = (p: string) => posted.filter((l) => (l.acct === "4100" || l.acct === "4200") && periodOf(l.date) === p).reduce((s, l) => s + l.cr, 0);
  sim.eq("month-on-month revenue with the previous month (LAG)", mom.map((r) => [r.PERIOD, cents(r.REV), r.PREV == null ? null : cents(r.PREV)]), months.map((p, i) => [p, revOf(p), i ? revOf(months[i - 1]) : null]));

  // ── Year-end close: income and expense accounts into retained earnings ─────
  const closing = await sim.mira(() =>
    lines.aggregate([
      postedOnly,
      { $match: { STATUS: "posted", ACCOUNT_CODE: { $in: pl } } },
      { $group: { _id: "$ACCOUNT_CODE", BAL: { $sum: "$NET" } } },
      { $sort: { ACCOUNT_CODE: 1 } },
    ]),
  );
  const closeLines: JLine[] = closing.filter((r) => cents(r.BAL) !== 0).map((r) => (cents(r.BAL) > 0 ? { acct: String(r.ACCOUNT_CODE), dr: 0, cr: cents(r.BAL) } : { acct: String(r.ACCOUNT_CODE), dr: -cents(r.BAL), cr: 0 }));
  const profit = -closing.reduce((s, r) => s + cents(r.BAL), 0);
  closeLines.push(profit >= 0 ? { acct: "3200", dr: 0, cr: profit } : { acct: "3200", dr: -profit, cr: 0 });
  await post([{ date: d(2026, 12, 31), source: "CLOSE", ref: "Year-end close", lines: closeLines }]);
  const after = await sim.mira(() =>
    lines.aggregate([
      postedOnly,
      { $match: { STATUS: "posted" } },
      { $lookup: { from: E.ACCOUNTS, localField: "ACCOUNT_CODE", foreignField: "CODE", as: "a", joinType: "inner", select: ["TYPE"] } },
      { $group: { _id: "$TYPE", BAL: { $sum: "$NET" } } },
    ]),
  );
  const byType = Object.fromEntries(after.map((r) => [r.TYPE, cents(r.BAL)]));
  sim.eq("year-end close: income and expense accounts are zero", [byType.REVENUE ?? 0, byType.EXPENSE ?? 0], [0, 0]);
  sim.eq("balance sheet: assets = liabilities + equity", byType.ASSET, -(byType.LIABILITY + byType.EQUITY));
  sim.eq("retained earnings hold the year's profit", -cents((await sim.mira(() => lines.aggregate([postedOnly, { $match: { STATUS: "posted", ACCOUNT_CODE: "3200" } }, { $group: { _id: null, B: { $sum: "$NET" } } }])))[0].B), profit);
  state.profit = profit;
}
