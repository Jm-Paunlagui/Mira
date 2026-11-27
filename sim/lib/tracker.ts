/**
 * API-surface tracker: proves the simulation calls every public Mira function.
 *
 * Every public method (no leading "_") of every class the library hands out is
 * wrapped, plus every barrel function and the methods on the objects createMira(),
 * mira.db(), createPerformance() and createMigrator() return. A call is counted only when the SIMULATION
 * makes it: the wrapper runs the real method inside an AsyncLocalStorage scope,
 * so calls the library makes internally (findOne → find, a collection's own
 * db.withConnection …) are not counted. A function the simulation never calls
 * directly is reported as unused and fails the run.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const inLibrary = new AsyncLocalStorage<true>();
const expected = new Set<string>();
const calls = new Map<string, number>();

type Fn = (...args: unknown[]) => unknown;

/**
 * Callbacks handed to the library (a withTransaction body, a forEach consumer,
 * withBatchConnection operations, then() handlers) are the simulation's own
 * code: they run OUTSIDE the library scope, so the calls they make count.
 */
const asCaller = (a: unknown): unknown =>
  typeof a === "function" ? (...x: unknown[]) => inLibrary.exit(() => (a as Fn)(...x)) : Array.isArray(a) && a.some((v) => typeof v === "function") ? a.map(asCaller) : a;

function wrap(key: string, fn: Fn): Fn {
  expected.add(key);
  return function (this: unknown, ...args: unknown[]) {
    if (inLibrary.getStore()) return fn.apply(this, args);
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const callerArgs = args.map(asCaller);
    return inLibrary.run(true, () => fn.apply(this, callerArgs));
  };
}

const isPublic = (name: string) => name !== "constructor" && !name.startsWith("_");

/** Wrap a class's public prototype methods (and statics) in place. */
export function trackClass(label: string, cls: { prototype: object }): void {
  const proto = cls.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!isPublic(name) || !d || typeof d.value !== "function") continue;
    Object.defineProperty(proto, name, { ...d, value: wrap(`${label}.${name}`, d.value as Fn) });
  }
  for (const name of Object.getOwnPropertyNames(cls)) {
    if (["length", "name", "prototype"].includes(name) || !isPublic(name)) continue;
    const d = Object.getOwnPropertyDescriptor(cls, name);
    if (!d || typeof d.value !== "function") continue;
    Object.defineProperty(cls, name, { ...d, value: wrap(`${label}.${name}`, d.value as Fn) });
  }
}

/** Wrap the function-valued properties of a plain object (db handle / createPerformance results). */
export function trackObject<T extends object>(label: string, obj: T): T {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const [k, v] of Object.entries(obj)) if (typeof v === "function" && isPublic(k)) out[k] = wrap(`${label}.${k}`, v as Fn);
  return out as unknown as T;
}

/**
 * Wrap a Mira instance: its methods count as "mira.*", db() also hands back a
 * tracked handle ("db.*"), and `closed` stays live (a spread would freeze it).
 */
export function trackMira<T extends object>(mira: T): T {
  const out = trackObject("mira", mira) as Record<string, unknown>;
  const db = out.db as Fn;
  out.db = (...a: unknown[]) => trackObject("db", db(...a) as object);
  Object.defineProperty(out, "closed", { get: () => (mira as { closed: boolean }).closed, enumerable: true });
  return out as unknown as T;
}

/** Wrap a barrel function; `after` may wrap what it returns (e.g. the db handle). */
export function trackFn<F extends Fn>(name: string, fn: F, after?: (r: unknown) => unknown): F {
  const w = wrap(name, after ? (((...a: unknown[]) => after(fn(...a))) as Fn) : fn);
  return w as F;
}

export function report() {
  const used = [...expected].filter((k) => calls.has(k)).sort();
  const unused = [...expected].filter((k) => !calls.has(k)).sort();
  return { total: expected.size, used, unused, calls };
}
