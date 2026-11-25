/**
 * Stage 15 — The loyalty-member register, kept as a typed model table (Mira 2.1):
 * Oracle stamps when a member joined and last changed; removing a member is a
 * soft delete the front desk can undo; every change leaves an audit line written
 * by hooks in the same transaction; bad input is refused before any SQL.
 *
 * Every model method is used once against a known expected state: find, findOne,
 * countDocuments, distinct, aggregate, insertOne, insertMany, updateOne,
 * updateMany, replaceOne, findOneAndUpdate, findOneAndReplace, deleteOne,
 * deleteMany, findOneAndDelete, withDeleted, restore. Two desk clerks editing the
 * same member at once show optimistic locking (t.version()).
 */
import type { Ctx } from "../lib/context";
import type { Sim } from "../lib/harness";

const MEMBERS = "SIM_MEMBERS";
const AUDIT = "SIM_MEMBER_AUDIT";

export async function membersStage(sim: Sim, ctx: Ctx) {
  const { api, db, raw } = ctx;
  const { t } = api;

  const Audit = api.defineTable(AUDIT, { ID: t.id(), MEMBER_ID: t.number(10), WHAT: t.text(60) });
  const Members = api.defineTable(
    MEMBERS,
    {
      ID: t.number(10).primaryKey(),
      NAME: t.text(40),
      TIER: t.text(10),
      POINTS: t.number(9),
      JOINED_AT: t.createdAt(),
      CHANGED_AT: t.updatedAt(),
      REMOVED_AT: t.deletedAt(),
      REV: t.version(),
    },
    {
      validate: true,
      hooks: {
        beforeInsert: (doc) => ({ ...doc, NAME: doc.NAME.trim() }),
        afterInsert: async (doc, _id, hctx) => {
          await Audit.on(hctx).insertOne({ MEMBER_ID: doc.ID, WHAT: "joined" });
        },
        afterUpdate: async (result, filter, update, hctx) => {
          const id = (filter as { ID?: number }).ID;
          // The columns the caller changed (REV is raised by Mira on every update).
          const changed = Object.keys({ ...update.$set, ...update.$inc }).filter((k) => k !== "REV");
          if (result.modifiedCount > 0 && typeof id === "number") await Audit.on(hctx).insertOne({ MEMBER_ID: id, WHAT: `changed ${changed.join(",")}` });
        },
        beforeDelete: (filter) => {
          if ((filter as { ID?: number }).ID === 1) throw new Error("the founding member cannot be removed");
        },
        afterDelete: async (result, filter, hctx) => {
          const id = (filter as { ID?: number }).ID;
          if (typeof id === "number" && result.deletedCount > 0) await Audit.on(hctx).insertOne({ MEMBER_ID: id, WHAT: result.soft ? "removed" : "erased" });
        },
      },
    },
  );

  await sim.mira(() => Audit.create(db));
  await sim.mira(() => Members.create(db));
  const members = Members.on(db);
  const audit = async () => (await raw<{ M: number; W: string }>(`SELECT MEMBER_ID AS M, WHAT AS W FROM ${AUDIT} ORDER BY ID`)).map((r) => `${r.M} ${r.W}`);

  // Sign-ups: one at the desk, a batch from the web form; the hooks trim names and audit them.
  await sim.mira(() => members.insertOne({ ID: 1, NAME: " Founder ", TIER: "gold", POINTS: 900 }));
  await sim.mira(() =>
    members.insertMany(
      [
        { ID: 2, NAME: "Ana", TIER: "silver", POINTS: 120 },
        { ID: 3, NAME: "Ben", TIER: "silver", POINTS: 80 },
        { ID: 4, NAME: "Cy", TIER: "bronze", POINTS: 10 },
        { ID: 5, NAME: "Di", TIER: "bronze", POINTS: 0 },
      ],
      { returning: [] },
    ),
  );
  const founder = await sim.mira(() => members.findOne({ ID: 1 }));
  sim.eq("model: the beforeInsert hook trimmed the name", founder?.NAME, "Founder");
  sim.ok("model: Oracle stamped JOINED_AT and CHANGED_AT on insert", founder !== null && founder.JOINED_AT instanceof Date && founder.CHANGED_AT.getTime() === founder.JOINED_AT.getTime(), founder);

  // Validation: a bad web-form row is refused before any SQL, with every problem listed.
  await sim.rejects(
    "model: validation refuses a bad sign-up (too-long tier, fractional points, unknown column)",
    () => members.insertOne({ ID: 6, NAME: "Ed", TIER: "platinum-plus", POINTS: 1.5, NICK: "e" } as never),
    /TIER is 13 bytes long; VARCHAR2\(10\) allows 10; POINTS must be a whole number, got 1\.5; NICK is not a column of this table/,
  );
  sim.eq("model: the refused sign-up left no row", await members.withDeleted().countDocuments({ ID: 6 }), 0);

  // Changes: points earned, a tier upgrade, a corrected record; CHANGED_AT moves, JOINED_AT does not.
  await new Promise((r) => setTimeout(r, 20));
  await sim.mira(() => members.updateOne({ ID: 2 }, { $inc: { POINTS: 30 } }));
  await sim.mira(() => members.updateMany({ TIER: "bronze" }, { $inc: { POINTS: 5 } }));
  await sim.mira(() => members.replaceOne({ ID: 4 }, { ID: 4, NAME: "Cyrus", TIER: "bronze", POINTS: 15 }));
  const upgraded = await sim.mira(() => members.untyped.findOneAndUpdate<{ TIER: string }>({ ID: 3 }, { $set: { TIER: "gold" } }, { returnDocument: "after" }));
  sim.eq("model: findOneAndUpdate returns the upgraded member", upgraded?.TIER, "gold");
  await sim.mira(() => members.untyped.findOneAndReplace({ ID: 5 }, { NAME: "Diana", TIER: "bronze", POINTS: 5 }));
  const ana = await members.findOne({ ID: 2 });
  sim.ok("model: an update moved CHANGED_AT and kept JOINED_AT", ana !== null && ana.CHANGED_AT.getTime() > ana.JOINED_AT.getTime(), ana);

  // Removal is a soft delete; the founder is protected by a hook; reads skip removed members.
  await sim.rejects("model: the beforeDelete hook protects the founding member", () => members.deleteOne({ ID: 1 }), /the founding member cannot be removed/);
  await sim.mira(() => members.deleteOne({ ID: 4 }));
  await sim.mira(() => members.deleteMany({ ID: 5 }));
  const removed = await sim.mira(() => members.untyped.findOneAndDelete<{ ID: number }>({ ID: 3 }));
  sim.eq("model: findOneAndDelete (soft) returns the member as they were", removed?.ID, 3);
  const active = await sim.mira(() => members.find({}).sort({ ID: 1 }).project({ ID: 1 }).toArray());
  sim.eq("model: find skips removed members", active.map((m) => m.ID), [1, 2]);
  sim.eq("model: countDocuments skips removed members", await sim.mira(() => members.countDocuments()), 2);
  sim.eq("model: distinct tiers of active members", (await sim.mira(() => members.distinct("TIER"))).sort(), ["gold", "silver"]);
  const points = await sim.mira(() => members.aggregate<{ P: number }>([{ $group: { _id: null, P: { $sum: "$POINTS" } } }]));
  sim.eq("model: aggregate totals the points of active members only", Number(points[0].P), 900 + 150);
  const all = members.withDeleted();
  sim.eq("model: withDeleted sees every member, removed ones too", await sim.mira(() => all.countDocuments()), 5);
  sim.eq("model: the rows are still in the table, marked", (await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM ${MEMBERS} WHERE REMOVED_AT IS NOT NULL`))[0].N, 3);

  // The desk removed Cy by mistake: restore; Diana asked to be erased: a forced delete.
  sim.eq("model: restore brings back a removed member", (await sim.mira(() => members.restore({ ID: 4 }))).modifiedCount, 1);
  await sim.mira(() => members.withDeleted().deleteOne({ ID: 5 }, { force: true }));
  sim.eq("model: active members after restore", (await members.find({}).sort({ ID: 1 }).toArray()).map((m) => m.ID), [1, 2, 4]);
  sim.eq("model: the erased member is gone from the table", (await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM ${MEMBERS} WHERE ID = 5`))[0].N, 0);

  sim.eq("model: the audit trail the hooks wrote", await audit(), [
    "1 joined", "2 joined", "3 joined", "4 joined", "5 joined",
    "2 changed POINTS", "4 changed NAME,TIER,POINTS", "3 changed TIER", "5 changed NAME,TIER,POINTS",
    "4 removed", "5 removed", "3 removed",
    "4 changed REMOVED_AT", // restore() is an update: the update hook sees it
    "5 erased",
  ]);
  sim.eq("model: every update raised the revision (Ana: +30 points)", (await members.findOne({ ID: 2 }))?.REV, 2);

  // Two clerks open Ana's record at once. The first saves; the second's save is stale.
  const clerkA = (await members.findOne({ ID: 2 }))!;
  const clerkB = (await members.findOne({ ID: 2 }))!;
  sim.eq("model: both clerks read the same revision", [clerkA.REV, clerkB.REV], [2, 2]);
  await sim.mira(() => members.updateOne({ ID: 2, REV: clerkA.REV }, { $set: { TIER: "gold" } }));
  await sim.rejects("model: the second clerk's stale save is refused (MiraConcurrencyError), not lost", () => members.updateOne({ ID: 2, REV: clerkB.REV }, { $set: { TIER: "bronze" } }), /changed since it was read \(version 2 expected, now 3\)/);
  const reread = (await members.findOne({ ID: 2 }))!;
  await sim.mira(() => members.updateOne({ ID: 2, REV: reread.REV }, { $inc: { POINTS: 1 } }));
  sim.eq("model: after re-reading, the second clerk's change lands on top of the first", await members.findOne({ ID: 2 }).then((m) => [m?.TIER, m?.POINTS, m?.REV]), ["gold", 151, 4]);

  // A transaction rolls back a sign-up and its audit line together.
  await sim.rejects(
    "model: a rolled-back sign-up leaves neither the member nor its audit line",
    new api.Transaction(db).withTransaction(async (session) => {
      await Members.on(session).insertOne({ ID: 7, NAME: "Temp", TIER: "bronze", POINTS: 0 });
      throw new Error("payment declined");
    }),
    /payment declined/,
  );
  sim.eq("model: no row and no audit line for the rolled-back sign-up", [await members.withDeleted().countDocuments({ ID: 7 }), (await audit()).filter((a) => a.startsWith("7 ")).length], [0, 0]);
}
