/**
 * TYPE TESTS for after(), for await, sql`…` and onQuery (Mira 2.1). Checked by `bun run typecheck`, never run.
 */
import { defineTable, t, createDb, sql, onQuery, type QueryEvent, type SqlStatement } from "../../src/utils/oracle-mongo-wrapper";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

const Orders = defineTable("ORDERS", { ID: t.id(), TOTAL: t.money(), NOTE: t.text(20).nullable() });
const db = createDb("appDb");
const orders = Orders.on(db);

async function usage() {
  const page = await orders.find().sort({ TOTAL: -1, ID: 1 }).limit(20).toArray();
  const next = await orders.find().sort({ TOTAL: -1, ID: 1 }).after(page[page.length - 1]).limit(20).toArray();
  assert<Equal<(typeof next)[number], { ID: number; TOTAL: string; NOTE: string | null }>>();
  await orders.find().sort({ ID: 1 }).after({ ID: 5 });
  // @ts-expect-error the cursor's values have the columns' types
  orders.find().sort({ ID: 1 }).after({ ID: "5" });

  for await (const row of orders.find().project({ ID: 1 })) {
    assert<Equal<typeof row, { ID: number }>>();
    void row.ID;
  }

  const q: SqlStatement = sql`SELECT * FROM ${sql.ident("ORDERS")} WHERE ID IN (${[1, 2]})`;
  const rows = await q.rows<{ ID: number }>(db);
  assert<Equal<typeof rows, { ID: number }[]>>();
  const res = await q.execute(db);
  assert<Equal<typeof res.rowsAffected, number>>();

  const stop: () => void = onQuery((e) => {
    assert<Equal<typeof e, QueryEvent>>();
  });
  stop();
}
void usage;
