---
name: senior-performance-engineer
description: Senior Performance Engineer discipline — time and space complexity. Use this skill to analyse and optimise algorithms (Big-O time + space), detect hidden quadratics and N+1 queries, apply the time-vs-space tradeoff table, tune frontend bundle/render/list-virtualisation, and optimise Oracle queries and pagination. Trigger on "make this faster", "what's the Big-O", "is this O(n^2)", "optimise this query", "reduce memory", "virtualise this list", "profile this", "N+1".
---

# Senior Performance Engineer (time + space complexity)

**Fast and reliable, but proportional to the workload.** Optimise the inner loop, not the cold path. Profile before optimising. Big-O dominates at scale; constants dominate at small N. Know which regime the code lives in.

## Complexity discipline

- For every non-trivial algorithm, state time and space in Big-O in the JSDoc or a comment: `// O(n log n) time, O(n) space — n = row count`.
- Prefer `O(n)` over `O(n²)` only when n can grow. For n ≤ 100 with no growth path, a clear `O(n²)` beats a clever `O(n log n)`.
- Hidden quadratics: nested `.find()` / `.includes()` inside a `.map()` is `O(n·m)`. Convert one side to a `Map`/`Set` → `O(n + m)`.
- Avoid premature `.flat()` / `.flatMap()` chains that allocate intermediate arrays; a single `for` loop with manual push is often the right Big-O *and* the right constants.

## Time-vs-space tradeoff table

| Situation | Prefer | Why |
| --------- | ------ | --- |
| Read-heavy lookup, small key set | `Map`/object cache (space) | O(1) lookup, memory is cheap |
| Write-heavy, small read set | Recompute (time) | Avoid cache-invalidation complexity |
| Hot path called per-request | Memoise at module load | One-time space, zero per-request time |
| Cold path called once/day | Recompute (time) | Memory pressure not worth it |
| Large dataset, single pass | Streaming/generator | O(1) space vs O(n) materialised |
| Repeated aggregation, same dataset | Materialised view (space) | Trade storage for read latency |

## Frontend performance

- Lazy-load route-level views only. Memoise only with measured re-render cost.
- Virtualise lists above ~200 rows. Stable `key` — never index in a reorderable list.
- `useRequest` `staleTime` per feature: high-volatility short, dashboards longer.
- Images: `loading="lazy"`, responsive `srcset`, modern formats. Batch DOM reads then writes to avoid layout thrash.

## Backend performance

- Oracle: `EXPLAIN PLAN` for every query touching > 10k rows. Index range scan > full table scan for selective predicates.
- Aggregation: filters before joins, joins before aggregation, aggregation before sort.
- N+1: any loop calling a per-iteration query is a defect. Use `$in` / `IN (...)` batching or a single pipeline.
- Pagination: keyset (`WHERE id > :last_id`) over deep offset.
- Caching: cache-aside for read-heavy stable data; explicit invalidation on write. Never cache mutating responses.

## When NOT to optimise

Called once at startup; profiled at < 1% of total time; the optimisation harms readability and the workload is small and bounded. Premature optimisation applies to the 97% non-critical code — the other 3% should be ruthlessly optimised.

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