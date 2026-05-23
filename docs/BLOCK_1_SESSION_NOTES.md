# Block 1 — Session Notes (2026-05-23)

**Status:** Working document. v0.1, drafted 2026-05-23.
**Purpose:** Capture the Block 1 walk-through findings produced in this session. Two of the six high-priority verifications (1.2 Verification Engine reality, 1.3 At least one policy map) were completable from the uploaded source files alone and are recorded as evidence text below, ready to paste into `ARCHITECTURE_GAP_MAP.md` v1.1. The other four (1.1, 1.4, 1.5, 1.6) require repo-side inspection and are recorded here as **precise next actions** — what to grep, where to look, and what the result means — so the next session pass can land them quickly.

**Companion to:** `ARCHITECTURE_GAP_MAP.md` (the rows updated), `DELIVERABLE_PATH.md` § Block 1 (the rules followed), `PILOT_PLATFORM_PUNCHLIST.md` (the output, drafted below as v0.1).

**Commit hash:** `[TBD — record `git rev-parse HEAD` when pasting into v1.1]`. This session worked from uploaded files, not from a repo checkout.

---

## Files inspected this session

| File | Lines | Role |
|---|---|---|
| `src/services/commercialEngine.ts` | 1287 | Named in slice 7 tracker. Read end to end. |
| `policies/default.json` (inferred path) | 11 rules | Policy map candidate #1. Read in full. |
| `policies/user-login.json` (inferred path) | 3 rules | Policy map candidate #2. Read in full. |
| `query-evidence.ts` (top-level, probably scratch) | 6 | Throwaway debug script. References a `caas_evidence.db` separate from `caas.db`. |

The path locations are inferred from filename and content shape. Confirm the actual paths via `git ls-files | grep -E '(commercialEngine|default\.json|user-login\.json|query-evidence)'` before pasting evidence into v1.1.

---

## Verification 1.2 — Verification Engine reality

**Where the gap map currently says it:** Plane 3, "Verification Engine" row, status `🔧 + ❓`. Evidence column claims "A `commercialEngine.ts` file is referenced in the slice 7 tracker, suggesting *some* engine layer exists. Whether it does verification-against-policy work as described is unverified."

**Status after verification: `❌` for the brief's Verification Engine. `✅` for what `commercialEngine.ts` actually does (which is a different thing).**

### What `commercialEngine.ts` actually is

A commercial pipeline and actuarial-insurance engine. Its file-level docstring (lines 1–27) lists six responsibilities, all commercial / billing / insurance:

1. Subscription management with integrity-hash verification
2. Monthly commitment evaluation (base fee, overages, invoice line items)
3. Underwriting risk scoring → GREEN/AMBER/ORANGE/RED band
4. Premium reduction token emission (HMAC-signed)
5. Invoice generation with tamper-evident HMAC signature
6. Token application against ledgers

Public surface (the `CommercialEngine` class, line 378):

- `getSubscription` / `createSubscription`
- `recordValidationRun` — increments a counter on the subscription; no compliance evaluation
- `evaluateMonthlyCommitment` — computes invoice totals from usage
- `generateInvoice` — writes a `commercial_billing_ledgers` row with HMAC signature
- `computeUnderwritingRiskScore` — *insurance* underwriting, not policy compliance (see below)
- `applyPremiumReductionToken`
- `getLedgerHistory`, `getLineItems`

### Why this is not the brief's Verification Engine

The brief: *"validates model metadata against policies."* The Plane 3 description references policy maps explicitly.

`commercialEngine.ts` reads **zero policy maps**. Confirmed by grep over the full 1287 lines: `policy|polic|framework|appliesTo|conditions|controlId|SOC2|HIPAA|GDPR|EU AI`. Every match for "policy" in the file refers to **insurance policy** (`policy_number`, `policy_start_date`, `base_annual_premium_usd`) — not compliance policy.

The closest analog is `computeUnderwritingRiskScore()` (lines 793–900). It reads:
- `payout_logs` (failure rate, duplicate count)
- `anomaly_logs` (high/critical counts, lockout count)
- `slow_query_log` (operational telemetry, failover events)
- `regulatory_report_log` (count only, no content inspection)
- `PRAGMA integrity_check` (DB integrity bit)

…and computes four hardcoded weighted scores (operational 0.30, security 0.30, compliance 0.20, financial 0.20) → composite 0–100 → band. **The weights, thresholds, and conditions are all literal numbers in the code, not data-driven from any policy map.** There is no path from a JSON rule like the ones in `default.json` into this function. A new framework cannot be added without a code change.

### Sub-finding: the "compliance" score component is misleading

Line 877–881:
```
let scoreCompliance = 0;
scoreCompliance += Math.min(regulatoryBreaches * 20, 60);
scoreCompliance += Math.min(duplicateRuns * 8, 40);
```

`regulatoryBreaches` is just `COUNT(*) FROM regulatory_report_log`. This is a count of *dispatched regulatory reports*, not a count of compliance breaches. The variable name and the contribution to the "compliance" component overstate what the table actually contains. This deserves its own line in the Block 2 risk register — it's the kind of thing that breaks under audit scrutiny.

### Evidence column text to paste (verification 1.2)

> **2026-05-23, commit `[TBD]`** — `src/services/commercialEngine.ts` (1287 lines) is a commercial-pipeline and actuarial-insurance engine: subscription management, invoice generation with HMAC signatures, and underwriting risk scoring against operational telemetry (payout_logs, anomaly_logs, slow_query_log, DB integrity). It is **not** the Verification Engine the brief describes — it does not consume policy maps and does not validate event metadata against policies. Score weights and thresholds are hardcoded literals. The 11-rule `policies/default.json` and 3-rule `policies/user-login.json` files exist on disk in the policy-map shape (framework/controlId/appliesTo/conditions) but no code in `commercialEngine.ts` reads them. The `_note` fields in `default.json` reference a `verification.ts` file with `forceFailOnEmptyConditions` and `forceFailEventTypes` hooks — not present in this session's upload set; **its existence/state is the highest-priority next grep**. **Brief-defined Verification Engine: ❌**. Commercial engine layer: ✅ as a separate concern.

### What this changes in the gap map row

The current row collapses two different questions into one cell. Recommend splitting in v1.1:

| Component (proposed v1.1 split) | Status | Evidence |
|---|---|---|
| Commercial / underwriting engine (`commercialEngine.ts`) | ✅ | Built, ~1287 lines, integration-test-worthy. Substantial. |
| Verification Engine (brief's Plane 3) | ❌ | Not built. The policy-map JSON files exist but have no consumer in this file. Confirm absence with the `verification.ts` grep below before locking ❌. |
| Verification Engine <2s latency target | n/a | Cannot test what doesn't exist. |

---

## Verification 1.3 — At least one policy map

**Where the gap map currently says it:** not its own row in v1.0. Implicit in Plane 2's "Regulatory Ingest" row (`🟡`, scaffolding exists, content unverified) and in Plane 2's "Policy Translation Layer" (`❓`).

**Status after verification: 🟡** — policy maps **in the right shape** exist as static JSON, but coverage is misaligned with the brief and runtime loading is unverified.

### What exists

Two JSON files, both well-formed policy maps in a clean schema:

**`default.json`** — 11 rules:

| ID | Framework | Control | Applies To | Enabled |
|---|---|---|---|---|
| `soc2-cc6.1-mfa-enrollment` | SOC2 | CC6.1 | `access.mfa_enrolled` | ✅ |
| `soc2-cc6.1-mfa-disabled-alert` | SOC2 | CC6.1 | `access.mfa_disabled` | ✅ |
| `soc2-cc7.2-deploy-approval` | SOC2 | CC7.2 | `deploy.completed` | ✅ |
| `soc2-cc7.2-deploy-rollback-logged` | SOC2 | CC7.2 | `deploy.rollback` | ✅ |
| `soc2-cc6.2-secret-rotation` | SOC2 | CC6.2 | `secret.rotated` | ✅ |
| `soc2-cc6.2-secret-exposure` | SOC2 | CC6.2 | `secret.exposed` | ❌ (note below) |
| `soc2-cc4.1-audit-log-integrity` | SOC2 | CC4.1 | `audit.log_tampered` | ❌ (note below) |
| `soc2-cc9.2-vendor-soc2` | SOC2 | CC9.2 | `vendor.soc2_report_uploaded` | ✅ |
| `iso27001-a12.6-vuln-scan` | ISO27001 | A.12.6.1 | `vuln.critical_found` | ✅ |
| `iso27001-a12.1-infra-drift` | ISO27001 | A.12.1.2 | `infra.drift_detected` | ✅ |

**`user-login.json`** — 3 rules, all SOC2 CC6.1/6.2/6.3, all `appliesTo: ["user.login"]`.

### Schema observations

The rule shape is coherent:
```
{ id, name, framework, controlId, description,
  appliesTo: [eventType],
  conditions: [{ field, operator, value? }],
  environments?: [string],
  failureSeverity: low|medium|high|critical,
  version, enabled }
```

Operators in use: `eq`, `neq`, `exists`. This is exactly the shape that maps cleanly to a typed `applyRule(event, rule)` function in a verification engine, if one existed.

### Three real findings

**Finding A — Coverage doesn't match what the platform claims.** Every rule in both files is `SOC2` or `ISO27001`. **Zero rules for EU AI Act. Zero rules for GDPR.** These are the two frameworks the brief explicitly names ("convert laws like the EU AI Act and GDPR into machine-executable JSON Policy Maps"). The login page (per `LOGIN_COPY_REWORDED.md`) frames the platform as helping with HIPAA / PCI-DSS / ISO 28000 / AML/KYC — **none of which are represented in the policy maps either**. The Pilot brief's compliance posture and the policy data on disk are in different universes. This goes on the Block 2 risk register, hard.

**Finding B — Two rules are disabled with an architectural admission.** `soc2-cc6.2-secret-exposure` and `soc2-cc4.1-audit-log-integrity` both have `enabled: false` with `_note` fields that say (paraphrased) "Disabled because an empty conditions array would always PASS. See verification.ts `forceFailOnEmptyConditions` override" and "handled via `forceFailEventTypes` in verification engine."

These notes are doing important evidentiary work, in two directions:

1. They confirm a `verification.ts` exists somewhere in the repo (or did at some point). **Find it next.** If it exists and implements the override correctly, then 1.2's `❌` becomes `🟡`. If it doesn't, then the policy maps include rules that *cannot fire today* and the author knew it.
2. They show the policy schema has a design flaw: a critical-severity rule with no conditions silently passes everything. The workaround (force-fail by event type, hardcoded in the engine) means the policy file isn't actually the source of truth for the worst cases — the engine code is. Anyone treating `default.json` as the source of truth for what the platform alerts on will get the wrong answer for `secret.exposed` and `audit.log_tampered`.

**Finding C — Runtime loading unverified.** I cannot determine from these files alone whether *anything* in production reads them. The path is plausibly `policies/default.json` and `policies/user-login.json` but the actual location is unconfirmed. Even if they sit in a `policies/` folder, "exists in the repo" ≠ "loaded at runtime" per the walk-through rules.

### Sub-finding — file encoding

`user-login.json` has CRLF line endings (`\r\n`). `default.json` has LF. Stopgap task A (`git config --global core.autocrlf input`) is solving exactly this class of inconsistency at the developer-machine layer; this file shows it's a real, present concern, not theoretical. Worth a note on the Block 0 close: confirm the `.gitattributes` posture for the repo as a whole, otherwise the next contributor who clones on Windows will commit CRLF JSON.

### Evidence column text to paste (verification 1.3)

> **2026-05-23, commit `[TBD]`** — Two policy-map JSON files exist on disk: `default.json` (11 rules covering SOC2 CC6.1/CC6.2/CC7.2/CC9.2/CC4.1 and ISO27001 A.12.1.2/A.12.6.1) and `user-login.json` (3 rules, SOC2 CC6.x, `user.login` event type). Schema is coherent (id/framework/controlId/appliesTo/conditions/severity/enabled) and would map cleanly to an event-evaluation function. **Coverage misaligned with brief**: zero rules for EU AI Act, GDPR, HIPAA, PCI-DSS, ISO 28000, or AML/KYC — only SOC2 and ISO 27001 represented. Two SOC2 critical-severity rules (`secret.exposed`, `audit.log_tampered`) are disabled with `_note` fields citing a `verification.ts` workaround (`forceFailOnEmptyConditions` / `forceFailEventTypes`) — that file is not yet located and is the highest-priority next grep. Runtime loading (whether any production code path actually reads these files) **unverified**. **Status: 🟡** — shape correct, content insufficient for the pilot's claimed framework coverage, consumer status unknown.

### What this changes in the punchlist

Two distinct items, not one:

1. **Build the consumer / engine** if it doesn't exist (the work that 1.2 will probably show is needed)
2. **Expand framework coverage** to include at least one rule set for whichever frameworks the Lite Pilot actually commits to in Block 2 — see Block 2 decision 3 in `DELIVERABLE_PATH.md`.

---

## Verifications 1.1, 1.4, 1.5, 1.6 — Cannot be completed from upload set alone

For each: what to look for, where, and what the result means. Cribbed straight into a form that, sitting at the repo, you can paste into a terminal one line at a time.

### Verification 1.1 — Evidence Vault integrity

**Goal:** decide whether tamper-resistance exists in any form (so Block 2's Trust Badge wording can be honest).

**Step 1 — find the writers.** These three tables are named in the gap map. Find what writes to them and how:
```bash
grep -rn "commercial_audit_log\b" src/ 2>/dev/null
grep -rn "role_audit_log\b" src/ 2>/dev/null
grep -rn "trust_badge_history\b" src/ 2>/dev/null
```
Then for each writer, read 30 lines around it and answer: (a) does it append-only (no UPDATE/DELETE on the table)? (b) does it write a hash chain (each row's hash includes the previous row's hash)? (c) does it sign each row (HMAC)? `commercialEngine.ts` shows the HMAC pattern at lines ~750 (`invoice_hash`, `signature`) — confirm whether the audit-log writers use the same discipline.

**Step 2 — `caas_evidence.db` may be a separate database.** `query-evidence.ts` references `caas_evidence.db`, distinct from `/data/caas.db`. Find what populates it:
```bash
grep -rn "caas_evidence\|evidence.db" src/ 2>/dev/null
grep -rn "INSERT INTO evidence\b" src/ 2>/dev/null
```
A second SQLite file changes the disaster-recovery story (Litestream is configured for `caas.db` per the gap map's Data layer row — is the second DB replicated too?).

**Step 3 — R2 Object Lock posture.** Cloudflare R2 console → bucket `caas-lite-backups` → Settings → Object Lock. Currently the gap map says `❌`. Either confirm or update.

**Step 4 — `.gitattributes` and binary integrity for the SQLite file in backups.** Litestream replicates WAL segments, not the whole DB; restore drill (separate gap map row, currently `❌`) is the only way to confirm what's actually recoverable.

**Verdict format for the gap map:**
- ✅ if append-only + hash chain or signature + R2 Object Lock + restore drill passed
- 🟡 if append-only and signed but no Object Lock and no restore drill
- ❌ if no append-only discipline (writers do UPDATE / DELETE) and no Object Lock
- 🔧 if a substitution exists (e.g. Litestream + R2 versioning is the chosen path; document it)

### Verification 1.4 — Trust Badge surface

**Goal:** clear yes/no on (a) public read-only vault page, (b) embeddable widget, (c) wired to real data.

```bash
# Public route — look for whatever serves the vault read-only view
grep -rn "trust.?badge\|public.?vault\|vault.*public" src/ 2>/dev/null | grep -iE "route|router|app\.get|app\.post"

# Embed widget — typically a small JS bundle served as a static asset
find . -path ./node_modules -prune -o -name "*.js" -print 2>/dev/null | xargs grep -l "trust.?badge\|caas.?badge" 2>/dev/null | head -10
ls public/embed/ 2>/dev/null || ls static/embed/ 2>/dev/null || echo "No embed/ folder under public or static"

# Data wiring — does the public route read from real audit logs or stub data
grep -rn "trust_badge_history\|trust_badge_registry" src/ 2>/dev/null
```

**Verdict format:**
- ✅ if all three are present and wired
- 🟡 if the public page exists but reads stub data, or the widget exists but the page doesn't
- ❌ if neither exists

**Why this matters now:** this is a Week 3 / Day-30 pilot deliverable. If `❌`, Block 3 gets a real build item (~days, not hours). If `🟡` with stub data, the Block 2 decision on Trust Badge wording must reflect that the badge doesn't yet read from real data.

### Verification 1.5 — API documentation accuracy

**Goal:** decide whether the integration team is blocked on doc rework before they arrive.

**Step 1 — find the docs.** Where they live is itself the first question.
```bash
find . -path ./node_modules -prune -o -type f \( -name "*.md" -o -name "openapi*" -o -name "swagger*" \) -print 2>/dev/null | grep -iE "api|endpoint|route|docs" | head -20
```
If nothing shows up, that's its own finding (`❌ docs do not exist`).

**Step 2 — pick 5 endpoints and compare.** Pick endpoints that span auth, read, write, and one webhook-style entry point if present. For each:
- Read the docs entry for the endpoint
- Open `src/routes/*.ts` for the matching handler
- Compare: route path, HTTP method, request body shape (look for zod schema — slice 7 uses `.strict()`), response shape, status codes documented vs returned
- One line per endpoint: "matches" / "drift: <what differs>"

**Verdict format:**
- ✅ if 5/5 match cleanly
- 🟡 if 3-4 match and the drift is cosmetic (field names) — fixable in hours
- ❌ if 0-2 match or major drift (wrong paths, wrong schemas) — days of rework, Block 3 item, integration team blocker

### Verification 1.6 — PDF generation capability

**Goal:** decide whether the Day-30 PDF deliverables (Initial Risk Scan, Evidence Vault Log, Compliance Gap Report) need infrastructure built first.

```bash
# Library presence in dependencies
grep -E '"(pdfkit|puppeteer|playwright|pdfmake|jspdf|html-pdf|wkhtmltopdf)"' package.json

# Actual usage in code (a dependency listed in package.json with zero imports = not built)
grep -rn -E "from ['\"](pdfkit|puppeteer|playwright|pdfmake|jspdf|html-pdf)" src/ 2>/dev/null

# Third-party PDF services
grep -rn -E "docraptor|pdfshift|api2pdf" src/ 2>/dev/null

# Any route that returns application/pdf
grep -rn "application/pdf" src/ 2>/dev/null
```

**Verdict format:**
- ✅ if a library is imported and an example route returns a real PDF (test it: `curl -o test.pdf` and open it)
- 🟡 if a library is listed in `package.json` but no route uses it (treat as ❌ for the pilot)
- ❌ if no library and no third-party calls — Block 3 item; recommend `pdfkit` or `pdfmake` for structured documents per `DELIVERABLE_PATH.md` § 3.4

---

## Cross-cutting findings (worth surfacing now)

These came up during the verifications above but don't belong to any one row.

### CF-1: A second database may exist

`query-evidence.ts` opens `caas_evidence.db`, distinct from `/data/caas.db`. The gap map's Data layer section only documents `caas.db`. Either this is a development-only artifact (and should be removed or moved to a `scripts/` folder out of `src/`) or it's a real second store and the disaster-recovery story is incomplete. **Action:** find every reference (`grep -rn "caas_evidence\|evidence\.db"`) and decide.

### CF-2: `commercialEngine.ts` is itself a Block 1 evidence point for slice 7 discipline

Reading the file confirms the slice 7 hardening discipline is real, not aspirational: `loadHmacSecret()` refuses to start in production without a secret (line 300+), integrity-hash verification on subscription reads (line 395), HMAC signatures on invoices and tokens (line 750+, 1124+). Counter to the engine-doesn't-exist finding, the *commercial* engine layer is one of the strongest-looking pieces of code in what we've seen. This means: when the punchlist scopes "build the Verification Engine," the bar for the new code is set by what's already in `commercialEngine.ts`. The integration team should read it as the house style guide before they build the engine.

### CF-3: The `verification.ts` grep is the single most important next action

If `verification.ts` exists in the repo and implements `forceFailOnEmptyConditions` and `forceFailEventTypes`, then a verification engine of some kind exists and 1.2 should re-open from `❌` to `🟡`. If it doesn't exist, then the policy JSON files are dead and 1.2 closes as `❌`. This one grep — `grep -rn "verification.ts\|forceFailOnEmpty\|forceFailEventTypes" src/` — is worth doing before any of the other 1.1/1.4/1.5/1.6 work above.

---

## Output: `PILOT_PLATFORM_PUNCHLIST.md` (v0.1 — items from this session only)

Per `DELIVERABLE_PATH.md` § Block 1 Output. This is **v0.1** — the items the four remaining verifications will generate are not in here yet.

| ID | Item | Status (from gap map) | Required for Lite Pilot? | Est. effort | Owner |
|---|---|---|---|---|---|
| P-001 | Build a Verification Engine that consumes the existing policy-map JSON shape (`default.json` / `user-login.json`) and produces per-event pass/fail with severity. Or: confirm `verification.ts` exists, evaluate what it does, and either re-scope this item or close it. | ❌ (pending the `verification.ts` grep) | Yes — without this, the platform's Plane 3 claim is unsupported. Whether it's Week 1 or Week 4-relevant depends on Block 2 scope lock. | `[TBD — small if verification.ts is most of the way there; days-to-weeks if building from zero]` | Integration team or project lead, depending on outcome of the grep |
| P-002 | Author policy maps for the framework(s) Block 2 decides the Lite Pilot will actually cover. Current files cover SOC2 + ISO 27001 only; brief names EU AI Act + GDPR; login copy frames HIPAA / PCI-DSS / ISO 28000 / AML/KYC. **Block 2 must pick which framework(s) are honest pilot claims; this item builds the rules for those.** | 🟡 (shape correct, coverage misaligned) | Yes — at least one framework must have honest, non-empty coverage by pilot Week 4. | `[TBD — days per framework]` | `[TBD]` |
| P-003 | Fix the policy-schema "empty conditions silently pass" design flaw, so critical rules don't depend on a hardcoded engine-side override. Either: change the evaluator so empty-conditions defaults to fail when severity is `critical`, or add a schema rule that forbids empty `conditions` for `critical`-severity rules. The current `forceFailOnEmptyConditions` workaround means the policy file is not the source of truth for the worst cases. | 🟡 | Yes if the engine in P-001 is built; otherwise rolls into P-001. | small (hours) once engine path is known | Whoever builds P-001 |
| P-004 | Rename or reclassify the "compliance" component in `commercialEngine.computeUnderwritingRiskScore`. Currently counts entries in `regulatory_report_log` and `payout_logs.duplicate_runs` and labels the combined score "compliance," which overstates what the inputs measure. Either rename to "regulatory activity" or replace with a real compliance-failure signal (output of the future P-001 engine). | n/a (new finding) | No for Week 1; yes before the Trust Badge surface (Week 3) makes any claim about a "compliance score." | small (hours for rename; days if replacing inputs) | Whoever owns `commercialEngine.ts` |
| P-005 | Locate or remove `query-evidence.ts` and decide the fate of `caas_evidence.db`. If real second DB: extend disaster-recovery story to cover it. If dev scratch: move under `scripts/` or delete. | n/a (new finding) | No for Week 1, but a `❓` here introduces backup-completeness risk that the gap map should track explicitly. | small (hours) | Project lead |
| P-006 | Add or confirm `.gitattributes` posture for the repo, especially `*.json text eol=lf`. `user-login.json` is CRLF, `default.json` is LF; Stopgap A solves it at the developer-machine layer, `.gitattributes` solves it at the repo layer for the next contributor on Windows. | n/a (new finding) | No, but trivially worth doing now | minutes | Project lead |

### Items deferred until 1.1, 1.4, 1.5, 1.6 land

The punchlist v0.2 (after the remaining four verifications) will likely add:

- **From 1.1:** R2 Object Lock configuration; hash-chain discipline on audit-log writers; restore drill (already noted in gap map § Data layer); the Block 2 decision on Trust Badge wording.
- **From 1.4:** if `❌`, build the public read-only vault page; if `❌`, build the embeddable widget.
- **From 1.5:** if `❌` or `🟡`, API documentation rework (DELIVERABLE_PATH § 3.6).
- **From 1.6:** if `❌`, PDF generation infrastructure (DELIVERABLE_PATH § 3.4).

---

## Reading discipline notes (for the next pass)

Three things came up that are worth carrying forward as habits:

1. **A row in the gap map can be two rows.** The Plane 3 "Verification Engine" row was collapsing the commercial engine and the compliance verification engine into one cell. Watch for this in the remaining rows — when a status looks ambiguous, the question may be "is this one thing or two."
2. **Policy data and the engine that reads it are *separate* verifications.** 1.3 can be 🟡 while 1.2 is ❌ — the data can exist with no consumer. Don't conflate them.
3. **`_note` fields in JSON are gold.** They are author confessions. Read them carefully. They almost always point at the next file you need to find.

---

## Change log

- **2026-05-23** — v0.1 initial draft. Covers verifications 1.2 and 1.3 from uploaded sources. Verifications 1.1, 1.4, 1.5, 1.6 left as precise next-action recipes for the next pass. Punchlist v0.1 with P-001 through P-006 drafted. Cross-cutting findings CF-1 / CF-2 / CF-3 surfaced.
