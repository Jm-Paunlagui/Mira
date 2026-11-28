# Collaboration Protocol

The fleet's shared contract for how work moves between agents. Every discipline skill cites this file. It exists because the failure mode of a specialist fleet is not weak specialists — it is strong specialists who hand each other ambiguous work.

**The governing fact:** an agent sees only the prompt written for it. Not the plan, not the other units, not the conversation, not what the previous agent decided. Everything it needs must be *in* that prompt. An agent that has to infer context will invent it, and two agents inventing independently will not agree.

---

## 1. The dispatch prompt

Every prompt sent to a specialist states these six things. A prompt missing any of them produces work that does not fit.

| # | Element | Failure if omitted |
| - | ------- | ------------------ |
| 1 | **The goal for this unit alone** | The agent solves a larger or smaller problem than intended |
| 2 | **Exact file paths** | The agent searches, guesses, or edits the wrong file |
| 3 | **The contract it must honour — pasted, not referenced** | The agent invents a reasonable shape that does not match its neighbour |
| 4 | **Constraints it must not break** | Established conventions are silently violated |
| 5 | **What is explicitly out of scope** | The agent helpfully expands into another specialisation |
| 6 | **What to report back** | The orchestrator cannot tell whether the unit actually landed |

**Paste contracts, never reference them.** "Use the shape defined in U2" is meaningless to an agent that cannot see U2.

---

## 2. Interface contracts

Wherever two units meet, the boundary is the orchestrator's responsibility, not either agent's. Name the concrete shape before dispatching either side — that is what makes the two units parallelisable.

| Boundary | The contract states |
| -------- | ------------------- |
| Backend → frontend | Full response body, error shape, status codes |
| Hook → view | The returned object, field by field |
| View → component | The prop signature |
| Query → service | Row shape, column names, types |
| Service → controller | What is returned and what is thrown |
| Planner → executor | File paths, exported names and signatures, allowed imports |
| Model → serving | Input feature vector, output shape, latency budget, failure fallback |
| Retrieval → generation | Chunk shape, metadata carried, k, citation format |
| QA → test author | Unmet checklist items **by number**, with the evidence for each |

Two units that agree on a contract up front can be built simultaneously. Two units that do not will collide, and the collision surfaces at integration — the most expensive place to find it.

---

## 3. Escalation

Every specialist is instructed never to work outside its specialisation. When work crosses the line, the agent does **not** reason its way into the adjacent problem. It emits an escalation and stops there.

An escalation states three things, and nothing else:

1. **What is needed** — the specific decision or change, concretely.
2. **Which discipline owns it** — the specialisation, not necessarily an exact agent name. The orchestrator routes.
3. **What was completed anyway** — everything not blocked by it.

An escalation is a **new work unit, not a failure**. The orchestrator routes it, then re-dispatches the blocked unit. Never answer an escalation by telling the original agent to handle it after all.

**Never escalate** to avoid work inside your own specialisation. "This needs a security review" on a plain input-validation bug you are qualified to fix is abdication, not routing.

---

## 4. Reporting back

What an agent returns depends on its shape. All three shapes report what they could **not** verify — an unqualified claim of completeness is the most damaging report an agent can produce.

| Shape | Returns |
| ----- | ------- |
| **Planner** (Opus, no write tools) | The plan: decisions with rationale, file-by-file changes, order of work, verification per step, out of scope |
| **Executor** (Sonnet, paired) | Files changed, deviations from the plan **with reasons**, anything left undone |
| **Single-pass specialist** (Opus) | Conclusions ranked by importance, evidence per finding (`file:line`), what could not be verified |
| **Single-pass builder** (Opus, no planner) | Files changed, decisions made and why, anything left undone |

Rules that apply to all four:

- **Never report a unit done on the strength of a plan.** A plan is not an outcome. Done means the executor confirmed it landed.
- **Report failures with the actual output**, not a summary of it.
- **A deviation from the plan is reported, never silent.** An executor that quietly substitutes its own design destroys the planner's guarantee and the contract with neighbouring units.
- The orchestrator reports to the user as the orchestrator — the user never saw the subagent output. Summarise what changed, what deviated, what failed, what is open.

---

## 5. Parallelism

Serialise only on real dependencies. Unnecessary serialisation is the most common defect in an orchestration plan.

Genuine blockers:

- A schema or table shape other units query
- An API response shape other units consume — **only until the shape is decided, not until it is built**
- A shared component or module several units import
- A review gate, which by definition runs last

Everything else runs in parallel, and the plan should say so explicitly.

---

## 6. Collisions

Two agents writing into the same file is worse than a gap. A gap is visible; a collision produces plausible, conflicting work that passes review.

Standing boundaries in this fleet:

| Contested surface | Owner | Not |
| ----------------- | ----- | --- |
| Frontend test files (general) | `senior-test-engineer` | `senior-react-qa-engineer`, which is read-only |
| App Router test surface | `senior-nextjs-qa-engineer` | `senior-test-engineer` |
| .NET test suites | `senior-csharp-qa-engineer` | `senior-test-engineer`, which authors no xUnit |
| Backend Supertest suites | `senior-test-engineer` | `senior-nodejs-qa-engineer`, which is read-only |
| Python in a training script | `senior-python-engineer` for typing, packaging, tests | not for the loop, the split, or the metric |
| A model's loop and architecture | `senior-deep-learning-engineer` | not `senior-python-engineer` |
| A model's deployment and monitoring | `senior-ai-engineer` | not the agent that trained it |
| RAG chunking and prompts | `senior-llm-engineer` | not `senior-ai-engineer` |
| CWE/CVE severity classification | `senior-cybersecurity-engineer`, `code-reviewer-cwe-cve` | every other agent flags and routes |

When you find yourself about to edit a file another specialisation owns: stop, escalate, and report what you completed.

---

## 7. Sequencing gates

Gates run in this order. Running them out of order wastes the later ones.

1. **Build** — planner then executor, or single-pass builder.
2. **QA** — the QA agent for that stack. Its output *is* the scope for the next gate.
3. **Tests** — authored against the QA findings plus the mandatory checklist.
4. **Security** — on anything touching auth, input handling, money, or PII.
5. **Documentation** — new exports, new `.env` variables, changelog.

Dropping a gate is allowed when the task genuinely does not warrant it. Dropping it **silently** is not — say which and why.
