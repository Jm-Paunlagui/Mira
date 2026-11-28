# OWASP Top 10 References

Quick reference for the four OWASP Top 10 lists most relevant to full-stack web work, with CWE crosswalks so findings can be cited by both framework and underlying weakness.

The OWASP Top 10s are awareness documents — *what attackers exploit most often* — not exhaustive standards. For comprehensive coverage use **OWASP ASVS** (Application Security Verification Standard) and the **OWASP Cheat Sheet Series**.

---

## Table of Contents

1. [OWASP Web Top 10 (2021)](#1-owasp-web-top-10-2021)
2. [OWASP API Security Top 10 (2023)](#2-owasp-api-security-top-10-2023)
3. [OWASP Mobile Top 10 (2024)](#3-owasp-mobile-top-10-2024)
4. [OWASP Top 10 for LLM Applications (2025)](#4-owasp-top-10-for-llm-applications-2025)
5. [OWASP ASVS — quick orientation](#5-owasp-asvs--quick-orientation)
6. [OWASP Cheat Sheet Series — selection](#6-owasp-cheat-sheet-series--selection)

---

## 1. OWASP Web Top 10 (2021)

| ID    | Title                                       | Primary CWEs                                              | Aumovio enforcement reference |
| ----- | ------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| A01   | **Broken Access Control**                   | CWE-285, CWE-862, CWE-863, CWE-639, CWE-22, CWE-352       | `AuthMiddleware.requireAccess(predicate)` on every protected route |
| A02   | **Cryptographic Failures**                  | CWE-327, CWE-326, CWE-330, CWE-916, CWE-319, CWE-311, CWE-312 | Argon2id for passwords; TLS-only; no `Math.random()` for tokens |
| A03   | **Injection**                               | CWE-79, CWE-89, CWE-78, CWE-77, CWE-94, CWE-917, CWE-643  | Bind variables via `parseFilter`/`parseUpdate`; React auto-escape; no `dangerouslySetInnerHTML` without DOMPurify |
| A04   | **Insecure Design**                         | CWE-209, CWE-256, CWE-501, CWE-522                        | Threat modeling per feature; secure-by-default templates |
| A05   | **Security Misconfiguration**               | CWE-16, CWE-260, CWE-315, CWE-520, CWE-732, CWE-756, CWE-1188 | Helmet middleware; CSP `frame-ancestors 'none'`; HSTS; no debug routes in prod |
| A06   | **Vulnerable and Outdated Components**      | CWE-1104, CWE-1357, CWE-1395                              | `npm audit` in CI; SBOM per release; suppression discipline |
| A07   | **Identification and Authentication Failures** | CWE-287, CWE-294, CWE-307, CWE-384, CWE-521, CWE-798    | JWT in HTTP-only cookie; rate-limited auth route (`max: 5`); MFA for admin |
| A08   | **Software and Data Integrity Failures**    | CWE-502, CWE-829, CWE-494, CWE-345                        | Signed cookies; no `eval`; verified package signatures; locked dep tree |
| A09   | **Security Logging and Monitoring Failures**| CWE-117, CWE-223, CWE-532, CWE-778                        | `logger.*` constants; no `console.log`; structured JSON logs; required audit events |
| A10   | **Server-Side Request Forgery (SSRF)**      | CWE-918                                                   | Outbound URL allow-list; block RFC1918, link-local, metadata ranges; DNS resolve server-side |

### A01 — Broken Access Control (most prevalent)

The #1 finding by frequency. Patterns to grep for:

- Routes without a `requireAccess` / authorisation middleware.
- Resource handlers that don't filter by `tenant_id` / `owner_id`.
- Admin endpoints behind only "is logged in" instead of "has admin role."
- URL parameters trusted for ownership (`/orders/123` — anyone authenticated can fetch).
- Force-browseable admin routes (`/admin/users`) without role check.
- HTTP method confusion (`GET` does mutation, bypassing CSRF).
- JWT with embedded role that the server trusts without re-checking against DB on sensitive ops.

### A03 — Injection (most catastrophic when present)

Test mentally: *can any user-supplied byte change the structure of a downstream parser's input?* If yes, that's injection.

### A04 — Insecure Design (the one no scanner catches)

Design-time weaknesses: missing rate limits on expensive ops, business workflows that can be skipped, lack of separation between admin and tenant data, no idempotency keys on payment endpoints, trust placed in client-computed values. **Threat model before you code.**

---

## 2. OWASP API Security Top 10 (2023)

For API-first or microservices work — and any backend that exposes REST/GraphQL endpoints to a frontend (i.e., the Aumovio backend).

| ID     | Title                                                              | Primary CWEs                                  | What to check |
| ------ | ------------------------------------------------------------------ | --------------------------------------------- | ------------- |
| API1   | **Broken Object Level Authorization (BOLA)**                       | CWE-639, CWE-284                              | Every route taking a resource ID: ownership check at the data layer, not just URL parsing |
| API2   | **Broken Authentication**                                          | CWE-287, CWE-294, CWE-307, CWE-798            | Token lifecycle, MFA on sensitive accounts, rate-limited login |
| API3   | **Broken Object Property Level Authorization**                     | CWE-915, CWE-213                              | Field-level filtering; users cannot read/write privileged fields via mass assignment |
| API4   | **Unrestricted Resource Consumption**                              | CWE-770, CWE-400, CWE-405                     | Body size cap, query-result cap, pagination required, query timeout, connection-pool limits |
| API5   | **Broken Function Level Authorization**                            | CWE-285, CWE-862                              | Admin endpoints actually check admin role; no privilege escalation by URL guessing |
| API6   | **Unrestricted Access to Sensitive Business Flows**                | CWE-799, CWE-837                              | Per-account rate limits on flows attackers want to abuse (signup, password reset, voucher redemption) |
| API7   | **Server Side Request Forgery (SSRF)**                             | CWE-918                                       | See A10 above; especially webhook delivery, image proxy, URL preview |
| API8   | **Security Misconfiguration**                                      | CWE-16, CWE-2, CWE-942                        | Specific CORS origins; no default credentials; security headers; up-to-date TLS |
| API9   | **Improper Inventory Management**                                  | CWE-1059, CWE-1188                            | Deprecated API versions retired; no forgotten staging endpoints in prod DNS; documented surface area |
| API10  | **Unsafe Consumption of APIs**                                     | CWE-20, CWE-918, CWE-502                      | Validate responses from third-party APIs; don't trust upstream encoding; timeouts and circuit breakers on outbound calls |

### BOLA vs IDOR

**BOLA** (API1) is the API-Top-10 framing of **IDOR** (CWE-639, "Insecure Direct Object Reference"). Same bug, two names. Always cite both when reporting: *"API1 / CWE-639 — Broken Object Level Authorization (IDOR)."*

### GraphQL-specific risks

- **Query depth / breadth attacks** → enforce depth limit, cost analysis, and persisted queries in production.
- **Field-level authorisation** is mandatory because clients pick fields — backend cannot use endpoint-level checks alone.
- **Batching** can bypass rate limits scoped per HTTP request — scope per resolver instead.
- **Introspection** disabled in production environments.

---

## 3. OWASP Mobile Top 10 (2024)

Less central to web work, but relevant if Aumovio (or any sibling project) has a mobile companion app.

| ID  | Title                                              |
| --- | -------------------------------------------------- |
| M1  | Improper Credential Usage                          |
| M2  | Inadequate Supply Chain Security                   |
| M3  | Insecure Authentication / Authorization            |
| M4  | Insufficient Input/Output Validation               |
| M5  | Insecure Communication                             |
| M6  | Inadequate Privacy Controls                        |
| M7  | Insufficient Binary Protections                    |
| M8  | Security Misconfiguration                          |
| M9  | Insecure Data Storage                              |
| M10 | Insufficient Cryptography                          |

Mobile-specific checkpoints not covered by web Top 10:

- Storing secrets in app binary (extractable via `strings` / decompiler).
- Trusting the device clock for token expiry.
- Pinning failures (certificate pinning bypass via repackaging).
- Backup exfiltration (iOS keychain accessibility, Android allowBackup).
- Deep-link hijacking and URL scheme collisions.
- Tap-jacking and screen-overlay attacks.

---

## 4. OWASP Top 10 for LLM Applications (2025)

If a feature ever wraps a model API (Claude, GPT, in-house) — increasingly relevant given your AI engineering work.

| ID    | Title                                              | What it is |
| ----- | -------------------------------------------------- | ---------- |
| LLM01 | **Prompt Injection** (direct & indirect)           | Untrusted content overrides the system prompt; indirect via tool-fetched docs |
| LLM02 | **Sensitive Information Disclosure**               | Model memorises training data; leaks via responses or embeddings |
| LLM03 | **Supply Chain Vulnerabilities**                   | Compromised model weights, datasets, plugins |
| LLM04 | **Data and Model Poisoning**                       | Adversarial training-data contamination affecting outputs |
| LLM05 | **Improper Output Handling**                       | Treating model output as trusted (executing, rendering, SQL-ing it) |
| LLM06 | **Excessive Agency**                               | Agentic system with overbroad permissions to take real-world actions |
| LLM07 | **System Prompt Leakage**                          | Adversarial extraction of system prompt content & embedded secrets |
| LLM08 | **Vector and Embedding Weaknesses**                | RAG retrieval poisoning; embedding inversion attacks |
| LLM09 | **Misinformation**                                 | Confident hallucinated outputs in safety-critical contexts |
| LLM10 | **Unbounded Consumption**                          | Token-cost DoS; runaway agentic loops |

Key defences:

- **Treat all LLM output as untrusted input.** Validate, sanitise, and constrain before any privileged action. This is CWE-1426.
- **Never put secrets in the system prompt** — assume they will leak.
- **Bound agency.** Tool use should require explicit user confirmation for irreversible actions; rate-limit and cost-cap agentic loops.
- **Layered defence for prompt injection:** input filtering, separation of trusted/untrusted content with role tags, output validation, principle of least privilege for tools.
- **RAG hygiene:** sign or verify retrieval sources; sanitise retrieved content for injection markers; log retrieval provenance for audit.

---

## 5. OWASP ASVS — quick orientation

The **Application Security Verification Standard** is the comprehensive OWASP standard — what to verify, with three levels:

- **Level 1** — Opportunistic. Defends against trivial/automated attacks. Penetration-testable from outside.
- **Level 2** — Standard. For applications containing sensitive data. The recommended baseline for most business applications.
- **Level 3** — Advanced. For applications performing high-value transactions, sensitive medical data, or critical infrastructure.

ASVS is organised into 14 chapters: V1 Architecture · V2 Authentication · V3 Session Management · V4 Access Control · V5 Validation/Sanitisation/Encoding · V6 Stored Cryptography · V7 Error Handling/Logging · V8 Data Protection · V9 Communications · V10 Malicious Code · V11 Business Logic · V12 Files/Resources · V13 API/Web Service · V14 Configuration.

When designing a security-critical feature, look up the relevant chapter for the verification requirements — they read as checklists. For financial workflows (payroll, benefits accrual, subsidy chains, credit ledgers): **Level 2 minimum, Level 3 for credit-card / banking data**.

---

## 6. OWASP Cheat Sheet Series — selection

The Cheat Sheets are concise, opinionated, implementation-level guidance for common security topics. Bookmark these:

- **Authentication Cheat Sheet** — login, lockout, credential storage
- **Authorization Cheat Sheet** — patterns, layered enforcement
- **Cross-Site Request Forgery Prevention** — token patterns, SameSite
- **Cross Site Scripting Prevention** — context-aware encoding
- **Content Security Policy** — CSP design with nonces / hashes
- **HTML5 Security** — `postMessage`, storage, sandboxed iframes
- **HTTP Headers** — full set of recommended response headers
- **Input Validation** — schema validation, canonicalisation
- **JSON Web Token for Java** (generalises to other ecosystems) — algorithm pinning, claim validation
- **Logging** — events to log, format, retention
- **Password Storage** — Argon2id parameters, peppering
- **REST Security** — auth, throttling, validation, errors
- **SQL Injection Prevention** — parameterisation patterns
- **Session Management** — IDs, lifecycle, cookies
- **TLS** — configuration, ciphers, HSTS
- **Transport Layer Security** — companion to TLS cheat sheet
- **Unvalidated Redirects and Forwards** — open redirect prevention
- **User Privacy Protection** — data minimisation, consent

URLs follow the pattern `cheatsheetseries.owasp.org/cheatsheets/<Title>_Cheat_Sheet.html`.

---

**Last reviewed against:** OWASP Web Top 10 (2021), API Top 10 (2023), Mobile Top 10 (2024), LLM Top 10 (2025), ASVS 5.0. Re-check `owasp.org` for refresh cycles — Top 10 lists revise every 3–4 years.
