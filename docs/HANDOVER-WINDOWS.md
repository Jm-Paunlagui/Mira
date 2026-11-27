# Windows handover: final 3.0 test before release

**Branch:** `feature/v3-restructure` (PR #36, held open) · **Head when written:** `4db39a1` + this file · **Date:** 2026-11-27

Everything that can run off Windows is green (see "Already passed"). What is left is CATHERINE's own platform: **Windows, Thick mode, Bun, and a compiled executable**. When every box under "Windows checklist" is ticked, say "merge #36". After that, `v3.0.0` is tagged, the GitHub release is created from the CHANGELOG, and you run `npm publish`.

---

## Already passed (Linux CI and macOS)

- CI on #36, after `4db39a1`: 13 of 13 checks. The live jobs are Thin and Thick, each over the 2.x failover descriptor and over plain Easy Connect, all in `TZ=Asia/Manila`. Type-check and build, CodeQL and dependency review also pass.
- Locally, Thin mode: 565 of 565 tests with 100% line and function coverage, in Manila and in UTC. The time-zone tests also pass in New York, across daylight saving.
- Locally, Thick mode (Instant Client 23.3, Easy Connect, Manila): 548 of 548 tests outside the chaos suite.
- Sim: all 177 public functions called, 366 of 366 checks. `bun run test:package` passes.

## What changed in the riskiest areas

1. **Session time zone.** Mira now opens each session in the process's own zone. 2.x forced `+00:00`, but under Bun that setting never reached the Oracle Client, so CATHERINE was already running this way. In Thick mode Mira sets the zone as a UTC offset such as `+08:00`; it uses no region name, because those give `ORA-01805`.
2. **Dead sessions.** When a Thick-mode call timeout kills a session, the connection is now dropped from the pool (`close({ drop: true })`). Before, the cleanup threw DPI-1010 and the pool slot leaked.
3. **Driver init is lazy.** The Oracle Client loads when the first pool opens, or when you call `initDriver()`. `ORACLE_INSTANT_CLIENT` is no longer read: pass `driver.libDir`, or use `MIRA_DRIVER_LIB_DIR` through `fromEnv`. The Windows DLL check is gone, so the directory goes to node-oracledb unchanged.
4. **Compiled executables.** Mira no longer detects `bun build --compile` and no longer loads `.env`. The app passes `driver.binaryDir` and loads its own `.env`.

---

## Setup

```powershell
git fetch
git checkout feature/v3-restructure
git pull
bun install
```

The `.env` file in the repo root (Bun loads it automatically) uses the 3.0 names. The 2.x names (`APP_DB_*`, `DB_HOST`, `ORACLE_INSTANT_CLIENT`) are not read any more.

```dotenv
MIRA_DB_USER=...
MIRA_DB_PASSWORD=...
MIRA_DB_CONNECT_STRING=host:1521/SERVICE    # or the 2.x TNS descriptor, on one line
MIRA_DB_POOL_MIN=5
MIRA_DB_POOL_MAX=20
MIRA_DB_QUEUE_MAX=40
MIRA_DB_POOL_TIMEOUT=30
MIRA_DRIVER_MODE=thick                       # thick fails loudly instead of falling back to Thin
MIRA_DRIVER_LIB_DIR=C:\oracle\instantclient_23_x
# optional, for bun run sim:
MIRA_SIM_DB_USERNAME=...
MIRA_SIM_DB_PASSWORD=...
MIRA_SIM_DB_CONNECT_STRING=...
```

To confirm that Thick mode really loaded:

```powershell
bun -e "const m=require('./src'); m.configureDriver({mode:'thick', libDir:process.env.MIRA_DRIVER_LIB_DIR}); console.log(m.initDriver())"
# expect: { mode: "thick", clientVersion: "23.x..." }
```

---

## Windows checklist

### A. Test suite in Thick mode

```powershell
$env:UV_THREADPOOL_SIZE = "32"   # Thick mode runs every call on a worker thread; CI uses 32
bun run typecheck
bun run test:coverage
```

- [ ] Typecheck is clean.
- [ ] Every test passes, with 0 unexpected failures in the scorecard.
- [ ] Coverage is 100% for lines and functions. Some Thin-only branches may show as uncovered in Thick mode; if so, note which ones, but CI (Thin) is the coverage bar.

### B. Time zones (the biggest behaviour change)

```powershell
bun run test:integration    # in the Windows system zone (Philippines = +08:00)
$env:TZ = "Asia/Manila"; bun test test/integration/timeZones.test.ts
$env:TZ = "UTC";         bun test test/integration/timeZones.test.ts
Remove-Item Env:TZ
```

- [ ] `timeZones.test.ts` passes in each zone.
- [ ] In CATHERINE, or in a quick script, a `Date` written to a `TIMESTAMP WITH TIME ZONE` column and to a `TIMESTAMP WITH LOCAL TIME ZONE` column reads back with the same `getTime()`.
- [ ] Existing CATHERINE rows written by 2.x read back with the same values as before. Under Bun, 2.x's `+00:00` never applied, so nothing should move. If something does move, stop and report it.

### C. Chaos suite (the Bun crash check)

```powershell
bun run test:chaos
```

- [ ] It passes without a crash or a hang. On macOS, Bun 1.4.5 with Instant Client segfaulted intermittently here (exit code 139). That is a Bun bug, not Mira's, but if it happens on Windows it matters for CATHERINE. Run it 2 or 3 times, and keep the `bun.report` link if it crashes.

### D. Sim and package check

```powershell
bun run sim                # needs the MIRA_SIM_* variables and a separate schema
bash test/package/run.sh   # Git Bash; it reads MIRA_DB_* and unsets them for the app
```

- [ ] The sim calls 177 of 177 functions and passes every check.
- [ ] The package check passes.

### E. Compiled executable (how CATHERINE ships)

You can do this inside CATHERINE, or with a scratch app outside the repo. In the scratch app, install the packed tarball with `npm pack` in the Mira repo, then `bun add <path-to-tgz>` in the app.

```ts
// app.ts
import path from "node:path";
import fs from "node:fs";
import { createMira } from "@jm-paunlagui/mira";

const exeDir = path.dirname(process.execPath);
// Load .env from beside the exe yourself; Mira no longer does it.
// Strip surrounding quotes as Bun's own loader does: a quoted MIRA_DRIVER_LIB_DIR
// ("C:\oracle\...") otherwise reaches libDir with its quotes and fails with DPI-1047.
for (const line of fs.readFileSync(path.join(exeDir, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}
const env = process.env;
const mira = createMira({
    pools: { appDb: { user: env.MIRA_DB_USER!, password: env.MIRA_DB_PASSWORD!, connectString: env.MIRA_DB_CONNECT_STRING!, poolMin: 1, poolMax: 4 } },
    driver: { mode: "thick", libDir: env.MIRA_DRIVER_LIB_DIR, binaryDir: path.join(exeDir, "node_modules", "oracledb", "build", "Release") },
});
console.log(await mira.open());
const [row] = await mira.db().withConnection(async (c) => (await c.execute("SELECT SESSIONTIMEZONE tz, SYSTIMESTAMP ts FROM dual", [], { outFormat: 4002 })).rows!);
console.log(row, await mira.stats());
await mira.close();
```

```powershell
bun build app.ts --compile --outfile dist\app.exe
# beside app.exe: .env, and node_modules\oracledb\build\Release\*.node copied from the app's node_modules
.\dist\app.exe
```

- [ ] `open()` reports `success: true`, and Thick mode loads from `binaryDir`.
- [ ] `SESSIONTIMEZONE` is the process's offset (`+08:00`).
- [ ] `close()` returns quickly and the process exits by itself.
- [ ] The same in CATHERINE's own build after the swap (see `docs/MIGRATION-3.0.md` §7), if you want to go that far before release.

---

## Reporting back

- **All boxes ticked:** say "merge #36".
- **Anything failed:** give the command, the failing test name, and the first error lines (the `ORA-` / `NJS-` / `DPI-` code). Leave `.env` values out.
- Windows-only fixes go on `feature/v3-restructure` and #36 gets re-checked in CI before the merge.

## Known limitations (documented, not blockers)

- In Thick mode in a daylight-saving zone, Dates from the other season move by one hour, so such processes should run on UTC. Manila has no DST, so this does not affect CATHERINE.
- Pool options you leave out use Mira's defaults (10 / 50 / 40), not 2.x's 5 / 20 / 40. Set them explicitly.
