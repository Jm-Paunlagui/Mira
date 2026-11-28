# Mira 3.1.0: security, performance, chaos, reliability

**Status:** security, performance and chaos done; reliability next · **Base:** v3.0.0 · **Branch:** `security/hardening`

3.1.0 works on four areas. Each one is done when its unit and integration tests pass, its own suite under `test/<area>/` passes, the sim's real-world stages pass, and CI is green across all four live jobs (Thin/Thick × failover/Easy Connect) plus the Windows job.

| Area | Suite | Tests now | Status |
| --- | --- | --- | --- |
| Security | `test/security` | 97 | ✅ done: 9 holes closed (see CHANGELOG 3.1.0) |
| Performance | `test/performance` | 44 (+11 unit, +3 integration) | ✅ budgets in CI; hot-path review done |
| Chaos | `test/chaos` | 25 | ✅ network chaos suite: stall, restart, flapping, close in flight, cut mid-write |
| Reliability | `test/reliability` | 12 | ⏳ evaluate: longer soak, leak and drift checks |

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

## 4. Reliability ⏳

Goal: results stay correct and resources flat over long runs and under concurrency.

Already covered: no lost updates, no leaks after 1,000 mixed ops, idempotent merge, balanced ledger, exact round trips, money sums, a 3k-op soak, deterministic SQL, cursor snapshot, per-connection state.

- [ ] Longer soak, opt-in in CI (for example 30k ops): memory (RSS, heap), open connections, open cursors (`V$OPEN_CURSOR`) and latency all flat
- [ ] Statement-cache and cursor leak check over many distinct call shapes
- [ ] Concurrency of typed tables, `include()` and `withCTE` under load: same results as sequential
- [ ] Time zones and DST over a soak in Thick mode (the 3.0 limitation stays documented)
- [ ] **Bun segfault, Thick mode, macOS.** Workaround in place: on macOS in Thick mode, `bun run test` runs the chaos suite in a second process (unless `--coverage` or a file filter is given; `MIRA_TEST_SPLIT=1/0` forces it): 3/3 full runs clean, against 4/4 crashes in one process. An issue for Bun is drafted for the maintainer to file. Details (updated 2026-11-28, after the network chaos tests): Every full Thick run now crashes (4/4; it was about half), and not only after the chaos tests: one run crashed right after `createMira.test.ts` "close() after a pool that never came up" (test 443 of 703). The common thread at every crash site is a Thick pool whose creation failed, then later work in the same `bun test` process. Thin mode is clean (703/703). Earlier notes: The crash lands within tests 678–680 of 692: the chaos tests right after the two dead-host tests (`127.0.0.1:1`, connection refused, 4 create attempts). Skipping the dead-host tests: 4/4 full runs clean; with them: about half crash. It is not the background re-creation of the dead pool (the chaos suite now closes its injected pools, and it still crashes), and it is not the bad-credentials test (moving it to a child process did not help). Outside `bun test` it never reproduced: dead pool retrying under load for 2 × 90 s (650k queries each), bad-credential pools ×30, dead host + breaker nudges ×9. Thin mode and CI (Linux Thick) are clean. Next: report it to Bun with `bun test` full-suite repro steps; retest on the next Bun release.

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
