# Mira 3.1.0: security, performance, chaos, reliability

**Status:** all four areas done; open: DST repeated-hour defect (decision), Bun Thick segfault on macOS (workaround), reviews before merge · **Base:** v3.0.0 · **Branch:** `security/hardening`

3.1.0 works on four areas. Each one is done when its unit and integration tests pass, its own suite under `test/<area>/` passes, the sim's real-world stages pass, and CI is green across all four live jobs (Thin/Thick × failover/Easy Connect) plus the Windows job.

| Area | Suite | Tests now | Status |
| --- | --- | --- | --- |
| Security | `test/security` | 97 | ✅ done: 9 holes closed (see CHANGELOG 3.1.0) |
| Performance | `test/performance` | 44 (+11 unit, +3 integration) | ✅ budgets in CI; hot-path review done |
| Chaos | `test/chaos` | 25 | ✅ network chaos suite: stall, restart, flapping, close in flight, cut mid-write |
| Reliability | `test/reliability` | 34 | ✅ soak, cursor leaks, concurrency, DST soak; one DST defect open (decision) |

Rules carried over from 3.0:
- A timing failure is fixed by finding the race and waiting for the real condition, never by loosening a bound.
- Keep coverage at 100% (lines and functions).
- Check every time-zone change in UTC, Asia/Manila and America/New_York.
- Thick mode is the production mode (CATHERINE, Windows), so measure there too.

---

## 1. Security ✅

- [x] SQL-text fuzzer (`fuzz.test.ts`): about 60 call shapes × 19 payloads at every string, key and number, checked by a lexer that also reads inside `EXECUTE IMMEDIATE`
- [x] View bind inlining (one pass), `$inSelect` strings refused, `sanitizeFilter`, DCL allowlist, balanced DDL fragments, aggregate operands, connect-string parts, nesting cap
- [x] GitHub Actions pinned to SHAs, `persist-credentials: false`, `SECURITY.md`
- [ ] CATHERINE: replace any `$inSelect` string with ``sql`…` ``; wrap filters built from request input in `sanitizeFilter()`

## 2. Performance ✅

Goal: know what each common call costs, make the hot paths cheaper, and fail CI on a regression.

- [x] **Baseline** (local docker 19c, Easy Connect, macOS arm64, 2026-11-27):

  | Metric | Thin | Thick |
  | --- | ---: | ---: |
  | `findOne` by PK p50 / p95 / p99 | 0.15 / 0.20 / 0.31 ms | 0.26 / 0.33 / 0.64 ms |
  | find + sort + page p50 / p95 | 0.36 / 0.46 ms | 0.47 / 0.58 ms |
  | `$group` over table p95 | 0.89 ms | 0.97 ms |
  | `$in` 5,000 values | 14.1 ms | 12.4 ms |
  | `insertMany` / `insertOne` loop | 137.8k / 3.5k rows/s (39×) | 157.3k / 2.7k rows/s (57×) |
  | `bulkUpdateByKeys` / `updateOne` loop | 208.9k / 3.7k rows/s | 253.6k / 2.9k rows/s |
  | `forEach` stream / `toArray` | 457k / 911k rows/s | 591k / 1,045k rows/s |
  | 200 concurrent over pool 10 (wall) | 230 ms | 68 ms |
  | `withConnection` overhead p50 | 0.01 ms | 0.07 ms |

- [x] **SQL build cost without a database** (µs per call, v3.0.0 → 3.1.0): typical `parseFilter` 1.00 → 1.20, `find().sort().limit()` 1.22 → 1.49, 6-stage pipeline 5.09 → 5.14, `$in` 5,000 values 8.4 → 12.3. The security guards (depth walk) cost about 0.2 µs per query, against about 150 µs per round trip. The walk was rewritten with two flat stacks (`$in` 5k: 17.6 → 12.3 µs).
- [x] **IN-list padding.** `$in`/`$nin` lists of up to 1,000 values are sent at power-of-two lengths (repeating the last value), so lengths 1–1,000 map to 11 SQL texts and Oracle reuses the cursor instead of hard-parsing each length. Measured on 500k rows, p95 (plain → padded): 5 values 1.40 → 0.49 ms, 30 values 1.26 → 0.61 ms, 300 values 3.96 → 1.99 ms, 700 values 11.56 → 2.95 ms.
- [x] **Collection bind (`TABLE(:b)`) for more than 1,000 values:** checked on 2M rows. The static plan shows a full scan, but the adaptive plan switches to the index at runtime (10 values: 0.86 ms), so no cardinality hint is needed.
- [x] **SQL build cost without a database** (`budgets.test.ts`, part A). Eleven builders and calls on a recording connection, each as a ratio to a fixed calibration workload in the same run (so a slower CPU slows both). Budget: 2× the recorded ratio; each sample is the fastest of nine rounds. Checked that the budgets bite: at half the factor all eleven fail, and the 3.0 `insertMany` (ratio 194 against a budget of 86) would have failed.
- [x] **Statements per call** (part B): exact counts from `onQuery()`. One statement for every read, write and bulk call; two for `findOneAndUpdate` / `findOneAndDelete` (SELECT, then DML by ROWID). The session time-zone `ALTER SESSION` runs once per new pooled session, not per checkout.
- [x] **Overhead over the raw driver** (part C): Mira against `conn.execute` / `executeMany` with the same SQL, interleaved samples, ratio of medians, bound 1.5×. Thin, local 19c:

  | Call | Mira / raw p50 |
  | --- | ---: |
  | `findOne` by PK | 1.00–1.04 |
  | find + sort + page of 20 | 1.01–1.02 |
  | `toArray` 10,000 rows | 1.00–1.01 |
  | `updateOne` by PK | 1.02–1.17 |
  | `insertMany` 1,000 rows | 1.05–1.09 (was 1.32) |

- [ ] **Hot-path review.**
  - [x] `insertMany` / `bulkUpdateByKeys`: the separate `COMMIT` round trip (now `autoCommit` for a one-statement batch outside a transaction) and per-row bind building (now one pass per column, positional). 347 → 67 µs of CPU per 1,000 rows.
  - [x] `insertMany`'s default `returning: ["ID"]` cost about +3.2 ms per 1,000 rows (2.7×). RETURNING is now skipped only when the database cannot change a supplied ID: every ID a safe integer, an own table, `NUMBER` with no scale, no enabled INSERT trigger (checked in the dictionary, cached 60 s per pool and table). A rewriting trigger, a scaled key, a view/synonym, a failed dictionary read or an explicit `returning` all keep RETURNING. 5.1 → 2.1 ms per 1,000 rows (1.11× the raw driver). Live test: a trigger that adds 1,000 to the key reports the stored 1007/1008.
  - [x] Large reads: `fetchArraySize` is already 1,000 (`src/driver/oracle.ts`) and `toArray` of 10,000 rows runs at 1.00× the raw driver. Statement cache: 50 per pool, and Mira's SQL text is stable per call shape (IN-list padding included).
  - [x] `executeMany` batch size: one call stays fastest (300,000 rows: 1.46M rows/s in one call vs 0.93M rows/s in 10,000-row chunks); memory grows with the input the caller already holds (~0.55 KB per row). No chunking.
- [x] **Budgets.** In CI via `test/performance/budgets.test.ts` (above). `MIRA_PERF_BUILD_FACTOR` scales part A for study only.
- [x] **Sim.** Every stage records wall time, statements and time inside statements, in `coverage/sim-stages.json` and the CI job summary. The sim is deterministic, so a stage's statement count moves only when code does. Local Thin run: 1,029 statements, 10.3 s, of which 7 s is stage 4's deliberate wait for flashback history.

## 3. Chaos ✅

Goal: every failure is bounded, surfaces a clear error, leaks no connection, and leaves the pool usable.

Already covered: dead host, circuit breaker, bad credentials, pool exhaustion, queue timeout, call timeout, `break()`, a connection closed underneath, crash mid-transfer, deadlock, NOWAIT, malformed input, a throwing or rejecting `forEach`.

All five run through a TCP proxy (`test/helpers/chaosProxy.ts`) in `test/chaos/network.test.ts`, so they need no database privileges and run in CI.

- [x] **Database restart** (every proxied connection cut at once): calls right after either work or fail with a connection error (none hang); every call works again within seconds, with no app restart, and nothing stays checked out. (`ALTER SYSTEM KILL SESSION` needs admin rights the test schema does not have; a cut connection is what a client sees either way.)
- [x] **Network stall** (packets stop, sockets stay open). Found: a call hung forever (there was no per-pool call timeout; the 60 s default was never applied), a health check hung (so the breaker never opened), and in Thick mode opening a pool hung (`connectTimeout` is Thin-only, and the failed attempt's awaited `pool.close` blocked behind hung native connects). Now: new `callTimeout` / `expireTime` pool options, a JS backstop for Thin's dead-link case, and bounded health checks and pool opens. Measured: a stalled call fails in 2.5 s (Thin) / 3.0 s (Thick) with `callTimeout` 1500; the breaker opens in ~5 s; opening a pool fails in 12 s / 17.6 s after 4 attempts.
- [x] **`mira.close()` during in-flight work and a stream:** close returns in ~1 s, both settle (none hang), and the instance refuses new work.
- [x] **Flapping** (three stall/recover cycles): exactly one `onChange` per transition (`false, true` × 3), 12–13 checks in all, and the breaker settles healthy.
- [x] **Fault injection:** connections cut after the 1st, 3rd and 7th statement of a 10-insert `withTransaction` leave no rows; a cut inside `bulkWrite` leaves none; a cut during a 20,000-row `insertMany` leaves all or none (observed: all, since it committed first).

## 4. Reliability ✅

Goal: results stay correct and resources flat over long runs and under concurrency.

Already covered: no lost updates, no leaks after 1,000 mixed ops, idempotent merge, balanced ledger, exact round trips, money sums, a 3k-op soak, deterministic SQL, cursor snapshot, per-connection state.

- [x] **Long soak** (`soak.test.ts`; 3,000 ops by default, `MIRA_SOAK_OPS=30000` locally): 8 workers on their own pool, mixed reads, writes, transactions, streams and deliberate failures. Over the measured window heap grows ~10 B/op at 30k (bound 1 MiB), server cursors +1.7 to +3.8 across 8 sessions (bound 16), connections flat at 8, p95 flat (1.3–1.5 ms). **Found:** `forEach` released its connection before the stream closed (50/50); Bun + Thick then misreported nearby errors as DPI-1039 / NJS-003. Fixed.
- [x] **Cursor leak check** (`cursorLeak.test.ts`, from `V$MYSTAT` / `V$OPEN_CURSOR`): 177 distinct texts twice on one connection stay within the cache of 50, round 2 hard parses 0; `$in` lengths 1–1,000 make 9 texts, each parsed once; 150 streams (100 aborted) and 150 failed statements hold no cursor; every pooled session stays within its cache. Oracle's internal collection-bind cursors (`table_…`, from `TABLE(:b)`) are not client cursors and are excluded.
- [x] **Concurrency** (`concurrency.test.ts`): typed-table reads and disjoint writes, aggregates, `include()` (hasMany, hasOne, belongsTo), `withCTE` and `withRecursiveCTE`, 50 concurrent callers each: identical to the sequential baseline in both modes; no connection left checked out.
- [x] **Time zones and DST** (`timezoneSoak.test.ts`, local run under America/New_York; CI runs it under Asia/Manila): 1,942 instants × 4 column types × 3 write paths. UTC and Manila: exact in both modes. New York: as documented outside one hour — Thick moves summer instants by exactly 1 h in the two time-zone column types only.
- [x] **Documented limitation (fix planned for 3.2): the hour repeated when clocks go back.** Decision: document in 3.1 (README, "Session time zone"); the `DEFECT:` tests in `timezoneSoak.test.ts` stay and assert the fixed behaviour (they fail only in a DST zone, and the scorecard counts them as known defects). In a daylight-saving zone, a Date in 01:00–02:00 local on the day clocks go back reads back an hour off: Thin in all four column types, Thick in TIMESTAMP and DATE; an equality filter there matches its twin too. node-oracledb binds a Date as a wall-clock time; binding it as `DB_TYPE_TIMESTAMP_TZ` keeps the instant in the two time-zone column types (checked with the raw driver). TIMESTAMP and DATE cannot tell the two 01:30s apart at all (document). A bind-type change on filters could stop index use on DATE/TIMESTAMP columns, so it needs a design (`senior-oracle-engineer-planner`). Processes on UTC or a zone without DST (CATHERINE: Manila) are not affected.
- [ ] **Error metadata (backlog).** Collection methods rethrow driver errors as `new Error(text)`, without `errorNum` or `cause`, so callers can only match `ORA-00001` by text. Partly addressed in 3.1: what leaves `withConnection` is now a `MiraDbError` (`kind`, `code`, `outcomeUnknown`), but its `originalError` for a statement failure is still the text-only rewrap. Next: keep the driver error as `cause` in `MSG.wrapError` callers.
- [ ] **Bun segfault, Thick mode, macOS.** Not caused by the `forEach` release bug (still 3/4 single-process crashes after that fix); the split runs were 3/3 clean afterwards, but one split run also crashed in the first process, so the workaround lowers the rate rather than removing it. Workaround in place: on macOS in Thick mode, `bun run test` runs the chaos suite in a second process (unless `--coverage` or a file filter is given; `MIRA_TEST_SPLIT=1/0` forces it): 3/3 full runs clean, against 4/4 crashes in one process. An issue for Bun is drafted for the maintainer to file. Details (updated 2026-11-28, after the network chaos tests): Every full Thick run now crashes (4/4; it was about half), and not only after the chaos tests: one run crashed right after `createMira.test.ts` "close() after a pool that never came up" (test 443 of 703). The common thread at every crash site is a Thick pool whose creation failed, then later work in the same `bun test` process. Thin mode is clean (703/703). Earlier notes: The crash lands within tests 678–680 of 692: the chaos tests right after the two dead-host tests (`127.0.0.1:1`, connection refused, 4 create attempts). Skipping the dead-host tests: 4/4 full runs clean; with them: about half crash. It is not the background re-creation of the dead pool (the chaos suite now closes its injected pools, and it still crashes), and it is not the bad-credentials test (moving it to a child process did not help). Outside `bun test` it never reproduced: dead pool retrying under load for 2 × 90 s (650k queries each), bad-credential pools ×30, dead host + breaker nudges ×9. Thin mode and CI (Linux Thick) are clean. Next: report it to Bun with `bun test` full-suite repro steps; retest on the next Bun release. Update 2026-11-28 (after the resilience work): two Mira defects were found while chasing it. (1) Thick reads of `connectionsInUse` could block the JS thread forever behind a hung native call, which looked like a hang rather than a crash. (2) Broken connections leaked out of Thick pools under `onQuery`, and closing such a pool then crashed Bun deterministically in `network.test.ts` teardown (3/3). With both fixed, the deterministic crash is gone. A random one remains: `network.test.ts` alone 1/2 then 3/3 crashed at different tests; the non-chaos suites 1/3. Still never reproduced outside `bun test`.

---

## Findings log

| Date | Area | Finding | Fix |
| --- | --- | --- | --- |
| 2026-11-27 | Security | `inlineBinds` re-read inlined literals, so a value could break out of a view's quotes | one-pass inlining (`05515d0`) |
| 2026-11-27 | Security | `$inSelect` ran a plain string as SQL, reachable from request input | strings refused; ``sql`…` `` accepted |
| 2026-11-27 | Security | DCL privileges, DDL types/DEFAULT/CHECK, aggregate operands and connect-string parts were spliced unchecked | allowlists and fragment checks |
| 2026-11-27 | Security | 100k-level nesting overflowed the stack | depth cap of 100 |
| 2026-11-27 | Bug | Buffers and ``sql`` `` statements inside a filter lost their type | filter resolution copies plain objects only |
| 2026-11-27 | Security | CodeQL: the IPv6 branch of the connect-string host regex was polynomial (ReDoS) | one quantifier per branch, length checked first |
| 2026-11-27 | Performance | Every distinct `$in` length was a new SQL text (a hard parse, and shared-pool churn) | IN-list padding to powers of two: p95 2–4× lower |
| 2026-11-28 | Reliability | `insertMany` / `bulkUpdateByKeys` sized binds with `Math.max(...values)`: a stack overflow from ~125k rows on Node, 1M on Bun | loop per column |
| 2026-11-28 | Performance | One-statement `insertMany` / `bulkUpdateByKeys` paid a separate `COMMIT` round trip and per-row bind objects (1.32× the raw driver) | `autoCommit` + rollback on failure; positional binds: 1.07× |
| 2026-11-28 | Bug | Messages read "a object" | article chosen by the word |
| 2026-11-28 | Reliability | Intermittent Bun segfault in a whole-suite Thick run on macOS (older than this work) | open: see Reliability |
| 2026-11-28 | Performance | `insertMany`'s default RETURNING "ID" cost 2.7× the insert alone | skipped when the dictionary proves a supplied ID is stored as given: 1.11× |
| 2026-11-28 | Reliability | The chaos suite left its failing pools in the registry; the health monitor kept re-creating them for the rest of the run | injected pools closed in `afterAll` |
| 2026-11-28 | Chaos | On a stalled link a call hung forever (no per-pool call timeout; the 60 s default was never applied) | `callTimeout` pool option + JS backstop (Thin's driver waits forever after its own timeout) |
| 2026-11-28 | Chaos | Health checks on a stalled link never finished, so the breaker never opened | checks bounded at `connectTimeout` |
| 2026-11-28 | Chaos | Thick mode: opening a pool over a stalled link hung (connectTimeout is Thin-only; an awaited close blocked the retry) | each open step bounded; failed attempt's close not awaited |
| 2026-11-28 | Reliability | `forEach` / `for await` released the connection on the stream's `end`, before its `close` (Bun + Thick: wrong error text on the next caller) | wait for `close` on every path |
| 2026-11-28 | Reliability | A Date in the repeated hour (clocks going back) reads back an hour off in a DST zone | open: design needed |
| 2026-11-28 | Security | Review of #38: an inlined negative number after `-` made a `--` comment in a view; `Nq'…'` passed the DDL fragment check; the RETURNING skip read only `USER_TRIGGERS` (a trigger owned by another schema could rewrite the ID); the bind rewriters did not skip comments / q-quotes; shared sub-objects made the depth walk exponential | negatives parenthesised; `nq'` refused; `ALL_TRIGGERS` + current-schema check + cache cleared on close; scanner skips comments and q-quotes; 100,000-object cap |
| 2026-11-28 | Chaos | Resilience review (21 findings): Promise.all on one connection cut healthy calls; a cut commit looked retry-safe; release, streams and close could hang on a silent link; a busy pool tripped the breaker; recovery skipped a test phase; a cold start over a dead link hung callers and stats(); retries reopened a full warm pool; stuck connections filled a pool for ~15 min; the Thick thread warning assumed Node's 4 threads | per-connection guard; `MiraDbError` with `outcomeUnknown`; bounded release, streams and close; `saturated`; half-open breaker; bounded cold start (`MIRA_POOL_OPENING`); poolMin 0 on retry, 2 abandoned steps max; pool replacement; thread budget over all pools, measured on Node and Bun |
| 2026-11-28 | Chaos | Thick: the health monitor read `pool.connectionsInUse`, an OCI read that waits on the pool mutex; a native drop hung on a silent link held it, freezing the JS thread for good (0% CPU, no timer ever fired) | Thick pools counted in JS; the driver read only while no pool operation is in flight |
| 2026-11-28 | Chaos | Thick + any trace handler (`onQuery`): node-oracledb 7.0.1's `close()` read the dead connection's service name for its trace context, threw `NJS-003`, and never released the session: one pool slot lost per cut connection | Mira closes with tracing off for the call's synchronous start; upstream issue drafted |
| 2026-11-28 | Security | CodeQL (js/polynomial-redos, high ×2): the new token regex of the bind rewriters rescanned the rest of the text from every unterminated `nq'[` (O(n²): 2.3 s for 200 KB) | linear hand-written scanner (0.15 ms); regression test bounds it at 200 ms |
| 2026-11-28 | Tests | CI flakes outside Mira: cursorLeak's session-wide hard-parse count hit 12 (bound 5) once (server reloads), and the soak's last-window p95 hit 724 ms once (a ~0.7 s stall) | cursorLeak asserts no new child cursor for Mira's own texts (V$SQL, granted to the test user); the soak records event-loop lag and per-window latency to place the next stall. Open: `forEach streams` in cursorLeak fails run alone in Thick (opened +1 while client cursors fall), before and after this change |
| 2026-11-28 | Supply chain | CI pulled the Oracle image by a moving tag and Instant Client from Oracle's unversioned "latest" link (rebuilt in place: same 23.26.2.0.0 label, a different zip a month later) with no checksum | image pinned by digest; versioned Instant Client URLs checked with SHA-256 |
