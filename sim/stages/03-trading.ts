/**
 * Stage 3 — A trading day. 36 till transactions, each one Transaction:
 *
 *   receipt number (sequence, via session.execute)
 *   → order header (insertOne)
 *   → lock the stock rows (find().forUpdate("nowait"))
 *   → take each item off the shelf (updateOne $inc; the QTY >= 0 check
 *     constraint refuses an oversell, which rolls the whole sale back)
 *   → order lines (insertMany)
 *   → optional dessert add-on behind a SAVEPOINT: if that shelf is empty the
 *     add-on is rolled back to the savepoint and the sale continues
 *   → total from the lines (aggregate on the session's connection)
 *   → pay from the customer's credit (findOneAndUpdate with CREDIT >= total;
 *     no row means not enough credit, and the sale rolls back)
 *
 * The in-memory model makes the same decisions independently; afterwards the
 * database must match it exactly (orders, lines, stock, credit, receipts).
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { ADDON_SKU, ORDER_REQUESTS, PRODUCTS, T, type State } from "../lib/data";

const err = (e: unknown) => (e as Error).message ?? String(e);

export async function tradingStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw, rawCount } = ctx;
  const { model } = state;
  const tx = new api.Transaction(db);
  const priceOf = (sku: string) => model.price.get(sku)!;

  for (const [i, req] of ORDER_REQUESTS.entries()) {
    const customerId = model.customerIds[req.customer];
    const receipt = 1000 + i; // one NEXTVAL per attempt, kept even when the sale rolls back

    // The model's decision.
    let expected: "ok" | "stock" | "credit" = "ok";
    if (req.lines.some((l) => model.stock.get(model.key(req.storeId, l.sku))! < l.qty)) expected = "stock";
    // The add-on comes off the shelf after the main items, so a Halo-Halo main item counts first.
    const haloInMain = req.lines.filter((l) => l.sku === ADDON_SKU).reduce((s, l) => s + l.qty, 0);
    const addOnFits = req.addOn && model.stock.get(model.key(req.storeId, ADDON_SKU))! - haloInMain >= 1;
    const total = req.lines.reduce((s, l) => s + l.qty * priceOf(l.sku), 0) + (addOnFits ? priceOf(ADDON_SKU) : 0);
    if (expected === "ok" && model.credit.get(customerId)! < total) expected = "credit";

    // The database's decision.
    let outcome: "ok" | "stock" | "credit" = "ok";
    let orderId = 0;
    let addOnKept = false;
    try {
      await tx.withTransaction(async (s) => {
        const seq = await s.execute<{ N: number }>(`SELECT "${T.RECEIPT_SEQ}".NEXTVAL AS N FROM DUAL`, {}, { outFormat: db.oracledb.OUT_FORMAT_OBJECT });
        const receiptNo = Number(seq.rows![0].N);
        const order = await s.collection(T.ORDERS).insertOne({ RECEIPT_NO: receiptNo, CUSTOMER_ID: customerId, STORE_ID: req.storeId, QUARTER: req.quarter });
        orderId = Number(order.insertedId);

        const ids = req.lines.map((l) => model.productIds.get(l.sku)!);
        if (req.addOn) ids.push(model.productIds.get(ADDON_SKU)!);
        await s.collection(T.STOCK).find({ STORE_ID: req.storeId, PRODUCT_ID: { $in: ids } }).forUpdate("nowait").toArray();

        for (const l of req.lines) await s.collection(T.STOCK).updateOne({ STORE_ID: req.storeId, PRODUCT_ID: model.productIds.get(l.sku) }, { $inc: { QTY: -l.qty } });
        await s.collection(T.LINES).insertMany(
          req.lines.map((l) => ({ ORDER_ID: orderId, PRODUCT_ID: model.productIds.get(l.sku), QTY: l.qty, UNIT_PRICE: priceOf(l.sku) / 100 })),
          { returning: [] },
        );

        if (req.addOn) {
          await s.savepoint("SP_ADDON");
          try {
            await s.collection(T.LINES).insertOne({ ORDER_ID: orderId, PRODUCT_ID: model.productIds.get(ADDON_SKU), QTY: 1, UNIT_PRICE: priceOf(ADDON_SKU) / 100 });
            await s.collection(T.STOCK).updateOne({ STORE_ID: req.storeId, PRODUCT_ID: model.productIds.get(ADDON_SKU) }, { $inc: { QTY: -1 } });
            addOnKept = true;
          } catch (e) {
            if (!/ORA-02290/.test(err(e))) throw e;
            await s.rollbackTo("SP_ADDON");
          }
          await s.releaseSavepoint("SP_ADDON");
        }

        const [sum] = await s.collection(T.LINES).aggregate([
          { $match: { ORDER_ID: orderId } },
          { $project: { ORDER_ID: 1, LINE_TOTAL: { $mul: ["$QTY", "$UNIT_PRICE"] } } },
          { $group: { _id: "$ORDER_ID", TOTAL: { $sum: "$LINE_TOTAL" } } },
        ]);
        const orderTotal = Number(sum.TOTAL);
        const paid = await s.collection(T.CUSTOMERS).findOneAndUpdate({ ID: customerId, CREDIT: { $gte: orderTotal } }, { $inc: { CREDIT: -orderTotal } }, { returnDocument: "after" });
        if (!paid) throw new Error("INSUFFICIENT_CREDIT");
        await s.collection(T.ORDERS).updateOne({ ID: orderId }, { $set: { TOTAL: orderTotal, STATUS: "paid" }, $currentDate: { CREATED_AT: { $type: "timestamp" } } });
      });
    } catch (e) {
      outcome = /ORA-02290/.test(err(e)) ? "stock" : /INSUFFICIENT_CREDIT/.test(err(e)) ? "credit" : (() => { throw e; })();
    }

    sim.eq(`sale ${String(i + 1).padStart(2, "0")} (${req.storeId}/${req.quarter}): ${expected === "ok" ? "completed" : `refused, ${expected}`}`, outcome, expected);
    if (outcome !== "ok") {
      model.rejected.push({ request: i, reason: outcome });
      continue;
    }
    for (const l of req.lines) model.stock.set(model.key(req.storeId, l.sku), model.stock.get(model.key(req.storeId, l.sku))! - l.qty);
    if (req.addOn && addOnFits) model.addOnsKept++;
    if (req.addOn && !addOnFits) model.addOnsRolledBack++;
    if (addOnFits) model.stock.set(model.key(req.storeId, ADDON_SKU), model.stock.get(model.key(req.storeId, ADDON_SKU))! - 1);
    model.credit.set(customerId, model.credit.get(customerId)! - total);
    if (req.addOn) sim.eq(`sale ${String(i + 1).padStart(2, "0")}: add-on ${addOnFits ? "kept" : "rolled back to the savepoint"}`, addOnKept, addOnFits);
    model.orders.push({
      receipt,
      orderId,
      customerId,
      storeId: req.storeId,
      quarter: req.quarter,
      total,
      lines: [...req.lines.map((l) => ({ sku: l.sku, qty: l.qty, unit: priceOf(l.sku) })), ...(addOnFits ? [{ sku: ADDON_SKU, qty: 1, unit: priceOf(ADDON_SKU) }] : [])],
    });
  }

  sim.ok("the day had completed sales, stock refusals, credit refusals and savepoint rollbacks", model.orders.length > 0 && model.rejected.some((r) => r.reason === "stock") && model.rejected.some((r) => r.reason === "credit") && model.addOnsRolledBack > 0, { orders: model.orders.length, rejected: model.rejected, addOnsRolledBack: model.addOnsRolledBack });

  // The database must now equal the model.
  const orders = await raw<{ RECEIPT_NO: number; CUSTOMER_ID: number; STORE_ID: number; QUARTER: string; STATUS: string; TOTAL: string }>(`SELECT RECEIPT_NO, CUSTOMER_ID, STORE_ID, QUARTER, STATUS, TOTAL FROM "${T.ORDERS}" ORDER BY RECEIPT_NO`);
  sim.eq(
    "orders: exactly the completed sales, paid, with their receipt numbers and totals",
    orders.map((o) => [Number(o.RECEIPT_NO), Number(o.CUSTOMER_ID), Number(o.STORE_ID), o.QUARTER, o.STATUS, cents(o.TOTAL)]),
    model.orders.map((o) => [o.receipt, o.customerId, o.storeId, o.quarter, "paid", o.total]),
  );
  const lineCount = model.orders.reduce((s, o) => s + o.lines.length, 0);
  sim.eq("order lines: no line from a refused sale or a rolled-back add-on survived", await rawCount(T.LINES), lineCount);
  const stockRows = await raw<{ STORE_ID: number; SKU: string; QTY: number }>(`SELECT s.STORE_ID, p.SKU, s.QTY FROM "${T.STOCK}" s JOIN "${T.PRODUCTS}" p ON p.ID = s.PRODUCT_ID ORDER BY s.STORE_ID, p.SKU`);
  sim.eq("stock: every shelf matches the model", stockRows.map((r) => `${r.STORE_ID}:${r.SKU}=${r.QTY}`), stockRows.map((r) => `${r.STORE_ID}:${r.SKU}=${model.stock.get(model.key(Number(r.STORE_ID), r.SKU))}`));
  const credit = await raw<{ ID: number; CREDIT: string }>(`SELECT ID, CREDIT FROM "${T.CUSTOMERS}" ORDER BY ID`);
  sim.eq("credit: every customer's balance matches the model", credit.map((c) => [Number(c.ID), cents(c.CREDIT)]), model.customerIds.map((id) => [id, model.credit.get(id)]));
  const [{ V }] = await raw<{ V: number }>(`SELECT LAST_NUMBER AS V FROM USER_SEQUENCES WHERE SEQUENCE_NAME = :s`, { s: T.RECEIPT_SEQ });
  sim.ok("receipt sequence advanced past every attempt, including refused sales", Number(V) >= 1000 + ORDER_REQUESTS.length, V);

  // Two tills, one shelf: a locked stock row is refused to the second till (NOWAIT), skipped by SKIP LOCKED.
  const adoboId = model.productIds.get(PRODUCTS[0].SKU)!;
  const turonId = model.productIds.get("P-TURON")!;
  await tx.withTransaction(async (s) => {
    const locked = await s.collection(T.STOCK).find({ STORE_ID: 1, PRODUCT_ID: adoboId }).forUpdate({ nowait: true }).toArray();
    sim.eq("forUpdate: till 1 locks the Makati adobo shelf", locked.length, 1);
    const other = new api.OracleCollection(T.STOCK, db);
    await sim.rejects("forUpdate nowait: till 2 is refused the same shelf (ORA-00054)", other.find({ STORE_ID: 1, PRODUCT_ID: adoboId }).forUpdate("nowait").toArray(), /ORA-00054/);
    const free = await other.find({ STORE_ID: 1, PRODUCT_ID: { $in: [adoboId, turonId] } }).forUpdate("skip locked").toArray();
    sim.eq("forUpdate skip locked: till 2 gets only the unlocked shelf", free.map((r) => Number(r.PRODUCT_ID)), [turonId]);
  });

  // Settle Q1 through db.withTransaction with a collection bound to the connection: first a run that fails and rolls back, then the real one.
  const q1 = model.orders.filter((o) => o.quarter === "Q1").length;
  await sim.rejects(
    "db.withTransaction: a failure rolls the settlement back",
    db.withTransaction(async (conn) => {
      await new api.OracleCollection(T.ORDERS, db, conn).updateMany({ QUARTER: "Q1" }, { $set: { STATUS: "settled" } });
      throw new Error("bank file rejected");
    }),
    /bank file rejected/,
  );
  sim.eq("db.withTransaction rollback: nothing settled", await rawCount(T.ORDERS, "WHERE STATUS = 'settled'"), 0);
  const settled = await db.withTransaction((conn) => new api.OracleCollection(T.ORDERS, db, conn).updateMany({ QUARTER: "Q1" }, { $set: { STATUS: "settled" } }));
  sim.eq("db.withTransaction commit: every Q1 order settled", [settled.modifiedCount, await rawCount(T.ORDERS, "WHERE STATUS = 'settled'")], [q1, q1]);

  // db.withConnection for a raw read, db.withBatchConnection for several on one connection.
  const sid = await db.withConnection(async (c) => (await c.execute<{ S: string }>("SELECT SYS_CONTEXT('USERENV','SID') AS S FROM DUAL", {}, { outFormat: db.oracledb.OUT_FORMAT_OBJECT })).rows![0].S);
  sim.ok("db.withConnection: runs a raw statement on a pooled connection", !!sid, sid);
  const batch = await db.withBatchConnection([
    async (c: unknown) => (await (c as { execute: (q: string) => Promise<{ rows: { S: string }[] }> }).execute("SELECT SYS_CONTEXT('USERENV','SID') AS S FROM DUAL")).rows[0].S,
    async (c: unknown) => (await (c as { execute: (q: string) => Promise<{ rows: { S: string }[] }> }).execute("SELECT SYS_CONTEXT('USERENV','SID') AS S FROM DUAL")).rows[0].S,
    async () => {
      throw new Error("printer offline");
    },
  ]);
  sim.eq("db.withBatchConnection: per-operation outcomes", batch.map((r: { success: boolean }) => r.success), [true, true, false]);
  sim.ok("db.withBatchConnection: both reads ran on the same session", (batch[0] as { result: unknown }).result === (batch[1] as { result: unknown }).result, batch);
}
