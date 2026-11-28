# Project Profile — Mira

**This is the swappable layer.** Everything else in the fleet is portable discipline; this file is the only place that knows which project the fleet is pointed at.

To move the fleet to a different project, replace this file. Do not edit the skills.

---

## 1. Authority order — keep this section verbatim

When a fact about this codebase matters, trust sources in this order:

1. **The code**, read now.
2. **The project's `CLAUDE.md`** or equivalent, which is close to the code and updated with it.
3. **This profile**, which is a navigation map, not a specification.
4. **The skill file**, which carries discipline and should not be asserting project facts at all.

Lower sources are hints for *where to look*. They are never evidence for a defect report. An agent that reports a defect on the strength of this file, without opening the code, is producing a false positive.

Documentation goes stale faster than anyone expects — including a large, well-maintained `CLAUDE.md`. Verify before asserting.

**Mira has no `CLAUDE.md`.** Level 2 is the file header comment at the top of each `src/` module (every module opens with one) plus `README.md`. Where a header and the code below it disagree, the code wins.

---

## 2. Identity

| | |
| - | - |
| **Project** | Mira (`@jm-paunlagui/mira` on npm) — a TypeScript library that gives MongoDB-style queries on Oracle: `createMira()` over node-oracledb pools, typed collections, aggregation pipelines, all compiled to Oracle SQL with bind variables. A **library**, not a server: there is no HTTP layer, no routes, no UI. |
| **Repo root** | `/Users/carolnicole/WebAndCloudDevelopment/Mira` |
| **Surfaces** | One: the library at the repo root (`package.json`). `sim/` and `test/` are not separately buildable — they run against `src/`. |
| **Version** | Read it from `package.json` `version`; do not trust a recorded number. |
| **VCS** | Git, single repo. Check the branch with `git branch --show-current`. Release history and open work: `CHANGELOG.md`, `docs/ROADMAP-*.md`. |
| **Fleet config** | `.claude/` at the repo root. This profile covers this repo only; resolve every path against it and never read facts from outside it. |
| **Lineage** | Mira is the successor of the `oracle-mongo-wrapper` that some skills mention: `src/` was `src/utils/oracle-mongo-wrapper/` before 3.0 (`CHANGELOG.md`, 3.0.0 "Layout"). Skills that say "oracle-mongo-wrapper" mean this codebase. (`src/utils/oracle-mongo-wrapper/` today is an untracked leftover holding only a `logs/` folder; it is not code.) |

---

## 3. Surfaces and stacks

### `.` — the library

| | |
| - | - |
| Stack | TypeScript (`typescript ~6.0`), `"type": "commonjs"`, runs on **Bun** (`packageManager: bun@1.4.5`, `engines.bun >=1.4`) and **Node** (`engines.node >=20`). Bun executes `src/**/*.ts` directly; `tsconfig.json` is type-check only (`noEmit`). The npm build is `tsconfig.build.json` → CommonJS + `.d.ts` in `dist/`. |
| Database | Oracle via `oracledb ^7.0.0` (node-oracledb), Thin and Thick mode. Driver mode and pools: `src/driver/oracle.ts`. No ORM underneath — Mira *is* the access layer. |
| Entry point | `src/index.ts` — the only public entry (`package.json` `main`/`exports` → `dist/index.js`, built from it). "Anything a user may import is re-exported here." A new public function must be added there. CLI: `src/cli/mira.ts` (`bin.mira` → `dist/cli/mira.js`). |
| App assembly | `src/driver/createMira.ts` (`createMira()` → pools, `db()`, `collection()`, `transaction()`); `src/driver/db.ts` (`withConnection` / `withTransaction` / `withBatchConnection`). |
| Authority doc | No `CLAUDE.md`. `README.md` (~1,900 lines, user-facing API docs), `SECURITY.md` (what is SQL by design vs bound), `CHANGELOG.md`, `docs/MIGRATION-3.0.md`. |
| Source layout | `src/{advanced, cli, config, core, driver, joins, migrate, parsers, pipeline, schema, shared, typed}` (+ the stray `utils/` above) |
| Tests | **`bun test` only** (`bunfig.toml` `[test]`). No Vitest, Jest or Mocha. Six categories, one folder each: `test/{unit, integration, performance, chaos, security, reliability}`. Helpers `test/helpers/{db,setup,stubs}.ts`; type tests `test/types/` (checked by `tsc`, not run); Node smoke `test/node/smoke.cjs`; packed-tarball check `test/package/run.sh`. Integration-style tests need a live Oracle. |
| Test command | `bun run test` (= `bun test/run.ts`, a wrapper that also prints a per-category scorecard); `bun run test:coverage`; per category `test:unit` … `test:reliability`; `bun run sim` (`sim/run.ts`); `bun run typecheck`; `bun run smoke:node`; `bun run test:package`. |
| Coverage gate | `bunfig.toml`: `coverageThreshold = { lines = 1.0, functions = 1.0 }` — 100% lines and functions; `src/shared/messages/**` is excluded. |
| CI | `.github/workflows/ci.yml`: type-check + build; a Windows job (Thick load, compiled executable); Oracle 23ai live jobs over a `driver: [thin, thick]` × `connect: [failover, easy]` matrix with `TZ: Asia/Manila`, each running the suite with coverage, the sim, the Node smoke test and the package check. Also `codeql.yml`, `dependency-review.yml`. |

### Not present in this project

No HTTP framework (no Express, Fastify, Nest), no frontend (no React, Vite, Next.js, Tailwind), no C#/.NET, no MongoDB (the API is MongoDB-*style*; the database is Oracle), no Dockerfile or Kubernetes manifests (CI's Oracle runs as a GitHub Actions service), no Python, Go or Rust, no ML/DL/LLM pipeline.

---

## 4. Where the facts live

| Fact | Authority |
| ---- | --------- |
| Public API surface | `src/index.ts` — the export list at the bottom is the definition |
| Error and log message text | `src/shared/messages/{oracleWrapper,oracle,miraConfig}.messages.ts` (catalogue, imported as `MSG`); error classes `MiraConfigError` (`src/config/defineConfig.ts`), `MiraValidationError` (`src/typed/validate.ts`), `MiraConcurrencyError` (`src/typed/model.ts`) |
| Logging | `src/shared/log.ts` (`setLogger`) — default is the console, warnings and errors only |
| What reaches SQL as text vs as binds | `SECURITY.md`, then the code: `src/shared/utils.ts` (`quoteIdentifier`, `sqlFragmentProblem`, `assertMaxDepth`, `inlineBinds`), `src/parsers/filterParser.ts` (`sanitizeFilter`) |
| Pools, driver mode, session time zone, money-safe fetch | `src/driver/oracle.ts` |
| Configuration and environment variables | `src/config/{fromEnv,defineConfig,types,connectString}.ts`; documented in `.env.example` |
| Query events (statement tracing) | `src/core/events.ts` (`onQuery`) |
| Typed tables, money columns | `src/typed/columns.ts` (`t.money()` = `NUMBER(19,4)`, read back as an exact string) |
| Migrations | `src/migrate/migrator.ts`, CLI in `src/cli/mira.ts` |
| Test conventions and coverage | `bunfig.toml`, `test/run.ts` (categories, `DEFECT:`/`SECURITY:` naming), `test/helpers/setup.ts` |
| Performance budgets | `test/performance/budgets.test.ts` (+ `buildBench.ts`) |
| Release plan and open items | `docs/ROADMAP-3.1.md` (current); `CHANGELOG.md` |
| Real-world scenario coverage | `sim/run.ts`, `sim/stages/`, `sim/RESEARCH.md` — the sim also checks that every public function is called |

---

## 5. Navigation shortcuts

- Every public function must be re-exported from `src/index.ts`, **and** called by the sim (`sim/run.ts` prints `API surface: n/n` and fails if any is unused).
- Driver initialisation is lazy: `oracledb` is required at module load but nothing initialises until the first pool (`initDriver` in `src/driver/oracle.ts`). Thick mode must be chosen before the first pool opens.
- Bun forces `TZ=UTC` inside `bun test` unless `TZ` is set; CI sets `Asia/Manila`. Time-zone behaviour must be checked under more than one zone (the roadmap names UTC, Asia/Manila, America/New_York).
- Live tests need an Oracle reachable through `MIRA_DB_*` variables (`fromEnv()`); test tables are prefixed `MIRA_` + a suite tag and dropped by each suite. The sim uses its own schema (`MIRA_SIM_*`).
- The local `.env` contents are **unverified** here by rule (never opened); its variable names may differ from `.env.example`.

---

## 6. Fleet applicability

| Applies here | Agents |
| ------------ | ------ |
| **Yes** | `senior-oracle-engineer` (+ planner), `senior-performance-engineer`, `senior-chaos-resilience-engineer`, `senior-cybersecurity-engineer`, `code-reviewer-cwe-cve`, `senior-test-engineer`, `senior-anti-pattern-auditor`, `senior-code-documentation-engineer`, `project-manager-architect` |
| **Conditionally** | `senior-accountant-mba` — only for money arithmetic in the library (`t.money()`, the money-safe fetch handler) and the sim's ledger/finance stages; there is no product finance logic. `senior-data-analytics-engineer` (+ planner) — only to review the correctness of analytics SQL Mira *generates* (window functions, ROLLUP/CUBE, pivot, CTEs); there is no warehouse or ELT pipeline. |
| **Not currently** | `senior-nodejs-engineer` (+ planner), `senior-nodejs-qa-engineer`, `senior-react-engineer` (+ planner), `senior-react-qa-engineer`, `senior-uiux-designer`, `senior-nextjs-engineer` (+ planner), `senior-nextjs-qa-engineer`, `senior-csharp-engineer` (+ planner), `senior-csharp-qa-engineer`, `senior-mongodb-engineer` (+ planner), `senior-docker-kubernetes-engineer` (+ planner), `senior-python-engineer`, `senior-go-engineer`, `senior-rust-engineer`, `senior-machine-learning-engineer` (+ planner), `senior-deep-learning-engineer` (+ planner), `senior-llm-engineer` (+ planner), `senior-ai-engineer` (+ planner) |

"Not currently" means **no target exists in this repo**, not that the agent is broken. Do not dispatch an inapplicable agent to "check anyway" — it has nothing to read and will invent findings.

**Near-misses to watch:**

- **MongoDB agents** keyword-match on "MongoDB-style". Mira has no MongoDB; its operators compile to Oracle SQL. Route to `senior-oracle-engineer`.
- **Node.js agents** keyword-match on Node/TypeScript. They carry Express backend discipline (middleware chain, controllers, constants buckets) — none of it exists in a library. Route general TypeScript library work to the applicable agents above.
- **`senior-test-engineer`** carries Vitest + Supertest discipline. Mira uses **`bun test` only** — Vitest and Mocha cannot measure coverage on Bun. Apply its test-design checklist; never its framework or file layout.
- **Docker/Kubernetes** may match on CI's Oracle service container. There is no image or manifest to review.

**Skill assertions that are false in this repo** (found by fleet-init doctor; the skills carry facts from another project). Do not report their absence as a defect:

- **No fixed pools.** `senior-oracle-engineer` names a dual-pool registry in `Backend/src/config/database.js` (`appDb` + `appDbBulk`). Mira has no such file: pool names are whatever the caller passes to `createMira({ pools })` (`src/config/types.ts`). `appDbBulk` appears only in doc examples.
- **No `AppError`, `catchAsync`, `ErrorHandlerMiddleware`, CSRF or middleware chain.** `code-reviewer-cwe-cve`, `senior-cybersecurity-engineer`, `senior-anti-pattern-auditor` and `project-manager-architect` check for them. A library has no request pipeline; Mira throws `Error`/`TypeError`/`RangeError` with text from the `MSG` catalogue, plus the three `Mira*Error` classes (§4).
- **File headers are mixed.** `senior-code-documentation-engineer` requires a `WHAT THIS FILE DOES` / `HOW IT WORKS` block on every file; 14 of 43 tracked `src` files use it, the rest use a `@fileoverview` or a plain header comment. Every file has *a* header; do not flag the other style as missing documentation.
- **No Vitest or Supertest** (`senior-test-engineer`): see the near-miss above.

---

## 7. Porting checklist

- [x] `.claude/` copied into the new repo
- [x] This file replaced and filled in (replaced the profile that was copied in with the fleet)
- [x] §3 lists every surface with a **verified** entry point
- [x] §4 points at code, not documentation, wherever possible
- [x] §6 updated so inapplicable agents are not dispatched
- [x] No skill file edited

Portable with no changes: the AI group (ML, DL, LLM, AI), the language agents (Python, Go, Rust), performance, chaos, accountant, docker-kubernetes, and every shared reference.
