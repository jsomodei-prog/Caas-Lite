# Session Resume — CaaS-Lite

**Status:** Living document. v1.0, 2026-05-23 end of session.
**Purpose:** Single-file picture of where the project stands and what to do next, so any future session (or the integration team) can pick up without re-reading every doc. Update at the end of each working session.

---

## Current state, in one paragraph

Block 0 (the stopgap) and Block 1 (gap-map verification) are both complete and committed. The platform is honest at the front door — no demo credentials, compliance copy reworded as "what we help clients address" rather than "what we are certified as," `/register` gated off via env var, no broken admin button, DEPLOYMENT.md bootstrap recipe corrected to match the live schema, H-007 (User Management gap) recorded in the slice 7 tracker. Block 1 walked the six high-priority gap-map verifications against the codebase and produced an 18-item punchlist. **The headline finding from Block 1 is that the Verification Engine code is real and well-built but has zero production callers; the policy maps cover SOC2/ISO27001 only with zero EU AI Act / GDPR coverage; the Trust Badge has only a JSON API (no public page, no embeddable widget); and there is no PDF generation infrastructure.** The next concrete work is Block 2 — reconciling the pilot scope against these Block 1 findings.

---

## What's committed

In order, most recent first:

| Commit | What |
|---|---|
| `925cd17` | Slice 7 tracker: add H-007 (User and Tenant Management gap) — task B |
| `323fa6f` | Add planning docs (deliverable path, stopgap, login rewording, Block 1 results) and update .gitignore |
| `241ce1e` | Stopgap C/D/E/F: gate /register, rework compliance copy, remove demo creds and Add User button |
| `340c225` | DEPLOYMENT.md: correct bootstrap recipe (email, control_plane, plane_role); annotate historical record — task G |
| `8a186bc` | Earlier session: Lite Pilot scope, architecture gap map, etc. |

Local and origin in sync as of session end.

---

## Block 0 — Stopgap status

| # | Task | State |
|---|---|---|
| A | git autocrlf=input | ✅ Done |
| B | H-007 in slice 7 tracker | ✅ Done (`925cd17`) |
| C | Demo credentials removed from login | ✅ Done (modulo two cosmetic placeholders — see housekeeping) |
| D | Compliance copy reworded (Option A) | ✅ Done on `register.html` |
| E | `/register` gated via `ENABLE_PUBLIC_REGISTRATION` | ✅ Done — code shipped, Fly secret set to `false`, GET verified 404 |
| F | "Add new user" button removed | ✅ Done |
| G | DEPLOYMENT.md bootstrap recipe corrected | ✅ Done (`340c225`) |

### Detail on E's verification

- **GET `/register`** returns 404 with secret set to `false`. Gate at `src/app.ts` line 718 confirmed working.
- **POST `/register`** and **POST `/auth/register`** return 429 (commercial-tier rate limiter fires before the gate). Gate code is identical-pattern to GET — same env var, same `process.env... === "true"` check, same comment cross-referencing. Trust the pattern even though the 429 prevents direct observation. **The 429 itself is a separate finding logged as P-019 below.**

---

## Block 1 — Gap-map verification status

Output: `docs/BLOCK_1_RESULTS.md` v1.0 (committed in `323fa6f`).

| # | Row | Verdict |
|---|---|---|
| 1.1 | Evidence Vault integrity | 🟡 — strong tamper-evidence (HMAC + chained hashes), no tamper-resistance (no WORM), atomicity gaps in 5 routes |
| 1.2 | Verification Engine | ❌ as deployed (no callers); ✅ as scaffolding (engine in `src/engine/` is well-built) |
| 1.3 | Policy maps | 🟡 — shape correct, content insufficient (SOC2/ISO27001 only; zero EU AI Act / GDPR) |
| 1.4 | Trust Badge surface | 🟡 — JSON API exists, no public page, no embeddable widget |
| 1.5 | API documentation | ❌ as discrete artifact; 🟡 as route-file header comments |
| 1.6 | PDF generation | ❌ — no library, no route, no third-party service |

The 18-item punchlist (P-001 through P-018) is in `BLOCK_1_RESULTS.md` § "Output: PILOT_PLATFORM_PUNCHLIST.md v1.0".

### Load-bearing items for pilot

- **P-001** — Wire `VerificationEngine` + `PolicyEngine` into production (the `TODO(phase15)` async processor in `pilot-ingest.ts`). Days, not weeks. Drives the Executive Scorecard deliverable.
- **P-002** — Author EU AI Act policy maps. 3-5 days. Drives the framework-coverage claim.
- **P-009 / P-010** — Build Trust Badge public read-only page + drop-in embeddable widget. 2-3 days each. Drives the Week 3 deliverable.
- **P-011** — OpenAPI generation from zod schemas. 3-5 days. Integration-team blocker.
- **P-012** — PDF generation (`pdfkit`). 3-5 days. Drives Week 1 (Initial Risk Scan) and Week 4 (Evidence Vault Log, Compliance Gap Report).

---

## Housekeeping outstanding (~30 min when picked up)

Independent tasks; do whichever fits the time available.

### H-1 — Add P-019 to the punchlist

The 429 finding from E verification. Suggested entry to add to `BLOCK_1_RESULTS.md` § Output: PILOT_PLATFORM_PUNCHLIST.md v1.0:

> **P-019** — Unauthenticated POSTs to public routes return 429 with `tier: PAY_AS_YOU_GO, limit: 0`. The commercial-tier rate limiter runs before the registration gate and refuses unauthenticated requests with a zero quota. If `ENABLE_PUBLIC_REGISTRATION` is ever set to `true`, public users will get 429 before reaching the registration form. Investigate middleware ordering in `src/middleware/`. Either (a) bypass commercial rate limiting for `/register` and `/auth/register`, or (b) set a non-zero default limit for unauthenticated routes. Discovered during Block 0 task E verification — curl POST to `/auth/register` returned this body verbatim during stopgap close-out. **Status:** ❌. **Required for pilot?** Only if Block 2 enables registration. **Effort:** Hours once the middleware is located.

Then commit and push.

### H-2 — Cosmetic placeholder cleanup in `index.html`

Two lines:
- Line 758: `placeholder="exec_demo"` → `placeholder="username"`
- Line 1360: `tenant: 'tenant-demo-001'` → optional (`tenant: ''`, or leave — internal state)

Commit, push, `fly deploy`.

### H-3 — Remove H-007 snippet file (optional)

`docs/slice7-tracker-H-007-snippet.md` content is now in `docs/slice7-hardening-tracker.md` (commit `925cd17`). Keep as historical pointer or remove:

```powershell
git rm docs/slice7-tracker-H-007-snippet.md
git commit -m "Remove H-007 snippet file (merged into slice 7 tracker, commit 925cd17)"
git push
```

---

## Block 2 — Pilot scope lock (half day to full day, focused)

**Input:** `docs/BLOCK_1_RESULTS.md` v1.0 (the punchlist + recommendations) and `docs/LITE_PILOT_SCOPE.md` v1.0 (the pre-Block-1 scope doc).

**Output:** `docs/LITE_PILOT_SCOPE.md` v2.0, with "as-deployed" addenda per deliverable noting which Block 1 finding affects it and what the fallback is if a punchlist item slips.

### Five decisions to make

Sketched in `BLOCK_1_RESULTS.md` § Recommendations:

1. **Trust Badge tamper-evidence wording.** Honest framing today: "Append-only audit trail with HMAC-signed state rows, chained-hash discipline on risk and audit-snapshot tables, daily off-site replication via Litestream to Cloudflare R2." Avoid "WORM" unless P-007 (R2 Object Lock) commits before Week 3.
2. **Verification Engine scope.** Pilot "Compliance Posture Snapshot" in Week 1, expand to "Continuous Verification" once P-001 lands.
3. **Policy coverage.** One framework, done well. Recommended: EU AI Act. Named in brief, SMB-relevant, achievable in Block 3 with a small initial rule set.
4. **PDF fallback.** Write into scope explicitly: if P-012 slips past Week 1, Initial Risk Scan delivers as markdown — the deliverable is the insight, not the format.
5. **Integration team first sprint.** Recommended: P-001 + P-013 (wire the engine + tests) as one landing-pad task.

### How to run Block 2

- Open `BLOCK_1_RESULTS.md` and `LITE_PILOT_SCOPE.md` side by side.
- For each deliverable in `LITE_PILOT_SCOPE.md` § 1, find the Block 1 findings that affect it.
- Write an "as-deployed" addendum: what's actually shippable in the pilot window, what's the fallback if a punchlist item slips, what's deferred to post-pilot.
- Commit `LITE_PILOT_SCOPE.md` v2.0.

---

## Block 3 — Pre-pilot build (weeks, with integration team)

Driven by the punchlist. Load-bearing items repeated here for reference: P-001 (wire engine), P-002 (EU AI Act policies), P-009/P-010 (Trust Badge surface), P-011 (OpenAPI), P-012 (PDF).

Depends on the integration team being available. Block 2 should reconfirm their first-sprint scope per Decision 5 before they arrive.

---

## Block 4 — First pilot

Per `docs/DELIVERABLE_PATH.md` § Block 4. Four-week pilot with one SMB client signed under a DPA. Out of scope until Block 3 completes.

---

## Files to read first when picking this up

In order:

1. **This file** — current state in one place.
2. **`docs/BLOCK_1_RESULTS.md`** — the punchlist, findings, and Block 2 recommendations.
3. **`docs/LITE_PILOT_SCOPE.md`** — the pre-Block-1 scope (Block 2's starting point).
4. **`docs/DELIVERABLE_PATH.md`** — the overall block structure if you need to re-orient.

Skip:

- `docs/BLOCK_1_SESSION_NOTES.md` — superseded by `BLOCK_1_RESULTS.md` v1.0; left in repo for the audit trail of how the analysis evolved.

---

## Cross-session conventions

These apply to every session, carried over from `DELIVERABLE_PATH.md` § Cross-block disciplines:

- **Honesty about what the platform is.** Lite version. No HIPAA / PCI-DSS / ISO 28000 / AML/KYC certifications.
- **Documentation lives in git.** No private Google Docs for source-of-truth.
- **Schema is truth.** Where docs and schema disagree, fix the docs. `.schema users` before any bootstrap recipe edit.
- **Audit-trail discipline.** Slice 7's pattern (zod `.strict()`, role audit log, commercial audit log) extends to new code in Block 3.
- **Decisions are recorded.** Open decisions in `DEPLOYMENT.md` § Open decisions is the pattern; when a decision is deferred, write down what's being deferred and what triggers it.

---

## Change log

- **2026-05-23 v1.0** — Initial draft at end of stopgap + Block 1 session. Block 0 closed. Block 1 closed. 18-item punchlist in place. P-019 logged here pending punchlist update (H-1). Block 2 sketched but not started.
