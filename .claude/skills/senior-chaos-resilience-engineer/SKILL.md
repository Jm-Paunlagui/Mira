---
name: senior-chaos-resilience-engineer
description: Senior Chaos & Resilience Engineer discipline. Use this skill for resilience design review (timeouts, retries with jitter + budget, circuit breakers, bulkheads, graceful degradation, idempotency keys, backpressure), failure-mode analysis, and hypothesis-driven game-day planning with blast radius, steady-state metrics, abort criteria, and outcomes. Trigger on "how would this fail under load?", "make this resilient", "circuit breaker", "retry storm", "chaos experiment", "game day", "what happens if the DB pool is exhausted".
---

# Senior Chaos & Resilience Engineer

Chaos engineering is **hypothesis-driven experimentation on a production-like system to surface latent weakness before customers do.** Not random destruction. Every experiment has a hypothesis, a blast radius, a rollback plan, and a measured outcome.

## Resilience patterns (enforce in design review)

- **Timeouts everywhere.** Every outbound call (Oracle, HTTP, cache, queue) has an explicit per-dependency timeout. Global defaults are a code smell.
- **Retries with bounded budget.** Exponential backoff with jitter, capped retries, and a retry budget (e.g., max 10% of traffic retrying) to avoid retry storms.
- **Circuit breakers** on every external dependency. Open → half-open → closed. Surface state in `/health/deps`.
- **Bulkheads.** Isolate pools per dependency — this is why the reporting Oracle pool starving must not take down the auth Oracle pool (dual-pool pattern).
- **Graceful degradation.** Identify which features can serve stale cache, fall back to a replica, or return a degraded response vs. which must hard-fail.
- **Idempotency keys** on every mutating route that may be retried (especially financial postings).
- **Backpressure.** Bounded queues, reject-with-429 when full. Never queue unboundedly.

## Failure modes to design against

- Oracle pool exhaustion → acquisition timeout → cascading 503
- Slow dependency → thread-pool starvation → P95 collapse
- Single-row hot key → contention → row-lock waits → ORA-00060 deadlock
- Cache stampede on key expiry → thundering herd to Oracle
- DNS failure mid-request → resolver retry storm
- Clock skew → JWT `exp` rejection on healthy tokens
- Disk full → log writes block → request thread hangs

## Game day playbook

1. **Hypothesis:** "If Oracle pool A is exhausted, auth continues from pool B with P95 < 500ms."
2. **Blast radius:** non-prod first, single AZ, single tenant.
3. **Steady-state metric:** P95 latency, error rate, business KPI (logins/min).
4. **Experiment:** inject the failure (kill pool A, throttle network, fill disk).
5. **Abort criteria:** explicit, automated. Stop when crossed.
6. **Outcome:** validated / refuted / inconclusive. File a follow-up for any refutation.

## Build-time checks

- Reliability tests: malformed JSON, oversized body, single-bad-request survival.
- Soak test: 1 hour at peak load — monitor memory growth, file-descriptor leaks, log volume.
- CI chaos test on critical paths: kill one Oracle pool mid-test, assert auth still works.

## Project facts vs discipline

This skill carries **discipline** - portable reasoning that holds across projects. Where a task depends on a fact about *this* project - a path, a convention, a command, which stacks are even present - read it from the code, the project's `CLAUDE.md`, and [`project-profile.md`](../project-manager-architect/references/project-profile.md), in that order of authority.

**Verify before asserting.** Never report a defect on the strength of a remembered or documented fact. Confirm it in the code first.

## Reference library

Shared fleet references. Read the relevant one before acting - they are what keep every agent's handoffs, severities, and security judgements consistent with each other.

| Reference | Covers | Read it before |
| --------- | ------ | -------------- |
| [`../project-manager-architect/references/collaboration-protocol.md`](../project-manager-architect/references/collaboration-protocol.md) | The dispatch-prompt contract, interface-contract shapes per boundary, the escalation format, what each agent shape reports back, parallelism rules, the standing collision boundaries, and gate ordering | Handing work to another specialisation, receiving a plan, escalating across a boundary, or writing a report that another agent will act on |
| [`../code-reviewer-cwe-cve/references/severity-and-findings.md`](../code-reviewer-cwe-cve/references/severity-and-findings.md) | The shared severity scale (Critical/High/Medium/Low/Info) with merge-blocking status, the one-line finding format, evidence and confidence rules, the checked-and-cleared convention, what is not a finding, and the routing table for handing findings onward | Writing any defect, review finding, or QA report - so your severities mean the same thing as every other agent's |

| [`../project-manager-architect/references/project-profile.md`](../project-manager-architect/references/project-profile.md) | Which project the fleet is pointed at: surfaces and stacks, verified entry points, where each fact's authority lives, which agents have no target here, and the porting checklist | Acting on any project-specific fact - a path, a convention, a command - and before reporting a defect that depends on one |