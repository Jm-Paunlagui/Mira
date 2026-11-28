# CWE Knowledge Catalog

Comprehensive reference for the CWE (Common Weakness Enumeration) catalog, organised by attack category. Use this when reviewing code, designing features, threat modeling, or triaging vulnerabilities.

Each entry: **CWE-ID — Name** · what it is · telltale code smell · mitigation.

CWE IDs are the canonical reference — cite them in code review, suppression notes, and incident reports. When uncertain about an exact ID, prefer naming the category over guessing the number.

---

## Table of Contents

1. [CWE Top 25 (2023)](#1-cwe-top-25-2023)
2. [Injection](#2-injection)
3. [Authentication](#3-authentication)
4. [Authorisation & Access Control](#4-authorisation--access-control)
5. [Session Management](#5-session-management)
6. [Cryptography](#6-cryptography)
7. [Information Disclosure](#7-information-disclosure)
8. [Input Validation](#8-input-validation)
9. [Memory Safety](#9-memory-safety)
10. [Concurrency](#10-concurrency)
11. [Resource Management & DoS](#11-resource-management--dos)
12. [Path Traversal & File Handling](#12-path-traversal--file-handling)
13. [Deserialization & Object Manipulation](#13-deserialization--object-manipulation)
14. [XML & Parser Issues](#14-xml--parser-issues)
15. [Web-Specific Weaknesses](#15-web-specific-weaknesses)
16. [SSRF & Request Forgery](#16-ssrf--request-forgery)
17. [Business Logic](#17-business-logic)
18. [Supply Chain](#18-supply-chain)
19. [Misconfiguration](#19-misconfiguration)
20. [Logging & Monitoring](#20-logging--monitoring)
21. [Cross-cutting hardening checklist](#21-cross-cutting-hardening-checklist)

---

## 1. CWE Top 25 (2023)

The most dangerous software weaknesses by real-world impact (MITRE-published, refreshed annually). Internalise all 25.

| Rank | CWE-ID  | Name                                                                 |
| ---- | ------- | -------------------------------------------------------------------- |
| 1    | CWE-787 | Out-of-bounds Write                                                  |
| 2    | CWE-79  | Cross-site Scripting (XSS)                                           |
| 3    | CWE-89  | SQL Injection                                                        |
| 4    | CWE-416 | Use After Free                                                       |
| 5    | CWE-78  | OS Command Injection                                                 |
| 6    | CWE-20  | Improper Input Validation                                            |
| 7    | CWE-125 | Out-of-bounds Read                                                   |
| 8    | CWE-22  | Path Traversal                                                       |
| 9    | CWE-352 | Cross-Site Request Forgery (CSRF)                                    |
| 10   | CWE-434 | Unrestricted Upload of File with Dangerous Type                      |
| 11   | CWE-862 | Missing Authorisation                                                |
| 12   | CWE-476 | NULL Pointer Dereference                                             |
| 13   | CWE-287 | Improper Authentication                                              |
| 14   | CWE-190 | Integer Overflow or Wraparound                                       |
| 15   | CWE-502 | Deserialization of Untrusted Data                                    |
| 16   | CWE-77  | Command Injection (generic)                                          |
| 17   | CWE-119 | Improper Restriction of Operations within the Bounds of a Buffer    |
| 18   | CWE-798 | Use of Hard-coded Credentials                                        |
| 19   | CWE-918 | Server-Side Request Forgery (SSRF)                                   |
| 20   | CWE-306 | Missing Authentication for Critical Function                         |
| 21   | CWE-362 | Race Condition                                                       |
| 22   | CWE-269 | Improper Privilege Management                                        |
| 23   | CWE-94  | Improper Control of Generation of Code (Code Injection)              |
| 24   | CWE-863 | Incorrect Authorisation                                              |
| 25   | CWE-276 | Incorrect Default Permissions                                        |

---

## 2. Injection

Parent: **CWE-74 — Improper Neutralization of Special Elements in Output Used by a Downstream Component**

| CWE-ID   | Name                       | Telltale                                                      | Mitigation                                                                                |
| -------- | -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CWE-89   | SQL Injection              | String concat / template literal into SQL query               | Parameterised queries / bind variables. ORMs that bind by default. Never `${userInput}` in SQL. |
| CWE-943  | NoSQL Injection            | Mongo `$where` with user input; raw object spread into filter | Validate operator allow-list. Reject objects where strings expected.                      |
| CWE-90   | LDAP Injection             | User input concatenated into LDAP filter                      | Escape `\`, `*`, `(`, `)`, NUL. Use parameterised LDAP libraries.                         |
| CWE-643  | XPath Injection            | User input in XPath query                                     | Parameterised XPath. Quote / escape.                                                      |
| CWE-78   | OS Command Injection       | `exec`, `system`, shell with user input                       | Use `execFile` / `spawn` with arg array. Never invoke shell. Allow-list binaries.         |
| CWE-77   | Command Injection (general)| Any command interpreter (SMTP, SQL*Plus, etc.) with input    | Parameterise; treat command channel as untrusted.                                         |
| CWE-94   | Code Injection             | `eval`, `Function()`, `vm.runInThisContext` on input          | Never `eval` untrusted code. Use proper parsers, sandboxes, or expression libraries.      |
| CWE-95   | Eval Injection             | Direct `eval(userInput)`                                      | Same as CWE-94.                                                                           |
| CWE-917  | Expression Language Injection | EL / template (Spring, Thymeleaf) with user input          | Treat templates as code; never compile user-supplied templates.                           |
| CWE-1336 | Server-Side Template Injection (SSTI) | Jinja2, Handlebars, EJS, Pug compiled with input    | Pre-compile templates at build; use safe contexts for variables.                          |
| CWE-79   | Cross-Site Scripting (XSS) | `innerHTML` / `dangerouslySetInnerHTML` / unescaped output    | Auto-escape (React does by default). DOMPurify for sanctioned HTML. CSP as defence-in-depth. |
| CWE-91   | XML Injection              | User input into XML structure                                 | XML-encode; use safe XML builder.                                                         |
| CWE-611  | XXE — XML External Entity  | XML parser with DTD/entity processing enabled                 | Disable DOCTYPE, external entities, parameter entities.                                   |
| CWE-918  | SSRF                       | Outbound HTTP with user-controlled URL                        | Allow-list hosts. Block private IPs and metadata services.                                |
| CWE-113  | HTTP Response Splitting    | `\r\n` in header value from user input                        | Strip / reject CR/LF in header writes.                                                    |
| CWE-93   | CRLF Injection             | `\r\n` in any control channel (log, header, command)          | Strip CR/LF; parameterise control channels.                                               |
| CWE-88   | Argument Injection         | User input becomes a CLI flag (e.g., `--config=/etc/passwd`)  | Use `--` separator; validate against flag allow-list.                                     |
| CWE-1426 | Improper Validation of Generative AI Output | LLM output executed or rendered without checks | Validate, sandbox, or constrain LLM output before any privileged use.                     |

### Injection review heuristic

When data crosses a parser boundary (SQL, HTML, shell, XML, URL, regex, LDAP, JSON, YAML, template, EL), one of two things must be true:
1. The data is structurally **separated** from the code (bind variables, arg arrays, attribute escaping).
2. The data is **strictly validated** against a grammar at least as strict as the downstream parser accepts.

If neither holds, it is an injection vulnerability — name the specific CWE.

---

## 3. Authentication

Parent: **CWE-287 — Improper Authentication**

| CWE-ID   | Name                                            | Telltale                                                  | Mitigation                                                              |
| -------- | ----------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-287  | Improper Authentication                         | Auth bypass paths; weak token checks                      | Centralised auth middleware; verify tokens cryptographically.           |
| CWE-306  | Missing Authentication for Critical Function    | Sensitive endpoint with no auth check                     | Auth by default; explicit allow-list for public routes.                 |
| CWE-307  | Improper Restriction of Excessive Auth Attempts | No rate limit on login                                    | Rate limit by IP + account; lockout with backoff; CAPTCHA.              |
| CWE-308  | Use of Single-factor Authentication             | Password only on sensitive accounts                       | TOTP / WebAuthn / push MFA for admin and finance roles.                 |
| CWE-521  | Weak Password Requirements                      | `minLength: 6`, no complexity                             | NIST 800-63B: ≥8 chars, screen against breach corpora, no forced rotation. |
| CWE-798  | Hard-coded Credentials                          | Username/password literal in source                       | Env vars / secret manager; rotate immediately if leaked.                 |
| CWE-259  | Hard-coded Password                             | Specific case of CWE-798                                  | Same as CWE-798.                                                        |
| CWE-321  | Hard-coded Cryptographic Key                    | JWT secret, AES key in source                             | Inject via env / KMS; rotate on incident.                               |
| CWE-294  | Authentication Bypass by Capture-replay         | Static tokens; no nonce                                   | Nonces, timestamps, request signing.                                    |
| CWE-549  | Missing Password Field Masking                  | Plain `<input>` for password                              | `<input type="password">`; toggle visibility with explicit user action. |
| CWE-1390 | Weak Authentication                             | Predictable tokens; truncated hashes                      | Cryptographically random tokens ≥128 bits; full-strength hashes.        |
| CWE-620  | Unverified Password Change                      | Change password without current-password check            | Re-authenticate before sensitive changes.                               |
| CWE-640  | Weak Password Recovery Mechanism                | Security questions; predictable reset tokens              | Time-limited, single-use, high-entropy reset tokens delivered out-of-band. |
| CWE-1244 | Internal Asset Exposed to Unsafe Debug Access   | Debug endpoints in production                             | Debug endpoints disabled in prod builds; protected by separate auth.    |

### Password hashing (CWE-916, CWE-759, CWE-760)

- **CWE-916** Use of Password Hash With Insufficient Computational Effort → use **Argon2id** (preferred), **scrypt**, or **bcrypt**. Never MD5, SHA-1, SHA-256 alone, or PBKDF2 with low iterations.
- **CWE-759** One-Way Hash Without a Salt → modern algorithms generate salt automatically; never hash passwords without it.
- **CWE-760** One-Way Hash with a Predictable Salt → use CSPRNG-generated per-password salts.
- **Pepper** (application-wide secret added to password before hashing) is defence-in-depth; store separately from DB.

---

## 4. Authorisation & Access Control

Parent: **CWE-284 — Improper Access Control**

| CWE-ID  | Name                                                          | Telltale                                                  | Mitigation                                                              |
| ------- | ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-285 | Improper Authorisation                                        | Missing checks on protected actions                       | Authorise every action; default deny.                                   |
| CWE-862 | Missing Authorisation                                         | Endpoint with auth but no role/ownership check            | Add `requireAccess(predicate)` to every route.                          |
| CWE-863 | Incorrect Authorisation                                       | Check exists but logic is wrong (e.g., `||` vs `&&`)      | Test authorisation matrix exhaustively (positive AND negative cases).   |
| CWE-639 | Authorisation Bypass Through User-Controlled Key (IDOR/BOLA) | `GET /invoices/:id` returns any user's invoice            | Verify ownership: `WHERE id = :id AND tenant_id = :session.tenant_id`.  |
| CWE-269 | Improper Privilege Management                                 | Privilege escalation paths; PUT `/users/me` accepts `role`| Reject privileged fields in user-facing DTOs.                           |
| CWE-250 | Execution with Unnecessary Privileges                         | App runs as root; DB user has DDL rights                  | Principle of least privilege — separate accounts per concern.           |
| CWE-732 | Incorrect Permission Assignment for Critical Resource         | World-writable files; 777 perms                           | Restrict file modes; use ACLs explicitly.                               |
| CWE-276 | Incorrect Default Permissions                                 | New objects default to broad access                       | Default deny / private; opt-in to share.                                |
| CWE-1220| Insufficient Granularity of Access Control                    | Single "admin" role for all admin actions                 | Fine-grained permissions (RBAC, ABAC, ReBAC).                           |
| CWE-915 | Improperly Controlled Modification of Dynamically-Determined Object Attributes (Mass Assignment) | `Object.assign(entity, req.body)` | Typed DTOs with explicit allow-list of fields.                        |
| CWE-668 | Exposure of Resource to Wrong Sphere                          | Internal API accessible from public network               | Network segmentation; service-to-service auth.                          |
| CWE-840 | Business Logic Errors                                         | Negotiated workflow can be skipped or replayed            | Enforce state machine; idempotency keys; server-side authority on state.|

### IDOR / BOLA review heuristic

For every endpoint that takes a resource identifier (`/:id`, `/:slug`, `?ref=`), ask: **what stops user A from accessing user B's resource?** If the answer is "the URL is hard to guess," it's not access control — it's obscurity. Required: an explicit ownership/tenancy check on the data fetch itself.

---

## 5. Session Management

| CWE-ID   | Name                                       | Telltale                                              | Mitigation                                                              |
| -------- | ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-384  | Session Fixation                           | Session ID not rotated on login                       | Regenerate session ID on every privilege change (login, MFA, role).     |
| CWE-613  | Insufficient Session Expiration            | Sessions valid for weeks; no idle timeout             | Absolute + idle timeouts; refresh tokens with rotation.                 |
| CWE-614  | Sensitive Cookie Without `Secure` Attribute| Cookie set without `Secure` on HTTPS site             | `Secure` on all auth cookies.                                           |
| CWE-1004 | Sensitive Cookie Without `HttpOnly`        | Auth cookie readable from JS                          | `HttpOnly` on all auth cookies.                                         |
| CWE-1275 | Sensitive Cookie with Improper `SameSite`  | `SameSite=None` without compensating CSRF defence     | `SameSite=Lax` minimum; `Strict` where UX permits.                      |
| CWE-352  | CSRF                                       | Mutating route trusts cookie alone                    | CSRF token (double-submit or synchroniser); SameSite cookies.           |
| CWE-565  | Reliance on Cookies without Validation     | Trusting cookie content for authorisation             | Sign / encrypt cookies; verify integrity server-side.                   |
| CWE-539  | Use of Persistent Cookies Containing Sensitive Information | PII in cookie                            | Session ID only in cookie; sensitive data server-side.                  |

---

## 6. Cryptography

Parent: **CWE-310 — Cryptographic Issues**

| CWE-ID  | Name                                                         | Telltale                                              | Mitigation                                                              |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-327 | Use of Broken / Risky Cryptographic Algorithm                | MD5, SHA-1, DES, 3DES, RC4, ECB mode                  | AES-GCM, ChaCha20-Poly1305, SHA-256/512, Argon2id.                      |
| CWE-326 | Inadequate Encryption Strength                                | AES-128 where 256 required; RSA-1024                  | AES-256-GCM; RSA-3072+ or Ed25519/X25519.                               |
| CWE-330 | Use of Insufficiently Random Values                           | `Math.random()` for tokens                            | `crypto.randomBytes` / `crypto.getRandomValues` / OS CSPRNG.            |
| CWE-338 | Use of Cryptographically Weak PRNG                            | LCG, Mersenne Twister for security purposes           | Cryptographic PRNG.                                                     |
| CWE-916 | Use of Password Hash With Insufficient Computational Effort   | bcrypt with low cost; PBKDF2 with few iterations      | Argon2id default params; bcrypt cost ≥12; PBKDF2 ≥600k (NIST 2024).     |
| CWE-759 | Use of One-Way Hash Without a Salt                            | Raw SHA-256 of password                               | Modern password-hash algorithm with built-in salt.                      |
| CWE-760 | Use of One-Way Hash With a Predictable Salt                   | Username as salt; counter as salt                     | CSPRNG-generated per-record salt.                                       |
| CWE-319 | Cleartext Transmission of Sensitive Information               | HTTP for login; unencrypted SMTP                      | TLS 1.2+ everywhere; HSTS; certificate pinning where appropriate.       |
| CWE-311 | Missing Encryption of Sensitive Data                          | PII stored plain in DB                                | Encrypt at rest (AES-GCM); field-level encryption for high-sensitivity. |
| CWE-312 | Cleartext Storage of Sensitive Information                    | Passwords in plain DB column; tokens in logs          | Hash passwords; mask / omit tokens in logs.                             |
| CWE-313 | Cleartext Storage in a File or on Disk                        | Secrets in unencrypted config file                    | Secret manager; encrypted volumes; KMS.                                 |
| CWE-323 | Reusing a Nonce, Key Pair in Encryption                       | GCM nonce reuse → catastrophic                        | Random nonce per encryption (96-bit for GCM); counter where structured. |
| CWE-347 | Improper Verification of Cryptographic Signature              | Accepting JWT without verifying signature             | Always verify; reject `alg: none`; pin algorithm.                       |
| CWE-345 | Insufficient Verification of Data Authenticity                | Trusting unsigned webhooks                            | HMAC / signed payloads; verify before processing.                       |
| CWE-1240| Use of a Cryptographic Primitive with a Risky Implementation  | Hand-rolled crypto                                    | Use vetted libraries (libsodium, WebCrypto, Node `crypto`).             |
| CWE-1392| Use of Default Credentials                                    | Admin/admin; jwt secret = "secret"                    | Generate per-deployment secrets; refuse to start with defaults.         |

### Cryptography review heuristics

- **Never roll your own crypto.** If you find yourself implementing AES, HMAC, or a signature scheme from primitives, stop. Use libsodium / WebCrypto.
- **JWT `alg: none` and algorithm confusion** (RS256 token accepted as HS256 with public key as secret) are perennial bugs. Pin the algorithm explicitly in verification.
- **Compare in constant time** for tokens, HMACs, signatures. Use `crypto.timingSafeEqual`.
- **Random ≠ cryptographic random.** `Math.random()` is never appropriate for security.

---

## 7. Information Disclosure

Parent: **CWE-200 — Exposure of Sensitive Information to an Unauthorized Actor**

| CWE-ID  | Name                                                       | Telltale                                              | Mitigation                                                              |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-200 | Exposure of Sensitive Information                          | API returns more fields than UI needs                 | Field-level allow-list in serialiser; per-role projections.             |
| CWE-201 | Insertion of Sensitive Information Into Sent Data           | Internal IDs, debug info in response                  | Strip in production serialiser.                                         |
| CWE-209 | Generation of Error Message Containing Sensitive Information| Stack trace, SQL, file path in error response         | Generic error in prod; details only in server logs.                     |
| CWE-532 | Insertion of Sensitive Information into Log File            | `logger.info({ user })` with full user object inc. token | Mask / redact; structured logger with field allow-list.              |
| CWE-538 | File and Directory Information Exposure                     | `index of /` enabled; `.git/` accessible              | Web server config: deny dotfiles, disable autoindex.                    |
| CWE-540 | Inclusion of Sensitive Information in Source Code           | API keys in `git log -p`                              | Pre-commit secret scanning (gitleaks, truffleHog); rotate on leak.      |
| CWE-598 | Use of GET Request with Sensitive Query Strings             | `?token=...` in URL → logs, referrer                  | Sensitive data in POST body or headers, never URL.                      |
| CWE-359 | Exposure of Private Personal Information to an Unauthorized Actor | PII leakage across tenants                    | Tenant isolation tested; row-level security.                            |
| CWE-548 | Exposure of Information Through Directory Listing           | Autoindex enabled                                     | Disable autoindex; explicit 404.                                        |
| CWE-552 | Files or Directories Accessible to External Parties         | Upload folder served back without auth                | Stored outside web root; served through auth-checked handler.           |
| CWE-1230| Exposure of Sensitive Information Through Metadata          | EXIF GPS in user-uploaded photos                      | Strip metadata server-side.                                             |

### Logging redaction discipline

The fields that **always** require masking in logs and crash reports: passwords, tokens (access, refresh, API, CSRF), session IDs, full credit-card / IBAN, government IDs (SSN, TIN, SSS, PhilHealth), full email when not necessary, full IP when geolocated reporting, biometric data, health information.

---

## 8. Input Validation

Parent: **CWE-20 — Improper Input Validation**

| CWE-ID  | Name                                                  | Telltale                                              | Mitigation                                                              |
| ------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-20  | Improper Input Validation                             | Trusting client validation; missing server check      | Validate every boundary (HTTP, queue, file, DB).                        |
| CWE-129 | Improper Validation of Array Index                    | `arr[req.query.i]` without bounds check               | Validate index is integer and within length.                            |
| CWE-606 | Unchecked Input for Loop Condition                    | `for (i = 0; i < req.body.n; i++)` with huge `n`      | Cap `n`; reject excessive values early.                                 |
| CWE-1284| Improper Validation of Specified Quantity in Input    | Negative quantity; absurd quantity                    | Range-check all numerics.                                               |
| CWE-1287| Improper Validation of Specified Type of Input        | Expecting string, receiving array (Express body)      | Schema-validate type and shape (Zod, Joi, Ajv).                         |
| CWE-1289| Improper Validation of Unsafe Equivalence in Input    | Unicode normalisation tricks; mixed-script lookalikes | Normalise (NFKC) and validate against canonical form.                   |
| CWE-694 | Use of Multiple Resources with Duplicate Identifier   | Race between create-by-name and check-by-name         | Unique constraints in DB; check + insert in single transaction.         |

### Validation review heuristic

Validate at **three layers**: client (UX), gateway (shape + cheap rejection), service (business rules and authoritative truth). Client-only validation is never a security control.

---

## 9. Memory Safety

Primarily relevant in C/C++, Rust `unsafe`, FFI, WASM, native node addons. Less common in pure JS/Node but **always** a concern when reviewing native modules or supply-chain dependencies in C.

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-119 | Improper Restriction of Operations within Buffer Bounds   | `strcpy`, raw pointer arithmetic                      | Bounds-checked APIs (`strncpy_s`, std::span); memory-safe language.     |
| CWE-787 | Out-of-bounds Write                                       | Writing past buffer end                               | Bounds checks; safe abstractions; ASLR + stack canaries as mitigation.  |
| CWE-125 | Out-of-bounds Read                                        | Reading past buffer end (Heartbleed)                  | Length validation; safe slice APIs.                                     |
| CWE-416 | Use After Free                                            | Dangling pointer                                      | RAII, smart pointers; Rust ownership.                                   |
| CWE-415 | Double Free                                               | Freeing same allocation twice                         | Null after free; smart pointers.                                        |
| CWE-476 | NULL Pointer Dereference                                  | Missing nullcheck                                     | Defensive checks; Optional/Maybe types; non-null types where available. |
| CWE-401 | Missing Release of Memory after Effective Lifetime         | Memory leak                                           | RAII; explicit lifetime management.                                     |
| CWE-190 | Integer Overflow or Wraparound                            | Arithmetic on `int32` without checks                  | Checked arithmetic; use BigInt for large unbounded values.              |
| CWE-191 | Integer Underflow                                         | Subtracting unsigned past zero                        | Range checks before arithmetic.                                         |
| CWE-369 | Divide By Zero                                            | Division without check                                | Validate divisor.                                                       |

---

## 10. Concurrency

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-362 | Race Condition                                            | Check-then-act without lock; non-atomic read-modify-write | Atomic operations; DB transactions; optimistic locking with version.    |
| CWE-367 | TOCTOU (Time-of-check Time-of-use)                        | `if (canAccess(path)) read(path)` — path can change   | Operate on file descriptor; check-and-act atomically.                   |
| CWE-820 | Missing Synchronization                                   | Shared mutable state without lock                     | Locks, atomics, message passing, immutability.                          |
| CWE-833 | Deadlock                                                  | Inconsistent lock ordering                            | Global lock-acquisition order; lock-free where possible; timeouts.      |
| CWE-366 | Race Condition within a Thread                            | Same-thread reentrancy issues                         | Reentrant data structures; careful callback design.                     |
| CWE-543 | Use of Singleton Pattern Without Synchronization in Multithreaded Context | Lazy init race                          | Eager init or double-checked locking done correctly.                    |

---

## 11. Resource Management & DoS

Parent: **CWE-400 — Uncontrolled Resource Consumption**

| CWE-ID  | Name                                                  | Telltale                                              | Mitigation                                                              |
| ------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-400 | Uncontrolled Resource Consumption                     | No limits on memory, CPU, connections                 | Quotas; rate limits; circuit breakers; bounded queues.                  |
| CWE-770 | Allocation of Resources Without Limits or Throttling  | `Array(req.body.n)` with no cap                       | Cap allocations; reject early.                                          |
| CWE-674 | Uncontrolled Recursion                                | Recursive JSON parser; recursive permission resolver  | Iterative implementations; max-depth guards.                            |
| CWE-1333| Inefficient Regular Expression Complexity (ReDoS)     | Catastrophic backtracking patterns                    | Linear regex engines (RE2); review patterns for `(a+)+`, `(a|a)+`.      |
| CWE-407 | Inefficient Algorithmic Complexity                    | O(n²) on attacker-controlled n                        | Choose O(n log n) or better; cap n.                                     |
| CWE-409 | Improper Handling of Highly Compressed Data (Zip Bomb)| Decompressing untrusted archive                       | Cap decompressed size; check compression ratio.                         |
| CWE-776 | XML Entity Expansion (Billion Laughs)                 | DTD with nested entity references                     | Disable DTD; cap entity expansion.                                      |
| CWE-789 | Memory Allocation with Excessive Size Value           | `Buffer.alloc(req.query.size)`                        | Cap size; validate against legitimate range.                            |
| CWE-1284| Improper Validation of Specified Quantity             | Same as input validation                              | See section 8.                                                          |
| CWE-405 | Asymmetric Resource Consumption (Amplification)       | Small request → large response/work                   | Bound work per request; require auth for expensive operations.          |

---

## 12. Path Traversal & File Handling

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-22  | Path Traversal                                            | `../../etc/passwd` in input                           | `path.resolve` + prefix check against intended root.                    |
| CWE-23  | Relative Path Traversal                                   | Subset of CWE-22                                      | Same as CWE-22.                                                         |
| CWE-36  | Absolute Path Traversal                                   | Input is `/etc/passwd`                                | Reject absolute paths in user input.                                    |
| CWE-73  | External Control of File Name or Path                     | User picks filename for server-side write             | Generate filenames; map user-supplied to internal IDs.                  |
| CWE-377 | Insecure Temporary File                                   | Predictable temp path, race on creation               | `mkstemp` / `O_CREAT|O_EXCL`; OS temp APIs.                             |
| CWE-434 | Unrestricted Upload of File with Dangerous Type           | `.php`/`.jsp` accepted; MIME from header              | Extension allow-list; MIME sniff content; store outside web root.       |
| CWE-451 | UI Misrepresentation (e.g., RTL filename trick)           | `evil.exe` shown as `eve.txt` via RTLO                | Sanitise filenames for display; normalise unicode.                      |
| CWE-552 | Files or Directories Accessible to External Parties       | Upload dir served directly                            | Serve through authenticated handler.                                    |
| CWE-426 | Untrusted Search Path                                     | `PATH` includes `.` or user-writable dirs             | Pin absolute paths; controlled environment.                             |
| CWE-427 | Uncontrolled Search Path Element                          | DLL hijacking; SO hijacking                           | Absolute paths; secure linker flags.                                    |

---

## 13. Deserialization & Object Manipulation

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-502 | Deserialization of Untrusted Data                         | Java `ObjectInputStream`, Python `pickle`, PHP `unserialize`, Node `node-serialize` | JSON-only for cross-trust boundaries; signed payloads if binary required. |
| CWE-915 | Mass Assignment                                           | `Object.assign(entity, req.body)`                     | Typed DTO; explicit field mapping.                                      |
| CWE-1321| Prototype Pollution                                       | `merge`, `set`, `lodash.set` with user keys           | Reject `__proto__`, `constructor`, `prototype` keys; `Object.create(null)`; libraries with guards. |
| CWE-913 | Improper Control of Dynamically-Managed Code Resources    | `require(req.query.module)`                           | Allow-list; static imports.                                             |
| CWE-1188| Initialization of a Resource with an Insecure Default     | Library defaults that enable unsafe features          | Override defaults; document hardened config.                            |

---

## 14. XML & Parser Issues

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-611 | XML External Entity (XXE)                                 | DTD/external entity processing on                     | Disable DOCTYPE, external entities, parameter entities (`noent: false`, `dtdload: false`). |
| CWE-776 | Improper Restriction of Recursive Entity References (Billion Laughs) | Nested entity expansion                  | Disable DTD; cap expansion.                                             |
| CWE-91  | XML Injection                                             | User input into XML structure                         | XML-encode; structured builders.                                        |
| CWE-643 | XPath Injection                                           | User input in XPath                                   | Parameterised XPath.                                                    |
| CWE-918 | SSRF via XML/JSON URI                                     | XML parser fetching `xsi:schemaLocation` URL          | Disable network access in parser.                                       |

---

## 15. Web-Specific Weaknesses

| CWE-ID   | Name                                                      | Telltale                                              | Mitigation                                                              |
| -------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-352  | CSRF                                                      | State-changing route trusting cookie                  | CSRF tokens; SameSite cookies; double-submit pattern.                   |
| CWE-1021 | Improper Restriction of Rendered UI Layers (Clickjacking) | App framable in iframe                                | CSP `frame-ancestors 'none'`; `X-Frame-Options: DENY`.                  |
| CWE-601  | URL Redirection to Untrusted Site (Open Redirect)         | `res.redirect(req.query.next)`                        | Allow-list of safe paths; relative-only redirects.                      |
| CWE-942  | Permissive Cross-domain Policy                            | `Access-Control-Allow-Origin: *` with credentials     | Specific origin; `Vary: Origin`; never `*` with credentials.            |
| CWE-693  | Protection Mechanism Failure                              | Missing security headers                              | Helmet; set all standard headers.                                       |
| CWE-693  | Missing HSTS                                              | No `Strict-Transport-Security` header                 | `max-age=31536000; includeSubDomains; preload`.                         |
| CWE-1173 | Improper Use of Validation Framework                      | Validation rules bypassed by HTTP method override     | Apply same validation regardless of method override.                    |
| CWE-444  | HTTP Request Smuggling                                    | Mismatched `Content-Length` / `Transfer-Encoding`     | Strict parsing; upgrade reverse proxies.                                |
| CWE-117  | Improper Output Neutralization for Logs                   | CR/LF / ANSI escapes in log lines                     | Strip control chars; structured JSON logs.                              |
| CWE-1275 | SameSite cookies (see Session Management)                 | See section 5                                         | See section 5.                                                          |

---

## 16. SSRF & Request Forgery

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-918 | Server-Side Request Forgery (SSRF)                        | Outbound HTTP with user URL; webhook fetcher; image proxy | Allow-list hosts; resolve DNS server-side and block private/link-local/metadata ranges; disable redirects across hosts. |
| CWE-441 | Unintended Proxy or Intermediary (Confused Deputy)        | Server makes request on behalf of user without auth context | Pass user auth through; verify intent.                                  |
| CWE-352 | CSRF (see Web-Specific)                                   | See section 15                                        | See section 15.                                                         |
| CWE-940 | Improper Verification of Source of a Communication Channel| Trusting `Origin` / `Referer` alone                   | Use cryptographic verification (CSRF token, signed webhook).            |

### SSRF block list (always)

- `127.0.0.0/8` (loopback)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 private)
- `169.254.0.0/16` (link-local, includes cloud metadata `169.254.169.254`)
- `100.64.0.0/10` (CGNAT)
- `::1/128`, `fc00::/7`, `fe80::/10` (IPv6 private/loopback/link-local)
- DNS-resolve server-side; do not let the HTTP library resolve from user input.

---

## 17. Business Logic

These are weaknesses in the **rules** the application enforces, not the **code** that enforces them. No scanner catches them — review requires domain knowledge.

| CWE-ID  | Name                                                          | Telltale                                              | Mitigation                                                              |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-840 | Business Logic Errors                                         | Workflow allows skipping required steps                | Server-side state machine; reject out-of-order transitions.             |
| CWE-841 | Improper Enforcement of Behavioral Workflow                   | Client-driven workflow                                | Server is authoritative on state.                                       |
| CWE-799 | Improper Control of Interaction Frequency                     | No throttle on coupon redemption                      | Per-account rate limit; idempotency keys.                               |
| CWE-837 | Improper Enforcement of a Single, Unique Action               | Voucher redeemable multiple times via race            | DB unique constraint; transactional check-and-use.                      |
| CWE-770 | No quantity limit                                             | Buy negative quantity → refund                        | Range-validate quantities; signed totals.                               |
| CWE-345 | Insufficient Verification of Data Authenticity                | Trusting client-supplied price                        | Recompute price server-side from product ID.                            |

### Financial / accounting-specific business-logic risks

- Negative amounts where only positive is expected (returns, refunds, vouchers).
- Floating-point arithmetic on currency → off-by-cent errors that violate GAAP/IFRS.
- TOCTOU on balance checks → spend twice.
- Replay of approved transactions.
- Currency / unit confusion (USD vs PHP, cents vs whole units).
- Off-by-one in date ranges → revenue recognised in wrong period.

---

## 18. Supply Chain

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-1357| Reliance on Insufficiently Trustworthy Component          | Single-maintainer abandonware                         | Vet maintainership; prefer maintained alternatives.                     |
| CWE-1395| Dependency on Vulnerable Third-Party Component             | Outdated package with known CVE                       | SCA in CI; auto-PR for patches; SBOM.                                   |
| CWE-829 | Inclusion of Functionality from Untrusted Control Sphere   | Loading remote JS at runtime                          | Bundle at build; pin SRI hashes on third-party scripts.                 |
| CWE-494 | Download of Code Without Integrity Check                   | `curl ... | sh` install scripts                       | Verify checksums / signatures; pin versions.                            |
| CWE-1104| Use of Unmaintained Third-Party Components                 | Library last published 5 years ago                    | Track maintenance signals; have a fork plan.                            |
| CWE-506 | Embedded Malicious Code                                    | Typosquatting; compromised maintainer account         | Lockfile review; package signature verification; runtime egress monitoring. |
| CWE-915 | Mass assignment (see Authz)                                | When triggered by deserialising attacker payload      | See section 4.                                                          |

### Supply-chain hardening

- **Lockfile committed** (`package-lock.json`, `yarn.lock`) and CI installs from it (`npm ci`).
- **SCA in CI:** Dependabot, Renovate, Snyk, GitHub Advanced Security, or equivalent.
- **SBOM** generated per release (CycloneDX preferred).
- **SLSA level ≥ 2** for build provenance (signed, source-correlated builds).
- **Verify package signatures** where the registry supports them (npm provenance, Sigstore).
- **Egress allow-list** in production — a compromised dep cannot exfiltrate to `evil.com` if the network refuses.

---

## 19. Misconfiguration

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-16  | Configuration                                             | Catch-all for misconfig                               | Hardened defaults; config review.                                       |
| CWE-756 | Missing Custom Error Page                                 | Default server error page reveals stack               | Custom 4xx/5xx pages.                                                   |
| CWE-942 | Permissive CORS                                           | See section 15                                        | Specific origins.                                                       |
| CWE-1392| Use of Default Credentials                                | Admin/admin in deployed product                       | Refuse to start; force rotation.                                        |
| CWE-489 | Active Debug Code                                         | Debug routes in prod                                  | Strip at build; separate prod profile.                                  |
| CWE-1393| Use of Default Password                                   | Same as CWE-1392                                      | Same as CWE-1392.                                                       |
| CWE-209 | Verbose errors (see Information Disclosure)               | See section 7                                         | Generic prod errors.                                                    |
| CWE-732 | World-writable files (see Authz)                          | See section 4                                         | Restrict modes.                                                         |
| CWE-552 | Backup files accessible (`.bak`, `~`)                     | `app.js.bak` in deploy                                | Deploy whitelist; deny dotfiles and backup patterns.                    |

---

## 20. Logging & Monitoring

OWASP A09:2021 — **Security Logging and Monitoring Failures**. Not having logs is itself a weakness.

| CWE-ID  | Name                                                      | Telltale                                              | Mitigation                                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| CWE-778 | Insufficient Logging                                      | Auth failures not logged                              | Log all auth events, authz denials, admin actions, integrity checks.    |
| CWE-117 | Improper Output Neutralization for Logs (Log Injection)    | User input rendered raw in log line                   | Structured JSON; strip CR/LF; escape control chars.                     |
| CWE-532 | Sensitive info in logs (see Information Disclosure)       | See section 7                                         | Redact / mask.                                                          |
| CWE-223 | Omission of Security-relevant Information                  | Logs missing user, IP, action                         | Standard log schema with mandatory fields.                              |
| CWE-779 | Logging of Excessive Data                                  | Logging entire request bodies in production           | Sample; redact; tier (debug/info/warn/error).                           |

### Required log events

- Authentication (success and failure, with reason for failure but without revealing whether user exists)
- Authorisation denials
- Admin actions (user creation, role change, config change)
- Data export / bulk read
- Cryptographic key operations
- Integrity-check failures (signature, checksum, HMAC)
- Rate-limit triggers
- Input validation rejections at gateway

---

## 21. Cross-cutting Hardening Checklist

Run mentally on every new feature, every PR, every threat-model review:

- [ ] **Auth:** Is auth required? Which CWE-287 / CWE-306 controls apply?
- [ ] **Authz:** Whose data can this access? Where is the CWE-639/862/863 check?
- [ ] **Input:** What is the trust boundary? Validated against what schema?
- [ ] **Output encoding:** Where does data leave the trust boundary into another parser? Correctly encoded?
- [ ] **Crypto:** Are passwords hashed correctly (CWE-916)? Tokens random (CWE-330)? Signatures verified (CWE-347)?
- [ ] **Errors:** Do prod errors leak details (CWE-209)?
- [ ] **Logs:** Are security events logged (CWE-778)? Is sensitive data redacted (CWE-532)?
- [ ] **Rate limits:** Auth, expensive ops, write endpoints (CWE-307, CWE-770)?
- [ ] **CORS / CSP / headers:** All set (CWE-693)?
- [ ] **Deps:** Recent SCA scan? Any unpatched Critical/High on the touched code path (CWE-1395)?
- [ ] **Business logic:** State machine enforced server-side (CWE-840)? Replay-safe (CWE-294)? Idempotent (CWE-837)?
- [ ] **Data classification:** What sensitivity? Triggers PCI / HIPAA / GDPR / DPA controls?
- [ ] **Failure mode:** What happens under load, under partial failure, under attack? (link to chaos engineering)

---

**Last reviewed against:** CWE 4.13 (current MITRE release as of 2026). Cross-check `cwe.mitre.org` if an ID looks unfamiliar — the catalog grows.
