

/**
 * @fileoverview Oracle-Mongo-Wrapper parser/schema validation messages.
 * `wrapError` is thrown as `new Error(...)` at all 45 call sites across the
 * wrapper (never a logger call itself) and reaches `error.log` only via
 * `ErrorHandlerMiddleware:32-46`'s generic `logger.error(err.message, ...)`;
 * it is never sent to clients. Bind VALUES are redacted before they ever
 * reach that string (CWE-532 — insertion of sensitive information into a
 * log file) — see `describeBinds` below.
 */

/**
 * Cap on the number of bind entries individually described in a
 * `wrapError` message. This is the only length bound on the `Binds:`
 * segment — `LOG_MAX_SAFESTR_LENGTH` does NOT apply here: `logger.js:358`
 * short-circuits truncation for string values (`if (typeof value ===
 * "string") return value;`), and `wrapError`'s output is the log
 * **message**, not a meta object value.
 * @type {number}
 */
const MAX_DESCRIBED_BINDS: number = 40;

/**
 * Describes a single bind value's *shape* — never its content. Kept
 * information (type, length, array/buffer size, bind direction) is exactly
 * what diagnoses the Oracle errors this wrapper throws for: ORA-01008 (not
 * all variables bound — arity), ORA-01722 (invalid number — type),
 * ORA-12899 (value too large for column — length). The value itself is
 * never diagnostic and is exactly what must never reach a log file.
 *
 * ⚠ Recursion is capped at one level (`depth > 0` short-circuits to
 * `"<object>"`) so this stays provably bounded in a logging path — it must
 * never be able to walk an attacker- or data-shaped object indefinitely.
 *
 * @param {*} v - The raw bind value (primitive, Buffer, Date, array, or a
 *   node-oracledb `{ val, dir, type }` bind descriptor).
 * @param {number} [depth=0] - Recursion depth guard.
 * @returns {string} A value-free shape description, e.g. `<string:11>`.
 */
/** The message of a thrown value (anything can be thrown; non-objects have none). */
const messageOf = (err: unknown): unknown =>
  err !== null && typeof err === "object" && "message" in err ? err.message : undefined;

function describeBindValue(v: unknown, depth: number = 0): string {
  if (v === null) return "<null>";
  if (v === undefined) return "<undefined>";
  if (Buffer.isBuffer(v)) return `<buffer:${v.length}>`;
  if (v instanceof Date) return "<date>";
  if (Array.isArray(v)) return `<array:${v.length}>`;
  if (typeof v === "string") return `<string:${v.length}>`;
  if (typeof v === "number") return "<number>";
  if (typeof v === "boolean") return "<boolean>";
  if (typeof v === "object") {
    if (depth > 0) return "<object>";
    if (v !== null && ("val" in v || "dir" in v)) {
      const bind = v as { dir?: unknown; val?: unknown }; // an oracledb bind definition object
      return `<bind dir:${bind.dir ?? "IN"} ${describeBindValue(bind.val, depth + 1)}>`;
    }
    return "<object>";
  }
  return "<object>";
}

/**
 * Describes an entire `binds` argument (object or array form accepted by
 * the wrapper's execute calls) as a value-free, length-bounded summary
 * suitable for `error.log`. Never includes a bind's actual value.
 *
 * @param {object|Array|null|undefined} binds - Named binds object or
 *   positional binds array.
 * @returns {string} e.g. `"3 bind(s): where_GID=<string:11>, where_CUTOFF_ID=<number>"`,
 *   `"0 bind(s)"`, or `"<none>"`.
 */
function describeBinds(binds: unknown): string {
  if (binds === null || typeof binds !== "object") return "<none>";

  const entries = Array.isArray(binds)
    ? binds.map((v, i) => [String(i), v])
    : Object.entries(binds);

  if (entries.length === 0) return "0 bind(s)";

  const shown = entries
    .slice(0, MAX_DESCRIBED_BINDS)
    .map(([name, v]) => `${name}=${describeBindValue(v)}`)
    .join(", ");

  const remaining = entries.length - MAX_DESCRIBED_BINDS;
  const suffix = remaining > 0 ? `, …+${remaining} more` : "";

  return `${entries.length} bind(s): ${shown}${suffix}`;
}

const oracleMongoWrapperMessages = {
  // ── Error formatter ──────────────────────────────────────────────────────
  wrapError: (scope: unknown, err: unknown, sql: unknown, binds?: unknown) =>
    `[${scope}] ${messageOf(err)}\nSQL: ${sql}${binds !== undefined ? `\nBinds: ${describeBinds(binds)}` : ""}`,

  // ── Privilege / DCL ──────────────────────────────────────────────────────
  INSUFFICIENT_PRIVILEGES: (scope: unknown, requiredPrivilege: unknown, err: unknown, sql: unknown) =>
    `[${scope}] Insufficient privileges. ${requiredPrivilege}\nOriginal: ${messageOf(err)}\nSQL: ${sql}`,
  DCL_GRANT_INSUFFICIENT: (err: unknown, sql: unknown) =>
    `[OracleDCL.grant] Insufficient privileges to GRANT. Requires GRANT OPTION or DBA role.\nOriginal: ${messageOf(err)}\nSQL: ${sql}`,
  DCL_REVOKE_INSUFFICIENT: (err: unknown, sql: unknown) =>
    `[OracleDCL.revoke] Insufficient privileges to REVOKE. Requires GRANT OPTION or DBA role.\nOriginal: ${messageOf(err)}\nSQL: ${sql}`,

  // ── Privilege requirement descriptions ───────────────────────────────────
  PRIV_PLAN_TABLE: "Requires SELECT on PLAN_TABLE and EXECUTE on DBMS_XPLAN.",
  PRIV_DBMS_STATS:
    "Requires EXECUTE on DBMS_STATS (typically granted via DBA role or explicit GRANT).",
  PRIV_CREATE_MVIEW: "Requires CREATE MATERIALIZED VIEW privilege.",
  PRIV_REFRESH_MVIEW: "Requires EXECUTE on DBMS_MVIEW.",
  PRIV_DROP_MVIEW: "Requires DROP MATERIALIZED VIEW privilege.",

  // ── Validation messages ──────────────────────────────────────────────────
  CREATEDB_INVALID_CONNECTION_NAME:
    "createDb: connectionName must be a non-empty string",
  MERGE_BINDS_KEY_COLLISION: (key: unknown) =>
    `Bind key collision: "${key}" exists in both bind objects.`,
  FILTER_UNSUPPORTED_OPERATOR: (op: unknown) =>
    `[filterParser] Unsupported operator: ${op}`,
  UPDATE_EMPTY: "[updateParser] Update object must not be empty.",
  UPDATE_RENAME_NOT_SUPPORTED:
    "[updateParser] $rename is not supported. Use ALTER TABLE to rename columns.",
  UPDATE_UNSUPPORTED_OPERATOR: (op: unknown) =>
    `[updateParser] Unsupported update operator: ${op}`,
  UPDATE_CURRENT_DATE_INVALID: (field: unknown) =>
    `[updateParser] $currentDate.${field} must be true, { $type: "date" } or { $type: "timestamp" }.`,
  FOR_UPDATE_INVALID_MODE: (mode: unknown) =>
    `[QueryBuilder.forUpdate] Invalid lock mode: ${typeof mode === "string" ? `"${mode}"` : typeof mode}. Use true, "nowait", "skip locked" or { of?: string[], wait?: number, nowait?: boolean, skipLocked?: boolean }.`,
  QUERY_BUILDER_CHAIN_AFTER_TERMINAL:
    "Cannot chain after terminal method has been called.",
  INSERT_MANY_EMPTY:
    "[OracleCollection.insertMany] Documents array must not be empty.",
  INSERT_MANY_RETURNING_WITH_BATCH_ERRORS:
    "[OracleCollection.insertMany] options.returning and options.batchErrors are mutually exclusive — pass returning: [] when batchErrors is enabled.",
  BULK_UPDATE_EMPTY:
    "[OracleCollection.bulkUpdateByKeys] Rows array must not be empty.",
  BULK_UPDATE_KEYS_REQUIRED:
    "[OracleCollection.bulkUpdateByKeys] options.keys must be a non-empty array of key column names.",
  BULK_UPDATE_NO_SET_COLUMNS:
    "[OracleCollection.bulkUpdateByKeys] Rows must contain at least one non-key column to update.",
  BULK_WRITE_EMPTY:
    "[OracleCollection.bulkWrite] Operations must be a non-empty array.",
  BULK_WRITE_UNKNOWN_OP: (keys: unknown) =>
    `[OracleCollection.bulkWrite] Unknown operation type: ${JSON.stringify(keys)}`,
  SCHEMA_ALTER_TABLE_UNKNOWN_OP: "[OracleSchema.alterTable] Unknown operation.",
  SCHEMA_CREATE_VIEW_INVALID_INPUT:
    "[OracleSchema.createView] Expected a QueryBuilder or SQL string.",
  PERF_EXPLAIN_PLAN_INVALID_INPUT:
    "[performance.explainPlan] Expected a QueryBuilder or SQL string.",
  PERF_CREATE_MVIEW_INVALID_INPUT:
    "[performance.createMaterializedView] Expected a QueryBuilder or SQL string.",
  SET_OP_COLUMN_COUNT_MISMATCH:
    "[SetResultBuilder] Column counts differ between queries",
  COLLECTION_INVALID_TABLE_NAME: (name: unknown) =>
    `[OracleCollection] tableName must be a non-empty string, got ${typeof name === "string" ? '""' : typeof name}.`,
  INVALID_ROW_COUNT: (scope: unknown, what: unknown, value: unknown) =>
    `[${scope}] ${what} must be a non-negative integer, got ${typeof value === "number" ? value : typeof value}.`,
  PIPELINE_UNKNOWN_STAGE: (stage: unknown) =>
    `[aggregatePipeline] Unsupported stage: ${String(stage)}.`,
  PIPELINE_UNKNOWN_EXPRESSION: (op: unknown) =>
    `[aggregatePipeline] Unsupported expression operator "${String(op)}".`,
  INLINE_BIND_UNSUPPORTED: (where: unknown, key: unknown, type: unknown) =>
    `[${where}] the filter value ${String(key)} (${String(type)}) cannot be written into a view: views cannot take bind values, and only numbers, strings and null have an exact literal form. Pass the view as SQL text instead.`,
  PIPELINE_MERGE_INVALID: (reason: unknown) =>
    `[aggregatePipeline] Invalid $merge: ${reason}.`,
  PIPELINE_HAVING_WITHOUT_GROUP:
    "[aggregatePipeline] $having must directly follow a $group stage.",
  JOIN_UNKNOWN_TYPE: (scope: unknown, type: unknown) =>
    `[${scope}] Unknown joinType "${String(type)}". Use left, right, full, inner, cross, self or natural.`,
  WINDOW_UNKNOWN_FUNCTION: (fn: unknown) =>
    `[windowFunctions] Unsupported window function: ${String(fn)}.`,
  WINDOW_INVALID_ARGUMENT: (name: unknown, value: unknown) =>
    `[windowFunctions] ${name} must be a positive integer, got ${typeof value === "number" ? value : typeof value}.`,
  WINDOW_INVALID_FRAME: (frame: unknown) =>
    `[windowFunctions] Invalid frame "${String(frame).slice(0, 80)}". Use ROWS|RANGE with UNBOUNDED PRECEDING / n PRECEDING / CURRENT ROW / n FOLLOWING / UNBOUNDED FOLLOWING.`,
  AGGREGATE_UNKNOWN_FUNCTION: (scope: unknown, fn: unknown) =>
    `[${scope}] Unsupported aggregate function: ${String(fn).slice(0, 40)}. Use SUM, AVG, MIN, MAX or COUNT.`,
  SUBQUERY_FIELD_REQUIRED: (fn: unknown) =>
    `[QueryBuilder.project] $subquery fn "${String(fn)}" needs a field.`,
};

export { oracleMongoWrapperMessages };
