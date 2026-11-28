# Secure Development Lifecycle

Reference for engineering practices that make security continuous rather than a one-time audit: scanning tools, threat modeling frameworks, supply-chain integrity, and incident response. Load this when integrating security into a CI pipeline, threat-modeling a new feature, hardening the build/release process, or planning the incident-response playbook.

---

## Table of Contents

1. [Application security testing — the four scan types](#1-application-security-testing--the-four-scan-types)
2. [Threat modeling frameworks](#2-threat-modeling-frameworks)
3. [Supply-chain integrity](#3-supply-chain-integrity)
4. [Secrets management](#4-secrets-management)
5. [Secure code review checklist](#5-secure-code-review-checklist)
6. [CI/CD security gates](#6-cicd-security-gates)
7. [Incident response (NIST 800-61)](#7-incident-response-nist-800-61)
8. [Responsible disclosure for your project](#8-responsible-disclosure-for-your-project)
9. [Compliance crosswalk](#9-compliance-crosswalk)

---

## 1. Application security testing — the four scan types

Each scan type sees a different slice of the system. **None replaces the others.** A mature pipeline runs at least SAST + SCA + secret scanning at PR time, DAST against staging on merge, and ideally IAST/RASP in pre-prod or prod-shadow.

### SAST — Static Application Security Testing

Analyses source code or compiled bytecode without executing it. Finds: injection patterns, hard-coded secrets, unsafe deserialization, weak crypto choices, missing auth annotations.

| Tool                                                                                   | Notes                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Semgrep**                                                                            | Pattern-based, fast, open-source rules. Great for custom rules tuned to your codebase. |
| **CodeQL** (GitHub)                                                                    | Query language; deep dataflow analysis; free for OSS, paid for private repos.          |
| **SonarQube / SonarCloud**                                                             | Broad language coverage; quality + security; gated quality profiles.                   |
| **Snyk Code**                                                                          | Symbolic execution; commercial; fast.                                                  |
| **Checkmarx, Veracode, Fortify**                                                       | Enterprise SAST; deep but slow.                                                        |
| **ESLint security plugins** (`eslint-plugin-security`, `eslint-plugin-no-unsanitized`) | Lint-level; quick wins for JS.                                                         |

**Strengths:** finds vulnerabilities before the code runs; surfaces issues at PR time when fix is cheapest; catches issues in code paths that aren't yet tested.

**Limitations:** high false-positive rate on framework-handled cases (e.g., React auto-escaping XSS); cannot see runtime configuration; cannot find business-logic flaws.

### DAST — Dynamic Application Security Testing

Probes a _running_ application from the outside, like a black-box attacker. Finds: misconfigurations, missing security headers, auth bypass, injection that manifests over the wire, server-side processing flaws.

| Tool                                        | Notes                                                             |
| ------------------------------------------- | ----------------------------------------------------------------- |
| **OWASP ZAP**                               | Open-source; scriptable; CI-friendly. The default starting point. |
| **Burp Suite** (Pro / Enterprise)           | Industry standard for manual testing; Enterprise for automation.  |
| **Nuclei**                                  | Template-based scanner; fast; massive community template library. |
| **Acunetix, AppScan, Rapid7 InsightAppSec** | Commercial DAST suites.                                           |

**Strengths:** sees the real attack surface; catches misconfigurations SAST can't; framework-agnostic.

**Limitations:** only finds bugs in exercised paths; needs an environment to scan; slow; can damage data — run against an isolated staging environment with test data.

### SCA — Software Composition Analysis

Inventories dependencies and checks them against vulnerability databases. See `cve-methodology.md` for full handling.

| Tool                                          | Notes                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| **`npm audit` / `yarn audit` / `pnpm audit`** | Built-in; uses GHSA; baseline.                                                  |
| **Dependabot / Renovate**                     | Auto-PR for upgrades; configure version policy carefully.                       |
| **Snyk Open Source**                          | Reachability analysis; broader DB than `npm audit`.                             |
| **Trivy**                                     | OSS; container + dependency + SBOM in one tool.                                 |
| **Grype**                                     | OSS; pairs with Syft for SBOM-driven scanning.                                  |
| **OWASP Dependency-Check**                    | OSS; CVE-focused; broad language support.                                       |
| **OWASP Dependency-Track**                    | OSS; consumes SBOMs; org-wide vulnerability dashboard.                          |
| **Socket.dev**                                | Behaviour analysis of npm packages — flags supply-chain risk beyond known CVEs. |
| **GitHub Advanced Security**                  | Bundles SCA + secret scanning + CodeQL.                                         |

### IAST — Interactive Application Security Testing

Runtime instrumentation that observes application behaviour from inside. Combines SAST visibility (source location) with DAST accuracy (real execution).

| Tool                  | Notes                            |
| --------------------- | -------------------------------- |
| **Contrast Security** | Commercial; mature; agent-based. |
| **Datadog ASM**       | Pairs with existing Datadog APM. |
| **Seeker (Synopsys)** | Enterprise.                      |

**Use case:** run during integration/e2e tests in CI to get extremely accurate vulnerability findings tied to specific request flows. Lower false-positive rate than SAST or DAST alone.

### RASP — Runtime Application Self-Protection

Runtime defence: blocks attacks as they happen, in production. Same vendors as IAST typically offer it. Trade-off: latency overhead and operational complexity vs. immediate protection against unpatched vulnerabilities.

### Secret scanning

Always-on, separate from SAST. Catches API keys, tokens, private keys committed to source.

| Tool                       | Notes                                                  |
| -------------------------- | ------------------------------------------------------ |
| **gitleaks**               | OSS; pre-commit + CI.                                  |
| **truffleHog**             | OSS; deep git-history scanning.                        |
| **GitHub secret scanning** | Built-in; alerts partners (AWS, Stripe, etc.) on leak. |
| **detect-secrets** (Yelp)  | OSS; baseline file pattern.                            |

**Always combine with pre-commit hooks** (`pre-commit` framework) so leaks never enter git history — rotation is faster than removal.

---

## 2. Threat modeling frameworks

Threat modeling is a structured conversation: _what could go wrong?_ Done at design time, before code, on every new feature with meaningful trust boundaries.

### The four questions (Shostack)

1. **What are we building?** — system diagram with trust boundaries.
2. **What can go wrong?** — apply a framework (STRIDE, PASTA, LINDDUN).
3. **What are we going to do about it?** — controls, mitigations, accepted risk.
4. **Did we do a good job?** — review, validate, iterate.

### STRIDE (Microsoft)

The most-used framework. One letter per category of threat — walk every component / data flow against each.

| Letter | Threat                 | Violates property | Example mitigation                                     |
| ------ | ---------------------- | ----------------- | ------------------------------------------------------ |
| **S**  | Spoofing               | Authentication    | Strong auth, MFA, mutual TLS                           |
| **T**  | Tampering              | Integrity         | Signatures, HMAC, ACLs, audit logs                     |
| **R**  | Repudiation            | Non-repudiation   | Append-only audit log, signed receipts                 |
| **I**  | Information Disclosure | Confidentiality   | Encryption at rest/in transit, access control, masking |
| **D**  | Denial of Service      | Availability      | Rate limits, quotas, autoscaling, circuit breakers     |
| **E**  | Elevation of Privilege | Authorisation     | Least privilege, sandboxing, input validation          |

**STRIDE-per-element:** apply each letter to each component (process, data store, data flow, external entity) in your diagram. STRIDE-per-interaction does the same per data flow — more thorough, more work.

### PASTA — Process for Attack Simulation and Threat Analysis

Seven-stage, risk-centric, business-aligned. Heavier than STRIDE; appropriate for high-stakes systems (finance, healthcare, critical infrastructure).

1. Define business objectives.
2. Define technical scope.
3. Application decomposition.
4. Threat analysis.
5. Vulnerability analysis.
6. Attack modeling.
7. Risk analysis and countermeasures.

### LINDDUN — privacy threat modeling

Privacy-focused complement to STRIDE. Use when handling personal data (always relevant under GDPR / Philippine Data Privacy Act / CCPA).

| Letter | Threat                                                                                |
| ------ | ------------------------------------------------------------------------------------- |
| **L**  | Linkability — can two records be linked to the same person?                           |
| **I**  | Identifiability — can a record be tied to a real identity?                            |
| **N**  | Non-repudiation — can the user deny an action they took? (sometimes a privacy _good_) |
| **D**  | Detectability — can an outsider tell whether a record exists?                         |
| **D**  | Data disclosure                                                                       |
| **U**  | Unawareness — does the user know what data is collected and how it's used?            |
| **N**  | Non-compliance — with applicable privacy law                                          |

### DREAD — risk scoring

For prioritising threats found during modeling. **Damage**, **Reproducibility**, **Exploitability**, **Affected users**, **Discoverability**. Score 1–10 each, average. Loose, but useful for stack-ranking when CVSS doesn't apply (design-time threats don't have CVEs yet).

### Attack trees

Diagram form: root node is attacker goal, children are sub-goals, leaves are concrete attacks. Useful for adversarial brainstorming and for explaining attack chains to non-security stakeholders.

### MITRE ATT&CK

Knowledge base of real-world attacker tactics and techniques. Use it to validate detection coverage (do we log/alert on the things attackers actually do?) and during incident response (which technique are we observing?). See `attack.mitre.org`.

### CAPEC

Common Attack Pattern Enumeration and Classification. The attacker-perspective complement to CWE. CWE says "this code has a weakness"; CAPEC says "here's how to exploit it."

---

## 3. Supply-chain integrity

Modern attacks increasingly target the build pipeline rather than the running app — Log4Shell, SolarWinds, event-stream, ua-parser-js, codecov. Defence has three layers: source, build, deployment.

### SLSA — Supply-chain Levels for Software Artifacts

Pronounced "salsa." Tiered framework from Google / OpenSSF (`slsa.dev`).

| Level  | Requirements                                                                                 |
| ------ | -------------------------------------------------------------------------------------------- |
| **L0** | No guarantees                                                                                |
| **L1** | Build process documented; provenance generated                                               |
| **L2** | Tamper-resistant build service; signed provenance; version-controlled source                 |
| **L3** | Hardened build platform; non-falsifiable provenance; isolated build environments             |
| **L4** | (deprecated in v1.0; concepts merged into L3) Two-party review, hermetic reproducible builds |

**Practical floor for production:** SLSA L2 — use GitHub Actions / GitLab CI with provenance attestation, sign artifacts, pin action versions to SHA (not tag).

### Sigstore

Free, open-source signing infrastructure for software artifacts. Components:

- **Cosign** — sign and verify container images and any blob.
- **Fulcio** — short-lived certificate authority bound to OIDC identity (e.g., GitHub Actions OIDC).
- **Rekor** — append-only transparency log of signatures.

`cosign sign` + `cosign verify` adds artifact integrity to a release pipeline with low operational cost.

### in-toto

Cryptographically verifies the **steps** of the build pipeline — each step signed by the role that performed it. Catches tampering between stages. `in-toto-run` / `in-toto-verify`.

### npm provenance

`npm publish --provenance` from GitHub Actions attaches a Sigstore-backed provenance statement to a published package. Consumers can verify the package came from the claimed source repo and CI workflow. Adopt for any package you publish.

### Lockfile discipline

- Commit the lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`).
- CI must install from lockfile (`npm ci`, `yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile`).
- Lockfile diffs in PR reviewed like any other code — large transitive churn is a smell.
- Use `npm overrides` / `yarn resolutions` to pin vulnerable transitive deps when upstream is slow.

### Build hardening

- **Pin action versions to commit SHA**, not tags or major: `uses: actions/checkout@a1b2c3d4...` not `actions/checkout@v4`.
- **Minimal permissions on GITHUB_TOKEN**: `permissions: contents: read` by default; elevate per-job.
- **No secrets in PR-triggered workflows** from forks — use `pull_request_target` only with extreme care.
- **Separate build identity from publish identity** — build workflow cannot publish; publish workflow requires manual approval / protected environment.
- **Reproducible builds** where the ecosystem supports it (deterministic output for the same input).

### Container image hygiene

- Pin base images to digest (`FROM node@sha256:...`), not tag.
- Use minimal bases (distroless, Alpine, Wolfi).
- Drop capabilities, run as non-root, read-only root filesystem.
- Scan with Trivy / Grype before push.
- Sign with Cosign on push.

---

## 4. Secrets management

Hierarchy from worst to best:

1. ❌ Hard-coded in source — never (CWE-798).
2. ❌ Committed `.env` file — never.
3. ⚠️ Untracked `.env` on production server — workable for one-server hobby projects only.
4. Platform env vars (Heroku, Vercel, container orchestrator secret) — baseline for small teams.
5. Secret manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, Doppler, 1Password) — baseline for production.
6. Secret manager + short-lived credentials (OIDC / workload identity / IAM roles) — no long-lived secrets in any environment.

### Operational rules

- **Rotate** on incident, on employee departure, on suspicion. Have a rotation runbook before you need it.
- **Audit access** — who read which secret when. Most secret managers log this.
- **Separate secrets per environment** — dev/staging/prod never share keys.
- **No secrets in logs, no secrets in error messages, no secrets in URLs** (CWE-532, CWE-209, CWE-598).
- **Pre-commit secret scanning** to catch leaks before they're committed (gitleaks).
- **Post-incident scanning** of git history if a leak is suspected (truffleHog).

If a secret leaks: **rotate first, investigate second.** Git history rewrites do not retract a leaked secret — assume any pushed value is permanently compromised.

---

## 5. Secure code review checklist

Run mentally on every PR that touches:

### Authentication / authorisation

- Is auth required on every new route? Which middleware enforces it?
- Are authorisation checks on the resource fetch itself, not just the route?
- Tenant / ownership boundary respected on reads _and_ writes?
- Any privileged fields accepted from user input? (mass assignment — CWE-915)

### Input handling

- Schema validation on the request body, query, headers, route params?
- Numeric inputs range-checked?
- File uploads: extension, MIME (sniffed), size, virus scan if relevant?
- Any place untrusted data crosses into SQL, HTML, shell, URL, regex, template, log, file path, XML, JSON?

### Output

- Errors generic in production? No stack traces? (CWE-209)
- Logs scrubbed of tokens, passwords, PII? (CWE-532)
- API responses field-allow-listed per role?

### Crypto

- Passwords hashed with Argon2id / scrypt / bcrypt? (CWE-916)
- Tokens generated from CSPRNG, ≥128 bits? (CWE-330)
- JWT algorithm pinned, signature verified, claims validated (`iss`, `aud`, `exp`, `nbf`)?
- TLS used for all sensitive transport?
- HMAC / signature on inbound webhooks?

### Resilience

- Timeouts on all outbound calls?
- Retries bounded (count + budget)?
- Circuit breaker where appropriate?
- Idempotency keys on mutating endpoints?
- Rate limit on the route — at appropriate cardinality (per-IP, per-user, per-tenant)?

### Dependencies

- Any new direct dependencies? License OK? Maintenance signals OK?
- SCA scan clean on the new dep tree?
- Lockfile churn explained?

### Documentation & ops

- New `.env` variable documented in `.env.example`?
- New log message named in `constants/messages/`?
- New route in API docs?
- Changelog updated?

---

## 6. CI/CD security gates

Suggested pipeline stages (block at hard gates, warn at soft gates):

### Pre-commit (developer machine)

- **Hard:** secret scan (gitleaks).
- **Soft:** linter security plugins.

### PR-time (CI on every commit)

- **Hard:** secret scan; SAST high-severity; SCA Critical/High on reachable paths; license check; type-check / lint.
- **Soft:** SAST medium; SCA Medium; coverage delta; complexity delta.

### Pre-merge (CI on PR ready)

- **Hard:** full test suite (unit + integration + security tests); SBOM generation succeeds.

### Post-merge to main (deploys to staging)

- **Hard:** build provenance signed; container image scanned and signed.
- **Soft:** DAST against staging; performance baseline.

### Pre-prod release

- **Hard:** all open Critical/High CVEs on reachable paths resolved or suppressed-with-justification; SBOM attached to release; KEV cross-check.
- **Soft:** chaos test passing; load test passing.

### Post-deploy

- Runtime monitoring (RASP, anomaly detection).
- Continuous SCA — new CVEs against deployed SBOM trigger re-triage automatically.

---

## 7. Incident response (NIST 800-61)

The canonical framework. Four phases — practise the playbook before you need it.

### Phase 1 — Preparation

Before any incident:

- Documented IR plan with named roles (incident commander, comms lead, scribe, technical lead).
- On-call rotation with escalation paths.
- Runbooks for common scenarios (credential leak, DB exfiltration, malicious dependency, ransomware, account takeover).
- Pre-approved external comms templates (status page, customer email, regulator notification).
- Forensic tooling ready (log retention, packet capture where relevant, image-capture procedure).
- Tabletop exercises every quarter.

### Phase 2 — Detection and Analysis

- Monitoring fires alert → IC paged.
- Triage: is this real? what's the scope? what's the blast radius?
- Open an incident channel (Slack / Teams) with strict membership; appoint scribe.
- Classify severity (your org's scale — typically SEV1/2/3/4).
- Start the timeline document — every action logged with timestamp and actor.

### Phase 3 — Containment, Eradication, Recovery

**Containment** — stop the bleeding without destroying evidence:

- Short-term: isolate affected hosts, revoke credentials, block IP ranges, disable feature flags.
- Long-term: patch, rebuild, re-image with the fix.

**Eradication** — remove the foothold:

- Rotate every credential that may have been exposed.
- Remove backdoors, persistence mechanisms.
- Verify root cause is addressed, not just symptoms.

**Recovery** — return to normal:

- Restore from clean backups where needed.
- Re-enable services in stages with monitoring.
- Heightened monitoring for re-occurrence for a defined window.

### Phase 4 — Post-incident activity

- **Blameless post-mortem** within 7 days. What happened, what worked, what didn't, what to change.
- **Track follow-up actions** as concrete tickets with owners and deadlines — not vague resolutions.
- **Update runbooks** based on what the incident taught you.
- **Update detection** to catch this class of incident faster next time.
- **Customer / regulator notification** if legally required (GDPR 72-hour breach notification; Philippine NPC 72-hour breach notification under DPA; state-by-state US breach laws).

### Evidence preservation

If law enforcement or litigation is even possible:

- Do not power off potentially-compromised systems — image them.
- Preserve volatile memory if you can capture it safely.
- Maintain chain of custody for any artifact retained as evidence.
- Engage legal counsel early.

---

## 8. Responsible disclosure for your project

Make it easy for researchers to report vulnerabilities to _you_.

### `SECURITY.md` (committed to repo root)

Cover at minimum:

- Where to send reports (dedicated email like `security@<domain>`, not a personal address).
- Encryption (PGP key, Signal contact) for sensitive details.
- Expected response time (acknowledge within 24h, triage within 72h).
- Safe-harbour language — researchers acting in good faith will not face legal action.
- Scope — what's in, what's out.
- Reward / recognition policy (hall of fame, swag, bounty program if any).

### `security.txt` (RFC 9116)

Serve at `/.well-known/security.txt`:

```
Contact: mailto:security@example.com
Expires: 2027-01-01T00:00:00.000Z
Encryption: https://example.com/pgp-key.txt
Acknowledgments: https://example.com/security/hall-of-fame
Preferred-Languages: en, fil
Canonical: https://example.com/.well-known/security.txt
Policy: https://example.com/security/policy
```

### Bug bounty platforms

For higher engagement: **HackerOne**, **Bugcrowd**, **Intigriti**, **YesWeHack**. Define scope tightly, set bounty bands appropriate to severity, dedicate triage capacity before launching.

---

## 9. Compliance crosswalk

Quick map of which framework applies when. Each has its own controls; map your security baseline once, satisfy multiple frameworks with overlapping evidence.

| Framework                     | When it applies                                | Highlights                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PCI-DSS v4.0**              | Handling payment card data                     | Network segmentation, encryption, quarterly scans, annual pen test, secure SDLC requirements                                                                   |
| **HIPAA / HITECH**            | US healthcare PHI                              | Encryption, access controls, audit logs, breach notification (60-day)                                                                                          |
| **SOX**                       | US publicly-traded co's financial reporting    | Change management, access controls, audit trails on financial systems                                                                                          |
| **GDPR**                      | Processing EU residents' personal data         | Lawful basis, DPIA, 72-hour breach notification, right to erasure, DPO appointment, DPA with processors                                                        |
| **Philippine DPA (RA 10173)** | Processing Philippine residents' personal data | NPC registration, DPO appointment, 72-hour breach notification, security measures, data subject rights                                                         |
| **CCPA / CPRA**               | US California residents' personal data         | Right to know, delete, opt out; data minimisation                                                                                                              |
| **ISO 27001 / 27002**         | Voluntary; common B2B contractual ask          | ISMS with 93 controls (2022 version); risk-based                                                                                                               |
| **SOC 2 Type II**             | Voluntary; common B2B SaaS ask                 | Trust Services Criteria (Security mandatory; Availability, Confidentiality, Processing Integrity, Privacy optional); auditor reviews evidence over 6–12 months |
| **NIST CSF 2.0**              | Voluntary; US federal baseline                 | Govern, Identify, Protect, Detect, Respond, Recover                                                                                                            |
| **NIST 800-53**               | US federal info systems (FedRAMP)              | Comprehensive control catalog; baselines by impact (Low/Moderate/High)                                                                                         |
| **CIS Controls v8**           | Voluntary; practical prioritised list          | 18 controls, three implementation groups                                                                                                                       |
| **FedRAMP**                   | US gov cloud services                          | NIST 800-53 based; authorisation process; continuous monitoring                                                                                                |
| **DORA**                      | EU financial entities and ICT providers (2025) | Operational resilience, third-party risk, incident reporting                                                                                                   |
| **NIS2**                      | EU essential and important entities            | Risk management, incident reporting, supply-chain security                                                                                                     |

### Recommended baseline for a multi-tenant SaaS

Build to **ISO 27001 + SOC 2** as the umbrella, with PCI-DSS or HIPAA scope-limited overlays where the data classification demands it. GDPR + DPA + CCPA-style privacy requirements are largely overlapping — pick the strictest and you satisfy the rest.

---

**Last reviewed against:** NIST 800-61 Rev. 2, SLSA v1.0, OWASP SAMM v2, NIST CSF 2.0, ISO/IEC 27001:2022, PCI-DSS v4.0, GDPR, Philippine DPA (RA 10173). Frameworks revise on multi-year cycles — re-check official sources before relying on specific control numbering.
