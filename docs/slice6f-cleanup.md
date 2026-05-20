# Slice 6f — Original-Handoff Cleanup

Closes the small follow-ups from the original Phase 15 handoff that didn't
fit in any other slice.

## 6f.1 — `.gitattributes` for LF/CRLF normalization

**Shipped as file: `/.gitattributes`** (in this slice's output directory).

Drop the file at the repo root. Then run:

```bash
git add --renormalize .
git commit -m "chore: normalize line endings via .gitattributes"
```

That one-time renormalization aligns existing repo blobs with the rules. Without it, existing CRLF lines in the repo stay until each file is touched, which produces noisy diffs forever.

**Why this matters specifically for this project.** The user's environment is Windows (`C:\Users\jsomo\...` paths in test output). Without explicit rules, the first Linux/macOS dev to touch the repo will see every file as fully modified. The `.gitattributes` removes that risk.

## 6f.2 — Tax-receipt cleanup (patch instructions)

The original handoff flagged four problems with the tax-receipt code path. The receipt-generation source file wasn't uploaded during this session, so these are written as patch instructions to apply by hand. Source file is presumably `src/lib/tax-receipt.ts` or `src/services/taxReceiptService.ts`.

### 6f.2a — `country_name` typo

**Symptom**: receipts render with the country misspelled (specific typo varies by codebase — handoff said "country_name" field renders incorrectly).

**Find**: search the tax-receipt module for hardcoded country name strings:

```powershell
Select-String -Path src/**/*.ts -Pattern "country_name|countryName" -Context 0,2
```

**Fix**: replace any hardcoded country name with a lookup against a country-code dictionary, OR ensure the typo is corrected. If the codebase has a `src/lib/iso-countries.ts` or similar reference, use that. If not, the typo correction is just a string fix.

**Verify**: write a unit test that generates a receipt for the affected country and asserts the rendered name matches the canonical spelling.

### 6f.2b — Empty regulator field

**Symptom**: the "Filed with: [regulator name]" line in the rendered receipt is blank for some countries.

**Find**:

```powershell
Select-String -Path src/**/*.ts -Pattern "regulator|filed_with" -Context 0,3
```

**Fix**: the receipt-rendering code probably reads from a per-country regulator config that's missing entries for the affected jurisdictions. Either:

- Add the missing regulator entries to the config (preferred — accurate).
- Render "Not applicable" or "Self-filed" when the regulator field is empty (acceptable fallback).
- Refuse to issue the receipt when the regulator is required for that jurisdiction (most conservative — fails loudly rather than silently).

The right choice depends on the compliance contract you have. If receipts MUST list a regulator for filing-required jurisdictions, option 3 is correct. If receipts are informational, option 2 suffices.

### 6f.2c — `dev_hmac_secret` fallback

**Symptom**: receipt signatures use the fallback secret `dev_hmac_secret` when `process.env.PAYOUT_HMAC_SECRET` is unset. Found at line 281 of `src/services/commercialEngine.ts` (verified slice 6e). The same pattern likely exists in the tax-receipt module.

**Find**:

```powershell
Select-String -Path src/**/*.ts -Pattern "dev_hmac_secret|dev-hmac-secret" -Context 0,2
```

**Fix**: in production code paths, throw at startup if the secret is unset rather than silently using `"dev_hmac_secret"`. Pattern:

```ts
const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET;
if (!HMAC_SECRET && process.env.NODE_ENV === "production") {
  throw new Error(
    "PAYOUT_HMAC_SECRET must be set in production. " +
    "Refusing to start with development fallback."
  );
}
const SECRET = HMAC_SECRET ?? "dev_hmac_secret";
```

The `NODE_ENV === "production"` check preserves dev ergonomics (you can still run locally without setting the env var) while removing the production foot-gun.

Even better: have the secret loaded once at boot through a `secret_state` table read (the v27 migration created `secret_state` — slice 6e log confirmed). Then there's no fallback at all in production; if the secret table is empty at boot, the app refuses to start.

### 6f.2d — Mixed-WHT misrepresentation

**Symptom**: when a payout combines withholding-tax amounts from multiple jurisdictions (a "mixed WHT" payout), the receipt presents them as if they were a single homogeneous tax line — losing the jurisdiction breakdown.

**Find**: search for where receipt line items are rendered:

```powershell
Select-String -Path src/**/*.ts -Pattern "withholding|wht" -Context 0,5
```

**Fix**: change the receipt-rendering function to render one line per jurisdiction when WHT spans more than one. Roughly:

```ts
// BEFORE
receipt.lines.push({
  type: "withholding",
  amount: totalWhtAmount,
  description: "Withholding tax",
});

// AFTER
for (const [jurisdiction, amount] of whtByJurisdiction.entries()) {
  receipt.lines.push({
    type: "withholding",
    amount,
    description: `Withholding tax (${jurisdiction})`,
    jurisdiction,
  });
}
```

If the receipt schema doesn't currently have a `jurisdiction` field on line items, add one and migrate the data model accordingly.

**Verify**: add a unit test that creates a payout with WHT from two countries and asserts the receipt has two distinct WHT lines with the right amounts.

## 6f.3 — Test secrets cleanup (deferred)

The original handoff flagged that `tests/setup.ts` contains hardcoded secret strings (HMAC secrets, JWT signing keys, etc. used for test runs). These can't be cleaned up in this session because:

- They're functional — the test suite needs SOME value for these secrets.
- Replacing them with `process.env.TEST_*` reads requires a CI secrets manager configured for the project, which isn't established yet.
- Removing them outright would break 127/127.

**Recommended approach for when CI secrets land:**

1. In `tests/setup.ts`, replace each hardcoded string with `process.env.TEST_<NAME> ?? throw new Error(...)`.
2. In your CI runner (GitHub Actions, etc.), set the `TEST_*` env vars from secret store before invoking `npm test`.
3. Local dev workflow: each developer puts test secrets in `.env.test` (gitignored), loaded by `tests/setup.ts` via `dotenv`.

This work is deferred until the secrets manager is provisioned. Flagged here so it's not forgotten.

## 6f.4 — Real calibration fitter (deferred)

The original handoff noted that the placeholder constants in `src/engine/risk-pricing.ts` need to be replaced with a real fitted model (MLE/GLM, etc.). The test output in this session shows the placeholder banner:

```
⚠  Placeholder constants. Numbers above are NOT valid quotes.
```

This is out of scope for the hardening sprint because it requires:

- Real loss-run data (multiple historical incident periods)
- An actuary to validate the fitting methodology
- Statistical software (R or Python with statsmodels) for the fit

The placeholder system is correctly labeled as such in the test output. Leaving it in this state with the warning banner is acceptable until real calibration data is available.

**Recommended exit condition**: once real data + actuarial sign-off exist, the fitter replaces the constants AND the test banner is removed AS PART OF the same commit. The warning is the contract — don't ship without it if the constants are still synthetic.

---

## Verification after applying slice 6f

1. **`.gitattributes`** dropped, `git add --renormalize .` run, committed. The next `git status` should show no spurious modifications.

2. **Tax-receipt fixes** (6f.2a-d) — for each fix applied, add or update a unit test that exercises the previously-broken path. The unit tests serve as regression guards.

3. **`npm test`** — must remain green. Tax-receipt changes touch generation code, not the existing 127 tests' assertions, so they should pass through unchanged unless your tax-receipt tests are part of that 127 (likely — search for `taxReceipt` in `tests/`).
