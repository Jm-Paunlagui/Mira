---
name: fleet-init
description: Point the agent fleet at a project, or re-verify that it is still pointed correctly. Use this after copying `.claude/` into a new repo, when a project profile looks stale, when agents start reporting defects that are not real, or when several copies of the fleet in one workspace have drifted apart. Produces or repairs `project-profile.md` from evidence read out of the repo, fills the applicability table so the orchestrator does not dispatch agents with no target, and reports which skill files have started asserting project facts they should not. Trigger on "/fleet-init", "set up the fleet here", "the profile is stale", "why is this agent inventing findings", "sync the fleet copies", "fleet doctor".
---

# Fleet Init

Two modes. Decide which from the request, and say which you are running.

- **`init`** — no usable `project-profile.md` for this repo, or it describes a different project. Build one from evidence.
- **`doctor`** — a profile exists. Verify every claim in it against the repo, and report drift.

Both modes end with a written profile and a short report. Neither mode edits a skill file. If a project fact seems to require a skill edit, that is a finding about the skill, not a licence to edit it.

---

## The rule this skill exists to enforce

A profile written from assumption is worse than no profile, because every agent downstream will trust it and report defects from it. **Every line you write into the profile must come from a file you actually opened.** Where you could not confirm something, write `unverified` next to it rather than a plausible guess.

---

## Mode: init

### 1. Establish the surfaces

A surface is an independently buildable unit — it has its own manifest. Find them:

- `package.json`, `pyproject.toml` / `setup.py`, `go.mod`, `Cargo.toml`, `*.csproj` / `*.sln`, `pom.xml` / `build.gradle`, `Gemfile`, `composer.json`

One manifest at the root means one surface. Several in subdirectories means a multi-surface repo — profile each separately.

### 2. Read the stack from the manifest, not from folder names

Take framework and **major version** from the dependency list, not from a README. Record what you actually found:

| Signal | Tells you |
| ------ | --------- |
| `express`, `fastify`, `koa`, `@nestjs/core` | Node HTTP framework and version |
| `next` | App Router — check for an `app/` directory before assuming |
| `react` + `vite` with no `next` | Vite + React, **not** Next.js — this distinction routes work to a different agent |
| `tailwindcss` v4 | Tokens live in `@theme`; there is correctly **no** `tailwind.config.js` |
| `oracledb`, `mongodb`/`mongoose`, `pg`, `mysql2`, `prisma` | Database and access layer |
| `vitest`, `jest`, `mocha`, `pytest`, `xunit` | Test framework — then find where tests actually live |
| `torch`, `tensorflow`, `scikit-learn`, `xgboost` | Which AI-group agent applies, if any |
| `@anthropic-ai/sdk`, `openai`, `langchain` | An LLM pipeline exists |

### 3. Verify the entry point by opening it

Entry points are routinely not where you would guess. Check the manifest's `main`, `scripts.start`, or `module` field, then **open the file**. Record the real path.

Note anything load-order sensitive in the first ~20 lines — a polyfill that must be first, a runtime that must be configured before I/O, a registration that must precede a require.

### 4. Find the fact authorities

For each fact an agent will want, find the file that owns it and record the path — do not copy the content.

Look for `CLAUDE.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `docs/`. **Prefer code over documentation** for anything mechanically checkable: response envelopes, error shapes, config schemas, exported constants.

When a document and the code disagree, record the code as the authority and note the discrepancy in the profile. That note is one of the most valuable lines in the file — it teaches every downstream agent not to trust the doc blindly.

### 5. Fill the applicability table

For every agent in `.claude/agents/`, decide: does a target exist in this repo?

Be strict. "We might add Kubernetes later" is **not here**. The cost of a wrong `Yes` is an agent that finds something to say about a stack that does not exist.

Flag near-misses explicitly — a Vite+React repo will attract the Next.js agents on keyword match, and the profile should say so.

### 6. Write the profile

Use `project-profile.template.md`, keeping section 1 (authority order) verbatim. Fill sections 2-6 from what you verified.

---

## Mode: doctor

Check the existing profile claim by claim. Report as a defect list — `claim · reality · severity` — following the shared severity scale.

1. **Every path resolves.** A path in the profile that does not exist is High: agents grep it, find nothing, and may report the absence as a defect.
2. **Every version matches the manifest.** A stale major version is Medium.
3. **Test command still exists** in the manifest scripts.
4. **Applicability is still true.** A stack added since the profile was written and still listed "not here" means an agent that should be routed never is. A stack removed and still listed "Yes" is worse.
5. **Documented facts still match code** — spot-check the ones the profile names as authorities, especially response and error shapes.
6. **Skills have not started asserting project facts.** Grep `.claude/skills/*/SKILL.md` for absolute paths, hardcoded step counts, and project-specific identifiers. Anything mechanically checkable that lives in a skill rather than the profile is a Medium finding against the skill — report it, name the skill, do not edit it.

---

## Multiple fleet copies in one workspace

A workspace with several repos may hold several copies of `.claude/`. They will drift, and drift is silent.

**Discipline is shared; profiles are not.** When copies exist:

- `agents/`, `skills/*/SKILL.md`, and every shared reference **should be identical** across copies. A difference is drift — report which copy is ahead, by file.
- `project-profile.md` **must differ**, because each points at its own repo. Identical profiles across two different repos is itself the defect: it means one copy is describing the other's codebase, and its paths are wrong.

Report both conditions. To compare, diff the directories excluding `project-profile.md`:

```
diff -r -q --exclude=project-profile.md <copyA>/.claude <copyB>/.claude
```

Name a single copy as canonical for discipline, and say which. Propagating an improvement means copying everything **except** each repo's own profile.

---

## Output

### Init
1. The surfaces found, with the evidence for each (which manifest, which entry file).
2. The written profile path.
3. Applicability: how many agents apply, how many do not, and any near-miss you flagged.
4. Anything recorded as `unverified`, and what would confirm it.

### Doctor
1. Verdict in one line: is the profile safe to trust.
2. Findings — `claim · reality · severity`, most severe first.
3. Drift across fleet copies, if several exist.
4. Skills asserting project facts, named, for the maintainer to fix.

If everything checks out, say so in one line with the count of claims verified. Do not pad a clean result.
