/**
 * ============================================================================
 * typed/generate.ts — `mira generate types`: defineTable() code from Oracle
 * ============================================================================
 *
 * Reads the schema's catalogue (USER_TAB_COLUMNS, identity columns, primary
 * and single-column foreign keys) and writes one `defineTable()` per table,
 * so existing tables get typed collections without hand-written types.
 *
 *   const code = await generateTableTypes(db, { tables: ["ORDERS", "CUSTOMERS"] });
 *
 * Only the current user's tables are read. CHECK constraints and multi-column
 * keys are not written (the row types do not depend on them).
 * ============================================================================
 */

import type { WrapperDb } from "../db";

export interface GenerateOptions {
  /** Table names (exact, upper-case as Oracle stores them) or LIKE patterns ("SIM_%"). Default: every table. */
  tables?: string[];
  /** Module the generated file imports defineTable and t from. Default "@jm-paunlagui/mira". */
  importFrom?: string;
}

interface CatalogColumn {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  DATA_LENGTH: number;
  CHAR_LENGTH: number;
  CHAR_USED: string | null;
  DATA_PRECISION: number | null;
  DATA_SCALE: number | null;
  NULLABLE: string;
  DATA_DEFAULT: string | null;
  IDENTITY_COLUMN: string;
  GENERATION_TYPE: string | null;
  IS_PK: number;
  REF_TABLE: string | null;
  REF_COLUMN: string | null;
  IS_JSON: number;
}

// One row per column with its identity generation, primary-key membership and
// (single-column) foreign-key target. DATA_DEFAULT is a LONG: fetched as a string.
const CATALOG_SQL = `
SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.CHAR_USED,
       c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, c.DATA_DEFAULT, c.IDENTITY_COLUMN, i.GENERATION_TYPE,
       CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK,
       fk.REF_TABLE, fk.REF_COLUMN, CASE WHEN jc.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_JSON
  FROM USER_TAB_COLUMNS c
  JOIN USER_TABLES ut ON ut.TABLE_NAME = c.TABLE_NAME
  LEFT JOIN USER_TAB_IDENTITY_COLS i ON i.TABLE_NAME = c.TABLE_NAME AND i.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN USER_JSON_COLUMNS jc ON jc.TABLE_NAME = c.TABLE_NAME AND jc.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN (SELECT cc.TABLE_NAME, cc.COLUMN_NAME
               FROM USER_CONSTRAINTS k JOIN USER_CONS_COLUMNS cc ON cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              WHERE k.CONSTRAINT_TYPE = 'P') pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
  LEFT JOIN (SELECT cc.TABLE_NAME, cc.COLUMN_NAME, rc.TABLE_NAME AS REF_TABLE, rc.COLUMN_NAME AS REF_COLUMN
               FROM USER_CONSTRAINTS k
               JOIN USER_CONS_COLUMNS cc ON cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
               JOIN USER_CONS_COLUMNS rc ON rc.CONSTRAINT_NAME = k.R_CONSTRAINT_NAME AND rc.POSITION = cc.POSITION
              WHERE k.CONSTRAINT_TYPE = 'R'
                AND (SELECT COUNT(*) FROM USER_CONS_COLUMNS x WHERE x.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1) fk
         ON fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
 WHERE ut.TABLE_NAME NOT LIKE 'BIN$%'`;

/** "SIM_ORDERS" → "SimOrders"; a name that would not be a JS identifier gets a "T" prefix. */
function exportName(table: string): string {
  const pascal = table
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z_]/.test(pascal) ? pascal : `T${pascal}`;
}

/** A property key: bare when it is a plain identifier, else quoted. */
const key = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

/** The t.* builder for one catalogue column. */
function builder(c: CatalogColumn): string {
  const type = c.DATA_TYPE;
  const p = c.DATA_PRECISION;
  const s = c.DATA_SCALE;
  const tsPrecision = /^TIMESTAMP\((\d)\)/.exec(type)?.[1];
  if (type === "NUMBER") {
    if (p === null && (s === null || s === 0)) return s === 0 ? "t.raw<number>(\"NUMBER(*,0)\")" : "t.number()";
    if (p === 19 && s === 4) return "t.money()";
    if (p !== null && s !== null && s > 0) return `t.decimal(${p}, ${s})`;
    // NUMBER(p) and NUMBER(p,0) are the same column to Oracle.
    return `t.number(${p})`;
  }
  if (type === "VARCHAR2") return c.CHAR_USED === "C" ? `t.text(${c.CHAR_LENGTH}, "char")` : `t.text(${c.DATA_LENGTH})`;
  if (type === "CHAR" && c.CHAR_USED !== "C") return `t.char(${c.DATA_LENGTH})`;
  // JSON: the 23ai JSON type, or a CLOB with an IS JSON check (t.json() adds that check itself).
  if (type === "JSON") return "t.json({ native: true })";
  if (type === "CLOB") return Number(c.IS_JSON) === 1 ? "t.json()" : "t.clob()";
  if (type === "BLOB") return "t.blob()";
  if (type === "DATE") return "t.date()";
  if (/^TIMESTAMP\(\d\)$/.test(type)) return tsPrecision === "6" ? "t.timestamp()" : `t.timestamp(${tsPrecision})`;
  if (/^TIMESTAMP\(\d\) WITH TIME ZONE$/.test(type)) return tsPrecision === "6" ? "t.timestampTz()" : `t.timestampTz(${tsPrecision})`;
  // Everything else keeps its Oracle type text, with the value type node-oracledb returns.
  const sized = /^(N?VARCHAR2|N?CHAR)$/.test(type) ? `${type}(${c.CHAR_LENGTH}${c.CHAR_USED === "C" && !type.startsWith("N") ? " CHAR" : ""})` : type === "RAW" ? `RAW(${c.DATA_LENGTH})` : type;
  const ts = /CHAR|CLOB|ROWID/.test(type) ? "string" : /^(FLOAT|BINARY_FLOAT|BINARY_DOUBLE)$/.test(type) ? "number" : /^(BLOB|RAW|LONG RAW)$/.test(type) ? "Buffer" : /^TIMESTAMP|^DATE/.test(type) ? "Date" : "unknown";
  return `t.raw<${ts}>(${JSON.stringify(sized)})`;
}

/** One column's full builder chain. */
function columnCode(c: CatalogColumn): string {
  const isPk = Number(c.IS_PK) === 1;
  if (c.IDENTITY_COLUMN === "YES" && c.GENERATION_TYPE === "ALWAYS" && isPk && c.DATA_TYPE === "NUMBER" && c.DATA_PRECISION === null && c.DATA_SCALE === null) return "t.id()";
  let code = builder(c);
  if (c.IDENTITY_COLUMN === "YES" && c.GENERATION_TYPE === "ALWAYS") code += ".identity()";
  // An identity BY DEFAULT column takes a value or lets Oracle assign one: optional on insert.
  else if (c.IDENTITY_COLUMN === "YES") code += ".identityByDefault()";
  else if (c.DATA_DEFAULT != null && c.DATA_DEFAULT.trim() !== "" && c.DATA_DEFAULT.trim().toUpperCase() !== "NULL") code += `.default(${JSON.stringify(c.DATA_DEFAULT.trim())})`;
  if (isPk) code += ".primaryKey()";
  else if (c.NULLABLE === "Y") code += ".nullable()";
  if (c.REF_TABLE && c.REF_COLUMN) code += `.references(${JSON.stringify(c.REF_TABLE)}, ${JSON.stringify(c.REF_COLUMN)})`;
  return code;
}

/**
 * Generate defineTable() code for the current user's tables.
 * @returns the source of a TypeScript module (one export per table, plus its row type)
 */
async function generateTableTypes(db: WrapperDb, options: GenerateOptions = {}): Promise<string> {
  const { tables, importFrom = "@jm-paunlagui/mira" } = options;
  const binds: Record<string, string> = {};
  let where = "";
  if (tables && tables.length > 0) {
    // An exact name is compared with "=" (its "_" is not a wildcard); a name with "%" is a LIKE pattern.
    where = ` AND (${tables.map((name, i) => ((binds[`t${i}`] = name), name.includes("%") ? `ut.TABLE_NAME LIKE :t${i}` : `ut.TABLE_NAME = :t${i}`)).join(" OR ")})`;
  }
  const rows = await db.withConnection(async (conn) => {
    const r = await conn.execute<CatalogColumn>(`${CATALOG_SQL}${where} ORDER BY c.TABLE_NAME, c.COLUMN_ID`, binds, {
      outFormat: db.oracledb.OUT_FORMAT_OBJECT,
      fetchInfo: { DATA_DEFAULT: { type: db.oracledb.STRING } },
    });
    return (r.rows ?? []) as CatalogColumn[];
  });

  const byTable = new Map<string, CatalogColumn[]>();
  for (const r of rows) byTable.set(r.TABLE_NAME, [...(byTable.get(r.TABLE_NAME) ?? []), r]);

  const out: string[] = [
    "// Generated by `mira generate types` from the Oracle catalogue. Do not edit by hand:",
    "// re-run the generator after a schema change.",
    `import { defineTable, t } from ${JSON.stringify(importFrom)};`,
  ];
  for (const [table, cols] of byTable) {
    const name = exportName(table);
    out.push("", `export const ${name} = defineTable(${JSON.stringify(table)}, {`);
    for (const c of cols) out.push(`  ${key(c.COLUMN_NAME)}: ${columnCode(c)},`);
    out.push("});", `export type ${name}Row = typeof ${name}.$row;`);
  }
  return `${out.join("\n")}\n`;
}

export { generateTableTypes, exportName };
