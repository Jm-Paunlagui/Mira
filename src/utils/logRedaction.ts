

/**
 * @fileoverview Log-line pseudonymisation and email masking.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Turns a bare GID / EMP_ID / USERID interpolated into a log message or meta
 * value into a stable, keyed, one-way pseudonym (`emp_<10 hex>` /
 * `usr_<10 hex>`), and masks bare email addresses leaking through free-text
 * (e.g. an SMTP rejection `cause`). Run once per record, at enqueue, in
 * `logger.js#log()` — see that file's `#injectCallSite` → redaction → write
 * ordering.
 *
 * WHY IT LIVES HERE, NOT IN `logger.js`
 * --------------------------------------
 * `logger.js` deliberately imports nothing from `src/` except modules whose
 * own transitive closure is Node built-ins (see the comment at
 * `logger.js:20-27`). This module requires **only `crypto`** — never
 * anything under `src/`, ever — so it is safe for the logger to require
 * without inviting the require cycle that rule exists to prevent.
 *
 * REVERSIBILITY
 * -------------
 * The pseudonym is a keyed HMAC truncated to 10 hex characters. It is
 * one-way: nobody — not an ADMIN, not a SUPER_ADMIN, not a database query —
 * can turn `emp_a3f19c2b` back into a GID. The forward direction is what an
 * operator needs instead: paste the *suspected* GID into the System Logs
 * search box, and `searchCandidates()` computes the same token(s) that GID
 * would have produced, so the search still finds every line for that
 * employee. See `AuditLogService.getSystemLogs`.
 *
 * KEY MATERIAL
 * ------------
 * HKDF-derived from the existing `DATA_SIGNING_SECRET` (already boot-guarded
 * fail-closed, already identical across cluster workers and process
 * restarts — see `src/config/bootGuard.ts`). Derivation is lazy (first call,
 * not module load) so it never races dotenv loading the logger singleton is
 * constructed before, and memoised so it costs one HKDF call per process
 * lifetime. **No new environment variable** — rotating `DATA_SIGNING_SECRET`
 * re-keys every pseudonym; lines written before a rotation will not
 * correlate with lines written after (documented in `.env.example`).
 *
 * @security Mitigates CWE-532 (insertion of sensitive information into log
 *   file) and CWE-200 (exposure of sensitive information) for GID/EMP_ID/
 *   USERID and bare email addresses reaching the log estate. The pseudonym
 *   is HMAC-keyed (not a bare hash) specifically so an ADMIN who can already
 *   read the logs cannot offline-brute-force the dense, small GID keyspace
 *   (11 digits) back to real values — an unkeyed hash was rejected for this
 *   reason. `crypto.createHmac`/`crypto.hkdfSync` are Node's own primitives;
 *   this module performs no custom cryptography.
 */

import crypto from "crypto";

/**
 * One global, case-insensitive scan per string. Alternation order matters:
 * the comma-joined `GIDs:` list form must be tried before the single-`GID`
 * form so a list is tokenised as a list, not truncated at its first element
 * (in practice `\bGID\b` cannot match inside `GIDs` anyway, since there is
 * no word boundary between "D" and "s" — the ordering is defence, not the
 * only thing making this safe).
 *
 * ⚠ The value class is `\d{2,}` (digits only) and that is LOAD-BEARING, not
 * conservatism. Widening this
 * to alphanumeric would start rewriting the words "is", "was", "role" and
 * "resolved" inside verified message strings, and a bare-numeric match
 * (dropping the label requirement entirely) would pseudonymise record IDs,
 * row counts, durations and money figures that happen to sit next to an
 * identifier-shaped label.
 *
 * Named capture groups select which branch matched without a second scan:
 *   - `gidList` — `GIDs: 1, 2, 3` (comma-joined; each element tokenised individually)
 *   - `gid`     — `GID: 123` or `GID 123`
 *   - `empId`   — `ADMIN_ID: 123` / `ADMIN_ID 123` (numeric admin PK), plus the
 *                 legacy `EMP_ID:` label so lines written before the rename
 *                 still pseudonymise to the same token (same `empid` class)
 *   - `userId`  — `USERID: 123` / `USERNAME: 123` (digit-only usernames only;
 *                 alphanumeric usernames are left as-is — see the ⚠ above)
 *   - `user`    — `USER 123` or `for user 123` (catches the label-free templates)
 *   - `email`   — a bare email address (masked, not pseudonymised)
 *
 * The GID / EMP_ID / USERID labels also accept the label-adjacent forms a
 * JSON-stringified object or a key=value line produces — `"GID":"123"`,
 * `"EMP_ID":123`, `GID=123`, `GID#123` — and a label glued to its digits
 * (`GID123`). Every form is still label-anchored; a bare number never is.
 * The e-mail class is Unicode-aware (`Peña`, IDN domains) — hence the `u`.
 *
 * @constant {RegExp}
 */
const IDENTIFIER_RE =
    /\bGIDs\s*:\s*(?<gidList>\d{2,}(?:\s*,\s*\d{2,})*)|\bGID(?![A-Za-z_])["']?\s*[:=#]?\s*["']?\s*(?<gid>\d{2,})|\b(?:EMP_ID|ADMIN_ID)(?![A-Za-z_])["']?\s*[:=#]?\s*["']?\s*(?<empId>\d{2,})|\b(?:USERID|USERNAME)(?![A-Za-z_])["']?\s*[:=#]?\s*["']?\s*(?<userId>\d{2,})|\buser\b\s*:?\s*(?<user>\d{2,})|(?<email>[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,})/giu;

/**
 * Depth/node budget for `scrubValue`'s recursive walk. Not theoretical —
 * `ErrorHandlerMiddleware.js` puts a multi-KB `stack` string in meta on
 * every 500, and other services build wide result objects. Past the
 * budget the walk stops, but nothing is written raw: strings are still
 * scrubbed (one regex pass each) and an unwalked object or array is
 * replaced by its scrubbed JSON text — the same serialisation the logger
 * would have done anyway, so the worst case stays linear in its size.
 */
const MAX_DEPTH = 6;
const MAX_NODES = 200;

/**
 * Maps the hash "class" (the string mixed into the HMAC input alongside the
 * raw value) to the pseudonym's display prefix. `userId` (labelled
 * `USERID:`) and `user` (the label-free `USER ${userId}` templates) share
 * the `userid` class deliberately — both name the same kind of identifier,
 * a user-account id, just via different templates, and an ADMIN searching
 * for one must find lines written under either.
 *
 * `gid` and `empId` are kept as SEPARATE hash classes (`gid:`/`empid:`
 * prefixes on the HMAC input) even though both render with the `emp_`
 * prefix, specifically so a GID and an EMP_ID that are numerically equal
 * never share a token.
 *
 * @constant {Record<string, string>}
 */
const TOKEN_PREFIX = Object.freeze({
    gid: "emp_",
    empid: "emp_",
    userid: "usr_",
});

/** Lazily-derived, memoised HKDF key. See module docblock. */
let _cachedKey: Buffer | null = null;

/**
 * Derives (once) and returns the HMAC key used for pseudonymisation.
 *
 * Lazy: the logger singleton is constructed the moment `bootGuard` requires
 * it (`server.ts`), so deriving at module load could race dotenv. Unset
 * secret falls back to a fixed dev string and does NOT warn — production is
 * already dead without `DATA_SIGNING_SECRET` (boot-guarded), and a warning
 * here would fire on every test run.
 *
 * @returns {Buffer}
 */
function getKey(): Buffer {
    if (_cachedKey) return _cachedKey;
    const secret = process.env.DATA_SIGNING_SECRET || "unkeyed-dev";
    _cachedKey = Buffer.from(
        crypto.hkdfSync("sha256", secret, "", "app-log-pseudonym-v1", 32),
    );
    return _cachedKey;
}

/**
 * Produces the stable keyed pseudonym for one identifier value.
 *
 * `emp_`/`usr_` + 10 lowercase hex, HMAC-SHA-256 over `"<klass>:<value>"`,
 * keyed by the HKDF-derived secret. One-way: there is no inverse. Same
 * `(klass, value)` pair always produces the same token, in this process and
 * every other process sharing `DATA_SIGNING_SECRET` — required because
 * `server.ts` forks workers that append to the same log file, so one GID
 * cannot be allowed to render two different tokens depending which worker
 * logged it.
 *
 * @param {string} klass - Hash-input class discriminator (e.g. "gid", "empid", "userid").
 * @param {string|number} value - The raw identifier value.
 * @returns {string} e.g. "emp_a3f19c2b4d"
 */
function pseudonymize(klass: string, value: string | number): string {
    const key = getKey();
    const digest = crypto
        .createHmac("sha256", key)
        .update(`${klass}:${value}`)
        .digest("hex")
        .slice(0, 10);
    return `${(TOKEN_PREFIX as Record<string, string>)[klass] || "usr_"}${digest}`;
}

/**
 * Replaces the digit run at the tail of `match` with its pseudonym, keeping
 * everything before it (the label, colon, whitespace) exactly as matched.
 *
 * @param {string} match - The full regex match (label + separator + digits).
 * @param {string} digits - The captured digit run (always a suffix of `match`).
 * @param {string} klass - Hash-input class for `pseudonymize`.
 * @returns {string}
 */
function replaceTail(match: string, digits: string, klass: string): string {
    const prefix = match.slice(0, match.length - digits.length);
    return prefix + pseudonymize(klass, digits);
}

/**
 * Masks an email address for safe display (CWE-200 / CWE-312) — keeps the
 * first character of the local part and the full domain, replaces the rest
 * of the local part with asterisks.
 *
 * Moved verbatim from `ServerNotificationService.js` (`2edcf93`). ⚠ The
 * array guard below is that same commit's fix — do not regress it: without
 * it, `String(anArray)` joins every address with a comma BEFORE
 * `indexOf("@")` runs, so only the first address gets masked and every
 * address after it ships in the clear.
 *
 * @param {string|string[]} email
 * @returns {string|string[]} e.g. `"j***@example.com"` for a string, or a
 *   masked array (same length, same order) when `email` is an array.
 *
 * @example
 * maskEmail("johndoe@example.com"); // "j******@example.com"
 * maskEmail(["a@example.com", "bee@example.com"]); // ["a*@example.com", "b**@example.com"]
 */
function maskEmail(email: string): string;
function maskEmail(email: string[]): string[];
function maskEmail(email: string | string[]): string | string[];
function maskEmail(email: string | string[]): string | string[] {
    if (Array.isArray(email)) return email.map((e) => maskEmail(e));
    const str = String(email ?? "");
    const at = str.indexOf("@");
    if (at <= 0) return "***";
    const local = str.slice(0, at);
    const domain = str.slice(at);
    return `${local[0]}${"*".repeat(Math.max(1, local.length - 1))}${domain}`;
}

/**
 * Scrubs one string: pseudonymises labelled GID/EMP_ID/USERID/user
 * identifiers and masks bare email addresses. One regex scan per string.
 *
 * Big-O: O(n) in string length — a single global-regex pass with a
 * constant-size replacement per match.
 *
 * @param {string} str
 * @returns {string} The same string if nothing matched (byte-identical —
 *   `String.prototype.replace` returns the original reference when there
 *   is no match).
 */
function scrubString(str: string): string {
    return str.replace(IDENTIFIER_RE, (match: string, ...rest: unknown[]) => {
        const groups = rest[rest.length - 1] as Record<string, string | undefined>;
        if (groups.gidList !== undefined) {
            const prefix = match.slice(
                0,
                match.length - groups.gidList.length,
            );
            const tokenizedList = groups.gidList.replace(/\d{2,}/g, (d) =>
                pseudonymize("gid", d),
            );
            return prefix + tokenizedList;
        }
        if (groups.gid !== undefined) {
            return replaceTail(match, groups.gid, "gid");
        }
        if (groups.empId !== undefined) {
            return replaceTail(match, groups.empId, "empid");
        }
        if (groups.userId !== undefined) {
            return replaceTail(match, groups.userId, "userid");
        }
        if (groups.user !== undefined) {
            return replaceTail(match, groups.user, "userid");
        }
        if (groups.email !== undefined) {
            return maskEmail(groups.email);
        }
        return match;
    });
}

/**
 * Meta keys whose VALUE is an identifier on its own, with no label in the
 * string to anchor `IDENTIFIER_RE` — `{ userId: "30901" }`, `{ gid: 123 }`.
 * Keys compare lowercased with `_`/`-` removed. Maps to the hash class, so
 * the token equals the one the labelled text form produces and the ADMIN
 * search candidates still find it.
 *
 * @constant {Record<string, string>}
 */
const IDENTIFIER_KEYS = Object.freeze({
    gid: "gid",
    gids: "gid",
    empid: "empid",
    adminid: "empid",
    userid: "userid",
});

/** @returns {string|undefined} The hash class for an identifier-named key. */
function identifierClassOf(key: unknown): string | undefined {
    return (IDENTIFIER_KEYS as Record<string, string>)[String(key).toLowerCase().replace(/[_-]/g, "")];
}

/**
 * Pseudonymises a bare identifier value held under an identifier-named key.
 * Digit strings and integers only; anything else goes through the normal
 * scrub (arrays element by element).
 */
function scrubIdentifierValue(value: unknown, klass: string, state: { nodes: number }, depth: number): unknown {
    if (typeof value === "number" && Number.isInteger(value) && value >= 10) {
        return pseudonymize(klass, String(value));
    }
    if (typeof value === "string" && /^\s*\d{2,}\s*$/.test(value)) {
        return pseudonymize(klass, value.trim());
    }
    if (Array.isArray(value)) {
        return value.map((item) =>
            scrubIdentifierValue(item, klass, state, depth + 1),
        );
    }
    return scrubValue(value, state, depth);
}

/**
 * Built-ins whose JSON form carries no own-property data worth walking
 * (or must keep their prototype to serialise at all: `Date#toJSON`).
 */
function isOpaqueObject(value: unknown) {
    return (
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof Map ||
        value instanceof Set ||
        value instanceof Promise ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
    );
}

/**
 * Past the walk budget: the subtree is replaced by its scrubbed JSON text
 * rather than copied raw. Cycles render as the logger renders them.
 *
 * @param {*} value
 * @returns {*}
 */
function scrubOverBudget(value: unknown): unknown {
    if (typeof value === "string") return scrubString(value);
    if (value === null || typeof value !== "object") return value;
    if (isOpaqueObject(value)) return value;
    let text;
    try {
        const seen = new WeakSet();
        text = JSON.stringify(value, (key, val) => {
            if (typeof val === "object" && val !== null) {
                if (seen.has(val)) return "[Circular Reference]";
                seen.add(val);
            }
            return val;
        });
    } catch {
        return "[Unserialisable]";
    }
    return text === undefined ? value : scrubString(text);
}

/**
 * Scrubbed copy of an Error or class instance. Keeps the prototype (so
 * `instanceof` and custom `toJSON` still work) and rebuilds every own
 * enumerable property — nodemailer errors carry `response` / `rejected`
 * with raw addresses. An Error's non-enumerable `message` / `stack` are
 * copied back non-enumerable, scrubbed.
 */
function scrubInstance(value: object, state: { nodes: number }, depth: number) {
    const src = value as Record<string, unknown>; // read reflectively: own enumerable keys of an arbitrary instance
    const copy = Object.create(Object.getPrototypeOf(value));
    if (value instanceof Error) {
        for (const key of ["message", "stack"] as const) {
            if (typeof src[key] === "string") {
                Object.defineProperty(copy, key, {
                    value: scrubString(src[key]),
                    enumerable: false,
                    writable: true,
                    configurable: true,
                });
            }
        }
    }
    for (const key of Object.keys(value)) {
        copy[key] = scrubChild(key, src[key], state, depth + 1);
    }
    return copy;
}

/** Scrubs one keyed child, honouring identifier-named keys and the budget. */
function scrubChild(key: unknown, child: unknown, state: { nodes: number }, depth: number) {
    if (state.nodes >= MAX_NODES) return scrubOverBudget(child);
    state.nodes += 1;
    const klass = identifierClassOf(key);
    return klass
        ? scrubIdentifierValue(child, klass, state, depth)
        : scrubValue(child, state, depth);
}

/** @returns {boolean} Whether `value` is a plain `{}`/`Object.create(null)` object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Recursively scrubs a value: strings are pseudonymised/masked via
 * `scrubString`; plain objects and arrays are walked and rebuilt (never
 * mutated); a bare identifier under an identifier-named key
 * (`IDENTIFIER_KEYS`) is pseudonymised. `Date`, `Buffer`, `Map`, `Set` and
 * similar built-ins are returned by reference; an `Error` or class instance
 * is copied with its prototype and own properties scrubbed — an `Error`
 * with enumerable `response` / `rejected` fields DOES serialise them.
 *
 * Stops walking past `MAX_DEPTH` / `MAX_NODES`; see the constants' docblock
 * for what happens to the rest.
 *
 * Big-O: O(k) in the number of nodes visited, bounded above by `MAX_NODES`;
 * each string node additionally costs `scrubString`'s O(length).
 *
 * @param {*} value
 * @param {{ nodes: number }} [state] - Internal node-budget counter.
 * @param {number} [depth]
 * @returns {*}
 */
function scrubValue(value: unknown, state: { nodes: number; } = { nodes: 0 }, depth: number = 0): unknown {
    if (typeof value === "string") return scrubString(value);

    if (Array.isArray(value)) {
        if (depth >= MAX_DEPTH || state.nodes >= MAX_NODES) {
            return scrubOverBudget(value);
        }
        return value.map((item) => {
            if (state.nodes >= MAX_NODES) return scrubOverBudget(item);
            state.nodes += 1;
            return scrubValue(item, state, depth + 1);
        });
    }

    if (value !== null && typeof value === "object") {
        if (isOpaqueObject(value)) return value; // Date/Buffer/Map/Set — by reference
        if (depth >= MAX_DEPTH || state.nodes >= MAX_NODES) {
            return scrubOverBudget(value);
        }
        if (!isPlainObject(value)) return scrubInstance(value, state, depth);
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            out[key] = scrubChild(key, value[key], state, depth + 1);
        }
        return out;
    }

    return value; // number, boolean, null, undefined
}

/**
 * Internal meta keys `logger.js` reads structurally and must survive
 * unscrubbed. `_clientMachine` in particular carries `username@userId (C)
 * IP` and is read verbatim by `AuditLogService._parseSystemLine` as
 * `machine` — this is a DELIBERATE residual, not an oversight.
 */
const INTERNAL_KEYS = new Set(["method", "url", "function", "file", "line"]);

/**
 * Returns a SHALLOW-CLONED copy of `meta` with every non-internal value
 * scrubbed. NEVER mutates the caller's object — services build meta objects
 * and sometimes reuse them across calls.
 *
 * Keys starting with `_` (e.g. `_isHttpRequest`, `_clientMachine`,
 * `_requestPhase`, `_noRedact`, `_noNotify`) and the five `INTERNAL_KEYS`
 * copy BY REFERENCE, unscrubbed — `logger.js#formatMessage` reads
 * `meta._clientMachine`/`meta.method` structurally, and
 * `#captureCallSite`/`_parseSystemLine` depend on `function`/`file`/`line`
 * keeping their exact shape.
 *
 * @param {object} meta
 * @returns {object} A new object; `meta` itself is never modified.
 */
function scrubMeta(meta: Record<string, unknown>): Record<string, unknown> {
    if (!meta || typeof meta !== "object") return meta;
    const clone: Record<string, unknown> = {};
    const state = { nodes: 0 };
    for (const key of Object.keys(meta)) {
        if (key.startsWith("_") || INTERNAL_KEYS.has(key)) {
            clone[key] = meta[key];
            continue;
        }
        clone[key] = scrubChild(key, meta[key], state, 1);
    }
    return clone;
}

/**
 * Computes the search candidates for an ADMIN's raw System Logs `?search=`
 * needle: the needle as typed, plus — when it is digits-only (the same
 * `\d{2,}` shape `IDENTIFIER_RE` requires) — the tokens that value would
 * have produced under each hash class it might have been logged as.
 *
 * This is the forward half of the "one-way pseudonym, reversible search"
 * design: nobody can turn a token back into a GID, but an operator who
 * already suspects a GID can still find every line for it, because the
 * same deterministic HMAC that produced the token in the log file
 * reproduces it here from the suspected raw value.
 *
 * @param {string} needle - Already trimmed/length-capped/lower-cased by the caller.
 * @returns {string[]} 1 element (the raw needle) for non-numeric input,
 *   4 elements (raw + gid/empid/userid tokens) for a digits-only needle.
 */
function searchCandidates(needle: string): string[] {
    const candidates = [needle];
    if (/^\d{2,}$/.test(needle)) {
        candidates.push(pseudonymize("gid", needle));
        candidates.push(pseudonymize("empid", needle));
        candidates.push(pseudonymize("userid", needle));
    }
    return candidates;
}

export { scrubString, scrubValue, scrubMeta, pseudonymize, searchCandidates, maskEmail, IDENTIFIER_RE };
