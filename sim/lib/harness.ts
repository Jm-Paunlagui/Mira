/**
 * Check harness: stages, checks, and an UNTRACKED raw-SQL handle.
 *
 * Every check compares what Mira did with an independent source of truth:
 * the simulation's own in-memory model of the business, or a hand-written SQL
 * read through `raw()` (a separate createDb handle the tracker never sees, so
 * verification reads are not counted as API use and do not go through the
 * query builders being checked).
 */
import { isDeepStrictEqual, inspect } from "node:util";

type Result = { stage: string; label: string; ok: boolean; detail?: string };

export class Sim {
  results: Result[] = [];
  stageTimes: { stage: string; ms: number; error?: string }[] = [];
  private current = "";

  async stage(name: string, fn: () => Promise<void>): Promise<void> {
    this.current = name;
    const t0 = performance.now();
    let error: string | undefined;
    try {
      await fn();
    } catch (e) {
      // A stage that throws is one failed check; later stages still run.
      error = (e as Error).stack?.split("\n").slice(0, 4).join("\n") ?? String(e);
      this.results.push({ stage: name, label: "stage completed without an uncaught error", ok: false, detail: error });
    }
    this.stageTimes.push({ stage: name, ms: performance.now() - t0, error });
  }

  ok(label: string, cond: boolean, detail?: unknown): void {
    this.results.push({ stage: this.current, label, ok: !!cond, detail: cond ? undefined : detail === undefined ? undefined : inspect(detail, { depth: 4, breakLength: 140 }) });
  }

  eq(label: string, actual: unknown, expected: unknown): void {
    const ok = isDeepStrictEqual(actual, expected);
    this.results.push({
      stage: this.current,
      label,
      ok,
      detail: ok ? undefined : `expected ${inspect(expected, { depth: 4, breakLength: 140 })}\n       actual   ${inspect(actual, { depth: 4, breakLength: 140 })}`,
    });
  }

  /** The promise (or thunk) must reject, with a message matching `re`. */
  async rejects(label: string, p: Promise<unknown> | (() => unknown), re: RegExp): Promise<void> {
    try {
      await (typeof p === "function" ? p() : p);
      this.results.push({ stage: this.current, label, ok: false, detail: `expected a rejection matching ${re}, but it succeeded` });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.results.push({ stage: this.current, label, ok: re.test(msg), detail: re.test(msg) ? undefined : `rejected, but "${msg.split("\n")[0]}" does not match ${re}` });
    }
  }

  get failed() {
    return this.results.filter((r) => !r.ok);
  }
}

/** Numbers come back as numbers, money as exact strings (NUMBER(12,2)); compare money in cents. */
export const cents = (v: unknown) => Math.round(Number(v) * 100);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
