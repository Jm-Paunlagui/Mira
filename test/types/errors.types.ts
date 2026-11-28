/**
 * TYPE TESTS for MiraDbError, stats().abandoned and health.onCheck's saturated flag (Mira 3.1). Checked by `bun run typecheck`, never run.
 */
import { MiraDbError, type MiraErrorKind, type MiraErrorCode } from "../../src";
import { db, mira } from "./_db";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

async function usage() {
  try {
    await db.withConnection(async () => 1);
  } catch (e) {
    if (e instanceof MiraDbError) {
      assert<Equal<typeof e.kind, MiraErrorKind>>();
      assert<Equal<typeof e.code, MiraErrorCode | undefined>>();
      assert<Equal<typeof e.outcomeUnknown, boolean>>();
      assert<Equal<typeof e.connectionName, string | undefined>>();
      assert<Equal<typeof e.durationMs, number | undefined>>();
      assert<Equal<typeof e.originalError, unknown>>();
      // @ts-expect-error the fields are read-only
      e.kind = "statement";
      const retrySafe: boolean = !e.outcomeUnknown;
      void retrySafe;
    }
  }
  const kinds: MiraErrorKind[] = ["connectivity", "saturation", "timeout", "statement"];
  // @ts-expect-error not a kind
  const bad: MiraErrorKind = "network";
  void kinds;
  void bad;
  const { abandoned, pools } = await mira.stats();
  assert<Equal<typeof abandoned, { calls: number; pools: number; zombies: number }>>();
  assert<Equal<typeof pools, Record<string, unknown>>>();
  // onCheck says when a check found the pool busy, not down.
  mira.health.onCheck((check) => {
    assert<Equal<typeof check.ok, boolean>>();
    assert<Equal<typeof check.saturated, boolean | undefined>>();
  });
  const made: MiraDbError = new MiraDbError("x", { kind: "timeout", code: "MIRA_CALL_TIMEOUT" });
  void made;
}
void usage;
