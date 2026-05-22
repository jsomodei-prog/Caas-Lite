# CaaS Platform — Architecture vs. Actual Gap Map

**Status:** Working document. v1.0, drafted 2026-05-22.
**Owner:** Project lead.
**Audience:** Project lead, integration team (incoming), future technical maintainers.

---

## What this document is

The project brief describes a four-plane Compliance-as-a-Service architecture with specific components in each plane. The deployed system has been live since 2026-05-21. This document maps each component the brief describes against what is known to exist in the deployed system, what is known not to exist, and what requires verification.

## What this document is NOT

This is **not a verified inventory**. The author of this document has not read the codebase. The "Status" column reflects what could be inferred from a deployment session, a database schema inspection, the slice 7 hardening tracker, and observed dashboard behavior. Several rows are marked **NEEDS VERIFICATION** — these require someone to actually look at the code or run the feature.

Use this document as a structured checklist to walk through with whoever has built the platform. After verification, update the Status column with confirmed facts.

---

## Status legend

| Code | Meaning |
|---|---|
| ✅ **Built & verified** | Component exists in code, has been observed working, or has been confirmed via inspection. |
| 🟡 **Built, gaps known** | Component exists but has known limitations or bugs against the brief. |
| ❓ **Needs verification** | Brief describes it; no evidence either way from this session's observations. |
| ❌ **Not built** | Confirmed absent or not yet started. |
| 🔧 **Substituted** | A different implementation choice has been made versus what the brief described. |

---

## Plane 1 — Governance Plane

> "Provides a 'Single Pane of Glass' through an Executive Dashboard and a secure Auditor Portal for regulators."

| Component | Brief description | Status | Evidence / Notes |
|---|---|---|---|
| Executive Dashboard | Single pane of glass for leadership to monitor real-time compliance health. | 🟡 | A dashboard exists at `caas-lite.fly.dev/dashboard` and renders for an Executive user. Whether the content shown matches the brief's vision (compliance health, real-time scoring) is unverified. Modules referenced (Reports, Report Builder) were not visible in the session. |
| Auditor Portal | Secure interface for regulators to access the Evidence Vault. | ❓ | No evidence either way. The brief positions this as a Plane 1 component but it may not be required for the Lite Pilot. |
| Live Trust Badge | Embeddable widget for the client's public site, linking to a read-only Evidence Vault view. | ❓ | The schema includes a `trust_badge_registry` and `trust_badge_history` table, which suggests work has happened here. Whether the embeddable widget and public read-only page exist is unverified. **High priority to verify — this is a Day-30 pilot deliverable.** |

---

## Plane 2 — Integration & Policy Plane

> "Uses a Policy Translation Layer to convert laws like the EU AI Act and GDPR into machine-executable JSON Policy Maps."

| Component | Brief description | Status | Evidence / Notes |
|---|---|---|---|
| Regulatory Ingest | Database of global laws (EU AI Act, GDPR) as structured JSON. | 🟡 | The schema includes `regulatory_frameworks`, `regulatory_field_rules`, `regulatory_consent_purposes`, and `regulatory_report_log` tables. Significant scaffolding exists. **What's actually loaded into these tables — which laws, what coverage, what version — is unverified.** |
| Policy Translation Layer | Mapping from legal clauses to technical metrics (e.g., "fairness" → Demographic Parity Ratio > 0.8). | ❓ | Schema supports the data shape but the translation logic itself is unverified. May exist; may be aspirational. |
| Configuration APIs / Micro-connectors | Pull metadata and PII logs from customer environments (AWS, Azure, GitHub). | ❌ | Brief explicitly calls these out as work to do ("Build micro-connectors..."). Per the project lead, this is the integration team's primary scope. Likely not built. |
| iPaaS connectors (Zapier, MuleSoft) | Pre-built integrations for SMB SaaS environments. | ❓ | Per the project lead, these are being added. Status of any specific connector is unverified. |

---

## Plane 3 — Enforcement & Verification Plane

> "Features a high-speed Verification Engine (Python/Go) that validates model metadata against policies, storing proof in an Immutable Evidence Vault (WORM storage)."

| Component | Brief description | Status | Evidence / Notes |
|---|---|---|---|
| Verification Engine | High-speed service (Python or Go) that runs automated checks against incoming technical data. Latency target: <2s pre-deployment. | 🔧 + ❓ | The deployed stack is Node.js, not Python or Go. This may be a deliberate substitution (single-stack simplicity) or a deviation. A `commercialEngine.ts` file is referenced in the slice 7 tracker, suggesting *some* engine layer exists. Whether it does verification-against-policy work as described is unverified. **The performance target (<2s) is unverified — no load testing observed.** |
| Evidence Vault (WORM storage) | Immutable audit trail with secure, append-only storage (e.g., S3 Object Lock) for time-stamped, unalterable records. | 🔧 + ❓ | Currently the database is SQLite on a Fly volume, replicated to Cloudflare R2 via Litestream. **SQLite is not WORM. R2 with Object Lock could be configured to be, but Object Lock is not currently configured on the `caas-lite-backups` bucket.** This is a credibility-critical gap if the Trust Badge claims tamper-evidence. The slice 7 tracker references `commercial_audit_log` and `role_audit_log` tables, and a `trust_badge_history` table — there is *some* audit-trail discipline in place, but it does not meet the brief's "immutable WORM" claim as currently deployed. **HIGH PRIORITY TO RESOLVE.** |
| Auditor access to the Vault | Read-only access for verification without exposing production code. | ❓ | Likely tied to the Auditor Portal (Plane 1). Status unverified. |

---

## Plane 4 — DevOps Plane

> "Implements CI/CD Compliance Gates to Block Deployment of non-compliant code and uses Production Monitor sidecars in Kubernetes to Isolate Models if they drift in real-time."

| Component | Brief description | Status | Evidence / Notes |
|---|---|---|---|
| CI/CD Compliance Gates | Injectable gates (GitHub Actions, Jenkins) that block deployment on policy violations. | ❌ | Confirmed not built. Explicitly out of scope for the Lite Pilot per the brief ("Lite version strips away enterprise-heavy CI/CD components"). |
| Production Monitor sidecars | Kubernetes sidecar agents monitoring live models for drift, triggering alerts or isolating models. | ❌ | Confirmed not built. The deployment is on Fly machines, not Kubernetes. The "Lite" architecture in the brief explicitly removes this. Belongs in a later "Full" version, not the Lite Pilot. |
| CaaS Lite "Watchdog" approach | Passive monitoring via webhooks and APIs (Lite alternative to the full DevOps plane). | ❓ + ❌ | This is the relevant Lite Pilot mechanism. Whether webhook ingestion is built at all is unverified, but probably not — the integration team is scoped to build the micro-connectors that would feed it. |

---

## Cross-cutting components

These don't fit cleanly into one plane but are critical to the pilot and to operation.

### Authentication & user management

| Component | Status | Evidence / Notes |
|---|---|---|
| Username/password/tenant login | ✅ | Verified working for `aitw-ops` in the deployment session. |
| Refresh tokens | ✅ | `refresh_tokens` table exists; auth flow uses them per the slice 7 tracker. |
| Role-based access | 🟡 | Schema supports `role`, `control_plane`, `plane_role` with constraints. Which UI surfaces are gated to which roles is unverified — the Reports / Report Builder visibility issue suggests gating exists but is not documented. |
| Audit logging of user actions | 🟡 | `role_audit_log` table exists and is populated. No UI to read it (per H-007 in the slice 7 tracker). |
| Admin UI for user creation | ❌ | Confirmed not built. The "Add new user" button links to the public self-registration page, which is not an admin flow. |
| Tenant registry / management UI | ❌ | Tenants are implicit strings. No governance. |
| Self-registration (`/register`) | 🟡 | Endpoint exists and creates users. Security posture is undefined. Profile-creation follow-up call returns 400 — a real bug. Recommended to disable until posture is decided. |

### Data layer

| Component | Status | Evidence / Notes |
|---|---|---|
| SQLite on Fly volume | ✅ | Verified. `/data/caas.db`, ~544 KB. |
| Litestream replication to R2 | ✅ | Verified. Bucket `caas-lite-backups`, sync interval 1s. |
| R2 Object Lock (WORM) | ❌ | Not configured. See Evidence Vault row in Plane 3 — this is the gap that prevents the platform from honestly claiming "WORM storage." |
| Bucket versioning on R2 | ❓ | Status unverified. Recommended baseline regardless of Object Lock decision. |
| Restore drill | ❌ | Backups exist; never tested. Per DEPLOYMENT.md § Disaster recovery. |
| Schema migrations | 🟡 | `schema_migrations` table exists. Migration discipline appears in place per slice 7. State of migration coverage unverified for newer features. |

### Operational maturity

| Component | Status | Evidence / Notes |
|---|---|---|
| Health checks (`/readyz`) | ✅ | Verified, added in commit `92ab0e5`. |
| Deployment pipeline (Fly) | ✅ | Verified. `fly deploy` from master works. |
| Staging environment | ❌ | None. Master deploys to production. |
| Observability (metrics, dashboards) | ❌ | `prom-client` in dependencies but nothing scrapes it. No Grafana or equivalent. |
| Alerting | ❌ | None. Healthcheck failures show in `fly logs` and page no one. |
| External monitoring (UptimeRobot, etc.) | ❌ | Not set up. |
| Log aggregation | ❌ | Only `fly logs` (stdout/stderr stream). No structured search across history. |
| Rate limiting | 🟡 | `express-rate-limit` runs in-process. No edge layer. Cloudflare proxy mode is grey-cloud (DNS only). |
| WAF / DDoS protection | ❌ | No edge protection. Decision to switch to Cloudflare orange-cloud is deferred. |
| TLS certificates | ✅ | Let's Encrypt via Fly, ~2 months to renewal at time of writing. |

### Compliance posture (the platform's own posture, not the platform's client features)

| Component | Status | Evidence / Notes |
|---|---|---|
| HIPAA certification | ❌ | Not pursued, not certified. Login page copy needs to make this explicit (per the recalibrated understanding: the copy represents what the platform helps clients with, not what the platform itself holds). |
| PCI-DSS certification | ❌ | Same as above. |
| ISO 28000 certification | ❌ | Same as above. |
| AML/KYC compliance program | ❌ | Same as above. The `kyc_tier` field on `user_profiles` is a per-customer KYC tracking mechanism, not a platform-level AML/KYC program. |
| Privacy policy / Terms of service | ❓ | The register form references "CaaS-Lite platform terms of service, privacy policy, and AML/KYC compliance requirements." Whether these documents exist and are accurate is unverified. |
| Data processing agreement (DPA) template for clients | ❓ | Required before any client signs up under GDPR. Status unverified. |
| Incident response plan | ❌ | Not documented. |
| Data retention / deletion policy | ❌ | Not documented. |

### Sales & monetization (per the brief)

| Component | Status | Evidence / Notes |
|---|---|---|
| Tiered subscriptions (Lite, Growth, Enterprise) | 🟡 | The schema includes `tenant_commercial_subscriptions` and `commercial_billing_ledgers`. Significant commercial infrastructure exists. Whether the tiers themselves are configured and the billing flows work end-to-end is unverified. |
| Usage-based billing | ❓ | Schema supports it. Implementation status unverified. |
| Insurance partnership / premium reduction flow | 🟡 | Schema includes `ai_insurance_warranties`, `premium_reduction_tokens`, `insurance_underwriting_registry`. Substantial scaffolding. Active partnerships and end-to-end flow are unverified. |
| Freelancer Partner Portal | ❌ | Not built. Explicitly deferred per pilot scope. |
| Freelancer payout engine | 🟡 | Schema includes `agents`, `payout_logs`. The `RegisterFreelancerBody` referenced in slice 7 supports MoMo and card. Whether Paystack/Stripe integration is live is unverified. |
| Recruitment landing page for agents | ❌ | Not built. |

### Pilot-specific surfaces (per the brief's Lite Pilot section)

| Component | Status | Evidence / Notes |
|---|---|---|
| The "Hook" — webhook ingestion endpoint | ❓ | Not directly observed. Critical for pilot Week 1. |
| Initial Risk Scan report (PDF) | ❓ | Brief describes it as a Week 1 deliverable. PDF generation capability unverified. |
| Shadow Scan Dashboard | ❓ | Brief describes it. Whether built or what state it's in unverified. |
| Real-time Drift Map | ❓ | Week 2 deliverable per brief. Status unverified. |
| Evidence Vault Log PDF export | ❓ | Day-30 deliverable. PDF generation + signed-record retrieval flow unverified. |
| Executive Scorecard (e.g., "98% Compliant" rating) | ❓ | Computation logic unverified. May or may not exist. |
| Compliance Gap Report | ❓ | Mentioned as a Trust Badge "lure." Status unverified. |

### Quality & engineering discipline

| Component | Status | Evidence / Notes |
|---|---|---|
| Automated test suite | ❓ | Slice 7's discipline implies tests exist. Breadth, depth, and CI integration unverified. |
| Schema validation (zod, etc.) | ✅ | Slice 7 tracker shows extensive zod usage with `.strict()` discipline. |
| Documented validation/hardening backlog | ✅ | The slice 7 hardening tracker is real and being maintained. |
| API documentation | 🟡 | Per the project lead: "some APIs exist, ... these have been documented." Document freshness and completeness against running code is unverified. **Critical to audit before integration team arrives.** |
| Onboarding documentation for new engineers | 🟡 | DEPLOYMENT.md exists (recently improved). Codebase-level onboarding documentation unverified. |

---

## Highest-priority verifications

If verification time is limited, do these first. They are ordered by what most determines whether the Lite Pilot can run honestly.

1. **Evidence Vault integrity.** Is there any tamper-evident storage in place, of any form? If the answer is "no, it's just SQLite with audit-log tables," then the Trust Badge cannot honestly make tamper-evidence claims, and either (a) WORM storage is added before Week 3 of any pilot, or (b) the Trust Badge wording is changed to claim only what's true.

2. **Verification Engine reality.** Does any code actually score events against policy maps and produce compliance ratings? If yes, what's its actual capability? If no, this is the largest single build item before any pilot can be run.

3. **At least one policy map.** Does an EU AI Act or GDPR policy map exist in machine-readable form, loaded into whatever engine exists? Without this, there is nothing for the engine to score against.

4. **Trust Badge surface.** Does the embeddable widget exist? Does the read-only public vault view exist? These are Day-30 deliverables; if neither exists, scope for Week 4 expands significantly.

5. **API documentation accuracy.** Open the current API documentation and compare a sample of endpoints against the running code. If accurate, the integration team is unblocked. If inaccurate, this is days of rework before they arrive.

6. **PDF generation capability.** Multiple Day-30 deliverables are PDFs (Evidence Vault Log, Initial Risk Scan, Compliance Gap Report). Is there PDF generation infrastructure in place? If not, what's the path — server-side library, headless browser, third-party service?

These six verifications determine whether the Lite Pilot timeline of "30 days from Week 1 start" is achievable, or whether substantial platform work must precede pilot Week 1.

---

## How to use this document

**For the project lead:**
- Walk through it once with whoever built the platform. Mark each ❓ with ✅ / 🟡 / ❌ / 🔧 based on actual code inspection.
- Where 🔧 substitutions exist, decide whether the substitution is permanent or temporary, and whether the brief should be updated to reflect the new reality.
- Where ❌ items exist that are required for the Lite Pilot, sequence them into the pre-pilot work plan.

**For the integration team on arrival:**
- This document is your orientation map of what to expect.
- The 🟡 rows are where you may encounter surprises — features that exist but don't behave as the brief suggests.
- The ❓ rows are open questions where your investigation will produce the answer.
- Surface anything you find that contradicts this document; the document is wrong in places, and your evidence updates it.

**For future maintainers:**
- This document captures the as-of-this-date understanding. Subsequent change should be recorded in the change log below.
- When components move from ❓ to ✅, retain the date of verification. "Verified working on YYYY-MM-DD against commit XXXXXX."

---

## Change log

- **2026-05-22** — v1.0 initial draft, based on the project brief, the deployment session of 2026-05-21, the schema inspection, the slice 7 hardening tracker, and observed dashboard behavior. Many rows marked **NEEDS VERIFICATION** pending code-level inspection by the project lead or the incoming integration team.
