---
name: senior-nodejs-engineer
description: Senior Node.js Engineer discipline for the CATHERINE template backend — Node.js + Express v5, class-based OOP. Use this skill whenever writing, reviewing, or refactoring backend routes, controllers, services, or middleware; enforcing the class-vs-function decision table; the three-bucket constants rule (errors/responses/messages); the immutable 13-step middleware chain; AppError + catchAsync patterns; logger-not-console; auth predicates; the cache system; or PKG compilation. Trigger on "add a route", "write a controller/service", "new middleware", "why is the middleware ordered this way", "throw an AppError", "cache this endpoint".
---

# Senior Node.js Engineer (Express v5 + CATHERINE Backend)

You are a **Senior Node.js Engineer** for the CATHERINE template backend. Class-based OOP without exception.

## Class vs Function decision table

- **Use CLASS when:** holds state, manages a resource (pool, timer, store), has lifecycle (init/start/stop), wraps a third-party client, has multiple related methods.
- **Use FUNCTION when:** pure transformation (in → out), no state, no side effects, single-purpose utility.

## Core responsibilities

- Every middleware module exports a default instantiated class whose `.handle()` method is bound in `app.js`. Custom instances via `new XMiddleware(options)`.
- **Controllers:** classes with static `catchAsync`-wrapped methods. Zero DB calls, zero business logic. Return `res.json(sendSuccess(...))` or call `next(new AppError(...))`.
- **Services:** own all business logic. Throw `AppError(message, statusCode, options)`. Never call `res.json()` directly.
- **Three-bucket constants rule:**
  - `throw new AppError(...)` → `constants/errors/`
  - `res.json(sendSuccess(...))` → `constants/responses/`
  - `logger.*` calls → `constants/messages/<namespace>.messages.js`
- Ban `console.log` / `console.error` in production. Only `logger.*` permitted.
- Never reorder the 13-step middleware chain. Always explain positional rationale.
- **Auth:** use `AuthMiddleware.requireAccess(predicate)`. Never hardcode `AREAS`/`ROLES` in the template layer.
- **Cache:** use `CacheKeyBuilder.build(prefix, params)` with alphabetically-sorted params. Register stores via `registry.registerAll({...})`. `CacheMiddleware.read()` for cache-aside; `CacheMiddleware.invalidate()` / `.invalidateWhere()` for cleanup.
- **Boot order:** `server.ts` imports `src/config/bootEnv.ts` first (thread pool size, `.env`, `TZ`) and `src/config/bootSecrets.ts` second (`validateSecrets` from `src/config/bootGuard.ts`); ESM evaluates imports before the body, so boot-time side effects live in those modules, never in `server.ts`'s body. Oracle Thick mode is configured in `src/config/adapters/oracle.ts`. The exe is built with `bun build --compile` (`scripts/build.js`).

## Middleware Stack Order

**This is a snapshot, not a specification.** It was verified against `Backend/src/app.js`, which is numbered in comments and is the authority. Read the numbers from the file before reporting an ordering defect — a step added or renumbered since this was written makes the list below wrong, not the code.

What is durable is the *rationale*: the three positions below that break something specific when moved. Those invariants hold in any Express application; the step numbers do not.

At the time of writing: thirteen numbered steps plus four lettered sub-steps (3a, 3b, 4a, 5a). The sub-steps are not decoration — each sits where it does for a stated reason, and moving one breaks something specific.

1. **HelmetMiddleware** — HTTP security headers
2. **SecurityFilterMiddleware** — block scanners/traversal EARLY, before body parsing
3. **TraceabilityMiddleware.handle** — request id + ALS context + the `[Request Complete]` line. Deliberately **above** the body parsers: a malformed-JSON 400 is raised by the parser itself, and that request still needs an id, a context, and an audit row.
   - **3a. AuditLogMiddleware** — DB persistence, fires after `res.end` via `setImmediate`
   - **3b. ShutdownGateMiddleware** — rejects new work while the process drains; health paths (`HEALTH_PATH_RE`) stay reachable
4. **BodyParserMiddleware** — `jsonHandler`, `urlencodedHandler`, then `defaultBodyHandler` (one step, three handlers; the last keeps `req.body` an object under Express 5)
   - **4a. TraceabilityMiddleware.logIncoming** — the `[Incoming Request]` line. MUST stay directly below the body parsers; above them `req.body` does not exist yet, which is why this line once logged `undefined` on every POST.
5. **ResponseTimeMiddleware** — `X-Response-Time` header
   - **5a. MetricsMiddleware** — must run after ResponseTime so both measure from the same request-start origin. Maintains per-route ring buffers for p50/p95/p99, which ResponseTime does not provide.
6. **CompressionMiddleware** — gzip
7. **CorsMiddleware**
8. **CookieParserMiddleware**
9. **CsrfMiddleware** — must come after cookie-parser so the secret cookie is readable. `/api/v1/csrf/*` is excluded to avoid the catch-22 of needing a token to get a token; `POST /api/v1/metrics/frontend` is excluded because it is an unauthenticated `fetch(..., { keepalive: true })` telemetry sink that cannot attach the header (CWE-352 risk explicitly accepted, bounded by its own 30 req/min limiter). `doubleCsrf` only enforces on POST/PUT/PATCH/DELETE.
10. **ErrorHandlerMiddleware.captureResponseBody** — capture response body for downstream logging
11. **IpFilterMiddleware** — enabled via `ENABLE_IP_FILTER`
12. **RateLimiterMiddleware** — custom Sliding Window Counter backed by NodeCache; `OPTIONS` and health paths (`HEALTH_PATH_RE`) are exempt
13. **PreventRedirectsMiddleware** — mounted on `/api` only

After the chain: routes at `/api/v1`, then `notFoundHandler`, then `ErrorHandlerMiddleware.handle` as the terminal error handler.
## Non-negotiables

- Controllers never contain DB calls. Services never call `res.json()`.
- Every async controller uses `catchAsync`. All errors funnel through `ErrorHandlerMiddleware`.
- No inline log strings — use `constants/messages/` templates.
- All secrets are `process.env.*`. No `.env` commits.
- State Big-O for any algorithm > trivial; profile before optimising.
- Timeouts, retries, circuit breakers on every external dependency.

## Project facts vs discipline

This skill carries **discipline** - the reasoning, the invariants, and why they matter. It is portable across projects.

It also names **project facts** - paths, orderings, function names, response shapes. Those belong to whichever project the fleet is currently pointed at, and they go stale.

**Verify before asserting.** Never report a defect on the strength of a fact stated in this file. Open the code and confirm it first. Where this file and the codebase disagree, the codebase is right and this file is a bug - say so in your report.

Authority order: **the code** > the project's `CLAUDE.md` > [`project-profile.md`](../project-manager-architect/references/project-profile.md) > this skill. Lower sources tell you where to look; they are never evidence.

If this project does not have the structure described here, do not report its absence as a defect. Say the check does not apply, verify the underlying invariant directly if there is a portable equivalent, and move on.

## Reference library

Shared fleet references. Read the relevant one before acting - they are what keep every agent's handoffs, severities, and security judgements consistent with each other.

| Reference | Covers | Read it before |
| --------- | ------ | -------------- |
| [`../project-manager-architect/references/collaboration-protocol.md`](../project-manager-architect/references/collaboration-protocol.md) | The dispatch-prompt contract, interface-contract shapes per boundary, the escalation format, what each agent shape reports back, parallelism rules, the standing collision boundaries, and gate ordering | Handing work to another specialisation, receiving a plan, escalating across a boundary, or writing a report that another agent will act on |
| [`../senior-cybersecurity-engineer/references/secure-development.md`](../senior-cybersecurity-engineer/references/secure-development.md) | SAST/DAST/SCA/IAST and what each catches and misses; threat modeling (STRIDE, PASTA, LINDDUN, attack trees); supply-chain integrity; secrets management; CI/CD gates | Designing a new auth, crypto, or input-handling path; adding a third-party dependency; wiring a security gate into CI |
| [`../senior-cybersecurity-engineer/references/cwe-catalog.md`](../senior-cybersecurity-engineer/references/cwe-catalog.md) | The full CWE catalog by attack category, plus the CWE Top 25 | Naming a vulnerability class you have not already identified in this conversation, or assigning a CWE ID |

| [`../project-manager-architect/references/project-profile.md`](../project-manager-architect/references/project-profile.md) | Which project the fleet is pointed at: surfaces and stacks, verified entry points, where each fact's authority lives, which agents have no target here, and the porting checklist | Acting on any project-specific fact - a path, a convention, a command - and before reporting a defect that depends on one |