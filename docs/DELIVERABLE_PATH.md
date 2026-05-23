# CaaS-Lite — Project Deliverable Path

**Status:** Working document. v1.0, drafted 2026-05-22.
**Owner:** Project lead.
**Audience:** Project lead, integration team (incoming), future technical maintainers.
**Companion to:** `ARCHITECTURE_GAP_MAP.md`, `STOPGAP_EXECUTION.md`, `DEPLOYMENT.md`.

---

## What this document is

A sequenced plan from the platform's current state — live since 2026-05-21 but with significant unverified surface area — to a first honest market test (the "Lite Pilot" described in the project brief). It exists to give the project lead and the incoming integration team a shared map of what has to happen, in what order, before any prospective pilot client can be invited in.

It is organised as **Blocks**. Each block has a goal, an input (what must be true to start it), an output (what must be true to end it), and a list of tasks. Later blocks depend on earlier blocks' outputs.

## What this document is NOT

It is not a verified project plan. The `ARCHITECTURE_GAP_MAP.md` companion document explicitly states that many components are marked **NEEDS VERIFICATION** and cannot yet be asserted as built, broken, or absent. Until those verifications happen, any plan that asserts "we'll ship X by date Y" is fiction. This document acknowledges that constraint by making Block 1 — the gap-map walk-through — the first real work, and treating its output as the input that decides everything downstream.

Where a specific date or duration is given, it is a **placeholder** for the project lead to make real once Block 1 has produced verified facts. Placeholders are marked `[TBD]`.

---

## The five blocks at a glance

| Block | Goal | When | Output |
|---|---|---|---|
| **0** | Stopgap tonight: close the credibility-critical holes that a prospective pilot client (or a hostile observer) would see today. | Tonight, ~1 hour. | A login page that doesn't lie, a `/register` that returns 404, a dashboard without a broken button, a correct DEPLOYMENT.md, and the slice 7 tracker updated. |
| **1** | Verified gap map: walk the codebase row-by-row and turn ❓ into ✅ / 🟡 / ❌ / 🔧 with evidence. | Next session, half a day to full day. | `PILOT_PLATFORM_PUNCHLIST.md` — every item that must become ✅ before pilot Week 1 can honestly begin. |
| **2** | Pilot scope lock: with verified facts in hand, decide what the Lite Pilot actually offers in Weeks 1–4. Adjust the brief if substitutions or gaps require it. | After Block 1. `[TBD]` days. | `LITE_PILOT_SCOPE.md` — what the pilot client is actually buying, what the platform actually delivers, and what's deferred. |
| **3** | Pre-pilot build: every ❌ item in the punchlist that's required for the locked Lite Pilot scope. Including User Management as the largest single application-level gap. | After Block 2. `[TBD]` weeks. | A platform that can run the Week 1–4 deliverables of the locked scope, end to end, without operator intervention. |
| **4** | First market test (the Lite Pilot itself): run the four-week pilot with the first client, document everything, decide whether to scale. | After Block 3 + a real client signed under a real agreement. | Pilot report; go/no-go on Growth tier; punchlist v2 for the Full version. |

Blocks 0 and 1 are scoped and ready. Blocks 2, 3, and 4 are scoped *as goals* but their internal task list is gated on Block 1's output.

---

## Block 0 — Stopgap (tonight)

**Goal:** close the holes that make the platform look unserious or deceptive to anyone who lands on it before the rest of the path is walked. None of this is the long-term answer; all of it is what a defensible MVP looks like at the front door.

**Input:** the platform as deployed today (2026-05-22), the slice 7 hardening tracker, the gap map (v1.0), the `STOPGAP_EXECUTION.md` checklist.

**Output:** the eight items in the `STOPGAP_EXECUTION.md` checklist completed (A through G tonight; H scheduled). The platform now presents itself honestly: no demo credentials in the footer, no compliance copy that overstates the platform's posture, no public registration endpoint, no broken admin button, a deployment recipe a successor can actually follow, and the hardening tracker correctly reflecting H-007.

### Tasks (cross-references to `STOPGAP_EXECUTION.md`)

| # | Task | Stopgap ref |
|---|---|---|
| 0.1 | Run `git config --global core.autocrlf input` on the project lead's machine. | Stopgap A |
| 0.2 | Paste the H-007 snippet into the slice 7 hardening tracker, matching existing entry format. Commit. | Stopgap B |
| 0.3 | Remove the demo credentials line from the login page. Deploy. | Stopgap C |
| 0.4 | Apply the reworded compliance copy from `LOGIN_COPY_REWORDED.md` (companion document). Deploy. | Stopgap D |
| 0.5 | Disable `/register` via `ENABLE_PUBLIC_REGISTRATION=false`; verify 404 on both GET and POST. | Stopgap E |
| 0.6 | Hide the "Add new user" button from the dashboard. Deploy. | Stopgap F |
| 0.7 | Commit and push the corrected `DEPLOYMENT.md` (bootstrap recipe now uses `control_plane`, `plane_role`, `email`; historical note retained for audit). | Stopgap G |
| 0.8 | Schedule Block 1 (the gap-map walk-through). | Stopgap H |

### What Block 0 does NOT do

- It does not fix any of the underlying gaps. The login copy is reworded, but the platform still doesn't hold HIPAA / PCI-DSS / ISO 28000 certifications. `/register` is gated off, but the security posture for self-registration is still undecided. The "Add new user" button is hidden, but User Management still isn't built.
- It does not change the gap map's status codes. Those change only after Block 1.

---

## Block 1 — Verified gap map

**Goal:** turn every ❓ in `ARCHITECTURE_GAP_MAP.md` into ✅ / 🟡 / ❌ / 🔧 with evidence read from the codebase, not inferred from observed behavior.

**Input:** Block 0 complete. The project lead has a half-day to full-day block of focused time. Access to the repo on the project lead's laptop.

**Output:** `PILOT_PLATFORM_PUNCHLIST.md`, a flat list of every ❌ and 🟡 item that must become ✅ for the Lite Pilot to run honestly. Plus an updated `ARCHITECTURE_GAP_MAP.md` (v1.1) where the Status and Evidence columns now reflect verified facts, dated, with commit references.

### The six high-priority verifications (do these first)

These are the rows that most determine whether the Lite Pilot timeline is achievable at all. They come directly from the gap map's "Highest-priority verifications" section.

| # | Verification | Where to look | What "verified" looks like |
|---|---|---|---|
| 1.1 | Evidence Vault integrity | Storage layer code; the `commercial_audit_log`, `role_audit_log`, and `trust_badge_history` writers; R2 bucket configuration. | A one-line summary in the Evidence column of the gap map, with date and commit hash, of what tamper-resistance (if any) actually exists. |
| 1.2 | Verification Engine reality | `commercialEngine.ts` (named in slice 7 tracker). Read end to end. | Input shape, scoring logic, output shape, documented in the Evidence column. Whether it does what the brief describes, doesn't, or does something else. |
| 1.3 | At least one policy map | `policies/`, `data/`, `seed/`, or wherever JSON policy data lives. Cross-reference with whatever consumes it in 1.2. | A list of policy maps that exist in the repo, which ones are loaded at runtime, which framework each covers. |
| 1.4 | Trust Badge surface | Frontend routes for the public read-only vault view; embeddable widget code; `trust_badge_registry` / `trust_badge_history` writers. | A clear yes/no on (a) is there a public read-only vault page, (b) is there an embeddable widget, (c) is it wired to real data. |
| 1.5 | API documentation accuracy | The current API documentation (location to be confirmed during the walk). Pick 5 endpoints; read both docs and code for each. | A delta list: where docs match code, where they don't. If the delta is large, this becomes a Block 3 task. |
| 1.6 | PDF generation capability | Repo search for `pdfkit`, `puppeteer`, `playwright`, `pdfmake`, or third-party service calls. | Either "it's built on X library" with a working example, or "not built" — which feeds a Block 3 task. |

### After the six, sweep the remaining ❓ rows

In rough priority order, taken from `ARCHITECTURE_GAP_MAP.md`:

- **Plane 1:** Auditor Portal status; Executive Dashboard module reality (Reports, Report Builder).
- **Plane 2:** what's actually loaded in `regulatory_frameworks` and friends; Policy Translation Layer; iPaaS connector status.
- **Plane 3:** Auditor access to the Vault.
- **Plane 4:** webhook ingestion ("Hook") status — this is the Lite-Pilot-relevant mechanism.
- **Cross-cutting:** privacy policy / ToS document existence; DPA template existence; bucket versioning on R2; staging environment realities (currently ❌); subscription tier configuration; usage-based billing implementation; insurance partnership state; freelancer payout integration (Paystack/Stripe live or not); Shadow Scan Dashboard; Real-time Drift Map; Executive Scorecard computation; Compliance Gap Report; automated test suite breadth.

### User Management addendum

User Management is a known production gap before Block 1 starts — `ARCHITECTURE_GAP_MAP.md` § Authentication & user management already marks the admin UI, tenant management UI, and audit-log read UI as ❌. Block 1's job for this row is not to *discover* whether it's a gap (it is) but to:

1. Confirm the gap map's list is complete — that no User Management surface has been built that the gap map missed.
2. Inspect the existing surfaces that *are* built (`refresh_tokens`, `role_audit_log`, role/`control_plane`/`plane_role` constraints, the `/register` endpoint) and document their actual behaviour so the Block 3 build (item 3.3) extends them cleanly rather than reinventing them.
3. Record the gap map's status updates for this row with date and commit reference like every other row.

The build itself happens in Block 3 (item 3.3), not Block 1. Block 1 only verifies the surface and writes the punchlist entry.

### Rules for the walk

- **Read the code, not the docs.** Where docs and code disagree, the code is truth and the docs are a Block 2 or Block 3 item.
- **One row at a time.** Mark each row with a date, a commit hash (`git rev-parse HEAD` at the moment of inspection), and a one-line evidence summary.
- **"Built" requires more than "exists in the repo."** A file that imports a library but never runs in any production code path is not "built." A schema column with no writer is not "built."
- **Where verification produces 🔧 (substituted),** decide whether the substitution is permanent (update the brief) or temporary (add a "revert to brief" item to the punchlist).

### Output: `PILOT_PLATFORM_PUNCHLIST.md`

The punchlist is what feeds Block 3. Its shape:

| ID | Item | Status (from gap map) | Required for Lite Pilot? | Est. effort | Owner |
|---|---|---|---|---|---|
| P-001 | (e.g.) Webhook ingestion endpoint | ❌ | Yes — Week 1 deliverable | `[TBD]` | Integration team |
| P-002 | (e.g.) PDF generation capability | ❌ | Yes — Week 1 + Week 4 deliverables | `[TBD]` | `[TBD]` |
| ... | ... | ... | ... | ... | ... |

Items marked "Required for Lite Pilot? No" still exist (they're real gaps) but they're deferred past Block 4 and don't gate the pilot.

---

## Block 2 — Pilot scope lock

**Goal:** with verified facts in hand, decide what the Lite Pilot actually offers in Weeks 1–4. Reconcile the brief against reality. Where reality forces a substitution or a cut, record it.

**Input:** `PILOT_PLATFORM_PUNCHLIST.md` from Block 1.

**Output:** `LITE_PILOT_SCOPE.md` — a document that, for each of the brief's Lite Pilot deliverables, states what's actually being offered, what's been substituted, what's been cut, and what's been deferred.

### Decisions Block 2 makes

These can't be made until Block 1 is done, but the *shape* of the decisions can be sketched now so Block 1's walk knows what to surface.

1. **Trust Badge tamper-evidence claim.** Depending on 1.1's outcome:
    - If WORM-equivalent storage is in place or close: claim tamper-evidence honestly.
    - If not, and adding it before Week 3 of the pilot is feasible: schedule it as a Block 3 item, then claim.
    - If not, and adding it is not feasible in the pilot window: change the Trust Badge wording to claim only what's true (e.g., "append-only audit trail with daily off-site replication").
2. **Verification Engine scope.** Depending on 1.2's outcome:
    - If it scores against policies meaningfully: pilot uses it as the brief describes.
    - If it's scaffolding only: either build it before pilot Week 1 (Block 3), or pilot a narrower offering ("Compliance Posture Snapshot" rather than "Continuous Verification").
3. **Policy coverage.** Depending on 1.3's outcome: which frameworks the pilot honestly covers. EU AI Act + GDPR is the brief's claim; verification may shrink that to "EU AI Act partial coverage" or similar.
4. **PDF deliverables.** Depending on 1.6's outcome: if no PDF infrastructure exists, Block 3 builds it before the deliverables are committed to.
5. **Integration team scope adjustment.** Block 1 may reveal that work the integration team was scoped for is partially done, or that other work is more urgent. Block 2 re-scopes their first sprint.

### What Block 2 does NOT decide

- Pricing. That's a commercial conversation downstream.
- The first pilot client. That's a sales conversation, parallel to but not part of this path.
- The Full version scope. That's post-Block 4.

---

## Block 3 — Pre-pilot build

**Goal:** every ❌ item in the punchlist that's required for the locked Lite Pilot scope, built and verified. The platform can run the Week 1–4 deliverables of the locked scope end to end without operator intervention.

**Input:** `LITE_PILOT_SCOPE.md` from Block 2. The integration team available.

**Output:** the platform delivers the locked scope. A dry run with internal data succeeds end to end.

### Known Block 3 items (will grow once Block 1 is done)

These items are already known, ahead of Block 1, because they were either confirmed absent or confirmed as work in `ARCHITECTURE_GAP_MAP.md` and `DEPLOYMENT.md`'s "What this deployment story does NOT cover" section.

#### 3.1 Micro-connectors

Per the brief and the gap map's Plane 2 row: build the configuration APIs and micro-connectors that pull metadata and PII logs from customer environments. Primary scope of the integration team per the project lead.

#### 3.2 Webhook ingestion ("the Hook")

Per the gap map's pilot-specific surfaces row: the webhook ingestion endpoint is the entry point for the "Watchdog" approach (the Lite alternative to the full DevOps plane). Critical for pilot Week 1.

#### 3.3 User Management (production gap)

This is the largest single application-level gap, documented in both `DEPLOYMENT.md` § "What this deployment story does NOT cover" and `ARCHITECTURE_GAP_MAP.md` § Authentication & user management. Scope:

- **Bootstrap (first Executive)**: stays as direct DB access by design. Document the recipe (already done in `DEPLOYMENT.md` § Bootstrap the first user).
- **Subsequent user creation**: Executive-role admin UI for creating users within their tenant. CRUD + role assignment within the role constraints (`Executive`, `Auditor`, `Partner`) and the `plane_role` CHECK constraint.
- **Self-registration security posture**: a decision, not just code. Pick one of (a) leave disabled, (b) invite-token only, (c) email-verified open registration scoped by tenant. Document the chosen posture, then either keep `/register` disabled or implement the chosen flow.
- **Tenant management UI**: provisioning flow, rename, archive. Tenants are currently implicit strings with no governance.
- **User listing, editing, deactivation, role-change, password-reset UI** for Executives within their tenant.
- **Audit log read UI**: the `role_audit_log` table is populated but has no UI. Tracked as part of slice 7 hardening (H-007 specifically references this gap). Surface it as a read-only view for Executives and Auditors.

This is being added to the slice 7 hardening tracker as the 22nd item per `DEPLOYMENT.md` § Open decisions item 5. It is not a "nice to have" — without it, every new user requires the project lead's direct DB access, which does not scale beyond the first pilot.

#### 3.4 PDF generation (if absent per 1.6)

Multiple Day-30 pilot deliverables are PDFs (Evidence Vault Log, Initial Risk Scan, Compliance Gap Report). If 1.6 confirms no infrastructure exists, build it. Recommended path: server-side library (`pdfkit` or `pdfmake`) for structured documents; headless browser (`puppeteer` / `playwright`) only if HTML-to-PDF fidelity is required.

#### 3.5 Evidence Vault integrity hardening (if required per 1.1)

If Block 2 decided the Trust Badge will claim tamper-evidence, and 1.1 confirmed the current state is "SQLite + audit-log tables with no tamper-resistance," then this item builds toward WORM-equivalent: R2 Object Lock on `caas-lite-backups`, plus a hash-chain or signed-record discipline on the writers.

#### 3.6 API documentation rework (if required per 1.5)

If the docs/code delta is large, this is days-to-weeks of rework. Integration team blocker — does not get to start their integration work against wrong docs. Co-build docs from code (OpenAPI generation from route handlers) rather than maintaining them by hand.

#### 3.7 Privacy policy, ToS, DPA template

Required before any client signs up under GDPR. The register form references these documents; the gap map marks them as ❓. If they don't exist, draft them; if they do, get them reviewed.

#### 3.8 Restore drill

`DEPLOYMENT.md` § Disaster recovery documents the procedure but notes it has never been rehearsed. Once before pilot Week 1. The procedure is in DEPLOYMENT.md; running it is the item.

### Items NOT in Block 3 (deferred past pilot)

From `DEPLOYMENT.md` § "What this deployment story does NOT cover" and the gap map:

- Observability beyond what `fly logs` provides (Grafana / Better Stack).
- Log aggregation beyond `fly logs`.
- External monitoring with paging (UptimeRobot / Better Stack).
- CDN / WAF / DDoS protection (Cloudflare orange-cloud decision).
- Staging environment.
- `app.aitwcloud.com` frontend subdomain split.

These are real production concerns but the pilot can run without them. They go on a "post-pilot hardening" list, not the punchlist.

---

## Block 4 — First market test (the Lite Pilot)

**Goal:** run the four-week pilot with the first client. Document everything. Decide whether to scale to a second pilot, to the Growth tier, or back to the drawing board.

**Input:** Block 3 complete; a first pilot client signed under a Data Processing Agreement and pilot agreement.

**Output:** pilot report; go/no-go decision on Growth tier; `PUNCHLIST_V2.md` for the Full version.

### Shape (per the brief's Lite Pilot section)

The week-by-week structure follows the brief, conditional on Block 2's scope lock. Sketched here so Block 2 has somewhere to land its decisions:

- **Week 1:** The "Hook" — webhook ingestion live; Initial Risk Scan PDF generated and delivered to the client.
- **Week 2:** Shadow Scan Dashboard accessible to the client; Real-time Drift Map operating.
- **Week 3:** Trust Badge surfaced (under whatever wording Block 2 settled on); embed code given to client; embedded widget loads and reads from the read-only vault view.
- **Week 4:** Evidence Vault Log PDF export; Executive Scorecard / "X% Compliant" rating; Compliance Gap Report; pilot review session with client.

Each of these is a placeholder until Block 2 locks it. If 1.1's verification of Evidence Vault integrity (for example) shows tamper-evidence isn't achievable in this window, Week 3's Trust Badge claim changes accordingly.

### What Block 4 does NOT do

- It is not the launch. There is no public "we are open for business" before Block 4's go/no-go and the punchlist v2 is at least scoped.
- It is not the path to the Full version. That's a separate planning cycle, after Block 4 and likely after a second pilot.

---

## Cross-block disciplines

These apply throughout all blocks, not to any one of them.

### Honesty about what the platform is

The platform is a Lite version. It does not hold HIPAA / PCI-DSS / ISO 28000 / AML/KYC certifications. Any external surface — login page, marketing copy, sales conversations, pilot agreements — frames what the platform *helps clients with* under those frameworks, not what the platform itself is certified as. The reworded login copy (`LOGIN_COPY_REWORDED.md`) is the template; the same discipline applies everywhere.

### Documentation lives in git

Every document referenced in this path lives in the project repo, versioned. The gap map, this deliverable path, the stopgap execution guide, the login copy rewording, the punchlist, the pilot scope, the bootstrap recipe in `DEPLOYMENT.md`. No private Google Docs holding source-of-truth.

### Schema is truth

`DEPLOYMENT.md` § Bootstrap the first user makes this explicit for one case: run `.schema users` before pasting an INSERT, because the schema is what's running, not what the doc claims. The same applies to any other recipe in any other document. Where docs and schema disagree, fix the docs.

### Audit-trail discipline

Slice 7's hardening discipline (zod `.strict()`, role audit log, commercial audit log) is the model. New code added in Block 3 follows the same disciplines. New tables get audit-log entries on writes that change state. New routes get zod schemas on inputs.

### Decisions are recorded

Open decisions in `DEPLOYMENT.md` § Open decisions is the pattern. When a decision is deferred, write it down with what's being deferred and what triggers the decision. When a decision is made, record what was decided and why, in the document closest to where it takes effect.

---

## Change log

- **2026-05-22** — v1.0 initial draft. Companion to `ARCHITECTURE_GAP_MAP.md` v1.0 and `STOPGAP_EXECUTION.md` v1.0. Blocks 0 and 1 are scoped concretely; Blocks 2, 3, and 4 are scoped as goals with internal tasks gated on Block 1's output.
