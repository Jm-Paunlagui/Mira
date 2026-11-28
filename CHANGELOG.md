# Changelog

## [3.1.0] — Unreleased

Theme: security hardening, then performance. A red-team pass (a new SQL-text fuzzer, plus hand-written attacks) found five ways for a caller's text to reach SQL unescaped. Each is fixed and has a regression test. **Upgrade if your app passes request input into filters, or builds views from filters.**

### Security

- **`createView()` / `createMaterializedView()` value injection.** Filter values are written into the view's SQL as literals, one bind at a time. A value containing another bind's name (for example `":where_CITY_1"`) pulled the next value into its own quotes, and a value such as `' || (SELECT PASSWORD FROM …) || '` then ran as SQL in the view. Binds are now inlined in one pass that never re-reads a literal. `renameBinds` (subqueries, `$lookup`) gets the same one-pass fix: it could rename a placeholder twice and bind the wrong value.
- **`$inSelect` operator injection.** A plain string given to `$inSelect` was run as raw SQL. A filter built from request input (`users.find({ ID: req.query.id })` with `?id[$inSelect]=SELECT…`) reached it. **Breaking:** a string is now refused. Pass a query (`orders.find(…).project(…)`), an array of values, or a ``sql`…` `` statement, whose values are binds.
- **New `sanitizeFilter(input)`.** It turns untrusted input into an equality-only filter and refuses `$` operators, nested objects, lists and `__proto__`/`constructor` keys. Mongo-style APIs let a request send `{ "NAME": { "$ne": "" } }`; use `users.find(sanitizeFilter(req.query))` and add your operators in code.
- **`grant()` / `revoke()` privilege injection.** Privilege names were joined into the statement as written. Only Oracle object privileges are accepted now (SELECT, INSERT, UPDATE, DELETE, ALTER, INDEX, REFERENCES, EXECUTE, READ, WRITE, DEBUG, FLASHBACK, UNDER, ON COMMIT REFRESH, QUERY REWRITE, ALL [PRIVILEGES]).
- **DDL fragments.** A column type (`createTable`, `alterTable` add/modify), `DEFAULT` and `CHECK` are still developer-written SQL, but each must now be one balanced fragment: quotes closed, parentheses balanced, no top-level `,`, no `;`, no comments. A value can no longer close the column definition and add its own. `addConstraint.type` takes only `UNIQUE` or `PRIMARY KEY`.
- **Aggregate operands.** A value that is neither a column, an expression nor a plain value (for example an object with its own `toString()`) was spliced into the SQL as `String(value)`. It is refused with a `TypeError`; non-finite numbers are refused too.
- **Connect-string injection.** `buildSimpleConnectString`, `buildTNSConnectString` and `fromEnv`'s `HOST`/`PORT`/`SERVICE` wrote their parts into the descriptor unchecked. A host such as `db)(ADDRESS=(HOST=evil)…` added an address and sent the credentials to another server. Host, port (1–65535) and service/SID are now validated; errors name the part, never the value.
- **Inlined negative numbers (`createView`, `createMaterializedView`).** A negative number written after a `-` in a `sql\`…\`` fragment (`A = 10-${n}`, n = -5) became `10--5`, and `--` starts a comment that dropped the rest of the line (for example a tenant predicate) from the stored view. Negative numbers are now inlined in parentheses. The bind rewriters also skip `--` / `/* */` comments and `q'…'` / `nq'…'` literals, so a placeholder written inside them is never filled in. They do it in one linear pass (a hand-written scanner, not a regular expression: CodeQL found that a regex for the same tokens took quadratic time on an unterminated `q'[` repeated, 2.3 s for 200 KB).
- **National q-quoted literals in DDL fragments.** `Nq'…'` / `nq'…'` passed the fragment check (only a q at the start of a word was refused), so a `DEFAULT` could hide a top-level comma and add a column. Refused like `q'…'`.
- **Shared sub-objects in a filter.** A shallow filter that reuses one object under two keys at every level was walked once per path (2⁴⁰ paths at 40 levels). The walk now also stops at 100,000 objects and arrays (`RangeError`).
- **Stack exhaustion.** A filter, update or pipeline nested 100,000 levels deep overflowed the stack inside the recursive parsers. Input deeper than 100 levels, or input that refers to itself, is refused up front with a `RangeError`.

### Performance

- **IN-list padding.** `$in` / `$nin` lists of up to 1,000 values are sent at power-of-two lengths, repeating the last value (results are identical). Lengths 1–1,000 now map to 11 SQL texts instead of 1,000, so Oracle reuses the parsed cursor. Measured p95: 2–4× lower (700 values: 11.6 → 3.0 ms).
- **`insertMany()` skips `RETURNING` when it is certain of the IDs.** With the default options, if every document supplies a safe-integer `ID`, the session writes to its own schema (no `ALTER SESSION SET CURRENT_SCHEMA`), the table is in that schema, its `ID` is a `NUMBER` with no scale, and no enabled trigger on it fires on insert (whoever owns the trigger), the supplied IDs are reported and no `RETURNING` (one out-bind per row) is sent. Otherwise, including when the dictionary read fails, nothing changes. The check is one dictionary query per pool and table per minute, and the answers are dropped when the Mira instance closes. Default `insertMany` of 1,000 rows: 5.1 → 2.1 ms (2.74× → 1.11× the raw driver). A trigger that rewrites the ID keeps `RETURNING`, so the stored value is reported. An explicit `returning: ["ID"]` always reads back.
- **`insertMany()` and `bulkUpdateByKeys()`: one round trip, less CPU.** A batch that is one statement (one column set, no `batchErrors`) and not inside a transaction now commits with the execute itself (`autoCommit`) instead of a separate `COMMIT`. A failed batch still commits nothing and is rolled back before the connection goes back to the pool. Binds are built in one pass per column, by position. Against the raw driver running the same SQL, `insertMany` of 1,000 rows went from 1.32× to 1.07×, and Mira's own CPU per 1,000 rows from 347 to 67 µs.

### Reliability

- **A database that stops answering no longer hangs Mira.** Found with a new TCP chaos proxy that stalls the link (packets stop, sockets stay open):
  - **New pool option `callTimeout`** (ms, default 0 = no limit; env `<P>_CALL_TIMEOUT`). It is set on every borrowed connection. Mira also bounds each round trip in JS at `callTimeout` + 1 s, because in Thin mode the driver's own timeout sends a break and then waits forever on a dead link. A call that hits the bound fails, and its connection is dropped instead of reused. The old `POOL_DEFAULTS.callTimeout` (60 s) was never applied (the driver ignores it in `createPool`) and is removed.
  - **New pool option `expireTime`** (minutes, default 0; env `<P>_EXPIRE_TIME`): keepalive probes, so a connection a firewall silently dropped is noticed.
  - **Health checks are bounded** at `connectTimeout`. Before, a check on a stalled link never finished, so the circuit breaker never opened and callers kept piling on. Now the breaker opens about 5 s into a stall and closes within a second of recovery, with one `onChange` per transition.
  - **Opening a pool is bounded** in Thick mode too (each step at twice `connectTimeout`). Thick mode does not apply `connectTimeout`, and a failed attempt's pool close is no longer awaited: queued behind hung native connects, it blocked every retry.
  - **`close()` / `closeAll()` are bounded.** A pool that does not close within 10 s + 2 × `connectTimeout` (a link that stopped answering) is abandoned: the call returns, logs it, and the pool keeps closing in the background. `createMira`'s `close()` closes its pools in parallel, so the bound is not paid once per pool. `closeAll()` no longer keeps the process alive for 30 s after a normal close (its guard timer was never cleared).
  - **Abandoned work is counted.** `mira.stats()` has a process-wide `abandoned: { calls, pools, zombies }` (native work Mira stopped waiting for and that is still running; closed pool names included), and each pool's entry has `abandonedCalls` and `abandonedPools`. A healthy run reports zeros. `zombies` counts connections dropped while a call on them was still hung (see below).
  - **Errors say what happened.** What `withConnection` throws (and so every collection method) is now a `MiraDbError` with `kind` (`"connectivity"`, `"saturation"`, `"timeout"`, `"statement"`), `code` (Mira's own case, such as `MIRA_CALL_TIMEOUT`, `MIRA_ACQUIRE_TIMEOUT`, `MIRA_CLOSE_TIMEOUT`, `MIRA_CIRCUIT_OPEN`; driver codes stay in the message and on `originalError`), `outcomeUnknown` (whether a write may have reached the database; see below), `connectionName`, `durationMs` and `originalError`. The message text is unchanged except for the messages Mira writes itself, which now end with ` [MIRA_CODE]`. The circuit-open message still contains `NJS-503`. New exports: `MiraDbError`, `MiraErrorKind`, `MiraErrorCode`, `MiraAbandoned`.
  - **One guard per borrowed connection (pools with `callTimeout`).** Calls on one connection run one after another (the driver serialises them anyway), and the JS bound starts when a call starts, so a `Promise.all` of healthy calls is no longer cut because it waited for its turn. The bound is read from `conn.callTimeout` when each call starts (a callback that raises it, or sets it to 0, is obeyed). A cut call kills its connection: later calls fail at once with `MIRA_CONNECTION_DEAD`, `withTransaction` does not ask the dropped session to roll back, `withBatchConnection` stops at a cut call or a lost link (it throws), and the connection is dropped, never returned to the pool.
  - **`outcomeUnknown` is now set.** A cut `commit`, auto-committed write (`autoCommit` true, which every write outside a transaction uses), DDL or PL/SQL block gives `MIRA_OUTCOME_UNKNOWN` and `outcomeUnknown: true`: it may or may not have reached the database, so check by a natural or idempotency key before repeating it. A cut query, a plain write inside a transaction (a dropped session's transaction can never commit) and a cut rollback give `MIRA_CALL_TIMEOUT` and `outcomeUnknown: false`: retrying is safe. A driver `ORA-03113` and the like on one of those calls is `outcomeUnknown: true` too. The flag survives a callback that rewraps the error.
  - **Releasing a connection is bounded** at `callTimeout` + 1 s. A release that hangs is logged, the call returns, and the connection is counted as a zombie until its close ends. `stats()` has `abandoned.zombies` (no longer reserved) and a per-pool `zombieConnections`.
  - **Streams cannot hang** on a stalled link. `forEach()`, `for await` and `conn.queryStream()` on a pool with `callTimeout` time each fetch and the stream's close: a stalled one ends the stream with an `error` and a `close` within `callTimeout` + 1 s (the driver's own `destroy()` waits for the fetch in flight, so it hung too), and the connection is dropped. A consumer that stops reading is never timed out; the bound runs only while Mira waits on the database.
  - **A busy pool is not a down pool.** A health check that fails because the pool is full (`NJS-040`/`NJS-076`, or the check queued until its bound) while calls are still finishing, or while fewer connections are stuck than are in use, does not count against the breaker. `health.metrics()` shows it as `saturated`, and `onCheck` reports `saturated: true`. A pool full of connections stuck on a dead link still counts as down. Saturation no longer nudges the monitor.
  - **Half-open breaker.** After an outage the first passing check moves the breaker to `half-open`: 3 calls at a time are let through, 3 successes (or the next passing check, or `recordProbeSuccess`) close it, a connectivity failure opens it again. `health.metrics()` has `state` (`"closed"`, `"open"`, `"half-open"`); `healthy` is true only when closed, so `onChange` still fires on the same two transitions. Recovery after an outage takes one more check than before.
  - **No stale health records.** A check that outlives its pool (`closePool`, `close()`) no longer brings back a record: a re-created pool of the same name could be stuck behind `NJS-503` with nothing left to check it.
  - **Cold start over a dead link does not hang callers.** A caller waits at most `connectTimeout` for a pool that is still opening and gets `MIRA_POOL_OPENING`; the opening goes on in the background. `stats()` no longer waits for it either (the pool shows `{ opening: true }`), and a health check never waits for a creation. Each failed opening attempt counts like a failed check, so the breaker opens after 3 attempts (about 9 s over a stall in Thin mode) instead of minutes; the pool coming up nudges the monitor, which half-opens and closes the breaker. A pool that could not be created is a `MiraDbError` of kind `connectivity` (message `Could not create pool …`, cause on `originalError`). `mira.open()` still waits for the whole creation and reports it.
  - **Opening a pool abandons at most 2 steps.** Opening steps (createPool, the warm-up connection, its ping) that Mira gave up on keep running in the driver; while 2 of them are unfinished the next attempt is deferred (`MIRA_CREATE_DEFERRED`) instead of piling up half-open pools and sessions. Retries (attempts 2 to 4) open with `poolMin: 0` and restore the configured `poolMin` in the background once the pool is up.
  - **A pool whose connections are stuck on a dead link is replaced.** A connection whose call was cut is dropped, but its close queues behind the hung call, so on a link that went silent (no reset) the slot stays in use until TCP gives up (about 15 minutes). When those zombie connections fill the pool, or the breaker opens while any exist, the pool is replaced: the old one closes in the background (counted as abandoned) and the next call or check opens a new one on new sockets. A caller still queued on the old pool fails with the driver's own `NJS-064`/`NJS-065`, now classified `connectivity`. `stats()` has a per-pool `replacements`. No replacement happens while 2 closes of replaced pools are still unfinished, during shutdown, or for a pool closed meanwhile.
  - **Thick mode: a broken connection no longer stays checked out of its pool.** node-oracledb 7.0.1, while any trace handler is installed (`onQuery` installs one, and so do tracing libraries), reads a connection's service and instance names at the start of every call. In Thick mode that read throws `DPI-1010` on a connection whose link broke, so `close()` failed with `NJS-003` before giving the session back. Every connection cut by a database restart or a network reset was lost to the pool for good (3 of 4 slots after 3 cuts), and closing the pool then waited out its drain. Mira now closes connections with tracing off for the start of the call. Found by the chaos suite; Thin mode was not affected.
  - **Thick mode: reading a pool's counts can no longer freeze the process.** `connectionsInUse` / `connectionsOpen` are OCI attribute reads in Thick mode, and OCI takes the session pool's mutex for them. A native operation hung on a silent link (dropping a stuck session, opening one) holds that mutex, so the health monitor's busy check blocked the JS thread itself: no timer fired again and the process stopped for good (found by the chaos suite on macOS). Thick pools are now counted in JS (every `getConnection`, connection close, `reconfigure` and pool close is tallied), and the driver is asked only while none of them is in flight. `stats()` then takes `poolMin` / `poolMax` from the config and reports `connectionsOpen` as last read safely, with `countsApproximate: true` while it could not be read. Thin mode is unchanged.
  - **The Thick worker-thread warning counts every pool.** Thick mode runs each call on one of the runtime's worker threads, shared by all pools. The warning is now computed once over all registered pools (sum of `poolMax`, plus 3 per pool for its health check and pool creation, plus 2), when the first pool opens, and again only if a later pool raises the need. Node uses `UV_THREADPOOL_SIZE` (default 4). Bun honours the same variable for a value of 2 or more and, unset, uses one thread per CPU core.

### Changed

- **An acquire Mira gives up on is not retried, and its bound is longer.** Mira's own bound on `pool.getConnection()` is now `queueTimeout` + `connectTimeout` (was `connectTimeout`; `connectTimeout` alone when `queueTimeout` is 0), so the driver's own `NJS-040` wins on a saturated pool and Mira's bound fires only when the driver itself is stuck. Failing it (`MIRA_ACQUIRE_TIMEOUT`) is no longer retried up to 3 times: each retry queued another waiter behind a stuck driver. A saturated pool gives one `NJS-040` per caller after `queueTimeout`.

### Known limitation

- **The hour repeated when clocks go back.** In a time zone with daylight saving, a `Date` between 01:00 and 02:00 local on the day clocks go back can read back one hour off (Thin mode: all date column types; Thick mode: `TIMESTAMP` and `DATE`), and an equality filter on it also matches its twin. Processes on UTC or in a zone without daylight saving are not affected. See README, "Session time zone". A fix for the zone-aware column types is planned for 3.2.

### Fixed

- **`forEach()` and `for await` handed their connection back before the query stream closed.** They settled on the stream's `end` (or right after `destroy()`), and node-oracledb closes the result set after that, so the connection went back to the pool while still in native use. Under Bun in Thick mode, another caller's error on that connection could then read `DPI-1039` / `NJS-003` instead of its real `ORA-` text (21–30 in 2,000 duplicate-key errors next to running streams). Both now wait for the stream's `close`.

- A `Buffer` or a ``sql`…` `` statement inside a filter kept its type: the filter-resolution step copied every object field by field.
- `insertMany()` and `bulkUpdateByKeys()` with a very large batch threw `RangeError: Maximum call stack size exceeded` while sizing the binds (`Math.max(...values)`): on Node from about 125,000 rows, on Bun at 1,000,000. Sized with a loop now.
- Error messages say "an object", not "a object" (`sanitizeFilter`, `$inSelect`).

### Supply chain

- Every GitHub Action is pinned to a commit SHA (Dependabot keeps the pins current), and `actions/checkout` no longer leaves the token in `.git/config`.
- `SECURITY.md`: how to report a vulnerability.
- CI pulls the Oracle Database image by digest and a versioned Instant Client (Linux 23.26.2.0.0, Windows 23.26.1.0.0) checked against its SHA-256, instead of a moving tag and Oracle's unversioned "latest" link.

### Tests

- `test/security/fuzz.test.ts` takes about 60 call shapes covering every public builder and sends each through every mutation: each string, key and number replaced by 19 hostile payloads, in both string and `toString()` object form. A SQL lexer, which also reads inside `EXECUTE IMMEDIATE` strings, checks that no payload ever appears as bare SQL.
- `test/security/hardening.test.ts`: a regression test for each fix above.
- `test/performance/budgets.test.ts`: bounds that fail on a 2× regression on any machine. SQL-building cost is measured against a fixed calibration workload in the same run; statements per call are exact counts; overhead over the raw driver is a ratio of interleaved medians.
- Reliability: `test/reliability/soak.test.ts` (3,000 mixed operations by default, `MIRA_SOAK_OPS=30000` for a long run: heap, RSS, server-side cursors, connections and p95 must stay flat), `cursorLeak.test.ts` (Oracle's own session statistics: 177 call shapes stay within the statement cache, repeats compile nothing, `$in` lengths 1–1,000 collapse to 9 SQL texts, aborted streams and failed statements hold no cursor), `concurrency.test.ts` (typed tables, `include()`, `withCTE` and recursive CTEs give the sequential answer under 50 concurrent callers) and `timezoneSoak.test.ts` (about 1,900 instants across both daylight-saving changes, four column types, three write paths). The test schema needs `SELECT` on `V_$OPEN_CURSOR`, `V_$MYSTAT`, `V_$STATNAME`.
- `test/chaos/network.test.ts` (with `test/helpers/chaosProxy.ts`): a stalled link, a database restart (every connection cut), a flapping link, `close()` with work and a stream in flight, and connections cut at random points in `withTransaction`, `bulkWrite` and `insertMany` (all or nothing). It needs no database privileges.
- The simulation records each stage's time, statement count and time spent in statements (`coverage/sim-stages.json`, and the CI job summary).

## [3.0.0] — 2026-11-28

Theme: Mira is a standalone library. The app passes its config in; Mira reads no environment variable, writes no log file and initialises no driver unless asked. Built on top of 2.2 (`createMira`, `configureDriver`, `setLogger`), which stays the entry point. Upgrade guide: [docs/MIGRATION-3.0.md](docs/MIGRATION-3.0.md). Plan and progress: [docs/ROADMAP-3.0.md](docs/ROADMAP-3.0.md).

### Removed (breaking)

- **`createDb()`** from the public API. Use `createMira(config).db(pool)`.
- **The built-in `appDb` / `appDbBulk` pools** and every variable that drove them: `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME`, `APP_DB_USERNAME`, `APP_DB_PASSWORD`, `APP_POOL_*`, `APP_BULK_*`, and the `NODE_ENV=development` + `APP_TEST_DB_*` test-schema switch. Pass pools to `createMira()`, or read `MIRA_DB_*` with `fromEnv()`.
- **`DB_TYPE` / `createAdapter()`** (Mira is Oracle only), **`POOL_NAMES`** (use `mira.config.poolNames`) and **`READINESS_GATING_POOLS`** (a readiness rule belongs to the app).
- **`ORACLE_INSTANT_CLIENT`** and its Windows-only DLL check. Thick mode loads from `driver.libDir`, or the system library path. `fromEnv()` reads `MIRA_DRIVER_LIB_DIR`.
- **Mira's file logger** (`src/utils/logger.ts`, log redaction, request context) and its variables: `LOG_*`, `ENABLE_CONSOLE_LOGS`, `DOCKER_CONTAINER`, `DATA_SIGNING_SECRET`. Mira writes no file.
- **Compiled-executable detection** (`runtimePaths`, `IS_COMPILED`): the `.env` loader, the `PATH` set-up and the connect-string whitespace tweak. Pass `driver.binaryDir`.
- The dev-mode "placeholder credentials" pass: missing `user` / `password` / `connectString` always throws.
- Dependencies: `dotenv` (never imported) and `@types/express`.

### Changed

- **Default log sink:** warnings go to `console.warn` and failures to `console.error`, prefixed `[mira]`; notices are dropped. `logger: console` shows everything, `logger: false` nothing.
- In `"auto"` driver mode, no Oracle Client on the library path is an ordinary Thin start: a one-line notice instead of a multi-line DPI-1047 warning. A `libDir` you named that fails to load is still a warning.
- **Session time zone follows the process, not UTC.** node-oracledb writes a JS `Date` in the process's zone and Oracle reads it in the session's, so the two must match. 2.1 forced sessions to `+00:00` through `ORA_SDTZ`, which was right only for a process on UTC: in any other zone, a `Date` written to a `TIMESTAMP WITH TIME ZONE` / `WITH LOCAL TIME ZONE` column moved by the process's offset (Thin and Thick, Node and Bun). It went unseen because `bun test` and CI ran on UTC. Under Bun the `ORA_SDTZ` change never reached the Oracle Client, so Thick mode under Bun happened to be right. Now every pool sets each new session's zone in its `sessionCallback`: the process's region (e.g. `Asia/Manila`) in Thin mode, falling back to its offset; its offset in Thick mode, where a region makes the client fetch with its own time-zone file (`ORA-01805` when that differs from the server's). An `ORA_SDTZ` you set yourself still wins (an offset, a region, `LOCAL` or `DBTIMEZONE`; anything else is refused with a warning). Mira no longer writes `ORA_SDTZ`.
- **`include()` reads zone-less dates as local time.** Related rows come back through Oracle's JSON functions, where a `TIMESTAMP` or `DATE` has no zone; Mira read that text as UTC, node-oracledb reads such columns as the process's local time, so they disagreed outside UTC.
- **A session the server already closed is dropped, not leaked.** In Thick mode, a call timeout that cannot be interrupted in flight closes the session (`NJS-500` / `ORA-03156`). `withConnection`'s cleanup then reset `callTimeout` on the dead connection, which threw `DPI-1010`: that replaced the caller's error and skipped the release, so the pool slot stayed "in use" for good. Cleanup now never throws over the caller's error, and a dead connection is closed with `{ drop: true }`. 2.x's TNS descriptor (with transparent failover) had been hiding this.
- **`mira.close()` no longer waits out the retries of a pool that cannot come up.** A pool still being created when its instance closes stops at the current attempt or backoff ("was closed while it was being created; not retrying"). Before, close waited for all 4 attempts and their backoff, each up to its connect timeout.
- **A handle kept after `mira.close()`** reports `isHealthy() === false` and rejects `withConnection` / `withTransaction` / `withBatchConnection` with "This Mira instance is closed". It used to stay "healthy" and fail with "Unknown connection".
- The bare handle's `closePool()` (close every pool in the process) is gone; `mira.db().closePool()` closes that instance, as in 2.2.
- **Layout:** `src/` is `index.ts`, `config/`, `driver/`, `core/`, `parsers/`, `pipeline/`, `joins/`, `schema/`, `typed/`, `migrate/`, `advanced/`, `shared/`, `cli/` (was `src/utils/oracle-mongo-wrapper/…`). The package entry is `dist/index.js`; only the package root is public.
- **Package:** publishes `dist/` without `src/`, and without source or declaration maps.
- The `mira` CLI connects with `MIRA_DB_*` through `fromEnv()`; `--verbose` sends every log line to stderr.

### Added

- **Lifecycle and health on the instance**, scoped to its own pools (what 2.x apps reached through the adapter): `mira.open()` opens every pool now and reports each result; `mira.stats()`; `mira.health.isHealthy(pool?)`, `allHealthy()`, `metrics()`, `onChange(fn)`, `onCheck(fn)` (each returns an unsubscribe function), `watch(on)`, `recordProbeSuccess(pool?)`, `nudge(pool?)`. `close()` removes the listeners an instance added and ends a watch it started. Type `MiraHealth`.
- Types `MiraDb` (what `mira.db()` returns) and `DbConnection`.
- `driver.binaryDir` for a Thick binary staged outside the package (compiled executables).
- `buildSimpleConnectString` / `buildTNSConnectString` now live in `config/connectString.ts` (same exports).

### Tests and simulation

- Tests build their pool with `createMira(fromEnv())` (`test/helpers/db.ts`); CI sets `MIRA_DB_*` and connects by service name, so the listener's SID-as-service tweak is gone.
- The simulation runs on its own `createMira` pool and also counts `mira.*` and `mira.health.*` methods; stage 17 exercises the config, lifecycle and health API. 177 of 177 public functions, 366 checks.
- Fixed races: the chaos leak check now waits for the health monitor's ping to return its connection; the flashback test waits until its timestamp maps behind the current SCN and restores its fixture on failure.
- CI runs the live suite in four jobs, Thin and Thick × the 2.x failover descriptor and plain Easy Connect, and in `TZ=Asia/Manila` (+08:00) instead of UTC, so a time-zone mismatch fails a test. The time-zone tests were also checked locally in UTC, Asia/Manila and America/New_York (across daylight saving), Thin and Thick.
- New package check (`bun run test:package`, a CI step in both driver modes): the packed tarball in an empty project, strict `tsc` over the published types, TypeScript under Bun, CommonJS and ES modules under Node, the CLI.
- 565 tests at 100% line and function coverage.


## [2.2.0] — not released separately (shipped in 3.0.0)

Theme: config passed in, not read from Mira's own env names. Step 1 of the 3.0 restructure; everything adds to 2.1, nothing breaks.

### Added

- **`createMira(config)`**: pools passed in as a config object, any number of them, any names. Returns `db(pool?)`, `collection(table, pool?)`, `schema()`, `dcl()`, `transaction()` and `close()`, which closes that instance's pools only. Pool names are type-checked from the config's keys.
- **`defineConfig(config)`**: validates a config and returns it frozen with `defaultPool` filled in. Every problem is reported in one `MiraConfigError` (`err.issues`); unknown pool keys are refused.
- **`fromEnv(options?)`**: opt-in reader for `MIRA_DB_*` (or per-pool prefixes) into a config. A number that does not parse throws instead of falling back.
- `buildSimpleConnectString` / `buildTNSConnectString` are exported from the package.
- Adapter: `closePool(name)` closes one pool and stops monitoring it; `isPoolOpen(name)`. Registry: `registerConnection` / `unregisterConnection` (used by `createMira`).
- Types: `Mira`, `MiraConfig`, `PoolConfig`, `ResolvedMiraConfig`, `FromEnvOptions`, `DriverMode`, `DriverOptions`, `MiraLogger`.
- **Driver mode (step 2):** `configureDriver({ mode: "auto" | "thin" | "thick", libDir })` and `createMira({ driver })`. `"thin"` never loads an Oracle Client; `"thick"` fails instead of falling back. An explicit `libDir` is passed to `initOracleClient` as is, so Thick mode with a directory works on macOS and Linux (the `ORACLE_INSTANT_CLIENT` check looks for Windows DLLs). Once the driver is up, only a compatible setting is accepted. `fromEnv()` reads `MIRA_DRIVER_MODE` / `MIRA_DRIVER_LIB_DIR`.
- **`initDriver()`** initialises the driver now and returns `{ mode, clientVersion }`; call it at startup to fail fast.
- **Logger (step 2):** `createMira({ logger })` and `setLogger(logger)` send Mira's log lines to any object with `info` / `warn` / `error` (optional `debug`); `false` silences them. Mira's own logger now loads on the first line it writes, so an app with its own logger gets no `./logs` folder from Mira.

### Changed

- **Importing Mira initialises nothing.** `ORA_SDTZ`, `oracledb.fetchTypeHandler`, `oracledb.fetchArraySize` and `initOracleClient` now run once, when the first pool opens (or at `initDriver()`), instead of at import. Pools and queries behave as before. Code that read `oracledb.oracleClientVersion` or `ORA_SDTZ` before any pool opened now sees them unset; call `initDriver()` first.

### Fixed

- `getConnectionConfig` looks up own keys only: `"constructor"` or `"toString"` no longer resolve to `Object`'s members.

### Tests

- New `test/unit/miraConfig.test.ts`, `test/unit/log.test.ts` and `test/integration/createMira.test.ts`; driver-mode cases in `test/unit/adapter.test.ts`. `test/node/smoke.cjs` also runs `createMira()` from the built package under Node and checks that importing it leaves `ORA_SDTZ` alone.
- `test/unit/adapter.test.ts` restored `runtimePaths` from the namespace `mock.module` had rewritten, so every adapter loaded after the compiled-exe tests still thought it was compiled. It now restores from a snapshot.

## [2.1.0] — 2026-11-26

Theme: Oracle-first, MongoDB-shaped, typed. Everything adds to 2.0; nothing breaks. Built step by step on `feature/2.1.0` (see `docs/ROADMAP-2.1.md`).

### Added — statistics (roadmap step 1)

- **`$group` accumulators.** Each takes a column, an expression, or `{ input, … }`.
  - `$countDistinct` → `COUNT(DISTINCT …)`
  - `$median` → `MEDIAN`
  - `$stdDevPop` / `$stdDevSamp` → `STDDEV_POP` / `STDDEV_SAMP`
  - `$percentile: { input, p, method }` → `PERCENTILE_CONT` (default) or `PERCENTILE_DISC`. `p` is a number from 0 to 1 or a list of them; a list returns a JS array.
  - `$push` / `$addToSet` → `JSON_ARRAYAGG(… NULL ON NULL RETURNING CLOB)`, returned by `aggregate()` as JS arrays, with an optional `orderBy`. `$push` keeps NULLs; `$addToSet` keeps each value once.
  - `$listAgg: { input, separator, distinct, orderBy }` → `LISTAGG(…) WITHIN GROUP (…)`, one string. The separator is bound.
- **Window options** in `$window`:
  - `default` for LAG / LEAD.
  - `ignoreNulls` for LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE.
  - `RATIO_TO_REPORT`.
- **NULLS FIRST / LAST** wherever a sort is given: `{ col: { order: 1 | -1, nulls: "first" | "last" } }` in `sort()`, `$sort`, a window's `orderBy`, an accumulator's `orderBy`, set operations, `withCTE`, `withRecursiveCTE` and `connectBy`'s `orderSiblings`. `1` / `-1` still work as before.
- **`FETCH … WITH TIES`:** `limit(n, { withTies: true })` on a sorted `find()`, and `{ $limit: { n, withTies: true } }` directly after a `$sort`. Without a sort Mira throws: Oracle would silently return exactly n rows.
- `buildAggregateSQL` also returns `arrays` (the output columns holding a JSON array) when there are any; `buildWindowExpr` takes an optional bind function, used for a non-number `default`.

### Changed

- A pipeline `$limit` must be a non-negative integer (or `{ n, withTies }`); anything else throws instead of reaching Oracle as `FETCH FIRST NaN ROWS`.

### Tests and simulation

- New `test/unit/statistics.test.ts` (SQL shape and argument checks) and `test/integration/statistics.test.ts`. The live tests compute every expected value from the fixture, including Oracle's percentile interpolation.
- The `unknown expression operator` test used `$stdDevPop` as its example of an unknown operator; it now uses `$kurtosis`.
- The simulation's reports stage adds the branch KPIs: distinct customers, median, standard deviation, P10/P90 and discrete P90 of the ticket, receipts (`$push`), quarters traded (`$addToSet`, `$listAgg`), each branch's revenue share (`RATIO_TO_REPORT`) with the previous branch's revenue (`LAG` default 0), the next customer with a known city (`LEAD` IGNORE NULLS), customers by city with NULLs first, and ties at the top (`WITH TIES` in `find()` and in a pipeline). 55 queries through Mira, 0 gaps.

### Added — usable from Node, and CI on a live Oracle (roadmap step 1)

- **npm package `@jm-paunlagui/mira`.**
  - `bun run build` compiles `src/` to CommonJS JavaScript with `.d.ts` types (and source maps) in `dist/`.
  - `package.json` gets `main`, `types`, an `exports` map and a `files` list. `npm pack` / `prepack` rebuild first.
  - Runs on Node.js 20+ as well as Bun 1.4+.
- **`@types/oracledb` is now a runtime dependency.** The public types refer to `oracledb`'s types, so a consumer without it failed to type-check (TS7016).
- **CI (`.github/workflows/ci.yml`).** Runs on every push and pull request.
  - A build job: type-check, build, and `npm pack --dry-run`.
  - A live job against Oracle Database Free 23ai (`gvenzl/oracle-free:23-slim-faststart`), run once in **Thin** and once in **Thick** mode: full suite with coverage, the simulation, and a Node smoke test of the built package.
  - The job creates the `MIRA` and `MIRA_SIM` schemas with `.github/oracle/setup-users.sql`. It lets the listener accept `FREEPDB1` as a SID, because Mira connects with `(SID=…)`.
- `test/node/smoke.cjs`: loads the package by name under plain Node, then does a live round trip that checks money, CLOB and aggregate values.
- README: install from npm, and how `.env` is loaded under Node (`node --env-file=.env`; Bun reads it by itself).

### Tests fixed on the CI database

Two tests failed only on the CI database:
- **`unit/adapter` "existing keys win"** expected `APP_DB_USERNAME` to be `mira`, the value in one developer's `.env`. It now sets its own value.
- **`appDbInUse()`**, used by the leak checks, could catch the pool health monitor's 30-second `ping()` in flight and report 1 connection checked out (2 runs in 3 on the CI image). It now re-reads the count for up to 2 s and returns the lowest value seen, so a real leak, which never returns to 0, still fails the test.

### Found by CI: Thick mode can hang when there are too few worker threads

- **The hang:** on the 4-core GitHub runner, the Thick-mode job hung in "concurrent transfers keep the ledger balanced". That test runs 8 transactions that wait on each other's row locks.
- **The cause:** in Thick mode each database call runs on a native worker thread (`UV_THREADPOOL_SIZE`), and a call waiting on a lock keeps its thread. With too few threads, the transaction holding the lock never gets one to commit. The database is fine, and Thin mode is unaffected.
- **Reproduced locally:** `UV_THREADPOOL_SIZE=2` hangs and `16` passes.
- **What changed:**
  - CI sets `UV_THREADPOOL_SIZE=32`.
  - The README warns Thick-mode users to set it to at least their largest `poolMax` before the process starts.
  - When Thick mode creates a pool whose `poolMax` is above `UV_THREADPOOL_SIZE` (Node's default 4 when it is not set), Mira logs a warning naming the pool, both numbers and the setting to use.

### Fixed — Thick mode moved `TIMESTAMP WITH (LOCAL) TIME ZONE` values by the client's UTC offset

- **The defect:** Thin mode opens every session at UTC, but Thick mode opened it in the operating system's zone. A JS `Date` written to a `TIMESTAMP WITH TIME ZONE` or `TIMESTAMP WITH LOCAL TIME ZONE` column was stored that zone's offset off: −8 h on a UTC+8 machine, through `insertOne`, `insertMany` and raw SQL alike. Filters compared consistently, so reads in Mira looked right. `TIMESTAMP` and `DATE` columns were not affected.
- **Why it went unseen:** `bun test` runs with `TZ=UTC`, but on Windows the Oracle client takes its zone from the system, not from `TZ`.
- **The fix:** the adapter sets `ORA_SDTZ=+00:00` before the Oracle client loads, unless `ORA_SDTZ` is already set. Thick mode now behaves as Thin mode does.
  - It uses a numeric offset because the region name `UTC` makes a 19.x client on a 23ai server fail with `ORA-01805` (time-zone file mismatch).
- **Behaviour change (Thick mode only):** `SESSIONTIMEZONE`, `CURRENT_TIMESTAMP`, `LOCALTIMESTAMP` and `CURRENT_DATE` in your own SQL are now UTC, as they already were in Thin mode. `SYSTIMESTAMP` and `SYSDATE` are unchanged, and so is `$now`, which uses database time. To keep another zone, set `ORA_SDTZ` yourself.
- **Tests:**
  - `test/integration/timeZones.test.ts`: every date column type keeps a Date's instant, written by `insertOne`, `insertMany` or raw SQL, and the session zone is `+00:00`. Before the fix these failed in Thick mode, with `TZ=UTC` and with `TZ=Asia/Manila`.
  - Adapter unit tests: `ORA_SDTZ` is set when missing or blank and kept when given; the thread-pool warning is checked with no setting, a small setting, a large enough setting, an invalid setting, and in Thin mode.

### Added — typed tables (roadmap step 2)

- **`defineTable(name, columns)` with column builders `t.*`.** A definition needs no database: `Table.on(db)` or `Table.on(session)` binds it.
  - Builders: `t.id()`, `t.number(p?, s?)`, `t.money()`, `t.decimal(p, s)`, `t.text(n, "char"?)`, `t.char(n)`, `t.clob()`, `t.blob()`, `t.date()`, `t.timestamp(p?)`, `t.timestampTz(p?)`, `t.raw<T>(type)`.
  - Modifiers: `.nullable()`, `.default()`, `.primaryKey()`, `.check()`, `.references()`, `.identity()`, `.identityByDefault()`.
  - Each column's type matches what Mira returns: scaled NUMBER is a `string`, CLOB a `string`, BLOB a `Buffer`, dates a `Date`, and nullable columns add `null`.
- **Type checking.** Filters (known columns, value types, operators by column type), inserts (identity columns refused; nullable, defaulted and BY DEFAULT identity columns optional), `$set` / `$inc` / `$currentDate` updates, sorts, and projections (the result type narrows) are all checked. `typeof Table.$row` and `typeof Table.$insert` name the types.
- **Compile-time only.** `on()` returns the plain `OracleCollection`, so behaviour is unchanged. New `.untyped` getters on `OracleCollection` and `QueryBuilder` return the object itself with the 2.0 signatures.
- `Table.ddl()` returns the `createTable()` column spec; `Table.create(db)` runs it. `defineTable` refuses a second identity column, because Oracle allows one (ORA-30669).
- **`mira generate types`** (package `bin`) and **`generateTableTypes(db, { tables, importFrom })`**: read `USER_TAB_COLUMNS`, identity columns, primary keys and single-column foreign keys, and write one `defineTable()` and one `…Row` type per table.
  - `--tables` takes exact names or `%` patterns; `--out`, `--import`, `--env` and `--verbose` are also available.
  - Log lines stay off stdout unless `--verbose`.
- Exported types: `RowOf`, `InsertOf`, `Filter`, `Update`, `Sort`, `Projection`, `Projected`, `TypedCollection`, `TypedQuery`, `TableTarget`, `Column`, `ColumnMeta`, `GenerateOptions`.

### Fixed — insertMany (found while testing typed tables)

- **Columns only later documents had were silently dropped.** `insertMany` took its column list from the first document, so with `[{ A }, { A, B }]` every `B` was lost with no error.
  - Documents are now split into consecutive runs with the same column set, with one `executeMany` per run in the same transaction.
  - Rows are still inserted in the caller's order (identity values follow it), and an omitted column keeps its DEFAULT.
  - `insertedIds`, `returning` and `batchErrors` offsets refer to the caller's positions.
- **A `Buffer` value failed with `NJS-011`.** Buffers are now bound as binary, and as a BLOB past 32 KB. Text past 32 KB is bound as a CLOB.

### Tests and simulation (typed tables)

- `test/types/typedTables.types.ts`, checked by `bun run typecheck`: exact inferred row and insert types, plus 16 misuses that must not compile (`@ts-expect-error`).
- `test/unit/typedTables.test.ts`: builders, `ddl()`, validation, `on()`, and the generator against a stub catalogue covering every Oracle type branch.
- `test/integration/typedTables.test.ts`: typed CRUD on a live table, `on(session)` rollback, the foreign key from `references()`, and the CLI.
  - Also a round trip: definition → `create()` → catalogue → generated code → imported → the same `ddl()`.
- `test/integration/defects.test.ts`: the two `insertMany` defects, batch-error offsets across groups, and CLOB text past 32 KB.
- Simulation, reports stage:
  - generates definitions for `SIM_CUSTOMERS` / `SIM_ORDERS` and checks them against 01-schema,
  - queries `SIM_ORDERS` through a hand-written typed definition,
  - creates `SIM_LOYALTY` from a definition and fills it in one transaction with documents of two shapes.
  - Result: 58 queries, 0 gaps, 124 of 124 public functions.

### Added — migrations (roadmap step 2)

- **`mira migrate new <name> | status | up | down`** and **`createMigrator(db, { dir | migrations, table })`** → `{ up, down, status, list }`.
  - Migration files (`.ts`, `.js`, `.cjs`, `.mjs`; named or default exports of `up` / `down`) run in name order. `migrate new` names them `<UTC timestamp>_<name>.ts`.
  - `up({ to })` applies up to a named migration. `down({ steps })` (default 1) rolls back the newest; `down({ to })` rolls back everything after a migration; `down({ to: null })` / `--all` rolls back all of them.
  - The context offers `schema`, `collection(name)`, `createTable(definition)` (typed tables), `execute(sql, binds)`, `db` and `dryRun`.
- **History.** `MIRA_MIGRATIONS` stores name, SHA-256 checksum, batch, applied-at time and duration. A **changed** or **missing** applied migration shows in `status` (the CLI exits 1), and `up` refuses to run.
- **Lock.** A row lock (`SELECT … FOR UPDATE NOWAIT`) on `MIRA_MIGRATIONS_LOCK` is held on a connection of its own for the whole run, so a concurrent run fails at once. No `DBMS_LOCK` grant is needed, and Oracle releases the lock if the process dies.
- **Dry run.** Each migration runs against a recording connection; the SQL is returned (and printed by `--dry-run`), and nothing is applied or recorded.
- **Failures.** Oracle DDL is not transactional, so a failed migration is not recorded. Its error names it and says the statements before the failure stay applied.
  - Migrator errors pass through `withConnection` unwrapped (`isOperational`), so `err.migration` and the message are kept.
- Exported types: `Migration`, `MigrationContext`, `MigratorOptions`, `MigrationStatus`, `MigrationState`, `MigrationRun`, `Migrator`.

### Tests and simulation (migrations)

- `test/integration/migrations.test.ts` (14 tests, live):
  - order and batches, `to` / `steps` / `all`, a pending migration that sorts before applied ones, changed and missing migrations
  - argument checks, no `down()`, a failing migration, dry runs with their exact SQL
  - **two runs racing for the lock**
  - files on disk (`.ts` with typed tables, `.js`, `.mjs` default export, `.d.ts` skipped, checksum of the file)
  - the whole `mira migrate` command line
- `test/unit/migrations.test.ts`: errors other than "already exists" / "lock busy", a dry run never touching the real connection, and the new-file helpers.
- Simulation, schema stage: a supplier table, its seed and a view arrive as three migrations. The stage checks `list`, a dry run, `up`, a repeat `up`, `down`, `status` by batch, a second `up`, and a refused `up` after a migration's code changed. Result: 307 checks, 129 of 129 public functions.

### Added — relations and include (roadmap step 3)

- **`relations(table, { name: hasMany(…) | hasOne(…) | belongsTo(…) })`** attaches relations to a typed table. They are declared apart from the tables, so two tables can point at each other and generated table files stay as they are.
  - `hasMany(Target, { foreignKey, localKey? })` and `hasOne(...)`: `Target.foreignKey = this.localKey`, by default this table's primary key.
  - `belongsTo(Target, { foreignKey, references? })`: `this.foreignKey = Target.references`, by default the target's primary key.
  - Names, columns and keys are checked when relations are declared.
- **`find().include(name, { where, sort, limit })`** fetches related rows in the **same statement**. Each relation is a correlated subquery in the SELECT list.
  - `hasMany` uses `JSON_ARRAYAGG(JSON_OBJECT …)` and gives an array, `[]` when there are none. `limit` keeps the first n rows per parent row, numbered with `ROW_NUMBER` (not `FETCH FIRST`; see 2.0.1's LATERAL row-limit bug).
  - `hasOne` / `belongsTo` use `JSON_OBJECT` and give an object or `null`.
  - It works with filters, `sort`, `skip`, `limit`, `project`, `forEach`, `next`, `await` and sessions.
- **Related rows keep Mira's types.** Scaled NUMBER columns are written with `TO_CHAR`, the same exact text as a top-level money column. DATE / TIMESTAMP columns become `Date`, CLOB text stays text, and BLOB / RAW columns are left out because JSON has no binary type.
- **Typed.** `include()` adds `orders: Order[]` or `customer: Customer | null` to the row type. The `where` and `sort` options are checked against the related table, and `limit` is accepted only for `hasMany`. A relation can't be projected as a column, and a table without relations has nothing to include.
- Exported: `relations`, `hasMany`, `hasOne`, `belongsTo`; types `Relation`, `NestedRow`, `IncludeOptions`, `IncludeOptionsOf`. `TypedQuery` gains its relation parameters, and existing `TypedQuery<R>` uses still compile.

### Fixed — insertMany with a column given as a number and as a numeric string

- A typed money column accepts `string | number`. `insertMany` chose one bind type per column from the first value, so `[{ AMT: "10.5" }, { AMT: 99 }]` failed with `NJS-011`.
- A column that mixes the two is now bound as text, with numbers sent as their decimal text, which Oracle converts exactly, as it does for a money string in `insertOne`. Proven first by a `DEFECT:` test.

### Tests and simulation (relations)

- `test/integration/relations.test.ts` (11 tests, live):
  - one statement per query
  - nested values equal to a direct read (money, decimals, dates, TIMESTAMP WITH TIME ZONE, a 6,000-character CLOB, BLOB left out)
  - per-parent `where` / `sort` / `limit`, `hasOne`, `belongsTo` with a projection, several includes with filters, `next` / `forEach` / `await`, a rolled-back session
  - every error, and the checks made when relations are declared
- `test/types/relations.types.ts`: exact nested types, plus 8 misuses that must not compile.
- Simulation, reports stage, each checked against the model:
  - each VIP's three biggest tickets (`hasMany` with `where` / `sort` / `limit`)
  - the customer behind every ticket of 300.00 or more (`belongsTo`)
  - each customer's first receipt (`hasOne`)
  - Result: 310 checks, 61 queries, 134 of 134 public functions.

### Added — JSON columns (roadmap step 3)

- **`t.json<T>()`** declares a JSON document column. It is a CLOB with an `IS JSON` check (Oracle 19c+), added by `ddl()` / `create()`. **`t.json<T>({ native: true })`** uses the 23ai JSON type.
- **A typed table reads and writes JSON columns as `T`:** in `insertOne`, `insertMany`, `replaceOne`, whole-column `$set`, `find`, `findOne`, `next`, `forEach`, `await`, and in `include()`, where a related row's JSON column is embedded as a document.
- **Paths in filters:** `"COL.a.b"` and `"COL.items.0.sku"`.
  - Operators: `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$between` `$exists` and `null`, via `JSON_VALUE(… RETURNING NUMBER | TIMESTAMP WITH TIME ZONE | VARCHAR2)` chosen from the value's type, and `JSON_EXISTS`.
  - **`$elemMatch`**, on element fields or on plain values, becomes `JSON_EXISTS(… '$.items[*]?(…)' PASSING …)` with every value bound.
- **Paths in updates:**
  - `$set` / `$unset` on paths become one `JSON_MERGEPATCH` per column.
  - **`$push`** (a value, or `$each`) and **`$pull`** (a value, or `$in`) rebuild the array with `JSON_TABLE` + `JSON_ARRAYAGG`. They also work on a column that holds an array.
  - Refused with a clear error: `$set` of null on a path (merge patch would delete the key; use `$unset`), paths through an array index, two updates of one path, overlapping paths, and a column set both whole and by path.
- **`$jsonTable`** pipeline stage: one row per array element, with typed columns (`NUMBER`, `VARCHAR2`, `DATE`, `TIMESTAMP`, `CLOB`, `JSON`; checked), `"$"` for the element itself, `ordinality`, and `outer`.
- **`mira generate types`** writes `t.json()` for a CLOB with `IS JSON` (from `USER_JSON_COLUMNS`), and `t.json({ native: true })` for the JSON type.
- **Typed:**
  - dotted paths must start with a known column
  - `$elemMatch` is only accepted on JSON columns
  - `$push` / `$pull` are typed
  - `t.json()` with no type argument is `unknown`, never `any` (`NoInfer`)
- **Same SQL on 19c and 23ai.** Only functions 19c has are used (no `JSON_TRANSFORM`). Path updates merge into `JSON_SERIALIZE(col RETURNING CLOB)`: merging into the 23ai JSON type directly made 23.26 store binary OSON version 2, which node-oracledb 7 can't read (`NJS-126`).

### Behaviour notes (JSON)

- **The untyped API is unchanged:** a JSON column is returned as its stored text, as in 2.0. Only typed tables decode it.
- **A filter key with a dot is now a JSON path.** Before, it was quoted as one column name; no Mira code used that.
- **The native JSON type needs Thin mode or Oracle Client 21c+.** With the 19.6 client against 23ai, reading it fails with `ORA-40569` and a write broke the session (`ORA-03106`). `Table.on(db)` refuses a native column on a 19.x Thick client with a clear message.
- **The native JSON type needs Oracle Database 21c+.** On 19c, `createTable()` (and so `create()` and migrations) refuses a `JSON` column with a clear message instead of `ORA-00902`.

### Found on Oracle 19c (JSON)

CI runs Oracle 23ai, so these were found by running the suite on the 19c container. Each was shown failing on 19c first.

- **`$push` / `$pull` lost every scalar element.** 19c's `JSON_TABLE` returns NULL for a scalar in a `FORMAT JSON` column (23ai returns it), and `JSON_ARRAYAGG` dropped the NULLs: `["a", {"z":1}]` plus `"c"` became `[{"z":1}]`. Elements are now read `WITH WRAPPER` and unwrapped.
- **`$elemMatch` with `$nin` or `$exists: false` matched nothing.** 19c never treats a negated path-filter condition (`!(…)`, `!exists(…)`) as true. A negation is now `NOT JSON_EXISTS` on each element (`EXISTS` over `JSON_TABLE`); `TO_CLOB` on the element stops 19c rewriting it into `ORA-31013`. `$elemMatch` without a negation keeps the single `JSON_EXISTS`.
- **`t.json({ native: true })` on 19c** failed with `ORA-00902`; it is now refused up front (above).

### Tests and simulation (JSON)

- `test/integration/jsonColumns.test.ts` (18 tests, Thick and Thin):
  - the `IS JSON` check; typed reads in every path; the untyped API returning text; `include()`
  - every path operator, `$elemMatch` form and update form, and each refusal
  - `$jsonTable` (inner, outer, ordinality, `"$"`, JSON / VARCHAR2 columns, with `$group`)
  - the generator round trip
  - native JSON: works in Thin; refused up front on a 19.x Thick client
- `test/types/jsonColumns.types.ts`: exact row and insert types, plus 4 misuses that must not compile.
- `test/unit/typedTables.test.ts`: the generator maps CLOB + `IS JSON` and the JSON type.
- Simulation, reports stage: the loyalty table gets a `PREFS` document per VIP. The stage checks a path filter, `$elemMatch`, `$push` + `$set` on paths for every VIP, `$pull`, and `$jsonTable` + `$group` of the resulting drinks menu, all against the model. Result: 313 checks, 66 queries, 134 of 134 public functions.

### Added — timestamps, soft delete, hooks and validation (roadmap step 4)

- **`t.createdAt()` / `t.updatedAt()`:** `TIMESTAMP(6) WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL`. Oracle stamps both on insert; every update through the table's collection sets the `updatedAt` column (`$currentDate`), unless the update sets it itself. A zoned type, so the value is an exact instant whatever the server's time zone.
- **`t.deletedAt()`: soft delete.**
  - `deleteOne` / `deleteMany` / `findOneAndDelete` mark rows instead of deleting them.
  - Reads (`find`, `findOne`, `countDocuments`, `distinct`, `aggregate`), updates and deletes skip marked rows, and so does `include()` of a soft-deleting related table.
  - `withDeleted()` sees marked rows; `restore(filter)` clears the mark; `{ force: true }` deletes for real.
  - Typed: `withDeleted()` and `restore()` exist only on a table with a `t.deletedAt()` column.
- **Hooks:** `defineTable(name, columns, { hooks })` with `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. A before-hook may return a changed document or update, or throw to stop the write. The hook context works like a session (`Table.on(ctx)`), so a hook's own writes join the transaction.
- **Validation:** `{ validate: true }` checks inserts and updates against the columns before any SQL: unknown, generated, required and not-nullable columns; number, money, text, date and binary values; the size of numbers and of `VARCHAR2` / `CHAR` text (UTF-8 bytes or characters). Every problem is listed in one `MiraValidationError` (`issues: { column, message }[]`).
- `replaceOne` / `findOneAndReplace` on such a table become a `$set` of every given column except the primary key, so the above apply.
- New exports: `MiraValidationError`, `ModelCollection`, and the types `TableOptions`, `TableHooks`, `HookContext`, `SoftDeleteMethods`, `CollectionOf`, `ValidationIssue`.

### Behaviour notes (model tables)

- `on()` returns a `ModelCollection` (a subclass of `OracleCollection`) only for a table that uses one of these features; every other typed table keeps the plain collection.
- `merge`, `mergeFrom`, `bulkUpdateByKeys`, `updateFromJoin`, `insertFromQuery`, `connectBy`, `pivot` and raw SQL are 2.0's and do none of this.

### Fixed — bulkWrite lost a typed table's settings

- Outside a transaction, `bulkWrite` ran its operations on a new plain `OracleCollection`, so a typed table's JSON columns were not encoded there. It now runs them on the same kind of collection (`_onConnection`), which keeps JSON columns, relations and model behaviour.

### Tests and simulation (model tables)

- `test/integration/model.test.ts` (19 tests): timestamps; soft delete through every wrapped method, `withDeleted()`, `restore()`, `{ force: true }`, upsert, `include()`; every hook, a hook that throws, hooks inside a rolled-back transaction, `bulkWrite`; validation before any SQL and hooks filling a column.
- `test/unit/validate.test.ts` (7 tests): every column kind, size rule and update operator.
- `test/types/model.types.ts`: row and insert types, typed hooks, `withDeleted()` / `restore()` only on soft-deleting tables, and misuses that must not compile.
- Simulation, new stage 15 "members": a loyalty-member register on a model table. Sign-ups through hooks, validation refusing a bad web-form row, points and tier changes, soft removal, a protected founding member, a mistaken removal restored, an erasure with `{ force: true }`, the audit trail the hooks wrote, and a rolled-back sign-up. Result: 333 checks, 86 queries, 151 of 151 public functions.

### Added — optimistic locking (roadmap step 4)

- **`t.version()`:** `NUMBER(10) DEFAULT 1 NOT NULL`, raised by 1 on every update through the table's collection (unless the update sets it; a replacement never does).
- **`MiraConcurrencyError`:** `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace`, `deleteOne` and `findOneAndDelete` whose filter pins the version (`{ ID: 1, VERSION: 3 }`) and match nothing while the row is still there now throw, instead of silently returning 0. `expectedVersion` and `currentVersion` say what happened. A gone row still returns 0; `updateMany` / `deleteMany` are not checked; `upsert` with a pinned version is refused.

### Fixed — Mira's own errors lost their class inside a transaction

- The adapter wraps every error thrown inside `withTransaction` as a generic `DB op failed` error, unless it is `isOperational`. `MiraValidationError` (422) and `MiraConcurrencyError` (409) are now operational, so `instanceof` works inside transactions and they aren't logged as critical database failures. Found by the optimistic-locking transaction test.

### Tests and simulation (optimistic locking)

- `test/integration/optimisticLocking.test.ts` (9 tests):
  - the version bump; two editors where the second is refused, then re-reads and succeeds
  - no conflict for a gone row, a version-only filter, `updateMany` or a non-pinned version
  - every checked method, soft and forced deletes, refused upserts
  - inside a transaction; both error classes surviving `withTransaction`
- `test/types/model.types.ts`: `t.version()` read and insert types.
- Simulation, stage 15: two desk clerks edit the same member. The stale save is refused, then re-read and applied on top. Result: 337 checks, 151 of 151 public functions.

### Added — keyset paging, streaming, raw SQL and query events (roadmap step 4)

- **`find().sort(…).after(cursor)`:** keyset pagination. It continues after the previous page's last row in the sort order, with one bound comparison per sort key (`(a < :a) OR (a = :a AND b > :b)`, direction by key). It refuses: no sort, a null or missing key, a cursor that is not an object. Typed: the cursor takes the row's types.
- **`for await (const row of find())`:** a query is an async iterable. Rows are streamed on one held connection, released when the loop ends, breaks or throws. Inside a transaction the session's connection is used. Typed rows.
- **``sql`…` ``:** raw SQL whose interpolated values are always binds.
  - Arrays become bind lists. `sql.ident()` splices checked, quoted identifiers.
  - Nested fragments are rendered from their parts (never re-parsed). `undefined`, functions, symbols, plain objects and empty arrays are refused.
  - `.rows(target)` and `.execute(target)` run on the db handle, a session or a hook context.
- **`onQuery(listener)`:** an event after every `execute` / `executeMany` (SQL, bind count, batch size, duration, rows, error; never bind values). It uses node-oracledb's trace handler, chains to one already installed (e.g. OpenTelemetry) and restores it on unsubscribe. A throwing listener is ignored.
- New exports: `sql`, `SqlStatement`, `onQuery`, and the types `SqlTarget`, `QueryEvent`, `QueryListener`.

### Tests and simulation (query tools)

- `test/integration/queryTools.test.ts` (15 tests):
  - full keyset paging equal to the sorted table; mixed directions and the `{ order }` form; refusals
  - streaming with JSON decoding and exclusion projection; `break` / `throw` / query errors / a failing pool releasing the connection; reading inside a transaction
  - `sql` binds of every kind, fragments with a `':p0'` literal, DML commit and rollback, refusals
  - query events for find / insertMany / delete / errors; listeners that throw; chaining to a stand-in OpenTelemetry handler, a disabled one, and one replaced meanwhile
- `test/types/queryTools.types.ts`: typed cursors, typed rows in `for await`, `sql` and `onQuery` types.
- Simulation, new stage 16 "exports":
  - the sales export keyset-paged in pages of 7, every sale once, biggest first
  - a streamed pass over every sale, and an early stop at the first big ticket
  - a store report in raw SQL with an `IN` list
  - `onQuery` counting the export's statements without leaking bind values
  - all checked against the model. Result: 345 checks, 96 queries, 154 of 154 public functions.

## [2.0.1] — 2026-11-25

Patch release: Mira now behaves the same in node-oracledb Thin and Thick mode. 2.0.0 was only tested in Thin mode. On a machine with an Oracle Client on the system PATH, the adapter loads Thick mode even when `ORACLE_INSTANT_CLIENT` is blank, and two things broke.

### Behaviour change

- **LOB columns come back as plain values.** CLOB and NCLOB return a `string`, and BLOB returns a `Buffer`, in both modes. In 2.0.0 they came back as driver `Lob` objects tied to a connection the wrapper had already released. In Thin mode `lob.getData()` still happened to work. In Thick mode it failed with `NJS-003: invalid or closed connection`. **Migration:** replace `await row.COL.getData()` with `row.COL`.

### Fixed

- **`performance.explainPlan(queryBuilder)` in Thick mode.** It failed with `ORA-01036: illegal variable name/number` because Thick mode refuses bind values on `EXPLAIN PLAN`. Thin mode requires them (`NJS-098`), so the bind values are now passed in Thin mode only. `EXPLAIN PLAN` never evaluates them either way.
- **`$lateralJoin` with a `limit` returned too few rows.** Oracle mis-handles a row limit (`FETCH FIRST` or `ROWNUM`) inside a LATERAL / APPLY subquery once it decorrelates it. On 23.26 one active user kept a match out of six. The subquery now picks its page by ROWID (`t0.ROWID IN (… FETCH FIRST n ROWS ONLY)`), which Oracle evaluates correctly. Plain queries are unchanged.
- **Wrapper error messages:** `COLLECTION_INVALID_TABLE_NAME`, `INVALID_ROW_COUNT` and `WINDOW_INVALID_ARGUMENT` show the refused value (cut to 40 characters), not only its type.

### Docs

- README: a blank `ORACLE_INSTANT_CLIENT` does not guarantee Thin mode. The startup log says which mode loaded.

### Tests

- Chaos: the `FOR UPDATE WAIT n` timeout test accepts `ORA-30006` (19c) and `ORA-00054` (23ai).
- Reliability: the CLOB round-trip expects a string, and a new 70,000-byte BLOB round-trip expects a `Buffer`.
- Unit: the fetch handler's CLOB, NCLOB and BLOB mappings.
- Integration: `$lateralJoin` with `sort` + `limit` keeps every outer row and picks each one's top row.
- Chaos: the queueTimeout test asserts the bound itself. Every NJS-040 lands near `queueTimeout`, never about 3× later. It no longer asserts an exact count, which depended on how many pooled connections were ready at that instant.
- Simulation:
  - A blank `MIRA_SIM_GRANTEE=` falls back to `APP_DB_USERNAME`. Before, the grant ran with grantee `""` (`ORA-01741`), so `OracleDCL.revoke` was never reached.
  - The hostile-identifier checks accept 23ai's `ORA-25716` (quote inside an identifier).
- Checked in Thick (Oracle Client 19.6) and Thin mode against Oracle 23ai Free (23.26.3):
  - Test suite: 365 of 365 pass, 100% coverage.
  - Simulation: 287 of 287 checks, 119 of 119 public functions.

## [2.0.0] — 2026-11-24

Major release: TypeScript on Bun, and a far more capable wrapper. Full notes: GitHub release `v2.0.0`.

### Breaking

- **Runtime:** TypeScript on Bun ≥ 1.4 (`.ts` sources, `bun.lock`, `main` → `src/utils/oracle-mongo-wrapper/index.ts`). Tests run on `bun test`; mocha and chai are removed.
- **Driver:** oracledb 7.0.1. Thick mode needs Oracle Client 19c or later.
- **Connections:** the `userAccount` / `unitInventory` registry is replaced by `appDb` / `appDbBulk` on `APP_DB_*` credentials. There is an optional test-database switch (`NODE_ENV=development` + `APP_TEST_DB_USERNAME`).
- **Behaviour fixes that change results:**
  - `$eq` / `$ne` with null → `IS [NOT] NULL`.
  - `$now` → database wall-clock time (`withTimeZone: true` for TIMESTAMP WITH TIME ZONE columns).
  - `findOneAndUpdate` / `findOneAndReplace` change one row.
  - `bulkWrite` joins a session's transaction.
  - `skip locked` + `limit` locks while fetching.
  - Locking reads never auto-commit.
  - Filter `$case` / `$coalesce` / `$nullif` compare the field.
  - Views from filtered queries inline their literals.
  - Unknown stages, operators and join types throw.
  - Window, PIVOT, subquery and set-operation options are allow-listed or integer-only.
  - `$merge` needs `fields`.
  - `isHealthy()` is false after `closePool()`.

### Added

- **Expression engine:**
  - nesting everywhere; aggregates over expressions
  - `$abs` `$ceil` `$floor` `$round` `$trunc` `$mod` `$literal`
  - GREATEST / LEAST
  - `$switch`
  - `$dateDiff` `$dateAdd` `$dateTrunc` `$lastDayOfMonth` `$year` `$month` `$dayOfMonth`
  - column-to-column conditions with `$and` / `$or` / `$not`
  - `grouping: true` subtotal flags
- **`$matchRecognize` stage**, with `$prev` / `$next`.
- **`connectBy` columns:** `root`, `includeIsLeaf`, `includeIsCycle`, `pathColumn`.
- **Joins and trees in the pipeline:**
  - `$lookup` with a `pipeline`
  - `$lateralJoin` with `outer: true`
  - a `$connectBy` stage
  - nested pipelines hoisted into the outer WITH
- **Recursion and generators:**
  - `withRecursiveCTE` `set` / `while` / `.aggregate()`
  - `series()` row generator
- **Collections and transactions:**
  - `insertMany` `returning` / `batchErrors`
  - `bulkUpdateByKeys`
  - `session.execute()`
  - `$in` over 1,000 values as one collection bind
  - `forUpdate` `{ of, wait, nowait, skipLocked }`
  - precise `$currentDate` timestamps

### Fixed

- **43 defects, each proven by a failing test first.** About ten of them returned wrong data with no error:
  - time zone (`$now`)
  - null comparisons
  - bind-name clashes
  - multi-row find-and-modify
  - `bulkWrite` and the session
  - SKIP LOCKED queues
  - lateral cross join
  - async `forEach`
  - silently skipped stages
  - lost money digits
- The full list is in the GitHub release `v2.0.0`.

### Security

- Window, frame, PIVOT, subquery and set-operation options are no longer spliced into SQL.
- Bind names are cleaned.
- `$in` lists are linear-time (DoS).

### Tests

- **363 / 363** (unit, integration, performance, chaos, security, reliability), 100% lines and functions, on a live Oracle 19c.
- **`bun run sim`:** 287 / 287 checks, 119 / 119 public functions, 50 / 50 business queries through Mira.

## [1.0.5] — 2026-04-05

### Security

- **utils.js** — `quoteIdentifier()` now escapes embedded double-quote characters (`"` → `""`) before wrapping, preventing identifier injection (CWE-116). Previously, a malicious identifier containing `"` could break out of the quoted context.
- **filterParser.js** — `$gtAny`/`$ltAny`/`$gteAny`/`$lteAny` and `$gtAll`/`$ltAll`/`$gteAll`/`$lteAll` operator parsing now uses regex with the global flag (`/Any/g`, `/All/g`, `/\$/g`) instead of `String.replace()` which only replaces the first occurrence (CWE-20, CWE-116).

### Bug Fixes

- **oracle.js** — Removed useless `committed` flag and redundant `if (!committed)` guard in `withTransaction()`. If execution reaches the `catch` block, `conn.commit()` never succeeded, so `rollback()` is always needed.
- **test.js** — Fixed useless type test: `"plain object" === typeof doc ? "object" : "object"` (both branches identical, `typeof` never returns `"plain object"`) replaced with `expect(doc).to.be.an("object")`.
- **test.js** — Removed unused first `scn` assignment in AS OF SCN test (value was always overwritten after the wait).

### Code Quality

- Removed 7 unused variables flagged by CodeQL static analysis:
    - `parseFilter` import in **subqueryBuilder.js**
    - `rowToDoc` import in **OracleCollection.js** and **QueryBuilder.js**
    - `joinType` variable in **OracleCollection.js** `updateFromJoin()`
    - `pathCol` variable in **oracleAdvanced.js** `buildConnectBy()`
    - `exact` variable in **test.js** `estimatedDocumentCount` test
    - `orig` variable in **test.js** `replaceOne` test

### CI/CD

- Added CodeQL workflow for automated code scanning on push/PR
- Added dependency-review workflow for PR dependency auditing
- Configured Dependabot for npm and GitHub Actions version updates
- Bumped `actions/checkout` from v4 to v6 (via Dependabot)
- Added `sample.js` and `test.dev.js` to `.gitignore`

### Tests

- Total: **236 passing**, 3 pending (privilege-dependent DCL only), 0 failing

## [1.0.4] — 2026-04-05

### Bug Fixes

- **aggregatePipeline.js** — Fixed `$out` stage: CTE + INSERT syntax (`WITH ... INSERT INTO`) is invalid Oracle SQL. Now emits `INSERT INTO "table" WITH ... SELECT ...` by deferring the INSERT to final SQL assembly instead of embedding it in a CTE.
- **aggregatePipeline.js** — Fixed `$bucket` stage: numeric boundary THEN-labels mixed with the string default label ("Other") caused ORA-00932 (inconsistent datatypes). All CASE WHEN result values are now coerced to strings when a default bucket is present.
- **aggregatePipeline.js** — Fixed `$replaceRoot` stage: `newRoot: "$"` (bare root reference) produced an empty quoted identifier (`"".*`) causing ORA-01741. Now correctly emits `SELECT * FROM prevSource` for root passthrough.

### Tests

- **test.js** — Converted 3 pending pipeline tests (`$out`, `$bucket`, `$replaceRoot`) to passing tests with full assertions.
- Total: **236 passing**, 3 pending (privilege-dependent DCL only)

## [1.0.3] — 2026-04-05

### Tests

- **test.js** — Added 64 new tests across 7 new sections (25–31), covering previously untested APIs:
    - **Section 25 — SQL Injection & Security**: bind-variable safety for filter/update payloads (`$in`, `$regex`, `$like`, `$set`), UNIQUE constraint violations, NOT NULL constraint violations
    - **Section 26 — mergeFrom, UNPIVOT, buildAnyAllSubquery**: `mergeFrom()` integration, `unpivot()` integration, `buildAnyAllSubquery()` unit tests for ANY/ALL
    - **Section 27 — Additional JOINs**: RIGHT OUTER, FULL OUTER, CROSS, NATURAL join types via `$lookup`
    - **Section 28 — Additional Window Functions**: LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE, window AVG, COUNT, MIN, MAX
    - **Section 29 — Additional Filter Operators**: `$notBetween`, `$case`, `$coalesce`, `$nullif`, `$not`, `$nor`, `$gtAny`, `$ltAll`, `$gteAny`, `$lteAll`, `$inSelect` (array & empty array), nested `$and`/`$or`
    - **Section 30 — Pipeline Stages & Aggregate Expressions**: `$first`, `$last`, `$concat`, `$toUpper`, `$toLower`, `$substr`, `$cond`, `$ifNull`, `$dateToString`, `$mul`, `$subtract`, `$divide`; `$out`, `$bucket`, `$replaceRoot` marked pending (known CTE/type limitations)
    - **Section 31 — Edge Cases & Streaming**: `forEach` streaming, `estimatedDocumentCount`, `distinct` (with/without filter), combined `$set`/`$inc`/`$mul`, `$unset`, `$currentDate`, `$rename` error, `skip`/`count`/chained cursor, `findOneAndUpdate`, `findOneAndDelete`, `buildWindowExpr` unit, `buildJoinSQL` unit (all 7 join types), adjacent `$match` merge, `drop()`, `replaceOne`, `updateMany`
- Total: **233 passing**, 6 pending (3 privilege-dependent DCL + 3 known pipeline limitations)

## [1.0.2] — 2026-04-05

### Performance

- **oracle.js** — Removed redundant `await conn.ping()` from `withConnection()` hot path; pool-level `poolPingInterval: 30` already validates connections
- **oracle.js** — Set `oracledb.fetchArraySize = 1000` globally (up from default 100), reducing internal driver round-trips for bulk reads; also added to `EXECUTE_OPTIONS` for visibility
- **OracleCollection.js** — `findOneAndUpdate()` upsert path now uses Oracle MERGE for atomic INSERT-or-UPDATE when `upsert:true`, `returnDocument:"after"`, and simple equality filter, reducing from 3 round-trips to 2 and eliminating TOCTOU race
- **OracleCollection.js** — `findOneAndDelete()` fetches ROWID in the initial SELECT and uses it directly in the DELETE, eliminating the redundant subquery table scan
- **aggregatePipeline.js** — Adjacent `$match` stages are coalesced into a single `$match` via `$and` before CTE generation, reducing optimizer overhead for multi-predicate pipelines

## [1.0.1] — 2026-04-05

### Security

- **aggregatePipeline.js** — Replaced raw interpolation with bind variables or `Number()` coercion:
    - `$limit` / `$skip` values: wrapped with `Number()` to prevent injection
    - `$count` alias: routed through `quoteIdentifier()` (with `.toUpperCase()` for Oracle convention)
    - `$facet` facet names: escaped single quotes via `.replace(/'/g, "''")`; quoted identifiers
    - `$replaceRoot` field reference: routed through `quoteIdentifier()`
    - `$substr` positional arguments: wrapped with `Number()`
    - `$dateToString` format string: escaped single quotes; added fallback default
    - `$group` / `$project` / `$addFields` aggregate aliases: routed through `quoteIdentifier()`
    - `_buildBucket` boundary and default values: converted from interpolation to bind variables
    - `_buildAddFieldsCols` literal values: converted from interpolation to bind variables
- **Transaction.js** — Added `_validateSavepointName()` regex guard (`/^[A-Za-z_][A-Za-z0-9_]*$/`) to `savepoint()` and `rollbackTo()` to prevent SQL injection via savepoint names
- **cteBuilder.js** — Wrapped `_skipVal` and `_limitVal` in `Number()` in both `CTEResult` and `RecursiveCTEResult` to prevent injection through limit/skip values
- **OracleSchema.js** — Wrapped all numeric sequence DDL options (`startWith`, `incrementBy`, `maxValue`, `minValue`, `cache`) in `Number()` to prevent injection
- **filterParser.js** — Added SECURITY WARNING comment on `$inSelect` raw SQL string fallback path documenting the risk and recommending the object form

## [1.0.0] — 2025-01-01

### Added

- **db.js** — Thin adapter factory (`createDb`) binding named connections from `src/config/database.js`
- **utils.js** — Shared helpers: `quoteIdentifier`, `convertTypes`, `rowToDoc`, `mergeBinds`, `buildOrderBy`, `buildProjection`
- **filterParser.js** — MongoDB filter → Oracle WHERE clause translator
    - Supports: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$between`, `$notBetween`, `$exists`, `$regex`, `$like`, `$any`, `$all`, `$and`, `$or`, `$nor`, `$not`, `$case`, `$coalesce`, `$nullif`
    - Subquery operators: `$exists` (collection), `$notExists`, `$inSelect`, `$subquery`, `$gtAny`, `$gtAll`, `$ltAny`, `$ltAll`
- **updateParser.js** — MongoDB update operators → Oracle SET clause translator
    - Supports: `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$currentDate`, `$rename` (throws with guidance)
- **QueryBuilder.js** — Chainable cursor with lazy SQL execution
    - Builder: `.sort()`, `.limit()`, `.skip()`, `.project()`, `.forUpdate()`
    - Terminal: `.toArray()`, `.forEach()`, `.next()`, `.hasNext()`, `.count()`, `.explain()`
    - Oracle features: AS OF SCN/timestamp flashback, TABLESAMPLE, FOR UPDATE modes
- **Transaction.js** — Transaction manager with Session class
    - `withTransaction(fn)` delegates to `db.withTransaction()`
    - Session: `collection()`, `savepoint()`, `rollbackTo()`, `releaseSavepoint()`
- **OracleCollection.js** — Core CRUD + all query methods
    - Read: `find()`, `findOne()`, `findOneAndUpdate()`, `findOneAndDelete()`, `findOneAndReplace()`, `countDocuments()`, `estimatedDocumentCount()`, `distinct()`
    - Insert: `insertOne()` (with RETURNING), `insertMany()` (executeMany, atomic)
    - Update: `updateOne()` (with upsert, RETURNING), `updateMany()`, `replaceOne()`, `bulkWrite()`
    - Delete: `deleteOne()` (with RETURNING), `deleteMany()`, `drop()`
    - Index: `createIndex()`, `createIndexes()`, `dropIndex()`, `dropIndexes()`, `getIndexes()`, `reIndex()`
    - Merge: `merge()`, `mergeFrom()`
    - Advanced: `connectBy()`, `pivot()`, `unpivot()`, `aggregate()`, `insertFromQuery()`, `updateFromJoin()`
    - Static set ops: `union()`, `intersect()`, `minus()`
- **aggregatePipeline.js** — MongoDB pipeline → Oracle SQL with CTE chaining
    - Stages: `$match`, `$group`, `$sort`, `$limit`, `$skip`, `$count`, `$project`, `$addFields`, `$lookup`, `$lateralJoin`, `$out`, `$merge`, `$bucket`, `$facet`, `$replaceRoot`, `$unwind`, `$having`
    - Advanced grouping: `$rollup`, `$cube`, `$groupingSets`
    - Expression operators: `$sum`, `$avg`, `$min`, `$max`, `$count`, `$first`, `$last`, `$concat`, `$toUpper`, `$toLower`, `$substr`, `$dateToString`, `$cond`, `$ifNull`, `$size`
- **windowFunctions.js** — Oracle analytic function builder
    - Functions: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, `SUM`, `AVG`, `COUNT`, `MIN`, `MAX`
    - Frame clause support: `ROWS BETWEEN`, `RANGE BETWEEN`
- **joinBuilder.js** — `$lookup` → Oracle JOIN clauses
    - Types: LEFT, RIGHT, FULL, INNER, CROSS, SELF, NATURAL
    - Multi-condition joins
- **setOperations.js** — UNION, UNION ALL, INTERSECT, MINUS
    - `SetResultBuilder` with `.sort()`, `.limit()`, `.skip()`, `.toArray()`
- **cteBuilder.js** — CTE builders
    - `withCTE(db, cteDefs)` — regular CTEs from named QueryBuilders
    - `withRecursiveCTE(db, name, def)` — recursive CTEs for hierarchies
- **subqueryBuilder.js** — Subquery utilities
    - Scalar, correlated, EXISTS, NOT EXISTS, IN (SELECT), ANY, ALL
- **oracleAdvanced.js** — Oracle-specific features
    - `buildConnectBy()` — hierarchical queries with NOCYCLE, SYS_CONNECT_BY_PATH
    - `buildPivot()` — PIVOT aggregation
    - `buildUnpivot()` — UNPIVOT with null handling
- **performanceUtils.js** — Performance utilities via `createPerformance(db)`
    - `explainPlan()` — EXPLAIN PLAN + DBMS_XPLAN.DISPLAY
    - `analyze()` — DBMS_STATS.GATHER_TABLE_STATS
    - `createMaterializedView()` — with refresh modes
    - `refreshMaterializedView()` — DBMS_MVIEW.REFRESH
    - `dropMaterializedView()`
- **OracleSchema.js** — DDL operations
    - `createTable()`, `alterTable()`, `dropTable()`, `truncateTable()`, `renameTable()`
    - `createView()`, `dropView()`, `createSequence()`, `createSchema()`
- **OracleDCL.js** — DCL operations
    - `grant()`, `revoke()`
- **index.js** — Barrel file re-exporting everything
- **test.js** — End-to-end test suite with 24 sections
- **README.md** — Usage examples for every category
