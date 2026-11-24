/**
 * Stage 12 — Kitchen production. Three dishes have multi-level recipes (a bill
 * of materials): Halo-Halo uses a sweet mix, which uses a syrup; sinigang uses
 * a vegetable mix. Sugar is used at two levels.
 *
 * Checks: recipe explosion (levels, every component), quantity explosion down
 * the levels, where-used, raw-material needs for the dishes sold (MRP net of
 * on-hand), the dish cost roll-up, and cycle detection on a bad recipe.
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";
import type { State } from "../lib/data";
import { BOM, E, ITEMS, RAW_ON_HAND, bomTree, explode, whereUsed } from "../lib/enterprise";

const DISHES = ["P-HALO", "P-ADOBO", "P-SINIG"];
const r4 = (x: unknown) => Math.round(Number(x) * 1e4) / 1e4;

export async function kitchenStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const schema = new api.OracleSchema(db);
  const coll = (t: string) => new api.OracleCollection(t, db);
  const bom = coll(E.BOM);

  await schema.createTable(E.ITEMS, { CODE: { type: "VARCHAR2(20)", primaryKey: true }, NAME: { type: "VARCHAR2(40)" }, KIND: { type: "VARCHAR2(5)", check: "KIND IN ('dish','sub','raw')" }, COST: { type: "NUMBER(14,2)" }, ON_HAND: { type: "NUMBER(14,3)", default: 0 } });
  await schema.createTable(E.BOM, { PARENT: { type: "VARCHAR2(20)", notNull: true, references: { table: E.ITEMS, column: "CODE" } }, CHILD: { type: "VARCHAR2(20)", notNull: true, references: { table: E.ITEMS, column: "CODE" } }, QTY: { type: "NUMBER(14,4)", notNull: true } });
  await coll(E.ITEMS).insertMany(ITEMS.map((i) => ({ CODE: i.CODE, NAME: i.NAME, KIND: i.KIND, COST: i.COST / 100, ON_HAND: RAW_ON_HAND[i.CODE] ?? 0 })), { returning: [] });
  await bom.insertMany(BOM, { returning: [] });

  // Explosion: every component under Halo-Halo with its level.
  const tree = (await sim.mira(() => bom.connectBy({ startWith: { PARENT: "P-HALO" }, connectBy: { PARENT: "$PRIOR CHILD" }, includeLevel: true }))) as { CHILD: string; LEVEL: number }[];
  const sortPairs = (xs: [string, number][]) => xs.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  sim.eq("connectBy: Halo-Halo recipe explodes to every component with its level", sortPairs(tree.map((r) => [r.CHILD, Number(r.LEVEL)])), sortPairs(bomTree("P-HALO").map((x) => [x.item, x.level])));
  const rec = (await sim.mira(() => api.withRecursiveCTE(db, "R", { anchor: bom.find({ PARENT: "P-SINIG" }), recursive: { collection: E.BOM, joinOn: { PARENT: "$R.CHILD" } } }).toArray())) as { CHILD: string; LVL: number }[];
  sim.eq("withRecursiveCTE: sinigang recipe explodes to the same tree", sortPairs(rec.map((r) => [r.CHILD, Number(r.LVL)])), sortPairs(bomTree("P-SINIG").map((x) => [x.item, x.level])));

  // Where-used: every recipe that needs sugar, at any level.
  const used = (await sim.mira(() => bom.connectBy({ startWith: { CHILD: "SUGAR" }, connectBy: { CHILD: "$PRIOR PARENT" } }))) as { PARENT: string }[];
  sim.eq("where-used: sugar is needed by the syrup, the sweet mix and Halo-Halo", [...new Set(used.map((r) => r.PARENT))].sort(), [...whereUsed("SUGAR")].sort());

  // Quantities multiplied down the levels: raw material per dish.
  const qty = await sim.viaSql("raw material per dish (quantity explosion)", "the recursive CTE builder joins levels but cannot carry an expression (parent quantity × child quantity) down them", () =>
    raw<{ DISH: string; ITEM: string; QTY: number }>(
      `WITH x (DISH, ITEM, QTY) AS (
         SELECT PARENT, CHILD, QTY FROM "${E.BOM}" WHERE PARENT IN ('P-HALO','P-ADOBO','P-SINIG')
         UNION ALL
         SELECT x.DISH, b.CHILD, x.QTY * b.QTY FROM x JOIN "${E.BOM}" b ON b.PARENT = x.ITEM)
       SELECT x.DISH, x.ITEM, SUM(x.QTY) AS QTY FROM x JOIN "${E.ITEMS}" i ON i.CODE = x.ITEM
        WHERE i.KIND = 'raw' GROUP BY x.DISH, x.ITEM ORDER BY x.DISH, x.ITEM`,
    ),
  );
  sim.eq(
    "quantity explosion: raw material per dish, multiplied through every level",
    qty.map((r) => [r.DISH, r.ITEM, r4(r.QTY)]),
    [...DISHES].sort().flatMap((dish) => [...explode(dish)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([item, q]) => [dish, item, r4(q)])),
  );

  // MRP: raw material needed to make what was sold, net of what is on hand.
  const sold = new Map<string, number>();
  for (const o of model.orders) for (const l of o.lines) if (DISHES.includes(l.sku)) sold.set(l.sku, (sold.get(l.sku) ?? 0) + l.qty);
  const need = new Map<string, number>();
  for (const [dish, n] of sold) for (const [item, q] of explode(dish)) need.set(item, (need.get(item) ?? 0) + n * q);
  const mrp = await sim.viaSql("MRP net requirements", "needs the quantity explosion above joined to demand and on-hand, with GREATEST(0, need − on hand)", () =>
    raw<{ ITEM: string; NET_NEED: number }>(
      `WITH demand AS (SELECT p.SKU AS DISH, SUM(l.QTY) AS N FROM SIM_ORDER_LINES l JOIN SIM_PRODUCTS p ON p.ID = l.PRODUCT_ID
                        WHERE p.SKU IN ('P-HALO','P-ADOBO','P-SINIG') GROUP BY p.SKU),
            x (DISH, ITEM, QTY) AS (
              SELECT PARENT, CHILD, QTY FROM "${E.BOM}" WHERE PARENT IN ('P-HALO','P-ADOBO','P-SINIG')
              UNION ALL
              SELECT x.DISH, b.CHILD, x.QTY * b.QTY FROM x JOIN "${E.BOM}" b ON b.PARENT = x.ITEM)
       SELECT i.CODE AS ITEM, GREATEST(0, SUM(x.QTY * d.N) - i.ON_HAND) AS NET_NEED
         FROM x JOIN demand d ON d.DISH = x.DISH JOIN "${E.ITEMS}" i ON i.CODE = x.ITEM
        WHERE i.KIND = 'raw' GROUP BY i.CODE, i.ON_HAND ORDER BY i.CODE`,
    ),
  );
  sim.eq("MRP: raw material to buy for the dishes sold (need − on hand, never negative)", mrp.map((r) => [r.ITEM, r4(r.NET_NEED)]), [...need].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([item, q]) => [item, r4(Math.max(0, q - (RAW_ON_HAND[item] ?? 0)))]));

  // Cost roll-up: what one plate costs in raw material.
  const cost = await sim.viaSql("dish cost roll-up", "same expression-carrying recursion as the quantity explosion", () =>
    raw<{ DISH: string; COST: number }>(
      `WITH x (DISH, ITEM, QTY) AS (
         SELECT PARENT, CHILD, QTY FROM "${E.BOM}" WHERE PARENT IN ('P-HALO','P-ADOBO','P-SINIG')
         UNION ALL
         SELECT x.DISH, b.CHILD, x.QTY * b.QTY FROM x JOIN "${E.BOM}" b ON b.PARENT = x.ITEM)
       SELECT x.DISH, SUM(x.QTY * i.COST) AS COST FROM x JOIN "${E.ITEMS}" i ON i.CODE = x.ITEM WHERE i.KIND = 'raw' GROUP BY x.DISH ORDER BY x.DISH`,
    ),
  );
  const costOf = (dish: string) => [...explode(dish)].reduce((s, [item, q]) => s + q * ITEMS.find((i) => i.CODE === item)!.COST, 0) / 100;
  sim.eq("cost roll-up: raw-material cost of one plate", cost.map((r) => [r.DISH, r4(r.COST)]), [...DISHES].sort().map((dish) => [dish, r4(costOf(dish))]));

  // A bad recipe line makes a loop (syrup needs sweet mix, which needs syrup).
  await bom.insertOne({ PARENT: "SYRUP", CHILD: "SWEET-MIX", QTY: 0.1 });
  const loop = (await sim.mira(() => bom.connectBy({ startWith: { PARENT: "P-HALO" }, connectBy: { PARENT: "$PRIOR CHILD" }, includeLevel: true, includeIsCycle: true }))) as { PARENT: string; CHILD: string; IS_CYCLE: number }[];
  const cyc = loop.filter((r) => Number(r.IS_CYCLE) === 1);
  sim.ok("cycle detection (includeIsCycle): the looping recipe line is reported", cyc.length > 0 && cyc.every((r) => ["SYRUP", "SWEET-MIX"].includes(r.PARENT)), cyc);
  sim.ok("connectBy on a looping recipe still returns (NOCYCLE)", loop.length >= bomTree("P-HALO").length, loop.length);
  await bom.deleteMany({ PARENT: "SYRUP", CHILD: "SWEET-MIX" });
}
