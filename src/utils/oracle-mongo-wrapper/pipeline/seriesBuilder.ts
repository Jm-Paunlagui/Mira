/**
 * ============================================================================
 * seriesBuilder.ts — row generator (a calendar or a number series)
 * ============================================================================
 *
 * series(db, { start, end, step?, unit?, as? }) produces one row per value from
 * `start` to `end` inclusive, in steps of `step`:
 *
 *   numbers:  series(db, { start: 1, end: 12 })                       → VALUE 1, 2, … 12
 *   dates:    series(db, { start, end, unit: "month", as: "M" })      → M on each month
 *             units: day, week, month, quarter, year (months keep the day of month)
 *
 * Use .toArray(), or .aggregate(pipeline) to build on it: month-end dates for a
 * depreciation schedule, or a calendar joined to sales ($lookup with a pipeline)
 * so days without sales appear with zero.
 *
 * SQL: a CONNECT BY LEVEL row generator over DUAL. Start, end and step are bound;
 * the step is a positive number (a whole number for dates), so the series always
 * ends; a start after the end gives no rows.
 * ============================================================================
 */
import type { DbConnection } from "../db";
import { quoteIdentifier } from "../utils";
import { buildAggregateSQL } from "./aggregatePipeline";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

type SeriesUnit = "day" | "week" | "month" | "quarter" | "year";
type SeriesSpec = { start: number | Date; end: number | Date; step?: number; unit?: SeriesUnit; as?: string };

/** How each date unit advances from the start: (LEVEL - 1) * step units. */
const DATE_STEP: Readonly<Record<SeriesUnit, (start: string, n: string) => string>> = Object.freeze({
  day: (s, n) => `${s} + ${n}`,
  week: (s, n) => `${s} + 7 * ${n}`,
  month: (s, n) => `ADD_MONTHS(${s}, ${n})`,
  quarter: (s, n) => `ADD_MONTHS(${s}, 3 * ${n})`,
  year: (s, n) => `ADD_MONTHS(${s}, 12 * ${n})`,
});
/** A safety ceiling on generated rows. */
const MAX_ROWS = 1_000_000;
const ALIAS = "MIRA_SERIES";

class SeriesResult {
  declare _db: import("../db").WrapperDb;
  declare _sql: string;
  declare _binds: Record<string, unknown>;
  constructor(db: import("../db").WrapperDb, sql: string, binds: Record<string, unknown>) {
    this._db = db;
    this._sql = sql;
    this._binds = binds;
  }

  async _run<T>(sql: string, binds: Record<string, unknown>, scope: string): Promise<T[]> {
    return this._db.withConnection(async (conn: DbConnection) => {
      try {
        const result = await conn.execute<T>(sql, binds, { outFormat: this._db.oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
        return result.rows ?? [];
      } catch (err) {
        throw new Error(MSG.wrapError(scope, err, sql));
      }
    });
  }

  /** Every value of the series, in order. */
  async toArray<T = Record<string, unknown>>(): Promise<T[]> {
    return this._run<T>(`${this._sql}`, this._binds, "series.toArray");
  }

  /** Run an aggregation pipeline over the series (it is the pipeline's source). */
  async aggregate(pipeline: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const agg = buildAggregateSQL(ALIAS, pipeline, this._db as never, "", undefined, [{ alias: ALIAS, sql: this._sql }]);
    return this._run<Record<string, unknown>>(agg.sql, { ...this._binds, ...agg.binds }, "series.aggregate");
  }
}

function series(db: import("../db").WrapperDb, spec: SeriesSpec): SeriesResult {
  const { start, end, step = 1, unit, as = "VALUE" } = spec ?? ({} as SeriesSpec);
  const dates = start instanceof Date && end instanceof Date;
  const numbers = typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end);
  if (!dates && !numbers) throw new Error(MSG.SERIES_INVALID("start and end must be both numbers or both dates"));
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0 || (dates && !Number.isInteger(step))) {
    throw new Error(MSG.SERIES_INVALID(`step must be a positive ${dates ? "whole " : ""}number`));
  }
  let value: string;
  let last: string;
  if (dates) {
    const advance = DATE_STEP[(unit ?? "day") as SeriesUnit];
    if (!advance) throw new Error(MSG.SERIES_INVALID(`unit must be one of ${Object.keys(DATE_STEP).join(", ")}`));
    value = advance("CAST(:series_start AS DATE)", "(LEVEL - 1) * :series_step");
    last = "CAST(:series_end AS DATE)";
  } else {
    if (unit !== undefined) throw new Error(MSG.SERIES_INVALID("unit applies to date series only"));
    value = ":series_start + (LEVEL - 1) * :series_step";
    last = ":series_end";
  }
  // The first row (LEVEL 1) is always produced by CONNECT BY, so the outer filter
  // drops it when the start is already past the end.
  const sql = `SELECT V AS ${quoteIdentifier(as)} FROM (SELECT ${value} AS V FROM DUAL CONNECT BY ${value} <= ${last} AND LEVEL <= ${MAX_ROWS}) WHERE V <= ${last}`;
  return new SeriesResult(db, sql, { series_start: start, series_end: end, series_step: step });
}

export { series, SeriesResult };
