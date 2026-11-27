/**
 * TYPE TESTS for model conveniences (Mira 2.1). Checked by `bun run typecheck`, never run.
 */
import { defineTable, t, relations, hasMany, type HookContext } from "../../src";
import { db } from "./_db";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

const Posts = defineTable(
  "POSTS",
  { ID: t.id(), TITLE: t.text(40), CREATED_AT: t.createdAt(), UPDATED_AT: t.updatedAt(), DELETED_AT: t.deletedAt() },
  {
    validate: true,
    hooks: {
      beforeInsert: (doc, ctx: HookContext) => {
        assert<Equal<typeof doc, { TITLE: string; CREATED_AT?: Date; UPDATED_AT?: Date; DELETED_AT?: Date | null }>>();
        void ctx.collection("LOG");
        return { ...doc, TITLE: doc.TITLE.trim() };
      },
      afterInsert: (_doc, id) => {
        assert<Equal<typeof id, unknown>>();
      },
      beforeUpdate: (update) => {
        if (update.$set?.TITLE === "") throw new Error("empty");
      },
      afterDelete: (result) => {
        assert<Equal<typeof result, { deletedCount: number; soft: boolean }>>();
      },
    },
  },
);
assert<Equal<typeof Posts.$row, { ID: number; TITLE: string; CREATED_AT: Date; UPDATED_AT: Date; DELETED_AT: Date | null }>>();
assert<Equal<typeof Posts.$insert, { TITLE: string; CREATED_AT?: Date; UPDATED_AT?: Date; DELETED_AT?: Date | null }>>();

const Plain = defineTable("PLAIN", { ID: t.id(), NAME: t.text(10), CREATED_AT: t.createdAt() });

// t.version(): a number on read, optional on insert, accepted in filters.
const Versioned = defineTable("VERSIONED", { ID: t.id(), REV: t.version() });
assert<Equal<typeof Versioned.$row, { ID: number; REV: number }>>();
assert<Equal<typeof Versioned.$insert, { REV?: number }>>();
void Versioned.on(db).updateOne({ ID: 1, REV: 3 }, { $inc: { REV: 1 } });

const posts = Posts.on(db);
const plain = Plain.on(db);

async function usage() {
  await posts.insertOne({ TITLE: "hello" });
  await posts.deleteOne({ ID: 1 });
  await posts.deleteMany({ TITLE: "x" }, { force: true });
  const all = await posts.withDeleted().find({ DELETED_AT: { $ne: null } }).toArray();
  assert<Equal<(typeof all)[number]["DELETED_AT"], Date | null>>();
  await posts.withDeleted().withDeleted().restore({ ID: 1 });
  await posts.restore();
  // Relations keep the soft-delete methods.
  await relations(Posts, { more: hasMany(Posts, { foreignKey: "ID" }) }).on(db).withDeleted().find().include("more").toArray();

  // @ts-expect-error only a table with t.deletedAt() has withDeleted()
  plain.withDeleted();
  // @ts-expect-error only a table with t.deletedAt() has restore()
  plain.restore();
  // @ts-expect-error a hook gets the table's insert type
  defineTable("X", { A: t.text(1) }, { hooks: { beforeInsert: (doc) => ({ ...doc, A: 1 }) } });
  // @ts-expect-error unknown hook names do not compile
  defineTable("X", { A: t.text(1) }, { hooks: { beforeSave: () => {} } });
}
void usage;
