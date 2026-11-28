# Severity and Findings

The fleet's shared vocabulary for reporting a defect. Cited by every reviewing, QA, and auditing skill.

It exists so that findings are **comparable** — across agents, across runs, and across stacks. A "High" from the Oracle reviewer and a "High" from the React QA agent must mean the same thing to the person triaging them, or the ranking is decoration.

---

## 1. Severity scale

| Severity | Means | Merge |
| -------- | ----- | ----- |
| **Critical** | Data loss, auth bypass, RCE, money computed wrong, or a broken production path. Exploitable or already failing. | Blocks |
| **High** | A rule violated in a way that misbehaves at runtime — a reordered middleware step, a controller holding a DB call, a cached write path with no invalidation, an N+1 on a hot path, a data leak between train and test. | Blocks |
| **Medium** | A real violation with no current runtime symptom. A string in the wrong constants bucket, a service reaching for `res`, a missing `dark:` variant, an unhandled empty state. | Fix before merge |
| **Low** | Drift that misleads the next reader. A stale comment, a documented shape that no longer matches the code, an undocumented parameter. | Fix when touched |
| **Info** | Worth recording, needs no action. | None |

Two rules that keep the scale honest:

- **Severity is about consequence, not effort.** A one-character fix to an auth predicate is Critical. A week-long refactor of naming is Low.
- **Do not inflate to get attention.** A report where everything is High is a report with no ranking, and the next reader stops trusting the column.

---

## 2. Finding format

One finding, one line, in this order:

```
location · issue · minimal fix · severity
```

- **Location** — `file:line`. A finding without a line number is a suspicion, not a finding.
- **Issue** — what is wrong, stated as a fact about the code, not as a preference.
- **Minimal fix** — the smallest change that resolves it. If the real fix is large, say so and route it rather than describing a refactor.
- **Severity** — from the scale above.

Rank the list **most severe first**. Within a severity, most confident first.

### Evidence is mandatory

Every finding is grounded in a line you actually read. Never infer a defect from a naming convention, a file name, or an assumption about what a function probably does. If you could not open the file, say the check was not performed — do not report it as passing and do not report it as failing.

### Confidence

When a verification pass ran, mark each finding:

- **CONFIRMED** — you traced it and the failure is certain.
- **PLAUSIBLE** — the code reads as defective but you could not confirm the path is reachable, or the behaviour depends on runtime state you could not inspect.

Never present PLAUSIBLE as CONFIRMED to strengthen a report.

---

## 3. Checked and cleared

A report that only lists defects loses the work you did clearing false positives — so the next reviewer redoes it and re-raises them.

Include a short **checked and cleared** section for anything that looked like a defect and is not, with the evidence that cleared it. Typical entries:

- A convention that is established platform-wide, not a local violation.
- A deliberate trade documented elsewhere in the codebase.
- A behaviour that is covered by a test you found.

This section is what stops a fleet of reviewers from oscillating.

---

## 4. What is not a finding

Reporting these erodes trust in the whole report:

- **Style preference** where the codebase is internally consistent. Consistency beats your taste.
- **An established convention** you personally disagree with. Route it as a discussion, not as a defect.
- **Another specialisation's domain.** Flag and route; do not produce a parallel severity report. Specifically: CWE/CVE classification belongs to `senior-cybersecurity-engineer` and `code-reviewer-cwe-cve`; Big-O rewrites belong to `senior-performance-engineer`; financial semantics belong to `senior-accountant-mba`.
- **A platform-wide issue reported per-file.** Report it once, name it as platform-wide, and route it to the owning engineer. Never patch one call site of a codebase-wide pattern.
- **A hypothetical.** "This could be a problem if someone later..." is not a defect in the code in front of you.

---

## 5. Handing findings onward

A finding is not finished when it is written. It is finished when it reaches whoever can act on it.

| Finding type | Goes to |
| ------------ | ------- |
| Missing test coverage | `senior-test-engineer` — as **unmet checklist items by number**, not prose |
| Feature rework beyond a minimal fix | The owning builder for that stack |
| Security severity classification | `senior-cybersecurity-engineer` or `code-reviewer-cwe-cve` |
| Complexity or N+1 requiring an algorithmic change | `senior-performance-engineer` |
| Money or accounting semantics | `senior-accountant-mba` |
| Naming an architectural smell | `senior-anti-pattern-auditor` |

Read-only agents state the minimal fix as text and write nothing. Write-capable agents apply the fix **within their own specialisation** and report the files changed; anything outside it is escalated, never written.

---

## 6. Report skeleton

```
## Verdict
One line: does this block merge, and why.

## Findings
location · issue · minimal fix · severity     (most severe first)

## Checked and cleared
What looked wrong and the evidence that cleared it.

## Not verified
Checks you could not perform, and why.

## Routed
Findings handed to another specialisation, with the discipline named.
```

If a check passes cleanly, say so in one line. Do not pad a clean result into paragraphs — a short report that says "six checks, all pass, here is the evidence" is more useful than a long one that buries it.
