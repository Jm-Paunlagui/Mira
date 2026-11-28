---
name: feature-docs
description: >-
  Generate end-to-end technical documentation for a software feature: a plain-language overview,
  Mermaid flowchart/sequence/ER diagrams embedded directly in Markdown, the frontend and backend
  implementations, how the two connect (the API contract), the technicalities, and a security section.
  Use this whenever the user asks to "document" a feature or wants "documentation of the implementation
  and processes" of something (auth, payments, a job, a module), asks how the frontend and backend
  work or connect, asks for a flowchart/Mermaid diagram of code, a technical deep-dive, a security or
  code review of a feature, or a "Q&A" / "verify with tests" section that backs answers with real test
  results. Also trigger when the user names paired folders like "for the Foo-FE and Foo-BE" — a request
  to document across those two folders. Even a bare "document the auth flow" means the full
  developer-grade document, not a paragraph.
---

# feature-docs

Produce a single, self-contained Markdown document that explains a feature the way a senior engineer
would hand it off to a new teammate: what it does, how it flows (with diagrams), how the frontend and
backend each implement it, how they talk to each other, the details that bite people, and the security
posture. Optionally — only when asked — a code review.

The user typically gives you a short prompt and expects you to know the full shape of the deliverable.
"I need documentation of the implementation and processes of the Authentication" means: produce the
**whole document** below, grounded in the **actual code**, not a generic essay.

---

## Step 1 — Resolve which folders to read

The document must describe real code. Before writing anything, figure out where the code lives.

**Folder resolution order:**

1. **Explicit names in the prompt.** If the user names paired folders — e.g. "for the `auth-FE` and `auth-BE`",
   "Name-FE and Name-BE", "the `web` and `api` folders" — use exactly those as the frontend and backend
   roots. The `-FE`/`-BE` suffix convention maps to frontend/backend respectively.
2. **Defaults.** If no folders are named, look for a frontend root and a backend root using these common
   names (case-insensitive): frontend → `Frontend`, `frontend`, `client`, `web`, `app`, `ui`, `fe`;
   backend → `Backend`, `backend`, `server`, `api`, `service`, `be`.
3. **Single tree / monorepo.** If there's no clean FE/BE split (one app, or a monorepo with `packages/*`),
   document it as a single codebase and skip the literal "Frontend vs Backend" split — instead use whatever
   real boundary exists (e.g. `components/` vs `routes/`, or `apps/web` vs `apps/api`).
4. **Nothing found / no code at all.** If you can't locate the relevant code, say so plainly and ask the
   user for the path, OR — if they explicitly want a design/spec doc rather than docs of existing code —
   produce the document from their description and label the diagrams and sections clearly as **proposed**,
   not as documentation of shipped code. Never silently invent file paths, function names, or routes.

**Then actually read it.** Locate the files relevant to the named feature (search by the feature keyword:
"auth", "login", "token", "session", etc.). Read enough to name real files, real routes, real functions,
real DB tables, and the real request/response shape. Grounding the document in concrete identifiers is the
difference between useful docs and plausible-sounding filler.

---

## Step 2 — Decide the depth (default is full)

| Trigger phrasing | What to produce |
| --- | --- |
| "document X", "documentation of the implementation and processes of X", "how FE and BE work/connect" | **Full document** — all descriptive sections (1–7 below). This is the default. |
| "flowchart of X", "diagram the X flow", "mermaid for X" | Lead with the diagram(s); include a short overview and the connect/technicalities sections around them. |
| "technicalities of X", "deep dive on X" | Full document, but expand §6 Technicalities heavily. |
| "security review of X", "is X secure" | Full document, but expand §7 Security into findings with severity (see Security section). |
| "code review X", "review the X code" | Full document **plus** the optional **Code Review** section. Only this phrasing turns on review. |
| "add a Q&A", "verify with tests", "Q&A backed by tests", "prove it works" | Include the **Verification Q&A** section (§8), grounding each answer in a real test. See the Verification Q&A rules below. |

By default, include §8 Verification Q&A whenever the feature has tests near it. Skip it (or reduce it to a
one-line coverage note) only if the user says to, or if no tests exist at all. When in genuine doubt, produce the full document. Over-documenting is cheap; under-documenting forces the
user to ask again.

---

## Step 3 — Produce the document

Save it as a `.md` file (e.g. `auth-documentation.md`) in the outputs directory so the user can download it.
Use this exact section order. Drop a section only if it's truly N/A for the feature (and say why in one line).

```markdown
# <Feature> — Technical Documentation

> Scope: <feature name>. Source: <FE folder> (frontend) + <BE folder> (backend), or <the real boundary>.
> Generated <date>. Diagrams render in GitHub/GitLab/Obsidian/VS Code preview (see "Rendering" note at the bottom).

## 1. Overview
2–4 sentences, plain language. What problem this feature solves and the one-line story of how a request
flows through it. No jargon a non-specialist couldn't follow.

## 2. Flow & Architecture
The diagram(s). For most request/response features use a **sequence diagram** (it shows the round trip:
client → API → DB → back). Add a **flowchart** when there's branching decision logic (valid? expired?
refresh?). See references/mermaid-diagrams.md for diagram-type selection and embedding mechanics.
<one or more ```mermaid blocks here>
A short paragraph under each diagram explaining what it shows.

## 3. Frontend implementation
Real files and what they do. Key components, where state lives, how the feature is triggered from the UI,
what it calls on the backend. Use a small table for files when there are several:
| File | Responsibility |
| --- | --- |
| `src/auth/LoginForm.jsx` | Collects credentials, calls POST /auth/login |
| `src/auth/useAuth.js` | Holds token in memory/state, exposes login/logout |

## 4. Backend implementation
Real routes, middleware, services, and data access. The path a request takes server-side. Table the routes:
| Method & Path | Handler / file | Purpose |
| --- | --- | --- |
| `POST /auth/login` | `routes/auth.js → login()` | Verify credentials, issue token |

## 5. How frontend and backend connect (the contract)
The integration surface — this is the part people most need and most often lack. For each endpoint the
feature uses: the request shape, the response shape, status codes, required headers/cookies/tokens, and
where auth/CSRF/correlation IDs are attached. Show representative request/response bodies (sanitised — no
real secrets). State who holds the token and how it travels (Authorization header? httpOnly cookie?).

## 6. Technicalities
The details that bite: token/session lifetimes and refresh logic, hashing/encryption choices, idempotency,
race conditions, retries/timeouts, error handling and edge cases, env/config dependencies, and any
non-obvious assumptions baked into the code. This is where you record the "why it's built this way."

## 7. Security
Concrete to this feature: where secrets and credentials live, how passwords/tokens are stored (hashing
algorithm, salting), transport (TLS), session handling, and the relevant exposure classes (e.g. injection,
XSS, CSRF, broken access control, secrets in logs). Map findings to OWASP categories where it's natural.
If the user asked for a security *review* specifically, present this as findings with severity (see below).

## 8. Verification Q&A
The questions a reviewer, new teammate, or interviewer would actually ask about this feature — each answer
backed by a real test (cited, and run if requested). This is the "how do we know it works" section. See the
Verification Q&A rules below for the hard no-fabrication rule. Format each item:

> **Q:** Does an expired access token get rejected on protected routes?
> **A:** Yes. The auth middleware checks `exp` and returns 401 before the handler runs.
> **Evidence:** `backend/test/auth.middleware.test.js → "rejects expired token"` asserts a 401 on an expired
> token. _Status: ✓ passing_ (last run 2026-06-16) — or _not run_ / **⚠ no test covers this** if that's the truth.

End the section with a short **coverage summary**: which behaviours are test-backed, and which are gaps.
```

---

## Embedding Mermaid in Markdown

This is the mechanic the document depends on, so get it right: a Mermaid diagram is a **fenced code block
whose language is `mermaid`**. Renderers that understand it (GitHub, GitLab, Obsidian, VS Code preview, many
static-site generators) turn the block into a diagram; everywhere else it shows as code.

Write it literally like this inside the Markdown file:

    ```mermaid
    sequenceDiagram
        participant C as Client
        participant A as API
        participant DB as Database
        C->>A: POST /auth/login {email, password}
        A->>DB: lookup user by email
        DB-->>A: user row (password hash)
        A->>A: verify hash (Argon2id/bcrypt)
        A-->>C: 200 { accessToken } / 401 Unauthorized
    ```

Pick the diagram type from `references/mermaid-diagrams.md` — read it before drafting diagrams. Quick guide:
**sequenceDiagram** for request/response round-trips (the usual pick for auth and API features),
**flowchart**/`graph TD` for decision logic, **erDiagram** for data models, **stateDiagram-v2** for state
machines (session/order lifecycles), **classDiagram** for OOP structure.

**Rendering / portability note to include in every doc:** add a short line near the top stating where the
diagrams render. If the user said the doc will become a **PDF via Chrome print** (or any plain Markdown→PDF
path), fenced `mermaid` blocks will *not* render there — offer to pre-render the diagrams to SVG/PNG with
`mermaid-cli` and embed them as images instead, or to point them at a Mermaid-aware renderer.

---

## Verification Q&A rules

This section is only trustworthy if its evidence is real. The whole point is to back claims with tests, so a
fabricated result defeats it entirely.

**Finding the tests.** Look for test files near the feature: `*.test.js(x)`, `*.spec.js(x)`, `__tests__/`,
and the backend equivalents (Jest/Vitest/Mocha + supertest for routes, etc.). Match each Q to the test that
actually exercises that behaviour by reading the test body and its assertions — not by filename guessing.

**Two evidence modes:**
- **Cite (default):** name the test file and the specific test, and state what it asserts. A cited assertion
  is legitimate documentation evidence and has no side effects. Mark status `not run` unless you actually ran it.
- **Run (on request):** when the user asks to run the tests, or it's clearly safe and wanted, execute the
  relevant tests, capture the **real** output, and embed it. State the command and the actual pass/fail.

**The hard rule — never fabricate.** If a behaviour has no test, you write **⚠ no test covers this** and,
optionally, the test you'd write to close the gap — clearly labelled as *proposed*, not as a result. You do
not invent a passing run, a green check, coverage numbers, or output you didn't observe. If you didn't run
it, don't claim it passed. A Q&A that honestly flags gaps is more valuable than one that hides them — it
tells the reader exactly where the feature is unverified.

**Pick real questions.** Aim the Q&A at what someone would actually challenge: failure paths, edge cases,
security-relevant behaviour, and the claims in §6 Technicalities. Skip trivial happy-path questions whose
answer is obvious from §2.

---

## Code Review section (opt-in)

Only include this when the user asks to "review" the code. Keep it clearly separated from the descriptive
sections above — descriptive text says what *is*; review says what's *wrong and how to fix it*. Format each
finding so it's actionable:

```markdown
## Code Review (requested)

### Findings
| # | Severity | Location | Issue | Why it matters | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | High | `routes/auth.js:42` | JWT secret read from a literal fallback if env var missing | Predictable secret → token forgery | Fail fast on missing secret; never default it |
| 2 | Medium | `useAuth.js:18` | Access token stored in localStorage | Exposed to XSS | Hold in memory or httpOnly cookie |

Severity scale: **Critical** (exploitable now / data loss) · **High** (serious, likely) · **Medium**
(should fix) · **Low** (style/hardening). Map to OWASP Top 10 / CWE where it's natural.
```

Don't invent vulnerabilities to fill the table. If the code is clean on a dimension, say so. A short,
honest review beats a padded one.

---

## Principles

- **Ground everything in real code.** Real file paths, route strings, function and table names. If you
  haven't read it, don't assert it. This single rule is what makes the output trustworthy.
- **Never fabricate test results.** Cite real tests; run them only when asked; flag untested behaviour as a
  gap. A fake green check is worse than an honest "no test covers this."
- **Explain the "why," not just the "what."** Anyone can read that a token expires in 15 minutes; the doc's
  value is recording *why* it's 15 and what the refresh story is.
- **Sanitise.** Never put real secrets, keys, tokens, or live credentials in examples. Use placeholders.
- **Don't pad.** Drop genuinely-N/A sections with a one-line reason rather than writing filler. A tight
  document gets read; a bloated one gets skimmed.
- **Diagrams earn their place.** Each diagram needs a sentence of prose explaining what it shows. A diagram
  with no explanation is decoration.
- **One document, downloadable.** Output a single `.md` file to the outputs directory and present it.
