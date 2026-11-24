/**
 * The enterprise layer on top of the canteen: general ledger, receivables and
 * payables, the inventory movement ledger, kitchen recipes, foreign currency
 * and a loan. Fixed data plus pure JS functions that compute what every report
 * SHOULD return; the stages compare Mira's (or raw SQL's) answer with these.
 *
 * Money is in cents everywhere in JS. Dates are local-midnight JS Dates (the
 * driver stores them as that wall-clock date in DATE columns).
 */
import { PRODUCTS } from "./data";

export const E = {
  ACCOUNTS: "SIM_GL_ACCOUNTS",
  JOURNALS: "SIM_GL_JOURNALS",
  LINES: "SIM_GL_LINES",
  BUDGET: "SIM_GL_BUDGET",
  AR_INV: "SIM_AR_INVOICES",
  AR_RCPT: "SIM_AR_RECEIPTS",
  AP_PAY: "SIM_AP_PAYMENTS",
  MOVES: "SIM_INV_MOVES",
  LOTS: "SIM_INV_LOTS",
  REORDER: "SIM_INV_REORDER",
  DAILY: "SIM_INV_DAILY",
  ITEMS: "SIM_KIT_ITEMS",
  BOM: "SIM_KIT_BOM",
  FX: "SIM_FX_RATES",
  IMPORTS: "SIM_IMPORT_INVOICES",
} as const;

export const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
export const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const DAY = 86_400_000;
export const daysBetween = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);
export const addDays = (x: Date, n: number) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);

/** A till sale's date, from its receipt number (same quarter as the order). */
export function saleDate(receipt: number): Date {
  if (receipt === 9999) return d(2026, 12, 31);
  const i = receipt - 1000;
  return d(2026, Math.floor(i / 9) * 3 + (i % 3) + 1, 1 + ((i * 7) % 28));
}
export const periodOf = (x: Date) => iso(x).slice(0, 7);
export const quarterOf = (x: Date) => `Q${Math.floor(x.getMonth() / 3) + 1}`;

/** Unit cost of each menu item: 40% of its opening price. */
export const COST = new Map(PRODUCTS.map((p) => [p.SKU, Math.round(p.PRICE * 0.4)]));
export const CATEGORY = new Map(PRODUCTS.map((p) => [p.SKU, p.CATEGORY]));

// ── General ledger ───────────────────────────────────────────────────────────
export const ACCOUNTS = [
  { CODE: "1000", NAME: "Assets", TYPE: "ASSET", PARENT_CODE: null },
  { CODE: "1100", NAME: "Cash", TYPE: "ASSET", PARENT_CODE: "1000" },
  { CODE: "1300", NAME: "Inventory", TYPE: "ASSET", PARENT_CODE: "1000" },
  { CODE: "1500", NAME: "Equipment", TYPE: "ASSET", PARENT_CODE: "1000" },
  { CODE: "1510", NAME: "Accumulated depreciation", TYPE: "ASSET", PARENT_CODE: "1500" },
  { CODE: "2000", NAME: "Liabilities", TYPE: "LIABILITY", PARENT_CODE: null },
  { CODE: "2100", NAME: "Accounts payable", TYPE: "LIABILITY", PARENT_CODE: "2000" },
  { CODE: "2300", NAME: "Customer deposits", TYPE: "LIABILITY", PARENT_CODE: "2000" },
  { CODE: "2400", NAME: "Loan payable", TYPE: "LIABILITY", PARENT_CODE: "2000" },
  { CODE: "3000", NAME: "Equity", TYPE: "EQUITY", PARENT_CODE: null },
  { CODE: "3100", NAME: "Owner's capital", TYPE: "EQUITY", PARENT_CODE: "3000" },
  { CODE: "3200", NAME: "Retained earnings", TYPE: "EQUITY", PARENT_CODE: "3000" },
  { CODE: "4000", NAME: "Revenue", TYPE: "REVENUE", PARENT_CODE: null },
  { CODE: "4100", NAME: "Food sales", TYPE: "REVENUE", PARENT_CODE: "4000" },
  { CODE: "4200", NAME: "Drink sales", TYPE: "REVENUE", PARENT_CODE: "4000" },
  { CODE: "5000", NAME: "Expenses", TYPE: "EXPENSE", PARENT_CODE: null },
  { CODE: "5100", NAME: "Cost of goods sold", TYPE: "EXPENSE", PARENT_CODE: "5000" },
  { CODE: "5200", NAME: "Wages", TYPE: "EXPENSE", PARENT_CODE: "5000" },
  { CODE: "5300", NAME: "Depreciation", TYPE: "EXPENSE", PARENT_CODE: "5000" },
  { CODE: "5400", NAME: "Interest", TYPE: "EXPENSE", PARENT_CODE: "5000" },
];
export const TYPE_OF = new Map(ACCOUNTS.map((a) => [a.CODE, a.TYPE]));
export const DEPRECIATION_MONTHLY = 200_000; // equipment 120,000.00 over 60 months
export const EQUIPMENT = 12_000_000;
export const OPENING_CASH = 50_000_000;

export type GlLine = { jid: number; date: Date; acct: string; dr: number; cr: number; status: "posted" | "draft" };
export type Journal = { jid: number; date: Date; source: string; ref: string; status: "posted" | "draft"; lines: { acct: string; dr: number; cr: number }[] };

export const balanceOf = (lines: GlLine[], acct: string) => lines.filter((l) => l.acct === acct).reduce((s, l) => s + l.dr - l.cr, 0);

// ── Receivables (corporate accounts) and payables ────────────────────────────
/** 13 invoices, one a month (the last two in December); number 5009 was never issued (a sequence gap). */
export const AR_INVOICES = [5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5010, 5011, 5012, 5013, 5014].map((no, i) => {
  const date = d(2026, Math.min(12, 1 + i), 5 + (i % 3) * 7);
  return { INV_NO: no, CUSTOMER: ["ACME", "GLOBEX", "INITECH"][i % 3], INV_DATE: date, DUE_DATE: addDays(date, 30), AMOUNT: 150_000 + i * 37_550 };
});
export const AR_RECEIPTS = [
  { RCPT_ID: 1, CUSTOMER: "ACME", RDATE: d(2026, 3, 1), AMOUNT: 200_000 },
  { RCPT_ID: 2, CUSTOMER: "ACME", RDATE: d(2026, 7, 10), AMOUNT: 400_000 },
  { RCPT_ID: 3, CUSTOMER: "GLOBEX", RDATE: d(2026, 4, 2), AMOUNT: 187_550 },
  { RCPT_ID: 4, CUSTOMER: "GLOBEX", RDATE: d(2026, 9, 15), AMOUNT: 100_000 },
  { RCPT_ID: 5, CUSTOMER: "INITECH", RDATE: d(2026, 6, 30), AMOUNT: 600_000 },
  { RCPT_ID: 6, CUSTOMER: "INITECH", RDATE: d(2026, 11, 20), AMOUNT: 50_000 },
];
export const AS_OF = d(2026, 12, 31);

/** Apply each customer's receipts to their invoices oldest first; open amount per invoice. */
export function fifoOpen(): Map<number, number> {
  const open = new Map<number, number>();
  for (const cust of ["ACME", "GLOBEX", "INITECH"]) {
    let paid = AR_RECEIPTS.filter((r) => r.CUSTOMER === cust).reduce((s, r) => s + r.AMOUNT, 0);
    for (const inv of AR_INVOICES.filter((x) => x.CUSTOMER === cust).sort((a, b) => a.INV_NO - b.INV_NO)) {
      const applied = Math.min(paid, inv.AMOUNT);
      paid -= applied;
      open.set(inv.INV_NO, inv.AMOUNT - applied);
    }
  }
  return open;
}
export const agingBucket = (inv: { DUE_DATE: Date }) => {
  const late = daysBetween(inv.DUE_DATE, AS_OF);
  return late <= 0 ? "current" : late <= 30 ? "1-30" : late <= 60 ? "31-60" : late <= 90 ? "61-90" : "90+";
};

/** Supplier payments: one duplicate (same supplier, invoice, amount) and one split run under the 10,000.00 approval limit. */
export const AP_PAYMENTS = [
  { PAY_ID: 1, SUPPLIER: "FreshFarm", INV_REF: "FF-101", PDATE: d(2026, 2, 3), AMOUNT: 480_000 },
  { PAY_ID: 2, SUPPLIER: "FreshFarm", INV_REF: "FF-102", PDATE: d(2026, 3, 3), AMOUNT: 512_500 },
  { PAY_ID: 3, SUPPLIER: "FreshFarm", INV_REF: "FF-102", PDATE: d(2026, 3, 9), AMOUNT: 512_500 },
  { PAY_ID: 4, SUPPLIER: "DrinksCo", INV_REF: "DC-7", PDATE: d(2026, 5, 4), AMOUNT: 950_000 },
  { PAY_ID: 5, SUPPLIER: "DrinksCo", INV_REF: "DC-8", PDATE: d(2026, 5, 5), AMOUNT: 940_000 },
  { PAY_ID: 6, SUPPLIER: "DrinksCo", INV_REF: "DC-9", PDATE: d(2026, 5, 6), AMOUNT: 990_000 },
  { PAY_ID: 7, SUPPLIER: "DrinksCo", INV_REF: "DC-10", PDATE: d(2026, 8, 20), AMOUNT: 300_000 },
  { PAY_ID: 8, SUPPLIER: "PackRight", INV_REF: "PR-1", PDATE: d(2026, 6, 1), AMOUNT: 999_900 },
  { PAY_ID: 9, SUPPLIER: "PackRight", INV_REF: "PR-2", PDATE: d(2026, 6, 20), AMOUNT: 999_900 },
];
export const APPROVAL_LIMIT = 1_000_000;

/** Runs of 2+ payments to one supplier, each under the limit, consecutive days apart ≤ 3, summing over the limit. */
export function splitRuns(): { supplier: string; first: number; last: number; n: number; total: number }[] {
  const out: { supplier: string; first: number; last: number; n: number; total: number }[] = [];
  for (const sup of [...new Set(AP_PAYMENTS.map((p) => p.SUPPLIER))].sort()) {
    const ps = AP_PAYMENTS.filter((p) => p.SUPPLIER === sup).sort((a, b) => +a.PDATE - +b.PDATE || a.PAY_ID - b.PAY_ID);
    let run: typeof ps = [];
    const flush = () => {
      const total = run.reduce((s, p) => s + p.AMOUNT, 0);
      if (run.length >= 2 && total > APPROVAL_LIMIT) out.push({ supplier: sup, first: run[0].PAY_ID, last: run[run.length - 1].PAY_ID, n: run.length, total });
      run = [];
    };
    for (const p of ps) {
      if (p.AMOUNT >= APPROVAL_LIMIT) {
        flush();
        continue;
      }
      if (run.length && daysBetween(run[run.length - 1].PDATE, p.PDATE) > 3) flush();
      run.push(p);
    }
    flush();
  }
  return out;
}

// ── Inventory ────────────────────────────────────────────────────────────────
/** Mid-year purchases at Makati with rising costs, each a lot with its own expiry. */
export const PURCHASES = [
  { SKU: "P-ADOBO", LOT: "AD-2", MDATE: d(2026, 4, 1), QTY: 20, UNIT_COST: 5_000, EXPIRY: d(2026, 6, 30) },
  { SKU: "P-ADOBO", LOT: "AD-3", MDATE: d(2026, 7, 1), QTY: 20, UNIT_COST: 5_400, EXPIRY: d(2026, 5, 31) },
  { SKU: "P-ADOBO", LOT: "AD-4", MDATE: d(2026, 10, 1), QTY: 10, UNIT_COST: 5_900, EXPIRY: d(2026, 12, 15) },
  { SKU: "P-COFFEE", LOT: "CF-2", MDATE: d(2026, 5, 1), QTY: 40, UNIT_COST: 2_300, EXPIRY: d(2027, 1, 31) },
];
export const TRANSFER = { SKU: "P-ADOBO", FROM: 1, TO: 3, QTY: 5, DATE: d(2026, 11, 2) };
export const SHRINK = { STORE_ID: 2, SKU: "P-LUMPIA", QTY: -2, DATE: d(2026, 12, 30) };

/** Daily closing stock of two items for December: zero runs are stock-outs. */
export const DAILY = (() => {
  const rows: { SKU: string; D: Date; QTY: number }[] = [];
  const zeros: Record<string, number[]> = { "P-HALO": [3, 4, 5, 12, 20, 21], "P-TURON": [1, 2, 9, 10, 11, 12, 30] };
  for (const sku of ["P-HALO", "P-TURON"]) for (let day = 1; day <= 31; day++) rows.push({ SKU: sku, D: d(2026, 12, day), QTY: zeros[sku].includes(day) ? 0 : 3 + (day % 4) });
  return rows;
})();
export function stockOutRuns() {
  const out: { sku: string; start: string; days: number }[] = [];
  for (const sku of ["P-HALO", "P-TURON"]) {
    let start: Date | null = null;
    let n = 0;
    for (const r of DAILY.filter((x) => x.SKU === sku)) {
      if (r.QTY === 0) {
        if (!start) start = r.D;
        n++;
      } else if (start) {
        out.push({ sku, start: iso(start), days: n });
        start = null;
        n = 0;
      }
    }
    if (start) out.push({ sku, start: iso(start), days: n });
  }
  return out;
}

// ── Kitchen recipes (multi-level bill of materials) ──────────────────────────
export const ITEMS = [
  ["P-HALO", "Halo-Halo", "dish", 0], ["P-ADOBO", "Chicken Adobo", "dish", 0], ["P-SINIG", "Pork Sinigang", "dish", 0],
  ["SWEET-MIX", "Sweet mix", "sub", 0], ["SYRUP", "Syrup", "sub", 0], ["VEG-MIX", "Vegetable mix", "sub", 0],
  ["ICE", "Shaved ice (kg)", "raw", 2000], ["MILK", "Evaporated milk (L)", "raw", 12000], ["BEANS", "Sweet beans (kg)", "raw", 18000],
  ["JACKFRUIT", "Jackfruit (kg)", "raw", 22000], ["SUGAR", "Sugar (kg)", "raw", 7000], ["WATER", "Water (L)", "raw", 100],
  ["CHICKEN", "Chicken (kg)", "raw", 24000], ["SOY", "Soy sauce (L)", "raw", 9000], ["VINEGAR", "Vinegar (L)", "raw", 6000],
  ["RICE", "Rice (kg)", "raw", 5500], ["PORK", "Pork (kg)", "raw", 32000], ["TAMARIND", "Tamarind (kg)", "raw", 15000],
  ["KANGKONG", "Kangkong (kg)", "raw", 8000], ["RADISH", "Radish (kg)", "raw", 6000],
].map(([CODE, NAME, KIND, COST]) => ({ CODE: CODE as string, NAME: NAME as string, KIND: KIND as string, COST: COST as number }));
export const BOM = [
  ["P-HALO", "ICE", 0.3], ["P-HALO", "MILK", 0.1], ["P-HALO", "SWEET-MIX", 1],
  ["SWEET-MIX", "BEANS", 0.05], ["SWEET-MIX", "JACKFRUIT", 0.04], ["SWEET-MIX", "SUGAR", 0.03], ["SWEET-MIX", "SYRUP", 1],
  ["SYRUP", "SUGAR", 0.02], ["SYRUP", "WATER", 0.05],
  ["P-ADOBO", "CHICKEN", 0.25], ["P-ADOBO", "SOY", 0.02], ["P-ADOBO", "VINEGAR", 0.02], ["P-ADOBO", "RICE", 0.15],
  ["P-SINIG", "PORK", 0.25], ["P-SINIG", "TAMARIND", 0.03], ["P-SINIG", "VEG-MIX", 1], ["P-SINIG", "RICE", 0.15],
  ["VEG-MIX", "KANGKONG", 0.05], ["VEG-MIX", "RADISH", 0.05],
].map(([PARENT, CHILD, QTY]) => ({ PARENT: PARENT as string, CHILD: CHILD as string, QTY: QTY as number }));
/** On-hand raw ingredients for the next production run. */
export const RAW_ON_HAND: Record<string, number> = { ICE: 2, MILK: 0.5, BEANS: 0, JACKFRUIT: 0.2, SUGAR: 0.1, WATER: 10, CHICKEN: 3, SOY: 1, VINEGAR: 1, RICE: 4, PORK: 1, TAMARIND: 0, KANGKONG: 0.1, RADISH: 0.1 };

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** Raw-ingredient quantity per one unit of `dish`, multiplied down every level. */
export function explode(dish: string, mult = 1, acc = new Map<string, number>()): Map<string, number> {
  for (const b of BOM.filter((x) => x.PARENT === dish)) {
    const kind = ITEMS.find((i) => i.CODE === b.CHILD)!.KIND;
    if (kind === "raw") acc.set(b.CHILD, r6((acc.get(b.CHILD) ?? 0) + mult * b.QTY));
    else explode(b.CHILD, mult * b.QTY, acc);
  }
  return acc;
}
/** Every item below `dish`, with its level (1 = direct component). */
export function bomTree(dish: string, level = 1, out: { item: string; level: number }[] = []) {
  for (const b of BOM.filter((x) => x.PARENT === dish)) {
    out.push({ item: b.CHILD, level });
    bomTree(b.CHILD, level + 1, out);
  }
  return out;
}
export function whereUsed(item: string, out = new Set<string>()) {
  for (const b of BOM.filter((x) => x.CHILD === item)) {
    out.add(b.PARENT);
    whereUsed(b.PARENT, out);
  }
  return out;
}

// ── Foreign currency and a loan ──────────────────────────────────────────────
export const FX = [
  ["USD", d(2026, 1, 1), 55.8], ["USD", d(2026, 3, 1), 56.25], ["USD", d(2026, 6, 15), 57.1], ["USD", d(2026, 9, 1), 56.4],
  ["EUR", d(2026, 1, 1), 60.5], ["EUR", d(2026, 4, 1), 61.75], ["EUR", d(2026, 10, 1), 62.05],
].map(([CCY, RDATE, RATE]) => ({ CCY: CCY as string, RDATE: RDATE as Date, RATE: RATE as number }));
export const IMPORTS = [
  { INV_NO: "IMP-1", CCY: "USD", IDATE: d(2026, 2, 10), AMOUNT: 1_250_00 },
  { INV_NO: "IMP-2", CCY: "USD", IDATE: d(2026, 6, 15), AMOUNT: 980_50 },
  { INV_NO: "IMP-3", CCY: "EUR", IDATE: d(2026, 3, 31), AMOUNT: 2_000_00 },
  { INV_NO: "IMP-4", CCY: "EUR", IDATE: d(2026, 11, 2), AMOUNT: 750_25 },
  { INV_NO: "IMP-5", CCY: "JPY", IDATE: d(2026, 5, 5), AMOUNT: 90_000_00 }, // no JPY rate: must surface as missing
];
/** Converted to pesos (cents) at the latest rate on or before the invoice date; null when there is none. */
export function convert(inv: (typeof IMPORTS)[number]): number | null {
  const rates = FX.filter((r) => r.CCY === inv.CCY && r.RDATE <= inv.IDATE).sort((a, b) => +b.RDATE - +a.RDATE);
  return rates.length ? Math.round(inv.AMOUNT * rates[0].RATE) : null;
}

/** 12-month annuity loan of 600,000.00 at 9% a year; the last payment absorbs the rounding. */
export const LOAN = { PRINCIPAL: 60_000_000, RATE_MONTH: 0.0075, MONTHS: 12 };
export function amortize() {
  const r = LOAN.RATE_MONTH;
  const pay = Math.round((LOAN.PRINCIPAL * r) / (1 - Math.pow(1 + r, -LOAN.MONTHS)));
  const rows: { n: number; interest: number; principal: number; balance: number }[] = [];
  let bal = LOAN.PRINCIPAL;
  for (let n = 1; n <= LOAN.MONTHS; n++) {
    const interest = Math.round((bal * 75) / 10_000); // 0.75% exactly (0.0075 is not exact in floating point)
    const principal = n === LOAN.MONTHS ? bal : pay - interest;
    bal -= principal;
    rows.push({ n, interest, principal, balance: bal });
  }
  return { pay, rows };
}

/** Split `cents` across weights so the parts sum exactly (largest remainder; ties to the earlier key). */
export function allocate(cents: number, weights: [string, number][]): Map<string, number> {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const raw = weights.map(([k, w], i) => ({ k, i, exact: (cents * w) / total }));
  const base = raw.map((x) => ({ ...x, part: Math.floor(x.exact), rem: x.exact - Math.floor(x.exact) }));
  let left = cents - base.reduce((s, x) => s + x.part, 0);
  for (const x of [...base].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break;
    x.part++;
    left--;
  }
  return new Map(base.map((x) => [x.k, x.part]));
}

export const firstDigit = (cents: number) => String(cents / 100).replace(/^0\.0*/, "")[0];
