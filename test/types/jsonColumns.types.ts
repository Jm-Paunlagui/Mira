/**
 * TYPE TESTS for JSON columns (Mira 2.1). Checked by `bun run typecheck`, never run.
 */
import { defineTable, t, createDb } from "../../src/utils/oracle-mongo-wrapper";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

type Prefs = { lounge: boolean; drinks: string[]; addr?: { city: string } };
const Members = defineTable("MEMBERS", {
  ID: t.id(),
  NAME: t.text(30),
  PREFS: t.json<Prefs>(),
  TAGS: t.json<string[]>().nullable(),
  RAW: t.json(),
  NATIVE: t.json<{ n: number }>({ native: true }).nullable(),
});
assert<Equal<typeof Members.$row, { ID: number; NAME: string; PREFS: Prefs; TAGS: string[] | null; RAW: unknown; NATIVE: { n: number } | null }>>();
assert<Equal<typeof Members.$insert, { NAME: string; PREFS: Prefs; RAW: unknown; TAGS?: string[] | null; NATIVE?: { n: number } | null }>>();

const members = Members.on(createDb("appDb"));

async function usage() {
  await members.insertOne({ NAME: "Ana", PREFS: { lounge: true, drinks: ["coffee"] }, RAW: 1 });
  const vip = await members.find({ "PREFS.lounge": true, "PREFS.addr.city": { $in: ["Cebu"] }, TAGS: { $elemMatch: { $eq: "vip" } } }).toArray();
  assert<Equal<(typeof vip)[number]["PREFS"]["drinks"], string[]>>();
  await members.find({ PREFS: { $elemMatch: { x: 1 } } }); // objects accept $elemMatch too (arrays of objects inside)
  await members.updateOne({ ID: 1 }, { $set: { "PREFS.lounge": false, NAME: "Bea" }, $unset: { "PREFS.addr": 1 }, $push: { "PREFS.drinks": "tea" }, $pull: { "TAGS.": "x" } });
  await members.updateOne({ ID: 1 }, { $set: { PREFS: { lounge: false, drinks: [] } } });

  // @ts-expect-error a path must start with a known column
  members.find({ "PERFS.lounge": true });
  // @ts-expect-error a whole JSON column takes its declared type
  await members.insertOne({ NAME: "x", PREFS: { lounge: "yes", drinks: [] }, RAW: 1 });
  // @ts-expect-error $elemMatch is for JSON values, not text columns
  members.find({ NAME: { $elemMatch: { $eq: "a" } } });
  // @ts-expect-error $push takes paths into known columns
  await members.updateOne({ ID: 1 }, { $push: { "NOPE.list": 1 } });
}
void usage;
