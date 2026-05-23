# Stopgap Execution Guide — Tonight

**Status:** Working document. v1.0, drafted 2026-05-22.
**Purpose:** Step-by-step instructions for the ~1 hour of work in Block 0 of `DELIVERABLE_PATH.md`. Each task has the exact command, file change, or check needed. Run them in order; later tasks depend on earlier ones being done.

This document covers the tasks that cannot be done as written artifacts and require the project lead's terminal: disabling `/register`, hiding the dashboard button, fixing the git warning, updating the slice 7 tracker, and starting the gap-map walk-through.

---

## Task order

| # | Task | Time | Requires terminal? |
|---|---|---|---|
| A | Fix git line-ending warning | 30 sec | Yes |
| B | Paste H-007 into slice 7 tracker | 2 min | Yes |
| C | Remove demo credentials line from login page | 5 min | Yes (edit code) |
| D | Apply reworded compliance copy from `LOGIN_COPY_REWORDED.md` | 10 min | Yes (edit code) |
| E | Disable `/register` via env var | 15 min | Yes (edit code + deploy) |
| F | Hide "Add new user" button | 10 min | Yes (edit code + deploy) |
| G | Apply DEPLOYMENT.md fix from `DEPLOYMENT_BOOTSTRAP_FIX.md` | 5 min | Yes (edit docs) |
| H | Start gap map walk-through (Block 1) | Half day | Yes (read code) |

**A through G** are tonight's work. **H** is the next session, not tonight.

---

## A — Fix git line-ending warning

Run once on the project lead's machine:

```bash
git config --global core.autocrlf input
```

Verification: open the project, run `git status`. The CRLF warning should not appear. This is a per-machine setting; it does not change anything in the repo and does not need to be committed.

If the warning persists for an existing checkout that already has the wrong line endings recorded, follow with:

```bash
git add --renormalize .
git status
```

Commit only if the diff is actually about line-ending normalisation and not a mix of substantive and whitespace changes.

---

## B — Paste H-007 into slice 7 tracker

**Find the tracker file.** It lives in the project repo. From the project root:

```bash
find . -type f -name "*.md" | xargs grep -l "H-00" 2>/dev/null
# or, if you remember the rough name:
find . -type f -iname "*slice*7*" -o -iname "*hardening*"
```

Open the file. Confirm it's the tracker by checking it has entries like H-001, H-002, etc.

**Paste the H-007 entry.** The H-007 snippet itself is held by the project lead (it came from an earlier session and is not in this conversation's context). When pasting:

- Match the formatting of the H-001 through H-006 entries already in the file. Same header level, same field order, same bullet style.
- If the snippet has a status field, set it consistently with how other open items in the tracker are marked.
- Preserve the entry's reference to "no UI to read the `role_audit_log` table" if that's part of the snippet — this is the gap the gap map's Authentication & user management section references.

After pasting:

```bash
git diff <path-to-tracker>
```

Confirm only H-007 was added; nothing else changed.

Commit:

```bash
git add <path-to-tracker>
git commit -m "Slice 7 tracker: add H-007 entry"
```

---

## C — Remove demo credentials line from login page

Locate the login page source. Likely candidates by project convention:

```bash
find . -type f \( -name "*.tsx" -o -name "*.jsx" -o -name "*.html" -o -name "*.ejs" \) | xargs grep -l -i "demo\|test.*credential\|example.*password" 2>/dev/null
```

Open the login page file. Find the line(s) that display demo credentials (typically something like `Demo: ops@example.com / password123` in the footer or near the login form).

Remove the entire line, not just the credentials. The presence of a "Demo:" label suggests the platform is in demo mode and is itself a misrepresentation for a production deployment.

Verify locally with `npm run dev` or equivalent, then deploy.

---

## D — Apply reworded compliance copy

See `LOGIN_COPY_REWORDED.md` (companion document). The change is to the same login page file edited in task C, plus possibly the footer component if shared across pages.

Decide which of Options A / B / C from the rewording document fits the current visual design. **Option A** (single line) is the safest default and the easiest paste.

After applying, also confirm:

- The "Framework references describe the obligations the platform helps clients address, not certifications the platform itself holds." disclaimer is present somewhere on the page.
- Any third-party badges or shields that imply certification are removed.
- Privacy policy and ToS links resolve to real documents — if they don't, remove the links until the documents exist (per the gap map: these are ❓).

---

## E — Disable `/register` via env var

This task has three parts: gate the route, set the env var in production, and verify.

### Part 1 — Gate the route in code

Find the `/register` route handler:

```bash
grep -rn "/register" src/ 2>/dev/null
# look for Express-style route definitions: router.post('/register', ...) or app.post('/register', ...)
```

Open the route file. The change pattern depends on what convention the codebase already uses for env-var-gated features. If there's no existing convention, here is the minimal version (Express-style):

```typescript
// at the top of the route file
const PUBLIC_REGISTRATION_ENABLED = process.env.ENABLE_PUBLIC_REGISTRATION === 'true';

// inside the route handler, as the first check
router.post('/register', async (req, res) => {
  if (!PUBLIC_REGISTRATION_ENABLED) {
    return res.status(404).end();
  }
  // ... existing handler logic
});
```

**Key choices:**
- `=== 'true'`, not just truthy. Env vars are strings; `'false'` is truthy. Be explicit.
- Default to disabled. The env var must be explicitly set to `'true'` to enable. Anything else, including absent, returns 404.
- Return `404` not `403` or `500`. 404 says "this endpoint does not exist" — that's the message a probe should see, not "exists but you can't use it."

Also gate the GET route that serves the registration page (if one exists), with the same logic. A 404 on POST but a rendered page on GET is half-disabled.

### Part 2 — Set the env var in production

On Fly:

```bash
fly secrets set ENABLE_PUBLIC_REGISTRATION=false -a caas-lite
```

Fly secrets restart the machine on set. Confirm with:

```bash
fly secrets list -a caas-lite | grep ENABLE_PUBLIC_REGISTRATION
```

The value is hidden; only the key and a hash are shown. That's normal.

### Part 3 — Verify

From any machine:

```bash
curl -i -X POST https://caas-lite.fly.dev/register \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `HTTP/2 404`. If you get 400, 403, 500, or the route's old behaviour, the gate is not in effect — check the env var, check the deploy succeeded, check the gate is at the top of the handler (not after other middleware that might short-circuit it).

Also probe the GET (if the registration page route existed):

```bash
curl -i https://caas-lite.fly.dev/register
```

Same expectation: 404.

---

## F — Hide "Add new user" button

Find the button in the dashboard source:

```bash
grep -rn "Add new user\|Add User\|add-new-user" src/ 2>/dev/null
```

Open the file. The current behaviour (per the gap map) is that the button links to the public self-registration page, which is not an admin flow. The fix has two options:

**Option 1 (preferred for tonight) — Remove the button entirely.**

Delete the button JSX/HTML. The User Management feature is a known production gap (see Block 1's "User Management addendum" in `DELIVERABLE_PATH.md`) and will be properly built in Block 3. Until then, no button is better than a broken button.

**Option 2 — Conditionally render based on a feature flag.**

If the design system or the dashboard's structure makes removing the button awkward (it leaves a visible hole, breaks a layout grid, etc.), gate it on an env var:

```tsx
{process.env.NEXT_PUBLIC_ENABLE_USER_MANAGEMENT === 'true' && (
  <Button>Add new user</Button>
)}
```

Then ensure the env var is unset or `false` in production. This is heavier than Option 1; only use it if Option 1 leaves a visible gap in the UI.

Deploy and verify by logging in as the operator and confirming the button does not appear.

---

## G — Apply DEPLOYMENT.md fix

See `DEPLOYMENT_BOOTSTRAP_FIX.md` (companion document). Open DEPLOYMENT.md, locate the bootstrap section, and replace it with the corrected text from the companion document.

Before pasting, run the schema verification from the companion document:

```bash
fly ssh console -a caas-lite
sqlite3 /data/caas.db ".schema users"
```

Confirm the column names in the corrected recipe match the live schema. If anything differs, fix the companion document, then DEPLOYMENT.md.

Commit DEPLOYMENT.md changes with a clear message:

```bash
git add DEPLOYMENT.md
git commit -m "DEPLOYMENT.md: correct bootstrap recipe (control_plane, plane_role, email)"
```

---

## H — Start the gap map walk-through (Block 1, not tonight)

This is the half-day-to-full-day session described in Block 1 of `DELIVERABLE_PATH.md`. Not tonight. Schedule it as a focused block on the next available day, ideally before the integration team arrives.

When you sit down for it, work through the six high-priority verifications in this order:

| # | Verification | Where to look |
|---|---|---|
| 1.1 | Evidence Vault integrity | Storage layer code; R2 bucket configuration; any code that writes audit records. Check whether records are hash-chained, signed, or simply inserted. |
| 1.2 | Verification Engine reality | `commercialEngine.ts` (named in the slice 7 tracker). Read it end-to-end. Determine input shape, scoring logic, output shape. |
| 1.3 | At least one policy map | Find policy map JSON files in the repo (likely under `policies/`, `data/`, or `seed/`). Confirm one is loaded into whatever engine exists at 1.2. |
| 1.4 | Trust Badge surface | Frontend routes for the public read-only vault view; embeddable widget code (likely a small JS bundle or iframe-friendly page). Cross-reference with `trust_badge_registry` and `trust_badge_history` table writers. |
| 1.5 | API documentation accuracy | Open the current API documentation. Pick 5 endpoints. For each, read the route handler in code and compare request shape, response shape, auth, error codes. |
| 1.6 | PDF generation capability | Search for `pdfkit`, `puppeteer`, `playwright`, `pdfmake`, or third-party PDF service calls. If none exist, this is a build item. |

For each, update the gap map's Status and Evidence columns with: verified date, commit reference, one-line summary of what's actually there.

After the six high-priority verifications, sweep the remaining ❓ rows. The list of those is in Block 1 of `DELIVERABLE_PATH.md`.

Output of the walk-through: a `PILOT_PLATFORM_PUNCHLIST.md` listing every ❌ and 🟡 item that must become ✅ for the Lite Pilot to run honestly. This punchlist is the input to Block 3.

---

## Checklist (tear-off)

```
[ ] A — git config --global core.autocrlf input
[ ] B — H-007 pasted into slice 7 tracker, committed
[ ] C — Demo credentials line removed from login page, deployed
[ ] D — Reworded compliance copy applied, deployed
[ ] E — /register gated on ENABLE_PUBLIC_REGISTRATION=false, returns 404, deployed
[ ] F — "Add new user" button hidden, deployed
[ ] G — DEPLOYMENT.md bootstrap section replaced, committed
[ ] H — Gap map walk-through scheduled (separate session)
```

---

## Change log

- **2026-05-22** — v1.0 initial draft. Companion to `DELIVERABLE_PATH.md`, `LOGIN_COPY_REWORDED.md`, `DEPLOYMENT_BOOTSTRAP_FIX.md`.
