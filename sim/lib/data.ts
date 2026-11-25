/**
 * The simulated business: a three-branch canteen. Fixed, deterministic data,
 * and an in-memory model the simulation updates alongside the database, so
 * every report can be checked against what SHOULD be there.
 *
 * Money is kept in cents in the model (NUMBER(12,2) in the database).
 */

export const T = {
  STORES: "SIM_STORES",
  PRODUCTS: "SIM_PRODUCTS",
  CUSTOMERS: "SIM_CUSTOMERS",
  EMPLOYEES: "SIM_EMPLOYEES",
  STOCK: "SIM_STOCK",
  ORDERS: "SIM_ORDERS",
  LINES: "SIM_ORDER_LINES",
  PRICE_FEED: "SIM_PRICE_FEED",
  QUARTERLY: "SIM_QUARTERLY",
  PROMOS: "SIM_PROMOS",
  ARCHIVE: "SIM_ORDERS_ARCHIVE",
  STORE_TOTALS: "SIM_STORE_TOTALS",
  ORDERS_OUT: "SIM_ORDERS_OUT",
  SECRET: "SIM_SECRET",
  SCRATCH: "SIM_SCRATCH",
  TILL_LOG: "SIM_TILL_LOG",
  RECEIPT_SEQ: "SIM_RECEIPT_SEQ",
  VIEW_MENU: "SIM_V_MENU",
  MV_SALES: "SIM_MV_SALES",
  LOYALTY: "SIM_LOYALTY",
  SUPPLIERS: "SIM_SUPPLIERS",
  VIEW_SUPPLIERS: "SIM_V_SUPPLIERS",
  MIGRATIONS: "SIM_MIGRATIONS",
} as const;

export const STORES = [
  { STORE_ID: 1, NAME: "Makati", CITY: "Manila" },
  { STORE_ID: 2, NAME: "Ayala Center", CITY: "Cebu" },
  { STORE_ID: 3, NAME: "Abreeza", CITY: "Davao" },
];

export const PRODUCTS = [
  { SKU: "P-ADOBO", NAME: "Chicken Adobo", CATEGORY: "meal", PRICE: 12000 },
  { SKU: "P-SINIG", NAME: "Pork Sinigang", CATEGORY: "meal", PRICE: 13550 },
  { SKU: "P-PANCIT", NAME: "Pancit Canton", CATEGORY: "meal", PRICE: 9500 },
  { SKU: "P-LUMPIA", NAME: "Lumpia (3 pcs)", CATEGORY: "snack", PRICE: 4500 },
  { SKU: "P-TURON", NAME: "Turon", CATEGORY: "dessert", PRICE: 2500 },
  { SKU: "P-HALO", NAME: "Halo-Halo", CATEGORY: "dessert", PRICE: 8575 },
  { SKU: "P-CALA", NAME: "Calamansi Juice", CATEGORY: "drink", PRICE: 4000 },
  { SKU: "P-COFFEE", NAME: "Barako Coffee", CATEGORY: "drink", PRICE: 5500 },
];

/** Halo-Halo is the add-on dessert and is scarce (2 / 1 / 2 per branch), so later add-ons roll back to the savepoint. */
export const ADDON_SKU = "P-HALO";
export const stockFor = (storeId: number, sku: string) => (sku === "P-HALO" ? ({ 1: 2, 2: 1, 3: 2 } as Record<number, number>)[storeId] : sku === "P-TURON" && storeId === 2 ? 1 : 30);

export const CUSTOMERS = [
  { NAME: "Juan Dela Cruz", EMAIL: "juan@canteen.sim", TIER: "vip", CITY: "Manila", CREDIT: 300000 },
  { NAME: "Maria Clara", EMAIL: "maria@canteen.sim", TIER: "vip", CITY: "Cebu", CREDIT: 300000 },
  { NAME: "Jose Rizal", EMAIL: "jose@canteen.sim", TIER: "regular", CITY: "Manila", CREDIT: 120000 },
  { NAME: "Andres B.", EMAIL: "andres@canteen.sim", TIER: "regular", CITY: "Davao", CREDIT: 120000 },
  { NAME: "Gabriela S.", EMAIL: "gabriela@canteen.sim", TIER: "vip", CITY: "Davao", CREDIT: 300000 },
  { NAME: "Apolinario M.", EMAIL: "apolinario@canteen.sim", TIER: "regular", CITY: "Cebu", CREDIT: 120000 },
  { NAME: "Emilio A.", EMAIL: "emilio@canteen.sim", TIER: "regular", CITY: "Manila", CREDIT: 120000 },
  { NAME: "Melchora A.", EMAIL: "melchora@canteen.sim", TIER: "vip", CITY: "Manila", CREDIT: 300000 },
  { NAME: "Low Credit", EMAIL: "low@canteen.sim", TIER: "regular", CITY: "Cebu", CREDIT: 5000 },
  { NAME: "Diego S.", EMAIL: "diego@canteen.sim", TIER: "regular", CITY: "Davao", CREDIT: 120000 },
  { NAME: "Teresa M.", EMAIL: "teresa@canteen.sim", TIER: "regular", CITY: null, CREDIT: 120000 },
  { NAME: "Lapu Lapu", EMAIL: "lapu@canteen.sim", TIER: "vip", CITY: "Cebu", CREDIT: 300000 },
];

export const EMPLOYEES = [
  { ID: 1, NAME: "CEO", MANAGER_ID: null, DEPT: "EXEC", SALARY: 250000 },
  { ID: 2, NAME: "COO", MANAGER_ID: 1, DEPT: "OPS", SALARY: 180000 },
  { ID: 3, NAME: "CFO", MANAGER_ID: 1, DEPT: "FIN", SALARY: 170000 },
  { ID: 4, NAME: "Makati Manager", MANAGER_ID: 2, DEPT: "OPS", SALARY: 60000 },
  { ID: 5, NAME: "Cebu Manager", MANAGER_ID: 2, DEPT: "OPS", SALARY: 58000 },
  { ID: 6, NAME: "Accountant", MANAGER_ID: 3, DEPT: "FIN", SALARY: 45000 },
  { ID: 7, NAME: "Cook", MANAGER_ID: 4, DEPT: "OPS", SALARY: 30000 },
];

/** 36 till transactions, 9 per quarter, rotating customers, branches and items. */
export const ORDER_REQUESTS = Array.from({ length: 36 }, (_, i) => ({
  customer: i % CUSTOMERS.length,
  storeId: (i % 3) + 1,
  quarter: `Q${Math.floor(i / 9) + 1}`,
  lines: [
    { sku: PRODUCTS[i % 8].SKU, qty: 1 + (i % 3) },
    { sku: PRODUCTS[(i * 3 + 1) % 8].SKU, qty: 1 },
  ].filter((l, k, all) => k === 0 || l.sku !== all[0].sku),
  addOn: i % 4 === 0,
}));

export type OrderResult = { receipt: number; orderId: number; customerId: number; storeId: number; quarter: string; total: number; lines: { sku: string; qty: number; unit: number }[] };

/** What the database should contain, maintained by the stages as they go. */
export class Model {
  customerIds: number[] = [];
  productIds = new Map<string, number>();
  price = new Map<string, number>(PRODUCTS.map((p) => [p.SKU, p.PRICE]));
  stock = new Map<string, number>();
  credit = new Map<number, number>();
  orders: OrderResult[] = [];
  rejected: { request: number; reason: string }[] = [];
  addOnsKept = 0;
  addOnsRolledBack = 0;
  key = (storeId: number, sku: string) => `${storeId}:${sku}`;
  /** General ledger lines as posted (seq = insertion order, which LINE_ID follows). */
  gl: { jid: number; seq: number; date: Date; acct: string; dr: number; cr: number; status: "posted" | "draft"; source: string }[] = [];
  nextJid = 1;
  /** Inventory movements: on hand per store:sku follows these exactly. */
  moves: { store: number; sku: string; type: string; qty: number; cost: number; date: Date; lot: string }[] = [];
}

/** Shared between stages. */
export interface State {
  model: Model;
  /** When the tables were created (flashback needs them a few seconds old). */
  createdAt: number;
  /** SCN and timestamp taken just before the back office changes prices. */
  scnBeforeBackOffice?: number;
  /** The year's profit, closed into retained earnings by the ledger stage. */
  profit?: number;
  tsBeforeBackOffice?: string;
}
