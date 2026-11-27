# Mira 3.0 Roadmap

**Status:** #34 and #35 merged; step 3 (#36) held open: Thick-mode fixes landing, then the maintainer's Windows test · **Base:** v2.1.0 · **Branch:** `feature/v3-restructure` (#36)

Mira grew inside an app template (CATHERINE / eMeal), so `config/`, `constants/` and `utils/logger` were app code that ended up in the library. An app that installed `@jm-paunlagui/mira` from npm could use only the two built-in pools (`appDb`, `appDbBulk`), through Mira's own env names, and adding a pool meant editing `node_modules`. 3.0 makes Mira a standalone library: the app passes its config in, and Mira reads no env variable, writes no log file and initialises no driver unless asked.

Update this file as each item lands: tick the box and add the PR number.

---

## 1. Progress

| Step | What | Branch | PR | Status |
|---|---|---|---|---|
| 1 | `createMira()`, `defineConfig()`, `fromEnv()`, runtime pool registry, `closePool()` | `feature/v3-config` | #34 | ✅ merged |
| 2 | Lazy driver init, `configureDriver()` / `initDriver()`, injectable logger | `feature/v3-driver` | #35 | ✅ merged |
| 3 | Restructure + remove the 2.x API → **3.0.0** | `feature/v3-restructure` | #36 | ✅ green, held open |
| 4 | CATHERINE switches from its own adapter copy to the npm package | CATHERINE repo | — | ⏳ after 3.0.0 |

### Step 3 checklist

- [x] **3a. Move files** to the target layout (§2). Import paths only; no behaviour change; full suite green at 100% (567 tests). 39 files moved with `git mv`; `package.json` entry is `dist/index.js`. Still to do: `config/index.ts` (adapter factory) stays until 3c, and `driver/registry.ts` still holds the connect-string builders until 3c splits out `config/connectString.ts`.
- [x] **3b. Drop app-template code.** Removed `logger.ts`, `logRedaction.ts`, `requestContext.ts`, `runtimePaths.ts`, `types/express.d.ts` and `@types/express`. Default log sink is the console, warnings and errors only (§4 D1). `driver.binaryDir` added (§4 D4); the compiled-exe `.env` loader, the PATH set-up and the compiled connect-string tweak are gone. Tests, `sim`, the CLI and the runner use `setLogger` instead of `ENABLE_CONSOLE_LOGS`; `LOG_*` left `.env.example`. 565 tests at 100%. Also fixed a chaos-test race (health ping holding a connection during the leak check).
- [x] **Blocker found during 3b — CI red on #34 and #35 (fixed):** `bun run sim` fails its rule that every public function is called by the simulation (all 345 checks pass). Not called: `createMira`, `defineConfig`, `fromEnv`, `buildSimpleConnectString`, `buildTNSConnectString` (#34) and `configureDriver`, `initDriver`, `setLogger` (#35). Fixed with sim stage 17 ("config": a reporting job with its own `createMira` pool): `cd529b0` on `feature/v3-config`, `3d8917f` on `feature/v3-driver`, merged forward into this branch. Sim: 162/162 functions, 356 checks.
- [x] **3c. Remove the 2.x API** (§3 "Removed"). Done:
  - `createDb` is internal; the built-in env pools, the `APP_TEST_DB_*` switch, `POOL_NAMES`, `READINESS_GATING_POOLS`, `DB_TYPE` / `createAdapter` (`config/index.ts`) and the `ORACLE_INSTANT_CLIENT` / Windows-DLL check are gone. Mira reads no env variable except node's `UV_THREADPOOL_SIZE` (for a warning) and Oracle's `ORA_SDTZ`.
  - `driver/registry.ts` starts empty; the builders moved to `config/connectString.ts`; 21 unused adapter message templates removed.
  - New public type `MiraDb` (what `mira.db()` returns) and `DbConnection`. A handle kept after `close()` reports unhealthy and refuses work with `MIRA_CLOSED` (it used to reach an unregistered pool name).
  - `"auto"` mode with no client on the library path logs a one-line notice instead of a multi-line DPI-1047 warning (a named `libDir` that fails is still a warning).
  - Tests use `createMira(fromEnv())` in `test/helpers/db.ts`; `config.test.ts` became `registry.test.ts`; type tests share `test/types/_db.ts`. The sim runs on its own `createMira` pool and counts `mira.*` methods. CLI, Node smoke test, CI and `.env.example` use `MIRA_DB_*`; CI no longer needs the listener's SID-as-service tweak.
  - Fixed a flashback test race (AS OF TIMESTAMP granularity); it now restores its fixture on failure.
  - 558 tests at 100%; sim 167/167 functions, 361 checks.
  - **Local `.env` still needs `MIRA_DB_USER`, `MIRA_DB_PASSWORD`, `MIRA_DB_CONNECT_STRING`** (see `.env.example`).
- [x] **3d. Package and docs.** Done:
  - Version 3.0.0; entry `dist/index.js`; `dotenv` dropped (never imported); the package publishes `dist/` (no `src/`, so no source or declaration maps), README, CHANGELOG, LICENSE, `.env.example` and `docs/MIGRATION-3.0.md`.
  - README: new Setup (install, connect, pool options, several pools, health and readiness, `fromEnv`, Thin/Thick, logging); later sections and Testing / Simulation updated. The old wrapper guide (`docs/QUERY-GUIDE.md`, a stale copy) is deleted after folding in its one unique section (`$lookup` `select`).
  - CHANGELOG 3.0.0; `docs/MIGRATION-3.0.md` (CATHERINE-oriented).
  - **Gap found and closed:** CATHERINE's readiness, alerting and shutdown code calls the adapter's lifecycle and health functions (`initializePools`, `closeAll`, `onPoolHealthChange`, `setPoolHealthWatched`, `recordProbeSuccess` …), none public in 3.0. Added `mira.open()`, `mira.stats()` and `mira.health.*`, scoped to the instance's pools (§3). Sim: 177/177 functions, 366 checks.
- [x] **3e. Verify as a user would.** `test/package/run.sh` (`bun run test:package`, also a CI step in both driver modes): packs the tarball, installs it with `@types/node` into an empty temp project with no `.env`, unsets every `MIRA_*` and 2.x variable, and gives the app its own pool name (`shop`) and variables (`PKG_DB_*`). Then: strict `tsc` (`skipLibCheck: false`) over a TypeScript app and the published `.d.ts`, the app under Bun (typed table create / insert / find, exact money, `MiraConfigError`, `open`, health, stats, close, no `logs/`), a CommonJS app and an ES-module app (named imports from the CommonJS build, `fromEnv` with a custom prefix) under Node, and the `mira` CLI binary. Checked that a wrong password fails it.
  - Found on the way: `mira.close()` waited out every retry of a pool that could not come up (4 attempts plus backoff; up to a minute with long connect timeouts). `closePool()` now stops a creation in progress at the current attempt or backoff. The test that exposed it took 5 s and only passed under the runner's 180 s timeout; it now takes ~0.1 s. 561 tests at 100%.
- [x] **Thick mode without failover (found on #36, fixed).** Reproduced locally with Instant Client 23.3 (macOS arm64) against the 19c container. Raw node-oracledb showed the cause: without failover, a Thick-mode call timeout that cannot be interrupted closes the session (`NJS-500` / `ORA-03156`), and closing it is fine. Mira's `withConnection` cleanup then reset `callTimeout` on the dead connection, which threw `DPI-1010` outside any `try`: it replaced the caller's error and skipped the release, leaking the pool slot. Fixed: cleanup never throws over the caller's error, and a dead connection is closed with `{ drop: true }`; the chaos test accepts either correct outcome and drops its own masking reset.
- [x] **Session time zone (found on the same run, then on CI in +08:00, fixed).** Measured locally (Thin/Thick × Node/Bun × process zone × session setting): node-oracledb writes a `Date` in the process's zone and Oracle reads it in the session's, so every Date round-trips only when the two match. 2.1's forced `+00:00` was right only on UTC; `bun test` and CI ran on UTC, so it looked fixed (and under Bun, where the `ORA_SDTZ` change never reaches the client, Thick mode was right by accident). Now each new pooled session is set to the process's region in Thin mode (exact across daylight saving; offset fallback) and its offset in Thick mode (a region fails there with `ORA-01805`: client and server time-zone files differ). `include()`'s JSON dates are read as local time to match. Limitation documented: Thick mode in a daylight-saving zone should run on UTC. CI runs Thin/Thick × failover/Easy Connect (4 jobs) in `TZ=Asia/Manila`.
- [ ] **Known, not Mira: Bun 1.4.5 + Instant Client on macOS arm64 segfaults** intermittently inside the chaos suite (killed sessions, breaks, deadlocks), with either connect string; once a failover run instead hung two chaos tests (16 min, 5 min). Bun's own message calls it a Bun bug (`bun.report`). Linux CI is unaffected; Thick mode is not a macOS deploy target. Re-check on the maintainer's Windows run.
- [ ] **Maintainer: final test on Windows** (Thick mode, Bun and the compiled executable), before release. Steps and checklist: [`HANDOVER-WINDOWS.md`](HANDOVER-WINDOWS.md).
- [ ] **3f. Merge and release.** #34 merged (`4f3a93f`) and #35 merged (`4ed51a5`) into `main` on 2026-11-27. #36 (step 3) is green and mergeable, and is held open by decision. After it merges: Claude creates the `v3.0.0` tag and the GitHub release from the CHANGELOG; the maintainer runs `npm publish` (irreversible, so kept with the maintainer).

---

## 2. Target structure

```
src/
  index.ts            public API (the only entry point in package.json "exports")
  config/             what the app passes in
    types.ts            MiraConfig, PoolConfig, DriverOptions, MiraLogger
    defineConfig.ts     validation → MiraConfigError
    fromEnv.ts          opt-in MIRA_* reader
    connectString.ts    buildSimpleConnectString / buildTNSConnectString
  driver/             talking to Oracle (the main API)
    createMira.ts       createMira() → db / collection / schema / dcl / transaction / close
    oracle.ts           node-oracledb init, pools, acquire, health monitor, shutdown
    registry.ts         runtime pool registry (no built-in pools)
    db.ts               the db handle (internal; createMira().db() returns it)
  core/               OracleCollection, QueryBuilder, Transaction, sql, events
  parsers/            filter, update, jsonPath
  pipeline/           aggregate, window, CTE, series, subquery
  joins/              joinBuilder, setOperations
  schema/             OracleSchema, OracleDCL
  typed/              defineTable, columns, model, relations, include, generate, validate
  migrate/            migrator
  advanced/           CONNECT BY, PIVOT, performance utilities
  shared/             used by every layer
    messages/           error and log message templates
    log.ts              log sink (setLogger)
    utils.ts            quoteIdentifier, convertTypes, rowToDoc, mergeBinds …
  cli/mira.ts         mira generate types / mira migrate
```

The query layer's folders sit at the top level, so the old `oracle-mongo-wrapper/` folder needs no new name.

### File map (2.x → 3.0)

| 2.x | 3.0 |
|---|---|
| `src/utils/oracle-mongo-wrapper/index.ts` | `src/index.ts` |
| `src/utils/oracle-mongo-wrapper/createMira.ts` | `src/driver/createMira.ts` |
| `src/utils/oracle-mongo-wrapper/db.ts` | `src/driver/db.ts` |
| `src/config/adapters/oracle.ts` | `src/driver/oracle.ts` |
| `src/config/database.ts` | `src/driver/registry.ts` (built-ins removed) + `src/config/connectString.ts` |
| `src/config/index.ts` (`DB_TYPE` adapter factory) | removed |
| `src/config/log.ts` | `src/shared/log.ts` |
| `src/config/{types,defineConfig,fromEnv}.ts` | unchanged |
| `src/constants/messages/*` | `src/shared/messages/*` |
| `src/utils/oracle-mongo-wrapper/utils.ts` | `src/shared/utils.ts` |
| `src/utils/oracle-mongo-wrapper/{core/*,Transaction.ts,sql.ts,events.ts}` | `src/core/` |
| `src/utils/oracle-mongo-wrapper/{parsers,pipeline,joins,schema,typed,migrate,advanced}/` | `src/<same name>/` |
| `src/utils/oracle-mongo-wrapper/README.md` | folded into the root README in 3d |
| `src/utils/oracle-mongo-wrapper/logs/` (stray log files) | deleted |
| `src/utils/{logger,logRedaction,requestContext,runtimePaths}.ts`, `src/types/express.d.ts` | removed in 3b (they stay in CATHERINE) |
| `src/cli/mira.ts` | unchanged path; uses `fromEnv()` from 3c |

---

## 3. Public API in 3.0

**Kept / added** (exported from `src/index.ts`):

- Entry: `createMira`, `defineConfig`, `fromEnv`, `MiraConfigError`, `configureDriver`, `initDriver`, `setLogger`, `buildSimpleConnectString`, `buildTNSConnectString`.
- On an instance: `db()`, `collection()`, `schema()`, `dcl()`, `transaction()`, `open()`, `stats()`, `health.{isHealthy, allHealthy, metrics, onChange, onCheck, watch, recordProbeSuccess, nudge}`, `close()`, `config`, `closed`.
- Types: `Mira`, `MiraHealth`, `MiraDb`, `DbConnection`, `MiraConfig`, `PoolConfig`, `ResolvedMiraConfig`, `DriverMode`, `DriverOptions`, `MiraLogger`, `FromEnvOptions`, plus the 2.1 types.
- Query layer, unchanged: `OracleCollection`, `QueryBuilder`, `OracleSchema`, `OracleDCL`, `Transaction`, `defineTable`, `t`, `relations`, `createMigrator`, `sql`, `onQuery`, the builders and parsers, and all 2.1 types.

**Removed:**

| 2.x | 3.0 replacement |
|---|---|
| `createDb("appDb")` | `createMira(config).db()` |
| Built-in `appDb` / `appDbBulk` pools from `APP_DB_*`, `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME`, `APP_POOL_*`, `APP_BULK_*` | pools in the config; `fromEnv()` reads `MIRA_DB_*` |
| `NODE_ENV=development` + `APP_TEST_DB_*` test-schema switch | the app picks its credentials |
| `DB_TYPE` / `createAdapter()` | none (Mira is Oracle only) |
| `POOL_NAMES`, `READINESS_GATING_POOLS` | `mira.config.poolNames`; readiness rules belong to the app |
| `db.closePool()` closing every pool in the process | closes that Mira instance (already so for `createMira` handles) |
| Mira's file logger, `ENABLE_CONSOLE_LOGS`, `LOG_*` variables | `logger` option / `setLogger()`; default console |
| Compiled-exe `.env` loading and PATH set-up | the app does it; pass `driver.binaryDir` |

---

## 4. Decisions

Each can be changed before 3d; say so in the PR.

- **D1. Default log sink = console, warnings and errors only.** Without a `logger`, `warning` → `console.warn`, `critical` → `console.error`, `notice` / `info` are dropped. A library should not create files or chatter by default. `logger: console` gives everything; `false` gives silence.
- **D2. `createDb` is removed, not deprecated.** The only app on Mira (CATHERINE) has its own copy of the adapter and does not install the package yet, so a shim has no one to protect. Internally `driver/db.ts` keeps building the handle.
- **D3. One driver per process.** Pools, the health monitor and the Oracle Client stay process-wide (node-oracledb's Thick mode is process-wide anyway). Several `createMira()` instances share them, separated by pool name.
- **D4. Compiled executables:** `driver.binaryDir` replaces Mira's own `IS_COMPILED` detection. The app knows where it staged the Thick binary; Mira no longer guesses from `Bun.main`.
- **D5. Package exports only `.`** (plus `./package.json`). Deep imports such as `@jm-paunlagui/mira/dist/...` are not supported; everything public is on the root. `src/` is not published, so the build emits no source or declaration maps.
- **D7. Lifecycle and health live on the instance**, filtered to its pools, rather than as process-wide exports; the monitor itself stays process-wide (D3).
- **D6. Messages stay templates in `shared/messages/`.** The "kept in sync with CATHERINE" note goes; CATHERINE keeps its own copy until step 4.

---

## 5. CATHERINE migration (step 4, outline)

Step by step in [MIGRATION-3.0.md](MIGRATION-3.0.md). In short:

1. `bun add @jm-paunlagui/mira@3`.
2. One `src/config/mira.ts` in CATHERINE: `createMira({ pools: { appDb, appDbBulk }, defaultPool: "appDb", driver: { libDir, binaryDir }, logger })`, with credentials from its existing env names, the 2.x TNS connect string (`buildTNSConnectString`) and its logger behind a small adapter (notice/warning/critical → info/warn/error).
3. Replace `createDb("appDb")` with `mira.db()` / `mira.db("appDbBulk")`; imports from `@jm-paunlagui/mira`.
4. Boot `initializePools()` → `mira.open()`; `ReadinessService` / `HealthStreamHub` / `AlertNotifierService` → `mira.health.*`; `TeardownSequence`'s `db.closeAll()` → `mira.close()`.
5. Delete CATHERINE's copies of the adapter and wrapper; keep its logger, `runtimePaths`, `requestContext` and readiness rules (`READINESS_GATING_POOLS`).

---

## 6. Rules that hold throughout

- `bun test` only; 100% line and function coverage on everything under `src/` that Mira ships (bunfig ignore list updated as files move).
- Six test folders under `test/` stay: unit, integration, performance, chaos, security, reliability.
- Every phase ends green: `bun run typecheck`, `bun run test:coverage`, `bun run build && node --env-file=.env test/node/smoke.cjs`.
