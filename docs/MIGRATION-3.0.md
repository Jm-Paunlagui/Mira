# Upgrading to Mira 3.0

Mira 3.0 is a standalone library: your app passes its pools in, and Mira reads no environment variable, writes no log file and initialises no driver unless asked. The query API (collections, pipelines, typed tables, migrations) is unchanged. What changes is how you connect, configure the driver, log, and shut down.

This guide is for apps on 2.x, and for apps that carry a copy of Mira's adapter and wrapper in their own `src/` (as CATHERINE does): the copy is replaced by the package.

---

## 1. Install

```bash
bun add @jm-paunlagui/mira@3     # or: npm install @jm-paunlagui/mira@3
```

Import everything from the package root. Deep paths (`.../dist/...`, `src/utils/oracle-mongo-wrapper/...`) are not part of the API.

## 2. One config module

Create the Mira instance once, in one module, and import it wherever you used `createDb()`.

```ts
// src/config/mira.ts
import { createMira, buildTNSConnectString } from "@jm-paunlagui/mira";

const env = process.env;
// 2.x always connected through this TNS descriptor (SID, load balancing, SELECT failover).
// Keep it to connect exactly as before, or switch to Easy Connect ("host:1521/SERVICE").
const connectString = buildTNSConnectString(env.DB_HOST, env.DB_PORT, env.DB_APP_SERVICE_NAME);
const credentials = { user: env.APP_DB_USERNAME!, password: env.APP_DB_PASSWORD!, connectString };

export const mira = createMira({
    pools: {
        // 2.x defaults, so behaviour does not move; tune as you like.
        appDb: { ...credentials, poolMin: 5, poolMax: 20, queueMax: 40, poolTimeout: 30 },
        appDbBulk: { ...credentials, poolMin: 1, poolMax: 6, queueMax: 24, queueTimeout: 30000, connectTimeout: 20000 },
    },
    defaultPool: "appDb",
    driver: { mode: "auto", libDir: env.ORACLE_INSTANT_CLIENT || undefined },
    logger: appLogger, // see §5
});
```

Your app keeps its own variable names: Mira never sees them. To use Mira's instead, `createMira(fromEnv())` reads `MIRA_DB_*` (table in §8).

**Test schema.** 2.x switched `appDb` / `appDbBulk` to `APP_TEST_DB_*` when `NODE_ENV=development`. That switch is gone: choose the credentials in your config module.

## 3. Replace `createDb`

| 2.x | 3.0 |
| --- | --- |
| `createDb("appDb")` / `createDb()` | `mira.db()` |
| `createDb("appDbBulk")` | `mira.db("appDbBulk")` |
| `new OracleCollection("T", createDb("appDb"))` | `mira.collection("T")` (or `new OracleCollection("T", mira.db())`) |
| `new OracleSchema(db)`, `new OracleDCL(db)`, `new Transaction(db)` | `mira.schema()`, `mira.dcl()`, `mira.transaction()` (the classes still work with `mira.db()`) |
| `Orders.on(createDb("appDb"))` | `Orders.on(mira.db())` |
| `createPerformance(db)`, `createMigrator(db)` | unchanged, with `mira.db()` |
| the db handle's type | `MiraDb` (exported) |

## 4. Lifecycle and health

Everything the 2.x adapter exported for boot, readiness and shutdown is on the instance, scoped to its pools.

| 2.x adapter (`config` / `db` object) | 3.0 |
| --- | --- |
| `initializePools()` | `await mira.open()`: `[{ name, success, error? }]` |
| `closeAll()` | `await mira.close()` |
| `getPoolStats()` | `await mira.stats()` |
| `isPoolHealthy(name)` | `mira.health.isHealthy(name)` (or `mira.db(name).isHealthy()`) |
| `allPoolsHealthy()` | `mira.health.allHealthy()` |
| `getHealthMetrics()` | `mira.health.metrics()` |
| `onPoolHealthChange(fn)` | `mira.health.onChange(fn)`: returns an unsubscribe function |
| `onPoolHealthCheck(fn)` | `mira.health.onCheck(fn)` |
| `setPoolHealthWatched(on)` | `mira.health.watch(on)` |
| `recordProbeSuccess(name)` | `mira.health.recordProbeSuccess(name)` |
| `nudgePoolHealth(name)` | `mira.health.nudge(name)` |
| `withConnection(name, fn)` / `withTransaction` / `withBatchConnection` | `mira.db(name).withConnection(fn)` … |
| `POOL_NAMES` | `mira.config.poolNames` |
| `READINESS_GATING_POOLS` | your app's own constant (e.g. `["appDb"]`); Mira never read it |

After `mira.close()`, a handle you kept reports `isHealthy() === false` and rejects work with "This Mira instance is closed". `close()` also removes the health listeners the instance added and turns off a watch it started.

## 5. Logging

Mira's file logger is gone, with `LOG_*`, `ENABLE_CONSOLE_LOGS`, `DOCKER_CONTAINER` and `DATA_SIGNING_SECRET`. Without a `logger`, Mira writes warnings to `console.warn` and failures to `console.error`, and nothing else. Pass your own logger to keep Mira's lines in your logs. Mira calls `debug` (optional), `info`, `warn` and `error`; an app logger with different method names needs a small adapter:

```ts
// CATHERINE's logger has notice / warning / critical
const appLogger = {
    debug: (m: string, ...a: unknown[]) => logger.debug(m, ...a),
    info: (m: string, ...a: unknown[]) => logger.notice(m, ...a),
    warn: (m: string, ...a: unknown[]) => logger.warning(m, ...a),
    error: (m: string, ...a: unknown[]) => logger.critical(m, ...a),
};
```

A logger that records the calling function from the stack trace will now name this adapter, not Mira's internals.

## 6. Driver: Thin or Thick

- `ORACLE_INSTANT_CLIENT` is no longer read. Pass the directory as `driver.libDir` (or read `MIRA_DRIVER_LIB_DIR` with `fromEnv`). Without one, `"auto"` tries the system library path and falls back to Thin.
- The Windows-only DLL check is gone: a `libDir` is handed to node-oracledb as is.
- Code that read `oracledb.oracleClientVersion` or `ORA_SDTZ` at import time: the driver now initialises when the first pool opens. Call `initDriver()` first; it returns `{ mode, clientVersion }`.
- `"thick"` throws if the client cannot load, instead of falling back.

## 7. Compiled executables (`bun build --compile`)

Mira no longer detects a compiled executable or loads `.env` beside it. Your app does both:

```ts
import path from "node:path";
const exeDir = path.dirname(process.execPath);
// load .env from disk yourself (never bake it into the executable), then:
createMira({ pools, driver: { binaryDir: path.join(exeDir, "node_modules", "oracledb", "build", "Release") } });
```

The 2.x whitespace collapse of a multi-line connect string is gone too: pass the connect string on one line.

## 8. Variables

Only if you use `fromEnv()` (or Mira's CLI and test suite):

| 2.x | 3.0 (`fromEnv`) |
| --- | --- |
| `APP_DB_USERNAME`, `APP_DB_PASSWORD` | `MIRA_DB_USER`, `MIRA_DB_PASSWORD` |
| `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME` (used as a SID) | `MIRA_DB_CONNECT_STRING`, or `MIRA_DB_HOST` + `MIRA_DB_PORT` + `MIRA_DB_SERVICE` (a service name, Easy Connect) |
| `APP_POOL_MIN` / `_MAX`, `APP_QUEUE_MAX`, `APP_POOL_TIMEOUT` | `MIRA_DB_POOL_MIN` / `_MAX`, `MIRA_DB_QUEUE_MAX`, `MIRA_DB_POOL_TIMEOUT` |
| `APP_BULK_*` | a second prefix: `fromEnv({ pools: { appDb: "MIRA_DB", appDbBulk: "MIRA_BULK" }, defaultPool: "appDb" })` |
| `ORACLE_INSTANT_CLIENT` | `MIRA_DRIVER_LIB_DIR` (and `MIRA_DRIVER_MODE`) |
| `DB_TYPE`, `APP_TEST_DB_*`, `DB_TEST_*`, `LOG_*`, `ENABLE_CONSOLE_LOGS` | gone |

A blank variable counts as unset; a number that does not parse throws, naming the variable.

## 9. Behaviour to re-check

- **Session time zone.** 2.x forced every session to `+00:00`; 3.0 opens it in the process's zone, the only setting under which a JS `Date` keeps its instant in a `TIMESTAMP WITH (LOCAL) TIME ZONE` column. On a server running on UTC nothing changes. Elsewhere, under Node, 2.x had been moving such Dates by the process's offset; under Bun (CATHERINE) its `ORA_SDTZ` change never took effect, so 3.0 behaves exactly as CATHERINE already did. SQL using `CURRENT_TIMESTAMP` / `LOCALTIMESTAMP` now sees the process's zone. In Thick mode in a daylight-saving zone, run the process on UTC.
- **Pool defaults.** Fields you leave out use Mira's pool defaults (min 10, max 50, queue 40). 2.x's env-driven pools defaulted to 5 / 20 / 40; set them explicitly (as in §2) to keep that.
- **Missing credentials** always throw; the 2.x development-mode "placeholder" pass is gone.
- **Config typos** throw: `MiraConfigError` lists every problem in `err.issues`.
- **One driver per process.** Two instances asking for different driver modes: the second is refused.
- **One logger per process.** A second instance with a different logger is refused while the first is live.

## Checklist

- [ ] `@jm-paunlagui/mira@3` installed; copied adapter / wrapper deleted
- [ ] One `createMira()` config module; credentials from your own variables
- [ ] `createDb(...)` → `mira.db(...)` everywhere; imports from the package root
- [ ] Boot: `await mira.open()`; shutdown: `await mira.close()`
- [ ] Readiness / health code moved to `mira.health.*`; `READINESS_GATING_POOLS` is the app's
- [ ] App logger passed as `logger` (with an adapter if its methods differ)
- [ ] Thick mode: `driver.libDir`; compiled executable: `driver.binaryDir` and your own `.env` loading
- [ ] Pool sizes set explicitly where the 2.x defaults mattered
