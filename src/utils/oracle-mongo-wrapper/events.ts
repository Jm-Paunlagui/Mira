/**
 * ============================================================================
 * events.ts — onQuery(): an event for every statement (Mira 2.1)
 * ============================================================================
 *
 *   const stop = onQuery((e) => {
 *     if (e.durationMs > 500) logger.warning(`slow ${e.operation} (${e.durationMs} ms): ${e.sql}`);
 *   });
 *   …
 *   stop(); // unsubscribe
 *
 * Built on node-oracledb's trace handler, so it sees every execute and
 * executeMany on every connection: Mira's own statements, sql`…`, and your
 * own conn.execute() calls alike.
 *
 * - The event carries the SQL text, the number of binds, the time taken, the
 *   rows returned / affected and the error. Bind VALUES are left out on
 *   purpose: they may hold passwords, tokens or personal data.
 * - oracledb has one trace handler for the whole process. If one is already
 *   installed (for example OpenTelemetry's oracledb instrumentation), Mira's
 *   handler passes every hook on to it, so spans keep working; when the last
 *   listener unsubscribes, the earlier handler is put back.
 * - A listener that throws is ignored: an event never breaks a query.
 * ============================================================================
 */

import oracledb from "oracledb";

/** One finished statement. */
export interface QueryEvent {
  /** "execute" or "executeMany". */
  operation: "execute" | "executeMany";
  /** The SQL text. */
  sql: string;
  /** How many binds were given (values are never included). For executeMany: binds per row. */
  bindCount: number;
  /** executeMany: how many rows of binds. */
  batchSize?: number;
  durationMs: number;
  /** Rows a query returned (when it returned them as an array). */
  rowCount?: number;
  /** Rows a DML statement changed. */
  rowsAffected?: number;
  /** The driver error, when the statement failed. */
  error?: Error;
}

export type QueryListener = (event: QueryEvent) => void;

type TraceContext = {
  operation?: string;
  args?: unknown[];
  error?: Error;
  additionalConfig?: { result?: { rows?: unknown[]; rowsAffected?: number } };
  miraStart?: number;
};
type TraceInstance = Record<string, ((...a: unknown[]) => unknown) | undefined> & { isEnabled?: () => boolean };
type TraceModule = { TraceHandlerBase: new () => object; setTraceInstance(o: unknown): void; getTraceInstance(): TraceInstance | undefined };

const listeners = new Set<QueryListener>();
let installed: object | null = null;
let previous: TraceInstance | undefined;

const trace = (): TraceModule => (oracledb as unknown as { traceHandler: TraceModule }).traceHandler;

const countBinds = (b: unknown): number => (Array.isArray(b) ? b.length : b && typeof b === "object" ? Object.keys(b).length : 0);

function emit(ctx: TraceContext): void {
  const op = /\.(execute|executeMany)$/.exec(ctx.operation ?? "")?.[1] as QueryEvent["operation"] | undefined;
  if (!op || ctx.miraStart === undefined) return;
  const [sql, binds] = ctx.args ?? [];
  const result = ctx.additionalConfig?.result;
  const many = op === "executeMany";
  const event: QueryEvent = {
    operation: op,
    sql: String(sql),
    bindCount: many ? (Array.isArray(binds) && binds.length > 0 ? countBinds(binds[0]) : 0) : countBinds(binds),
    durationMs: Math.round((performance.now() - ctx.miraStart) * 1000) / 1000,
  };
  if (many) event.batchSize = Array.isArray(binds) ? binds.length : Number(binds);
  if (Array.isArray(result?.rows)) event.rowCount = result.rows.length;
  if (typeof result?.rowsAffected === "number") event.rowsAffected = result.rowsAffected;
  if (ctx.error) event.error = ctx.error;
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch {
      // A listener's failure never reaches the query.
    }
  }
}

function install(): void {
  const t = trace();
  previous = t.getTraceInstance();
  const prev = previous;
  // Every hook the driver may call: passed on to the earlier handler when it is enabled.
  const forward = (name: string) =>
    function (this: unknown, ...a: unknown[]) {
      if (prev?.isEnabled?.()) prev[name]?.apply(prev, a);
    };
  class MiraTraceHandler extends t.TraceHandlerBase {
    isEnabled() {
      return true;
    }
    onEnterFn(ctx: TraceContext) {
      ctx.miraStart = performance.now();
      if (prev?.isEnabled?.()) prev.onEnterFn?.call(prev, ctx);
    }
    onExitFn(ctx: TraceContext) {
      if (prev?.isEnabled?.()) prev.onExitFn?.call(prev, ctx);
      emit(ctx);
    }
  }
  const handler = new MiraTraceHandler() as unknown as Record<string, unknown>;
  for (const name of ["onBeginRoundTrip", "onEndRoundTrip", "onPoolExpand", "onPoolShrink", "onPoolAcquire", "onPoolRelease", "onPoolWait", "onPoolRequestTimeout", "onPoolConnectionHit", "onPoolConnectionMiss", "onPoolClose"]) {
    handler[name] = forward(name);
  }
  installed = handler;
  t.setTraceInstance(handler);
}

/** Call `listener` after every statement. Returns a function that unsubscribes it. */
function onQuery(listener: QueryListener): () => void {
  if (typeof listener !== "function") throw new TypeError("[onQuery] the listener must be a function.");
  if (!installed) install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && installed) {
      // Put the earlier handler back, unless someone replaced ours meanwhile.
      if (trace().getTraceInstance() === installed) trace().setTraceInstance(previous);
      installed = null;
      previous = undefined;
    }
  };
}

export { onQuery };
