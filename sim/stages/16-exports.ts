/**
 * Stage 16 — Month-end exports, with the smaller 2.1 tools:
 *   - the accountant's sales export, paged with after() (keyset pagination),
 *   - a streamed pass over every sale with `for await`, stopping early for the
 *     first big ticket,
 *   - an ad-hoc store report in raw SQL through sql`…`, every value bound,
 *   - onQuery() counting the export's statements and checking no bind value leaks.
 * Every result is checked against the model kept by the trading stage.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

// The table holds currency (NUMBER(12,2)); the model keeps totals in cents.
const cents = (v: unknown) => Math.round(Number(v) * 100);

export async function exportsStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db } = ctx;
  const { model } = state;
  const { sql } = api;
  const orders = new api.OracleCollection(T.ORDERS, db);

  const events: Array<{ sql: string; bindCount: number; error?: Error }> = [];
  const stop = api.onQuery((e) => events.push(e));

  // 1. The sales export, biggest tickets first, 7 per page, each page after the last row of the one before.
  const want = [...model.orders].sort((a, b) => b.total - a.total || a.orderId - b.orderId).map((o) => o.orderId);
  const exported: number[] = [];
  let last: Record<string, unknown> | undefined;
  let pages = 0;
  for (;;) {
    const q = orders.find({}).sort({ TOTAL: -1, ID: 1 }).project({ ID: 1, TOTAL: 1 }).limit(7);
    const page = await sim.mira(() => (last ? q.after(last) : q).toArray<{ ID: number; TOTAL: number }>());
    if (page.length === 0) break;
    pages++;
    exported.push(...page.map((r) => Number(r.ID)));
    last = page[page.length - 1];
  }
  sim.eq("after(): the keyset-paged export has every sale once, biggest first (ties by ID)", exported, want);
  sim.eq("after(): pages of 7", pages, Math.ceil(model.orders.length / 7));

  // 2. Stream every sale once; and stop at the first ticket over 1,000.00 in receipt order.
  let streamed = 0;
  let streamedCents = 0;
  await sim.mira(async () => {
    for await (const row of orders.find({}).project({ TOTAL: 1 })) {
      streamed++;
      streamedCents += cents(row.TOTAL);
    }
  });
  sim.eq("for await: streamed every sale and its total", [streamed, streamedCents], [model.orders.length, model.orders.reduce((s, o) => s + o.total, 0)]);
  let firstBig: number | null = null;
  await sim.mira(async () => {
    for await (const row of orders.find({ TOTAL: { $gt: 1000 } }).sort({ RECEIPT_NO: 1 })) {
      firstBig = Number(row.RECEIPT_NO);
      break;
    }
  });
  const big = [...model.orders].sort((a, b) => a.receipt - b.receipt).find((o) => o.total > 100_000);
  sim.eq("for await + break: the first big ticket by receipt number", firstBig, big?.receipt ?? null);

  // 3. The store report in raw SQL: a list of stores (IN), a threshold, a quoted table name; all bound.
  const stores = [...new Set(model.orders.map((o) => o.storeId))].sort((a, b) => a - b).slice(0, 2);
  const min = 50;
  const report = await sim.mira(() =>
    sql`SELECT STORE_ID, COUNT(*) AS N, SUM(TOTAL) AS TOTAL
          FROM ${sql.ident(T.ORDERS)}
         WHERE STORE_ID IN (${stores}) AND TOTAL >= ${min}
         GROUP BY STORE_ID ORDER BY STORE_ID`.rows<{ STORE_ID: number; N: number; TOTAL: number }>(db),
  );
  const expected = stores
    .map((s) => {
      const os = model.orders.filter((o) => o.storeId === s && o.total >= min * 100);
      return { store: s, n: os.length, total: os.reduce((t, o) => t + o.total, 0) };
    })
    .filter((r) => r.n > 0);
  sim.eq("sql`…`: the store report (IN list and threshold bound)", report.map((r) => ({ store: Number(r.STORE_ID), n: Number(r.N), total: cents(r.TOTAL) })), expected);

  stop();
  const mine = events.filter((e) => e.sql.includes(T.ORDERS));
  sim.ok("onQuery: an event for every export statement (pages, streams, report)", mine.length >= pages + 1 + 1, { events: mine.length, pages });
  sim.ok("onQuery: events carry bind counts, never the bound values", mine.some((e) => e.bindCount > 0) && !JSON.stringify(mine).includes(`"${stores[0]}"`) && mine.every((e) => !e.error), mine.slice(0, 3));
  const before = events.length;
  await orders.countDocuments();
  sim.eq("onQuery: no events after unsubscribing", events.length, before);
}
