# Mira 3.1.0: security, performance, chaos, reliability

**Status:** security done (`05515d0`); performance in progress (baseline and IN-list padding done); chaos and reliability next · **Base:** v3.0.0 · **Branch:** `security/hardening`

3.1.0 works on four areas. Each one is done when its unit and integration tests pass, its own suite under `test/<area>/` passes, the sim's real-world stages pass, and CI is green across all four live jobs (Thin/Thick × failover/Easy Connect) plus the Windows job.

| Area | Suite | Tests now | Status |
| --- | --- | --- | --- |
| Security | `test/security` | 97 | ✅ done: 9 holes closed (see CHANGELOG 3.1.0) |
| Performance | `test/performance` | 10 (+4 unit, +1 integration) | 🔶 baseline recorded; IN-list padding landed; budgets next |
| Chaos | `test/chaos` | 17 | ⏳ evaluate: add failure modes not yet covered |
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

## 2. Performance ⏳

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
- [ ] **SQL build cost without a database.** Micro-benchmarks of `parseFilter`, `buildAggregateSQL`, `include()` and the new guards (depth walk, fragment checks), so a builder regression shows up even with the database idle.
- [ ] **Hot-path review.**
  - Statement cache hit rate (Mira builds the same SQL text for the same call shape, so the cache can hit).
  - `fetchArraySize` / `prefetchRows` for large reads.
  - `executeMany` batch size.
  - Round trips per call (`insertOne` RETURNING, `findOneAndUpdate`, `include`).
- [ ] **Budgets.** Turn the baseline into bounds, so that a 2× regression fails, with headroom for the CI runners.
- [ ] **Sim.** Time the trading-day and reporting stages and record them with each run.

## 3. Chaos ⏳

Goal: every failure is bounded, surfaces a clear error, leaks no connection, and leaves the pool usable.

Already covered: dead host, circuit breaker, bad credentials, pool exhaustion, queue timeout, call timeout, `break()`, a connection closed underneath, crash mid-transfer, deadlock, NOWAIT, malformed input, a throwing or rejecting `forEach`.

- [ ] Database restart while a pool is open (sessions killed with `ALTER SYSTEM KILL SESSION` across the whole pool), then recovery with no app restart
- [ ] Network stall rather than refusal (packets dropped): connect timeout and call timeout both bound it
- [ ] `mira.close()` during in-flight work and during a stream
- [ ] Health watcher under flapping (up/down/up): no storm of `onChange` events, and the breaker settles
- [ ] Fault injection at random points in `withTransaction`, `bulkWrite` and `insertMany` batches: all or nothing, as documented

## 4. Reliability ⏳

Goal: results stay correct and resources flat over long runs and under concurrency.

Already covered: no lost updates, no leaks after 1,000 mixed ops, idempotent merge, balanced ledger, exact round trips, money sums, a 3k-op soak, deterministic SQL, cursor snapshot, per-connection state.

- [ ] Longer soak, opt-in in CI (for example 30k ops): memory (RSS, heap), open connections, open cursors (`V$OPEN_CURSOR`) and latency all flat
- [ ] Statement-cache and cursor leak check over many distinct call shapes
- [ ] Concurrency of typed tables, `include()` and `withCTE` under load: same results as sequential
- [ ] Time zones and DST over a soak in Thick mode (the 3.0 limitation stays documented)

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
