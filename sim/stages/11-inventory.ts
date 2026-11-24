/**
 * Stage 11 — Inventory. The stock table becomes the result of a movement
 * ledger: opening stock, one issue per sold item (from the trading day),
 * mid-year purchase lots at Makati, an inter-branch transfer and a cycle-count
 * shrinkage, each written together with the stock change in one transaction.
 *
 * Checks: ledger-to-stock reconciliation, weighted average cost, FIFO cost of
 * goods issued, FEFO lot picking by two workers at once (SKIP LOCKED), ABC
 * analysis, reorder alerts, stock-out runs and zero-sales days.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { PRODUCTS, STORES, T, stockFor, type State } from "../lib/data";
import { COST, DAILY, E, PURCHASES, SHRINK, TRANSFER, d, iso, saleDate, stockOutRuns } from "../lib/enterprise";

export async function inventoryStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const schema = new api.OracleSchema(db);
  const coll = (t: string) => new api.OracleCollection(t, db);
  const moves = coll(E.MOVES);
  const tx = new api.Transaction(db);
  const pid = (sku: string) => model.productIds.get(sku)!;

  await schema.createTable(E.MOVES, {
    MOVE_ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    MDATE: { type: "DATE", notNull: true },
    STORE_ID: { type: "NUMBER", notNull: true, references: { table: T.STORES, column: "STORE_ID" } },
    SKU: { type: "VARCHAR2(20)", notNull: true },
    MTYPE: { type: "VARCHAR2(8)", notNull: true, check: "MTYPE IN ('OPEN','RCV','ISS','TRF_OUT','TRF_IN','ADJ')" },
    QTY: { type: "NUMBER(14,3)", notNull: true },
    UNIT_COST: { type: "NUMBER(14,2)", notNull: true },
    LOT: { type: "VARCHAR2(10)" },
  });
  const record = (m: { store: number; sku: string; type: string; qty: number; cost: number; date: Date; lot: string }) => {
    model.moves.push(m);
    return { MDATE: m.date, STORE_ID: m.store, SKU: m.sku, MTYPE: m.type, QTY: m.qty, UNIT_COST: m.cost / 100, LOT: m.lot || null };
  };

  // Opening stock and one issue per sold item, as they happened.
  const history = [
    ...STORES.flatMap((s) => PRODUCTS.map((p) => record({ store: s.STORE_ID, sku: p.SKU, type: "OPEN", qty: stockFor(s.STORE_ID, p.SKU), cost: COST.get(p.SKU)!, date: d(2026, 1, 1), lot: "OPEN" }))),
    ...model.orders.flatMap((o) => o.lines.map((l) => record({ store: o.storeId, sku: l.sku, type: "ISS", qty: -l.qty, cost: COST.get(l.sku)!, date: saleDate(o.receipt), lot: "" }))),
  ];
  await moves.insertMany(history, { returning: [] });

  const reconcile = async (label: string) => {
    const ledger = await sim.mira(() => moves.aggregate([{ $group: { _id: { STORE_ID: "$STORE_ID", SKU: "$SKU" }, Q: { $sum: "$QTY" } } }, { $sort: { STORE_ID: 1, SKU: 1 } }]));
    const stock = await sim.mira(() =>
      coll(T.STOCK).aggregate([{ $lookup: { from: T.PRODUCTS, localField: "PRODUCT_ID", foreignField: "ID", as: "p", joinType: "inner", select: ["SKU"] } }, { $sort: { STORE_ID: 1, SKU: 1 } }]),
    );
    const key = (r: Record<string, unknown>) => `${r.STORE_ID}:${r.SKU}`;
    sim.eq(`${label}: on hand from the movement ledger = stock table = model`, [
      Object.fromEntries(ledger.map((r) => [key(r), Number(r.Q)])),
      Object.fromEntries(stock.map((r) => [key(r), Number(r.QTY)])),
    ], [Object.fromEntries([...model.stock].sort()), Object.fromEntries([...model.stock].sort())]);
  };
  await reconcile("after the trading day");

  // Purchases: each lot is a receipt movement plus a stock increase, in one transaction.
  for (const p of PURCHASES) {
    await tx.withTransaction(async (s) => {
      await s.collection(E.MOVES).insertOne(record({ store: 1, sku: p.SKU, type: "RCV", qty: p.QTY, cost: p.UNIT_COST, date: p.MDATE, lot: p.LOT }));
      await s.collection(T.STOCK).updateOne({ STORE_ID: 1, PRODUCT_ID: pid(p.SKU) }, { $inc: { QTY: p.QTY } });
    });
    model.stock.set(model.key(1, p.SKU), model.stock.get(model.key(1, p.SKU))! + p.QTY);
  }
  // Transfer Makati → Abreeza: both shelves locked, two movements, two stock rows, one transaction.
  await tx.withTransaction(async (s) => {
    const shelves = await s.collection(T.STOCK).find({ STORE_ID: { $in: [TRANSFER.FROM, TRANSFER.TO] }, PRODUCT_ID: pid(TRANSFER.SKU) }).sort({ STORE_ID: 1 }).forUpdate("nowait").toArray();
    sim.eq("transfer: both shelves locked before moving stock", shelves.length, 2);
    await s.collection(T.STOCK).updateOne({ STORE_ID: TRANSFER.FROM, PRODUCT_ID: pid(TRANSFER.SKU) }, { $inc: { QTY: -TRANSFER.QTY } });
    await s.collection(T.STOCK).updateOne({ STORE_ID: TRANSFER.TO, PRODUCT_ID: pid(TRANSFER.SKU) }, { $inc: { QTY: TRANSFER.QTY } });
    await s.collection(E.MOVES).insertMany([
      record({ store: TRANSFER.FROM, sku: TRANSFER.SKU, type: "TRF_OUT", qty: -TRANSFER.QTY, cost: COST.get(TRANSFER.SKU)!, date: TRANSFER.DATE, lot: "" }),
      record({ store: TRANSFER.TO, sku: TRANSFER.SKU, type: "TRF_IN", qty: TRANSFER.QTY, cost: COST.get(TRANSFER.SKU)!, date: TRANSFER.DATE, lot: "" }),
    ], { returning: [] });
  });
  model.stock.set(model.key(TRANSFER.FROM, TRANSFER.SKU), model.stock.get(model.key(TRANSFER.FROM, TRANSFER.SKU))! - TRANSFER.QTY);
  model.stock.set(model.key(TRANSFER.TO, TRANSFER.SKU), model.stock.get(model.key(TRANSFER.TO, TRANSFER.SKU))! + TRANSFER.QTY);
  // Cycle count: two lumpia missing at Ayala Center.
  await tx.withTransaction(async (s) => {
    await s.collection(E.MOVES).insertOne(record({ store: SHRINK.STORE_ID, sku: SHRINK.SKU, type: "ADJ", qty: SHRINK.QTY, cost: COST.get(SHRINK.SKU)!, date: SHRINK.DATE, lot: "COUNT" }));
    await s.collection(T.STOCK).updateOne({ STORE_ID: SHRINK.STORE_ID, PRODUCT_ID: pid(SHRINK.SKU) }, { $inc: { QTY: SHRINK.QTY } });
  });
  model.stock.set(model.key(SHRINK.STORE_ID, SHRINK.SKU), model.stock.get(model.key(SHRINK.STORE_ID, SHRINK.SKU))! + SHRINK.QTY);
  await reconcile("after purchases, transfer and shrinkage");

  // Weighted average cost of everything received (opening + purchases), per item.
  const wac = await sim.mira(() =>
    moves.aggregate([
      { $match: { MTYPE: { $in: ["OPEN", "RCV"] }, SKU: { $in: ["P-ADOBO", "P-COFFEE"] } } },
      { $addFields: { EXT: { $mul: ["$QTY", "$UNIT_COST"] } } },
      { $group: { _id: "$SKU", Q: { $sum: "$QTY" }, V: { $sum: "$EXT" } } },
      { $addFields: { WAC: { $divide: ["$V", "$Q"] } } },
      { $sort: { SKU: 1 } },
    ]),
  );
  const recv = (sku: string) => model.moves.filter((m) => m.sku === sku && (m.type === "OPEN" || m.type === "RCV"));
  sim.eq(
    "weighted average cost per item (receipts value ÷ quantity)",
    wac.map((r) => [r.SKU, Number(Number(r.WAC).toFixed(4))]),
    ["P-ADOBO", "P-COFFEE"].map((sku) => [sku, Number((recv(sku).reduce((s, m) => s + m.qty * m.cost, 0) / recv(sku).reduce((s, m) => s + m.qty, 0) / 100).toFixed(4))]),
  );

  // FIFO: issues at Makati consume the oldest layers first.
  // Running receipts per item (windowed), total issued per item, then each receipt layer
  // takes LEAST(layer, GREATEST(0, issued − quantity received before it)).
  const fifo = await sim.mira(() =>
    moves.aggregate([
      { $match: { STORE_ID: 1, SKU: { $in: ["P-ADOBO", "P-COFFEE"] } } },
      {
        $addFields: {
          INQ: { $cond: { if: { $or: [{ $eq: ["$MTYPE", "OPEN"] }, { $eq: ["$MTYPE", "RCV"] }] }, then: "$QTY", else: 0 } },
          OUTQ: { $cond: { if: { $lt: ["$QTY", 0] }, then: { $mul: ["$QTY", -1] }, else: 0 } },
        },
      },
      {
        $addFields: {
          CUMIN: { $window: { fn: "SUM", field: "INQ", partitionBy: "SKU", orderBy: { MDATE: 1, MOVE_ID: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } },
          ISSUED: { $window: { fn: "SUM", field: "OUTQ", partitionBy: "SKU" } },
        },
      },
      { $match: { MTYPE: { $in: ["OPEN", "RCV"] } } },
      { $addFields: { TAKE: { $min: ["$QTY", { $max: [0, { $subtract: ["$ISSUED", { $subtract: ["$CUMIN", "$QTY"] }] }] }] } } },
      { $group: { _id: "$SKU", COGS: { $sum: { $mul: ["$TAKE", "$UNIT_COST"] } }, ENDING: { $sum: { $mul: [{ $subtract: ["$QTY", "$TAKE"] }, "$UNIT_COST"] } } } },
      { $sort: { SKU: 1 } },
    ]),
  );
  const fifoModel = (sku: string) => {
    const layers = model.moves.filter((m) => m.store === 1 && m.sku === sku && m.qty > 0 && (m.type === "OPEN" || m.type === "RCV")).sort((a, b) => +a.date - +b.date);
    let issued = -model.moves.filter((m) => m.store === 1 && m.sku === sku && m.qty < 0).reduce((s, m) => s + m.qty, 0);
    let cogs = 0;
    let ending = 0;
    for (const l of layers) {
      const take = Math.min(l.qty, Math.max(0, issued));
      issued -= take;
      cogs += take * l.cost;
      ending += (l.qty - take) * l.cost;
    }
    return [sku, cogs, ending];
  };
  sim.eq("FIFO: cost of goods issued and ending value at Makati", fifo.map((r) => [r.SKU, cents(r.COGS), cents(r.ENDING)]), ["P-ADOBO", "P-COFFEE"].map(fifoModel));

  // FEFO picking: lots with expiry dates, two pickers at once.
  await schema.createTable(E.LOTS, { LOT: { type: "VARCHAR2(10)", primaryKey: true }, STORE_ID: { type: "NUMBER" }, SKU: { type: "VARCHAR2(20)" }, QTY_LEFT: { type: "NUMBER" }, EXPIRY: { type: "DATE" } });
  await coll(E.LOTS).insertMany([...PURCHASES.map((p) => ({ LOT: p.LOT, STORE_ID: 1, SKU: p.SKU, QTY_LEFT: p.QTY, EXPIRY: p.EXPIRY })), { LOT: "AD-OPEN", STORE_ID: 1, SKU: "P-ADOBO", QTY_LEFT: 3, EXPIRY: d(2026, 12, 31) }], { returning: [] });
  const fefo = [...PURCHASES.filter((p) => p.SKU === "P-ADOBO").map((p) => [p.LOT, p.EXPIRY] as const), ["AD-OPEN", d(2026, 12, 31)] as const].sort((a, b) => +a[1] - +b[1]).map(([l]) => l);
  const pick = (s: { collection: (t: string) => { find: InstanceType<typeof api.OracleCollection>["find"] } }) =>
    s.collection(E.LOTS).find({ STORE_ID: 1, SKU: "P-ADOBO", QTY_LEFT: { $gt: 0 } }).sort({ EXPIRY: 1 }).limit(1).forUpdate("skip locked").toArray<{ LOT: string }>();
  await tx.withTransaction(async (a) => {
    const first = await pick(a);
    await tx.withTransaction(async (b) => {
      const second = await pick(b);
      sim.eq("FEFO picking: two pickers at once get the two earliest-expiring lots (SKIP LOCKED)", [first[0]?.LOT, second[0]?.LOT], fefo.slice(0, 2));
    });
  });

  // ABC analysis: items by sales value, class A = the items making up the first 80%.
  const abc = await sim.mira(() =>
    coll(T.LINES).aggregate([
      { $addFields: { VAL: { $mul: ["$QTY", "$UNIT_PRICE"] } } },
      { $group: { _id: "$PRODUCT_ID", VAL: { $sum: "$VAL" } } },
      { $project: { PRODUCT_ID: 1, VAL: 1, CUM: { $window: { fn: "SUM", field: "VAL", orderBy: { VAL: -1, PRODUCT_ID: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } }, TOT: { $window: { fn: "SUM", field: "VAL" } } } },
      { $addFields: { SHARE: { $divide: ["$CUM", "$TOT"] } } },
      { $match: { SHARE: { $lte: 0.8 } } },
      { $sort: { VAL: -1, PRODUCT_ID: 1 } },
    ]),
  );
  const valBy = new Map<number, number>();
  for (const o of model.orders) for (const l of o.lines) valBy.set(pid(l.sku), (valBy.get(pid(l.sku)) ?? 0) + l.qty * l.unit);
  const ranked = [...valBy].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  let cum = 0;
  const classOf = new Map(ranked.map(([id, v]) => [id, (cum += v) / total <= 0.8 ? "A" : cum / total <= 0.95 ? "B" : "C"]));
  sim.eq("ABC: class A items (cumulative share of sales ≤ 80%)", abc.map((r) => Number(r.PRODUCT_ID)), ranked.filter(([id]) => classOf.get(id) === "A").map(([id]) => id));
  const abcAll = await sim.mira(() =>
    coll(T.LINES).aggregate([
      { $addFields: { VAL: { $mul: ["$QTY", "$UNIT_PRICE"] } } },
      { $group: { _id: "$PRODUCT_ID", VAL: { $sum: "$VAL" } } },
      { $addFields: { CUM: { $window: { fn: "SUM", field: "VAL", orderBy: { VAL: -1, PRODUCT_ID: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } }, TOT: { $window: { fn: "SUM", field: "VAL" } } } },
      { $addFields: { CLS: { $switch: { branches: [{ case: { $lte: [{ $divide: ["$CUM", "$TOT"] }, 0.8] }, then: "A" }, { case: { $lte: [{ $divide: ["$CUM", "$TOT"] }, 0.95] }, then: "B" }], default: "C" } } } },
      { $sort: { VAL: -1, PRODUCT_ID: 1 } },
    ]),
  );
  sim.eq("ABC: every item's class", abcAll.map((r) => [Number(r.PRODUCT_ID), r.CLS]), ranked.map(([id]) => [id, classOf.get(id)]));

  // Reorder alerts: shelves below their reorder point.
  await schema.createTable(E.REORDER, { STORE_ID: { type: "NUMBER" }, PRODUCT_ID: { type: "NUMBER" }, ROP: { type: "NUMBER" } });
  const rop = (store: number, sku: string) => (sku === "P-HALO" || sku === "P-TURON" ? 2 : 25 + store);
  await coll(E.REORDER).insertMany(STORES.flatMap((s) => PRODUCTS.map((p) => ({ STORE_ID: s.STORE_ID, PRODUCT_ID: pid(p.SKU), ROP: rop(s.STORE_ID, p.SKU) }))), { returning: [] });
  const low = await sim.mira(() =>
    coll(T.STOCK).aggregate([
      { $lookup: { from: E.REORDER, as: "r", joinType: "inner", localField: "STORE_ID", foreignField: "STORE_ID", on: [{ localField: "STORE_ID", foreignField: "STORE_ID" }, { localField: "PRODUCT_ID", foreignField: "PRODUCT_ID" }], select: ["ROP"] } },
      { $addFields: { SHORT: { $subtract: ["$ROP", "$QTY"] } } },
      { $match: { SHORT: { $gt: 0 } } },
      { $sort: { STORE_ID: 1, PRODUCT_ID: 1 } },
    ]),
  );
  const lowModel = STORES.flatMap((s) => PRODUCTS.map((p) => [s.STORE_ID, pid(p.SKU), rop(s.STORE_ID, p.SKU) - model.stock.get(model.key(s.STORE_ID, p.SKU))!])).filter((r) => r[2] > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  sim.eq("reorder alerts: shelves below their reorder point, with the shortfall", low.map((r) => [Number(r.STORE_ID), Number(r.PRODUCT_ID), Number(r.SHORT)]), lowModel);

  // Stock-out runs in December (gaps and islands).
  await schema.createTable(E.DAILY, { SKU: { type: "VARCHAR2(20)" }, D: { type: "DATE" }, QTY: { type: "NUMBER" } });
  await coll(E.DAILY).insertMany(DAILY, { returning: [] });
  const runs = await sim.viaSql("stock-out runs (consecutive zero days)", "MATCH_RECOGNIZE (row pattern matching) is not exposed", () =>
    raw<{ SKU: string; START_D: string; DAYS: number }>(
      `SELECT SKU, TO_CHAR(START_D, 'YYYY-MM-DD') AS START_D, DAYS FROM "${E.DAILY}"
       MATCH_RECOGNIZE (PARTITION BY SKU ORDER BY D
                        MEASURES FIRST(D) AS START_D, COUNT(*) AS DAYS
                        ONE ROW PER MATCH PATTERN (Z+) DEFINE Z AS QTY = 0)
       ORDER BY SKU, START_D`,
    ),
  );
  sim.eq("stock-out runs: start date and length of every run", runs.map((r) => ({ sku: r.SKU, start: r.START_D, days: Number(r.DAYS) })), stockOutRuns());

  // Zero-sales days for two items in Q4, densified against a calendar.
  const dense = await sim.viaSql("zero-sales days (calendar densification)", "partitioned outer join and a row generator (CONNECT BY LEVEL) are not exposed", () =>
    raw<{ SKU: string; ZERO_DAYS: number }>(
      `WITH cal AS (SELECT DATE '2026-10-01' + LEVEL - 1 AS D FROM DUAL CONNECT BY LEVEL <= 92),
            s AS (SELECT SKU, MDATE, -QTY AS QTY FROM "${E.MOVES}" WHERE MTYPE = 'ISS' AND SKU IN ('P-ADOBO','P-CALA'))
       SELECT SKU, COUNT(*) AS ZERO_DAYS FROM (
         SELECT s.SKU, c.D, NVL(SUM(s.QTY), 0) AS SOLD FROM s PARTITION BY (s.SKU) RIGHT OUTER JOIN cal c ON (s.MDATE = c.D) GROUP BY s.SKU, c.D)
        WHERE SOLD = 0 GROUP BY SKU ORDER BY SKU`,
    ),
  );
  const soldDays = (sku: string) => new Set(model.moves.filter((m) => m.type === "ISS" && m.sku === sku && m.date >= d(2026, 10, 1)).map((m) => iso(m.date))).size;
  sim.eq("zero-sales days in Q4 per item (92 days minus days with a sale)", dense.map((r) => [r.SKU, Number(r.ZERO_DAYS)]), ["P-ADOBO", "P-CALA"].map((sku) => [sku, 92 - soldDays(sku)]));
}
