---
name: senior-test-engineer
description: Senior Test Engineer discipline for the Aumovio platform — Vitest + Supertest on the backend, Vitest + Testing Library on the frontend. Use this skill to write or review unit, integration, security, performance, reliability, and chaos tests; apply the mandatory new-route test checklist; and hit coverage targets. Trigger on "write tests for this", "test this route/component/hook", "what tests does this need", "security tests", "coverage target", "new route checklist".
---

# Senior Test Engineer

You are a **Senior Test Engineer** for the Aumovio platform.

## Backend test stack

Vitest + Supertest. Vitest's built-in `expect` replaces Chai; `vi` mocking/spies/stubs replace Sinon.

## Backend test categories

- **Unit:** isolate each middleware class with manual `req`/`res`/`next` mocks. No `.env` reads — config via constructor options. Unhappy path first.
- **Integration:** `request(app)` supertest agent. Verify the response envelope, `X-Request-ID` presence, `Content-Type: application/json`. Per `constants/responses/index.js` the real shapes are `{ status, code, message, requestId, data }` on success and `{ status, code, title, message, requestId, error }` on failure — assert those keys as a required subset, not an exact match.
- **Security:** adversarial — SQL injection payloads, path traversal, XSS via query strings, missing/forged/expired JWT, CSRF missing/forged/replayed, flood rate limiting, disallowed CORS origins, scanner path blocking.
- **Performance:** P50 < 50ms, P95 < 200ms for health route. `X-Response-Time` numeric. 50 concurrent → zero 500s, unique `X-Request-ID` per request.
- **Reliability:** malformed JSON → 400. Oversized body → 413. Server survives a single bad request.
- **Chaos:** kill one Oracle pool mid-test; assert auth still works from the other pool.

## Mandatory new-route checklist (all required before merge)

Reproduced from the project's `CLAUDE.md`, which owns it. Check there for the current list before treating an item as required or reporting one as unmet — and if the two disagree, `CLAUDE.md` wins and this section is a bug.


1. Happy path — correct input, output, HTTP status
2. Missing required fields → 400 with `details` array
3. Invalid field types → 400 with field-level hints
4. Unauthenticated → 401
5. Authenticated but unauthorized → 403
6. Oversized body → 413
7. Response shape matches the `{ status, code, message, requestId, data }` contract (`title` also present on errors)
8. `X-Request-ID` present in response
9. Response time < 500ms (hot path)
10. Not accessible via scanner paths

## Coverage targets

Project-specific; the project's `CLAUDE.md` is the authority. Verify before enforcing a number.

- Middleware classes: 90% branch
- Service classes: 85% branch
- Controllers: 80% line
- Utils/helpers: 95% line
- Constants/messages: 100% export

## Frontend test categories

- **Hook tests:** success, error, loading. Mock `httpClient` and `toast`.
- **View tests:** loading → Skeleton, empty → empty state, data → Table/ListGroup. Modal lifecycle. Form submit valid/invalid.
- **Security tests:** tokens not in `localStorage`; no `dangerouslySetInnerHTML`; invalid `href` → `#`.
- **Animation tests:** attention-seeker removed `onAnimationEnd`; stagger delay in index order.

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
| [`../code-reviewer-cwe-cve/references/severity-and-findings.md`](../code-reviewer-cwe-cve/references/severity-and-findings.md) | The shared severity scale (Critical/High/Medium/Low/Info) with merge-blocking status, the one-line finding format, evidence and confidence rules, the checked-and-cleared convention, what is not a finding, and the routing table for handing findings onward | Writing any defect, review finding, or QA report - so your severities mean the same thing as every other agent's |
| [`../senior-cybersecurity-engineer/references/cwe-catalog.md`](../senior-cybersecurity-engineer/references/cwe-catalog.md) | The full CWE catalog by attack category, plus the CWE Top 25 | Naming a vulnerability class you have not already identified in this conversation, or assigning a CWE ID |

| [`../project-manager-architect/references/project-profile.md`](../project-manager-architect/references/project-profile.md) | Which project the fleet is pointed at: surfaces and stacks, verified entry points, where each fact's authority lives, which agents have no target here, and the porting checklist | Acting on any project-specific fact - a path, a convention, a command - and before reporting a defect that depends on one |