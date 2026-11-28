/**
 * SECURITY FUZZ — every caller-supplied string Mira can splice into SQL.
 *
 * No database: a recording connection captures each SQL text Mira builds. Each
 * base call is mutated at every string leaf, every object key and every number
 * (one mutation at a time), with payloads that carry the marker word PWNED
 * behind a character that would end an identifier or literal. A small SQL lexer
 * then checks the marker never appears as bare SQL: outside "quoted identifiers",
 * 'string literals' and bind names. A thrown error is a safe outcome (input
 * refused); SQL with a bare marker is an injection.
 */
import { describe, it, expect } from "bun:test";
import oracledb from "oracledb";
import { OracleCollection, OracleSchema, OracleDCL, withCTE, withRecursiveCTE, sql } from "../../src";

// ─── SQL lexer: where does the marker sit? ─────────────────────────────────
type Leak = { sql: string; at: number };
export function bareMarker(text: string, marker = "PWNED"): Leak | null {
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "'") {
      const start = ++i;
      while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") i += 2; else if (s[i] === "'") break; else i++; }
      // dynamic SQL: the literal after EXECUTE IMMEDIATE is itself a statement
      if (/EXECUTE\s+IMMEDIATE\s*$/i.test(s.slice(0, start - 1))) {
        const inner = bareMarker(s.slice(start, i).replace(/''/g, "'"), marker);
        if (inner) return { sql: s, at: start + inner.at };
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length) { if (s[i] === '"' && s[i + 1] === '"') i += 2; else if (s[i] === '"') break; else i++; }
      i++;
    } else if ((c === "q" || c === "Q") && n === "'") {
      // Oracle q'[...]' — marker inside one is a literal; a payload that forges one is caught by the outer check
      const open = s[i + 2];
      const close = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
      const end = s.indexOf(close + "'", i + 3);
      i = end < 0 ? s.length : end + 2;
    } else if (c === ":" && /[A-Za-z_]/.test(n ?? "")) {
      // bind name: letters, digits, _ — a marker glued on with _ is still one bind name
      i++;
      while (i < s.length && /[A-Za-z0-9_$#]/.test(s[i])) i++;
    } else if (s.startsWith(marker, i) && !/[A-Za-z0-9_$#]/.test(s[i - 1] ?? "") && !/[A-Za-z0-9_$#]/.test(s[i + marker.length] ?? "")) {
      return { sql: s, at: i };
    } else i++;
  }
  return null;
}

// ─── recording db ───────────────────────────────────────────────────────────
const seen: string[] = [];
const conn = {
  execute: async (text: string) => (seen.push(text), { rows: /COUNT\(/.test(text) ? [{ CNT: 0 }] : [], rowsAffected: 0, outBinds: {}, metaData: [] }),
  executeMany: async (text: string) => (seen.push(text), { rowsAffected: 0, outBinds: [], batchErrors: [] }),
  commit: async () => {}, rollback: async () => {}, close: async () => {},
  oracleServerVersion: 2304000000,
};
const fakeDb = {
  oracledb, connectionName: "fuzz",
  withConnection: async (cb: (c: unknown) => unknown) => cb(conn),
  withTransaction: async (cb: (c: unknown) => unknown) => cb(conn),
  withBatchConnection: async (ops: Array<(c: unknown) => unknown>) => { for (const op of ops) await op(conn); },
  isHealthy: () => true, getPoolStats: () => ({}),
} as never;
const users = () => new OracleCollection("USERS", fakeDb);
const orders = () => new OracleCollection("ORDERS", fakeDb);

// ─── payloads and mutation ──────────────────────────────────────────────────
const PAYLOADS = [
  `a" PWNED "`, `a' PWNED '`, `a) PWNED (`, `a PWNED`, `a--PWNED`, `a/*PWNED*/`, `a;PWNED`,
  `a\nPWNED`, `a"||PWNED||"`, `a'||PWNED||'`, `a]' PWNED --`, `1 PWNED`, `a.b PWNED`, `a,PWNED`,
  `$a PWNED`, `$PRIOR a PWNED`, `q'[x]' PWNED`, `a\u0000PWNED`, `a’ PWNED`,
];
const sneaky = (p: string) => ({ toString: () => p, valueOf: () => p, [Symbol.toPrimitive]: () => p });

type Path = (string | number)[];
type Mut = { label: string; value: unknown };
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}
function* mutations(root: unknown): Generator<Mut> {
  function* walk(v: unknown, path: Path): Generator<{ path: Path; kind: "str" | "num" | "obj"; v: unknown }> {
    if (typeof v === "string") yield { path, kind: "str", v };
    else if (typeof v === "number") yield { path, kind: "num", v };
    else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* walk(v[i], [...path, i]);
    else if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      yield { path, kind: "obj", v };
      for (const [k, x] of Object.entries(v)) yield* walk(x, [...path, k]);
    }
  }
  const set = (base: unknown, path: Path, val: unknown) => {
    const c = clone(base) as Record<string | number, unknown>;
    let o = c as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
    o[path[path.length - 1]] = val;
    return c;
  };
  for (const node of [...walk(root, [])]) {
    const where = node.path.join(".");
    for (const p of PAYLOADS) {
      if (node.kind === "str" || node.kind === "num") {
        if (node.path.length === 0) continue;
        yield { label: `${where} = ${JSON.stringify(p)}`, value: set(root, node.path, p) };
        yield { label: `${where} = sneaky(${JSON.stringify(p)})`, value: set(root, node.path, sneaky(p)) };
      } else {
        // rename each key, and add a hostile key
        for (const k of Object.keys(node.v as object)) {
          const renamed = Object.fromEntries(Object.entries(node.v as object).map(([kk, x]) => [kk === k ? (k.startsWith("$") ? `$${p}` : p) : kk, clone(x)]));
          yield { label: `${where}{key ${k} -> ${JSON.stringify(p)}}`, value: node.path.length ? set(root, node.path, renamed) : renamed };
          if (k.startsWith("$")) {
            const raw = Object.fromEntries(Object.entries(node.v as object).map(([kk, x]) => [kk === k ? p : kk, clone(x)]));
            yield { label: `${where}{key ${k} -> raw ${JSON.stringify(p)}}`, value: node.path.length ? set(root, node.path, raw) : raw };
          }
        }
      }
    }
  }
}

// ─── the calls ──────────────────────────────────────────────────────────────
// Each case: args (mutated) and a runner. Runners consume cursors so SQL is built.
// rawDdl: slots that ARE developer-written SQL (a column type, DEFAULT, CHECK). A bare word there is
// legal; what must never pass is a payload that leaves the column definition (quote, paren, comma,
// ";" or a comment), which sqlFragmentProblem() refuses.
type Case = { name: string; args: unknown[]; run: (...a: any[]) => unknown; rawDdl?: RegExp };
const STRUCTURAL = /[;,()'"]|--|\/\*/;
const arr = async (q: any) => (q && typeof q.toArray === "function" ? q.toArray() : q);
const CASES: Case[] = [
  { name: "find", args: [{ NAME: "Juan", AGE: { $gte: 18, $lt: 65 }, $or: [{ CITY: "Cebu" }, { CITY: { $in: ["Davao", "Iloilo"] } }] }], run: (f) => arr(users().find(f)) },
  { name: "find ops", args: [{ A: { $ne: 1 }, B: { $nin: [1, 2] }, C: { $exists: true }, D: { $regex: "^a", $options: "i" }, E: { $between: [1, 2] }, F: { $like: "a%" }, G: { $notBetween: [1, 2] }, I: { $gtAny: [1, 2] }, J: { $lteAll: [3] } }], run: (f) => arr(users().find(f)) },
  { name: "find json/array ops", args: [{ "DATA.a.b": 1, TAGS: { $all: ["x"] }, ITEMS: { $elemMatch: { QTY: { $gt: 1 } } }, $and: [{ X: 1 }], $nor: [{ Y: 2 }] }], run: (f) => arr(users().find(f)) },
  { name: "find expressions", args: [{ $expr: { $gt: [{ $coalesce: ["$A", 0] }, { $nullif: ["$B", 0] }] }, AT: { $lt: { $now: true } }, T: { $case: [{ when: { S: 1 }, then: "a" }], $else: "b" } }], run: (f) => arr(users().find(f)) },
  { name: "find subqueries", args: [{ STATUS: "paid" }, { USER_ID: 1 }, { collection: "ORDERS", match: { USER_ID: "$ID" } }, { collection: "ORDERS", field: "TOTAL" }], run: (sf, sp, ex, any) => arr(users().find({ ID: { $inSelect: orders().find(sf).project(sp) }, $exists: ex, $notExists: ex, SCORE: { $gtAny: any } })) },
  { name: "find $expr / $text", args: [{ $expr: { $gt: ["$SCORE", "$AGE"] } }], run: (f) => arr(users().find(f)) },
  { name: "find options", args: [{ NAME: "a" }, { projection: { NAME: 1, AGE: 1 }, sort: { AGE: -1 }, limit: 5, skip: 2 }], run: (f, o) => arr(users().find(f, o)) },
  { name: "sort/project/limit/skip", args: [{ AGE: -1, NAME: 1 }, { NAME: 1, EMAIL: 0 }, 3, 1], run: (s, p, l, k) => arr(users().find({}).sort(s).project(p).limit(l).skip(k)) },
  { name: "sort nulls", args: [{ AT: { order: -1, nulls: "last" } }], run: (s) => arr(users().find({}).sort(s)) },
  { name: "after cursor", args: [{ AGE: 1, ID: 1 }, { AGE: 30, ID: 5 }], run: (s, c) => arr(users().find({}).sort(s).after(c).limit(10)) },
  { name: "forUpdate", args: [{ wait: 5, skipLocked: false, of: ["NAME"] }], run: (m) => arr(users().find({ ID: 1 }).forUpdate(m)) },
  { name: "projection $subquery", args: [{ NAME: 1, N: { $subquery: { collection: "ORDERS", filter: { USER_ID: "$ID" }, aggregate: "COUNT" } } }], run: (p) => arr(users().find({}).project(p)) },
  { name: "findOne/count/distinct", args: [{ NAME: "a" }, "CITY"], run: async (f, d) => { await users().findOne(f); await users().countDocuments(f); await users().distinct(d, f); } },
  { name: "insertOne", args: [{ NAME: "a", AGE: 1 }, { returning: ["ID", "NAME"] }], run: (d, o) => users().insertOne(d, o) },
  { name: "insertMany", args: [[{ NAME: "a", AGE: 1 }, { NAME: "b", AGE: 2 }], { returning: ["ID"] }], run: (d, o) => users().insertMany(d, o) },
  { name: "updateOne ops", args: [{ ID: 1 }, { $set: { NAME: "x" }, $inc: { AGE: 1 }, $unset: { CITY: 1 }, $mul: { SCORE: 2 }, $min: { LO: 1 }, $max: { HI: 9 }, $currentDate: { AT: true } }], run: (f, u) => users().updateOne(f, u) },
  { name: "updateMany/upsert", args: [{ CITY: "a" }, { $set: { CITY: "b" } }, { upsert: true }], run: (f, u, o) => users().updateMany(f, u, o) },
  { name: "update json/array", args: [{ ID: 1 }, { $set: { "DATA.a": 1 }, $push: { TAGS: "x" }, $pull: { LIST: "y" } }], run: (f, u) => users().updateOne(f, u) },
  { name: "replaceOne", args: [{ ID: 1 }, { NAME: "x", AGE: 2 }], run: (f, d) => users().replaceOne(f, d) },
  { name: "delete", args: [{ ID: 1 }, { CITY: "x" }], run: async (a, b) => { await users().deleteOne(a); await users().deleteMany(b); } },
  { name: "findOneAndUpdate", args: [{ ID: 1 }, { $set: { NAME: "x" } }, { upsert: true, returnDocument: "after", sort: { ID: 1 }, projection: { NAME: 1 } }], run: (f, u, o) => users().findOneAndUpdate(f, u, o) },
  { name: "findOneAndDelete/Replace", args: [{ ID: 1 }, { NAME: "x" }], run: async (f, d) => { await users().findOneAndDelete(f); await users().findOneAndReplace(f, d); } },
  { name: "bulkWrite", args: [[{ insertOne: { document: { NAME: "a" } } }, { updateOne: { filter: { ID: 1 }, update: { $set: { NAME: "b" } } } }, { deleteOne: { filter: { ID: 2 } } }, { replaceOne: { filter: { ID: 3 }, replacement: { NAME: "c" } } }]], run: (ops) => users().bulkWrite(ops) },
  { name: "bulkUpdateByKeys", args: [[{ ID: 1, NAME: "a" }], { keys: ["ID"] }], run: (r, o) => users().bulkUpdateByKeys(r, o) },
  { name: "merge", args: [{ ID: 3, NAME: "d" }, { localField: "ID", foreignField: "ID" }, { whenMatched: { $set: { NAME: "e" } }, whenNotMatched: "insert", whenMatchedDelete: { STATUS: "x" } }], run: (d, on, o) => users().merge(d, on, o) },
  { name: "createIndex", args: [{ NAME: 1, AGE: -1 }, { name: "IX_A", unique: true }], run: (s, o) => users().createIndex(s, o) },
  { name: "createIndexes/dropIndex", args: [[{ fields: { NAME: 1 }, name: "IX_B" }], "IX_B"], run: async (s, n) => { await users().createIndexes(s); await users().dropIndex(n); } },
  { name: "aggregate basic", args: [[{ $match: { AGE: { $gt: 1 } } }, { $group: { _id: "$CITY", N: { $sum: 1 }, A: { $avg: "$AGE" }, M: { $max: "$SCORE" }, L: { $listAgg: { input: "$NAME", separator: ",", orderBy: { NAME: 1 } } } } }, { $sort: { N: -1 } }, { $skip: 1 }, { $limit: 5 }]], run: (p) => users().aggregate(p) },
  { name: "aggregate project exprs", args: [[{ $project: { NAME: 1, X: { $add: [{ $mul: ["$SCORE", 2] }, { $divide: ["$AGE", 4] }, 1] }, C: { $concat: ["$NAME", " <", "$EMAIL", ">"] }, D: { $dateToString: { date: "$AT", format: "YYYY-MM-DD" } }, R: { $round: ["$SCORE", 2] }, S: { $substr: ["$NAME", 0, 2] }, U: { $toUpper: "$NAME" }, Y: { $year: "$AT" } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate cond/switch", args: [[{ $addFields: { T: { $cond: { if: { $gte: ["$SCORE", 80] }, then: "hi", else: "lo" } }, W: { $switch: { branches: [{ case: { $eq: ["$A", 1] }, then: "one" }], default: "other" } }, I: { $ifNull: ["$CITY", "none"] } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate dates", args: [[{ $project: { A: { $dateAdd: { startDate: "$AT", unit: "day", amount: 1 } }, B: { $dateDiff: { startDate: "$AT", endDate: "$BT", unit: "day" } }, C: { $dateTrunc: { date: "$AT", unit: "month" } }, E: { $lastDayOfMonth: "$AT" } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate rollup/cube", args: [[{ $group: { _id: { $rollup: ["CITY", "REGION"], grouping: true }, N: { $count: "*" } } }], [{ $group: { _id: { $cube: ["A", "B"] }, T: { $sum: "$X" } } }]], run: async (a, b) => { await users().aggregate(a); await users().aggregate(b); } },
  { name: "aggregate lookup/unwind", args: [[{ $lookup: { from: "ORDERS", localField: "ID", foreignField: "USER_ID", as: "o" } }, { $unwind: "$o" }, { $replaceRoot: { newRoot: "$o" } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate lookup pipeline", args: [[{ $lookup: { from: "ORDERS", let: { uid: "$ID" }, pipeline: [{ $match: { $expr: { $eq: ["$USER_ID", "$$uid"] } } }, { $limit: 1 }], as: "o" } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate lateralJoin", args: [[{ $lateralJoin: { from: "ORDERS", on: { USER_ID: "$ID" }, sort: { TOTAL: -1 }, limit: 1, as: "o", project: { TOTAL: 1 } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate facet/bucket/count", args: [[{ $facet: { a: [{ $match: { S: "x" } }, { $count: "n" }], b: [{ $bucket: { groupBy: "$AGE", boundaries: [0, 18, 65], default: "other" } }] } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate window", args: [[{ $addFields: { R: { $window: { fn: "ROW_NUMBER", partitionBy: ["CITY"], orderBy: { AGE: -1 } } }, S: { $window: { fn: "SUM", field: "SCORE", partitionBy: "CITY", orderBy: { ID: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" } }, L: { $window: { fn: "LAG", field: "AGE", offset: 1, orderBy: { ID: 1 } } } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate having/percentile", args: [[{ $group: { _id: "$CITY", P: { $percentile: { input: "$AGE", p: 0.5 } }, MD: { $median: "$AGE" }, SD: { $stdDevPop: "$AGE" }, CD: { $countDistinct: "$NAME" }, F: { $first: "$NAME" }, PU: { $push: "$NAME" }, AS: { $addToSet: "$CITY" } } }, { $having: { P: { $gt: 1 } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate jsonTable", args: [[{ $jsonTable: { column: "DATA", path: "items", ordinality: "N", columns: { SKU: "sku", QTY: { path: "qty", type: "NUMBER" } } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate matchRecognize", args: [[{ $matchRecognize: { partitionBy: ["SKU"], orderBy: { D: 1 }, measures: { N: { $count: "*" }, F: { $first: "$A.D" } }, pattern: "A B+", define: { A: { QTY: { $gt: 0 } }, B: { QTY: { $gt: 1 } } } } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate connectBy stage", args: [[{ $connectBy: { startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, maxLevel: 3 } }]], run: (p) => users().aggregate(p) },
  { name: "aggregate out/merge", args: [[{ $match: { A: 1 } }, { $out: "ARCHIVE" }], [{ $merge: { into: "ARCHIVE", on: { ID: "ID" }, fields: ["ID", "TOTAL"], whenMatched: "keepExisting" } }]], run: async (a, b) => { await users().aggregate(a); await users().aggregate(b); } },
  { name: "aggregate literal/mod/size", args: [[{ $project: { L: { $literal: "x" }, M: { $mod: ["$A", 3] }, Z: { $size: "$TAGS" }, AB: { $abs: "$A" }, CE: { $ceil: "$A" }, FL: { $floor: "$A" }, TR: { $trunc: ["$A", 1] }, LO: { $toLower: "$N" }, SU: { $subtract: ["$A", "$B"] } } }]], run: (p) => users().aggregate(p) },
  { name: "connectBy", args: [{ startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, root: "NAME", includeIsLeaf: true, includePath: true, pathColumn: "NAME", orderSiblings: { NAME: 1 }, maxLevel: 4 }], run: (s) => users().connectBy(s) },
  { name: "pivot", args: [{ value: { $sum: "$AMOUNT" }, pivotOn: "QUARTER", pivotValues: ["Q1", "Q2"], groupBy: "REGION" }], run: (s) => users().pivot(s) },
  { name: "unpivot", args: [{ valueColumn: "AMOUNT", nameColumn: "QUARTER", columns: ["Q1", "Q2"], include: ["REGION"] }], run: (s) => users().unpivot(s) },
  { name: "set ops", args: [{ NAME: "a" }, { NAME: "b" }, 2, 1], run: async (a, b, l, s) => { await OracleCollection.union(users().find(a), users().find(b), { all: true }).sort({ NAME: 1 }).limit(l).skip(s).toArray(); await OracleCollection.intersect(users().find(a), orders().find(b)).toArray(); await OracleCollection.minus(users().find(a), users().find(b)).toArray(); } },
  { name: "updateFromJoin", args: [{ target: "USERS", join: { table: "ORDERS", on: { ID: "USER_ID" } }, set: { TOTAL: "$TOTAL", FLAG: 1 }, where: { STATUS: "paid" } }], run: (s) => (users() as any).updateFromJoin(s) },
  { name: "insertFromQuery", args: ["ARCHIVE", { NAME: "a" }, { columns: ["NAME", "AGE"] }], run: (t, f, o) => (users() as any).insertFromQuery(t, users().find(f), o) },
  { name: "asOf/sample", args: [{ asOf: { scn: 123 } }, { asOf: { timestamp: "2026-01-01" } }, { sample: { percent: 10, seed: 3 } }], run: async (a, b, c) => { await arr(users().find({}, a)); await arr(users().find({}, b)); await arr(users().find({}, c)); } },
  { name: "withCTE", args: [{ active: { STATUS: "a" } }, { AGE: -1 }, 3, 1], run: (defs, s, l, k) => withCTE(fakeDb, Object.fromEntries(Object.entries(defs).map(([n, f]) => [n, users().find(f as object)]))).from(Object.keys(defs)[0]).sort(s).limit(l).skip(k).toArray() },
  { name: "withRecursiveCTE", args: ["org", { MANAGER_ID: null }, { collection: "EMP", joinOn: { M: "$org.ID" } }, { ID: 1 }, 5], run: (n, a, r, s, l) => withRecursiveCTE(fakeDb, n, { anchor: new OracleCollection("EMP", fakeDb).find(a), recursive: r } as never).sort(s).limit(l).toArray() },
  { name: "schema createTable", args: ["T1", { ID: { type: "NUMBER", primaryKey: true, autoIncrement: true }, NAME: { type: "VARCHAR2(100)", notNull: true, default: "x" }, AGE: { type: "NUMBER", check: "AGE > 0" }, U: { type: "NUMBER", references: { table: "USERS", column: "ID" } } }, { ifNotExists: true }], run: (n, c, o) => new OracleSchema(fakeDb).createTable(n, c, o), rawDdl: /^1\.\w+\.(type|default|check) = "/ },
  { name: "schema createTable plain", args: ["T1", { ID: { type: "NUMBER(10)", primaryKey: true }, D: { type: "NUMBER", default: 0, check: "D >= 0" }, V: { type: "NUMBER GENERATED ALWAYS AS (D * 2) VIRTUAL" } }], run: (n, c) => new OracleSchema(fakeDb).createTable(n, c), rawDdl: /^1\.\w+\.(type|default|check) = "/ },
  { name: "schema alterTable ops", args: ["T1", { X: "NUMBER" }, { Y: "VARCHAR2(10)" }, "Z", { from: "A", to: "B" }, { type: "UNIQUE", columns: ["A", "B"], name: "UQ_AB" }, "UQ_AB"], run: async (t, add, mod, drop, ren, con, dropCon) => { const s = new OracleSchema(fakeDb) as any; for (const op of [{ addColumn: add }, { modifyColumn: mod }, { dropColumn: drop }, { renameColumn: ren }, { addConstraint: con }, { dropConstraint: dropCon }]) { try { await s.alterTable(t, op); } catch { /* next op */ } } }, rawDdl: /^[12]\.\w+ = "/ },
  { name: "schema drop/view/sequence", args: ["T1", "V1", { A: 1 }, "S1"], run: async (t, v, f, q) => { const s = new OracleSchema(fakeDb) as any; for (const step of [() => s.dropTable(t, { ifExists: true, cascade: true }), () => s.createView(v, users().find(f), { orReplace: true }), () => s.dropView(v, { ifExists: true }), () => s.createSequence?.(q, { startWith: 1, incrementBy: 1 }), () => s.dropSequence?.(q, { ifExists: true }), () => s.truncateTable?.(t)]) { try { await step(); } catch { /* next */ } } } },
  { name: "dcl", args: [["SELECT", "INSERT"], "USERS", "APP_RO"], run: async (p, t, u) => { const d = new OracleDCL(fakeDb as never) as any; await d.grant(p, t, u); await d.revoke(p, t, u); } },
  { name: "sql tag ident", args: ["USERS", "NAME"], run: (t, c) => (sql as any)`SELECT ${(sql as any).ident(c)} FROM ${(sql as any).ident(t)} WHERE X = ${t}`.rows(fakeDb) },
];

// ─── run ────────────────────────────────────────────────────────────────────
describe("security fuzz: no caller string reaches SQL unquoted", () => {
  for (const c of CASES) {
    it(`${c.name}`, async () => {
      // the base call must build SQL, or the fuzz proves nothing
      seen.length = 0;
      try { await c.run(...clone(c.args)); } catch (e) { if (process.env.FUZZ_DEBUG) console.error(`[base] ${c.name}: ${(e as Error).message}`); }
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) expect(bareMarker(s)).toBeNull();

      const leaks: string[] = [];
      let tried = 0;
      for (const m of mutations(c.args)) {
        tried++;
        seen.length = 0;
        try { await c.run(...(m.value as unknown[])); } catch { /* refused: safe */ }
        if (c.rawDdl?.test(m.label) && !STRUCTURAL.test(JSON.parse(m.label.slice(m.label.indexOf(" = ") + 3)))) continue;
        for (const s of seen) {
          const hit = bareMarker(s);
          if (hit) { leaks.push(`${m.label}\n    ${s.slice(Math.max(0, hit.at - 80), hit.at + 40).replace(/\s+/g, " ")}`); break; }
        }
      }
      expect(tried).toBeGreaterThan(0);
      if (leaks.length) console.error(`\n[fuzz] ${c.name}: ${leaks.length} leak(s)\n  ` + [...new Set(leaks)].slice(0, Number(process.env.FUZZ_SHOW ?? 40)).join("\n  "));
      expect(leaks).toEqual([]);
    }, 120_000);
  }
});

describe("security fuzz: lexer self-check", () => {
  it("finds a bare marker and ignores quoted ones", () => {
    expect(bareMarker(`SELECT "a PWNED" FROM T WHERE X = 'PWNED' AND Y = :b_PWNED`)).toBeNull();
    expect(bareMarker(`SELECT a FROM T WHERE X = 'it''s' PWNED`)).not.toBeNull();
    expect(bareMarker(`SELECT "a"" PWNED" FROM T`)).toBeNull();
    expect(bareMarker(`SELECT "a" PWNED "" FROM T`)).not.toBeNull();
    expect(bareMarker(`SELECT 1 FROM T -- PWNED`)).not.toBeNull();
    expect(bareMarker(`SELECT q'[PWNED]' FROM dual`)).toBeNull();
    expect(bareMarker(`BEGIN EXECUTE IMMEDIATE 'CREATE TABLE "T" ("A" NUMBER) PWNED'; END;`)).not.toBeNull();
    expect(bareMarker(`BEGIN EXECUTE IMMEDIATE 'CREATE TABLE "T" ("A" VARCHAR2(9) DEFAULT ''PWNED'')'; END;`)).toBeNull();
  });
});
