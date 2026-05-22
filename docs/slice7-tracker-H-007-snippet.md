### H-007 — User & Tenant Management — required module, not yet built

- **Source:** Slice 7 hardening session 2026-05-21 (post-deploy retrospective); DEPLOYMENT.md § "What this deployment story does NOT cover."
- **Status:** `Open`. **Owner:** `?` (needs product + security; engineering cannot scope alone).
- **Current behavior:** There is no admin surface for managing the users and tenants that the rest of the platform assumes exist. Specifically:
  - **Bootstrap (first Executive)** requires direct DB access via `fly ssh console` + `sqlite3` — no UI for it, by design (see DEPLOYMENT.md § Bootstrap the first user).
  - **Subsequent user creation by an Executive** requires hitting the API endpoint directly (`POST /users` or equivalent). The admin-side UI for this either doesn't exist or isn't wired to a route an Executive would discover.
  - **Self-registration** via `/register` works end-to-end but has unclear security posture — no documented rate limit, no email verification posture, no per-tenant scoping rule, no captcha. Acceptable for a closed alpha; not acceptable for any public launch.
  - **Tenant management** does not exist as a concept in the UI. Tenants are implicit strings (`tenant-aitw-001`) created by being typed into an INSERT. No provisioning flow, no rename, no archive, no list, no governance.
  - **User lifecycle operations** — listing, editing, deactivation, role-change, password-reset — none are visible in the UI. The DB supports all of them; the API may support some; nothing surfaces to an admin.
  - **Audit log of user actions** is captured in the DB (table `role_audit_log` and related) but there is no UI to read it. The most security-sensitive trail in the system is write-only from an operator's perspective.
- **Proposed change:** This is not a schema tightening; it's a module to build. The shape, at minimum:
  - An admin UI accessible to `Executive` / `client_super_admin` users with: user list, user detail (view + edit), user create, user deactivate, role-change with reason capture, password-reset flow, tenant list, tenant detail, tenant create / archive, audit-log reader with filters by actor, target, action, time range.
  - A documented self-registration policy: one of {disabled, invite-token only, email-verified open within tenant, fully open}. The current implicit "fully open" is not a chosen posture, it's a default.
  - Server-side endpoints for any of the above that don't already exist, with the slice-7-style schema discipline (zod + `.strict()` + audit-log writes).
- **Behavior change:** Net-additive. Existing API surface remains; this adds the admin UI on top and locks down `/register` per the chosen posture. The one breaking change is whatever the self-registration decision turns out to be — if anything tighter than "fully open" is chosen, existing self-registrations using the loose path break.
- **Affected:**
  - **Production operators** — currently doing first-user bootstrap by hand per the DEPLOYMENT.md recipe. They get a real flow.
  - **Every Executive user** — gains an admin surface they don't currently have.
  - **Self-registered users** — affected by whatever the security-posture decision is. If the decision is "disable self-registration entirely," the `/register` route gets removed and any in-flight signups break.
  - **Audit / compliance review** — the role_audit_log becomes readable, which is the precondition for any real compliance posture.
- **Product question:** This is the largest open product question in the tracker. It decomposes:
  - *What is the self-registration security posture?* Disabled / invite-token / email-verified-within-tenant / fully open. This must be answered before any public launch and probably before the UI is built (the UI design depends on the answer).
  - *Who provisions tenants?* Self-service via the same Executive UI, or platform-operator-only via direct DB / a separate ops tool, or some hybrid (an Executive can request a new tenant, an ops admin approves)?
  - *What is the role model for the admin UI?* The current roles are `Executive` and the permission level `client_super_admin`. Is there a `tenant_admin` below Executive who can manage their own tenant's users but not others? If so, the UI needs row-level visibility filters.
  - *Is password reset email-driven or token-driven or operator-driven?* Each has different infrastructure prerequisites (SMTP / queue / nothing).
- **Suggested rollout:** **Coordinated**, and almost certainly multi-slice. A sensible decomposition:
  1. **Decide self-registration posture** (product + security, no code). Block public launch on this.
  2. **Enforce the decision in the existing `/register` route** (rate limit, captcha, or removal). Drop-in if decision is "disable" or "tighten." Coordinated if decision is "email-verified" (needs SMTP infra first).
  3. **Build read-only admin surfaces first** — user list, audit log reader. These have no risk and give operators something useful immediately.
  4. **Build write surfaces** — user create / edit / deactivate, role change with reason — with the slice-7 schema discipline.
  5. **Build tenant management** — provisioning, rename, archive. Coordinated with whatever the tenant-provisioning answer is.
- **Pre-merge checks (when implementing):**
  - For each new endpoint: schema + `.strict()` + audit-log write + handler test + fixture audit. Same checklist slice 7 used.
  - For the self-registration tightening: `grep -r "POST /register\|/api/v1/register" tests/ sdk/ dashboard/` to find every caller before changing the contract.
  - For the audit-log reader: confirm pagination + indexing on `role_audit_log` (and related tables) before exposing — a naive `SELECT *` on a year of audit rows from the UI is a self-DoS.
  - Before merging the first admin-UI route: document the role gate in one place so subsequent routes copy from a single source of truth, not by lifting from neighbors.
