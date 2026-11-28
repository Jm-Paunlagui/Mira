# Project Profile — TEMPLATE

Copy this over `project-profile.md` when pointing the fleet at a new project, then fill it in. **Leave every skill file untouched** — if a project fact seems to need a skill edit, it belongs here instead.

---

## 1. Authority order — keep this section verbatim

When a fact about this codebase matters, trust sources in this order:

1. **The code**, read now.
2. **The project's `CLAUDE.md`** or equivalent, which is close to the code and updated with it.
3. **This profile**, which is a navigation map, not a specification.
4. **The skill file**, which carries discipline and should not be asserting project facts at all.

Lower sources are hints for *where to look*. They are never evidence for a defect report. An agent that reports a defect on the strength of this file, without opening the code, is producing a false positive.

Documentation goes stale faster than anyone expects — including a large, well-maintained `CLAUDE.md`. Verify before asserting.

---

## 2. Identity

| | |
| - | - |
| **Project** | `<name — and one line on what it does>` |
| **Repo root** | `<absolute path>` |
| **Surfaces** | `<top-level apps/packages, e.g. api, web, worker>` |
| **Fleet config** | `<path to .claude/>` |

---

## 3. Surfaces and stacks

Repeat this block per surface. Delete the ones that do not apply.

### `<surface>` — `<role>`

| | |
| - | - |
| Stack | `<language, framework + major version, notable architecture style>` |
| Database | `<engine, and any access layer or ORM>` |
| Entry point | `<exact path — check it, entry points are often not where you would guess>` |
| App assembly | `<where routing/middleware/composition happens>` |
| Authority doc | `<path to CLAUDE.md or equivalent, and rough size>` |
| Source layout | `<top-level dirs under src>` |
| Tests | `<framework, and the directory they actually live in>` |
| Test command | `<the real command from package.json / Makefile / etc.>` |

### Not present in this project

`<List the stacks with no target here. Be explicit — this is what stops the orchestrator dispatching an agent that has nothing to read.>`

---

## 4. Where the facts live

The point of this table: skills must not restate these. List every fact an agent is likely to want, and the authority for it. Prefer the code over a document wherever the code is readable.

| Fact | Authority |
| ---- | --------- |
| `<e.g. request/response envelope>` | `<exact file — the code, not the doc>` |
| `<e.g. error shape>` | `<...>` |
| `<e.g. auth model>` | `<...>` |
| `<e.g. logging conventions>` | `<...>` |
| `<e.g. schema and migrations>` | `<...>` |
| `<e.g. test checklist and coverage targets>` | `<...>` |
| `<e.g. design tokens / component library>` | `<...>` |
| `<e.g. environment variables>` | `<...>` |

---

## 5. Navigation shortcuts

Facts agents need in order to *find* things — not to assert them. Keep this short; every line here is a maintenance liability.

- `<e.g. boot order invariant and which file holds it>`
- `<e.g. where tests actually live, if it is not the obvious path>`
- `<e.g. a load-order or registration invariant that is easy to break>`

---

## 6. Fleet applicability

| Applies here | Agents |
| ------------ | ------ |
| **Yes** | `<list>` |
| **Not currently** | `<list>` |

"Not currently" means **no target exists in this repo**, not that the agent is broken. Do not dispatch an inapplicable agent to "check anyway" — it has nothing to read and will invent findings.

---

## 7. Porting checklist

- [ ] `.claude/` copied into the new repo
- [ ] This file replaced and filled in
- [ ] §3 lists every surface with a **verified** entry point
- [ ] §4 points at code, not documentation, wherever possible
- [ ] §6 updated so inapplicable agents are not dispatched
- [ ] No skill file edited

Portable with no changes: the AI group (ML, DL, LLM, AI), the language agents (Python, Go, Rust), performance, chaos, accountant, docker-kubernetes, and every shared reference.
