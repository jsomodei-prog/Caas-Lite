/**
 * tests/audit-coverage.test.ts
 *
 * Permanent regression guard for slice 5.
 *
 * What this test does:
 *   1. Scans every file under src/routes/ for mutation route registrations
 *      (router.post/.patch/.put/.delete).
 *   2. For each mutation, traces the handler function it references.
 *   3. Asserts the handler either (a) writes to commercial_audit_log or
 *      role_audit_log, OR (b) appears on the allowlist below with a reason.
 *
 * What it does NOT catch:
 *   - Non-atomic audit writes (mutation + audit as separate statements).
 *     That's a slice 6 fix and would need static analysis to detect.
 *   - Conditional audits (handler writes audit in one branch but not
 *     another). The test only checks for presence of an audit insert
 *     statement in the handler's lexical scope.
 *   - Audits that fire from downstream helpers. If foo() is a route and
 *     it calls helper(), and helper() writes the audit, this test sees
 *     the audit in helper's source — but only if helper lives in the
 *     same routes/ file. Cross-file audits need to be added to the
 *     allowlist with the reason "audited downstream in <path>".
 *
 * Design choice: regex over the source rather than AST parsing. Trade-off
 * is brittleness vs simplicity. The AUDIT_PATTERN and ROUTE_PATTERN below
 * are intentionally conservative — false positives are caught at PR review,
 * false negatives (a real gap slipping through) would defeat the purpose.
 * If the regex starts misfiring, swap for ts-morph or @typescript-eslint
 * AST nodes.
 */

import * as fs from "fs";
import * as path from "path";

const ROUTES_DIR = path.join(__dirname, "..", "src", "routes");

// Match `router.METHOD("path", ..., async_(NAME))` or `..., asyncHandler(NAME))`.
// Captures: 1 = method, 2 = path, 3 = handler name.
// `(?:(?!router\.)[\s\S])*?` is "any chars but cannot span across another router.X call".
// Without that constraint, the non-greedy match extends across multiple route lines
// and mis-associates handlers.
const ROUTE_WITH_HANDLER = /router\.(post|patch|put|delete)\s*\(\s*["'`]([^"'`]+)["'`](?:(?!router\.)[\s\S])*?(?:async_|asyncHandler)\(\s*([a-zA-Z_$][\w$]*)\s*\)\s*\)/g;

// Match `router.METHOD("path", ..., (req, res) => ...)` — inline arrow handler.
// Tolerates TypeScript type annotations: `(req: Request, res: Response): void => ...`.
// Optional pieces:
//   - `(?:\s*:\s*[A-Za-z_$][\w$.]*)?` after req and res — param type annotation
//   - `(?::\s*[A-Za-z_$][\w$.]*\s*)?` after the closing paren — return type
// Captures: 1 = method, 2 = path. No handler name; we fall back to file-level audit check.
const ROUTE_WITH_INLINE   = /router\.(post|patch|put|delete)\s*\(\s*["'`]([^"'`]+)["'`](?:(?!router\.)[\s\S])*?\(\s*req(?:\s*:\s*[A-Za-z_$][\w$.]*)?\s*,\s*res(?:\s*:\s*[A-Za-z_$][\w$.]*)?\s*\)\s*(?::\s*[A-Za-z_$][\w$.]*\s*)?=>/g;

const AUDIT_PATTERN = /INSERT\s+INTO\s+(commercial_audit_log|role_audit_log)/i;
const AUDIT_HELPER_CALL = /\b(commercialAuditLog|auditLog|roleAuditLog|writeAudit|insertAudit)\s*\(/;

/**
 * Allowlist of mutation routes that are intentionally NOT audited.
 * Format: { file: "filename.ts", route: "METHOD /path", reason: "..." }
 *
 * To add an entry: PR must include both this allowlist update AND the
 * decision recorded in docs/audit-coverage.md.
 */
interface AllowlistEntry {
  file:   string;
  route:  string;   // e.g. "POST /quote"
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  // --- Pure compute, no state mutation ---
  {
    file:   "risk-pricing.ts",
    route:  "POST /quote",
    reason: "Pure calculator. No DB writes, no state mutation. Documented in handler header.",
  },

  // --- High-volume ingest where the data table IS the audit trail ---
  {
    file:   "pilot-ingest.ts",
    route:  "POST /decisions",
    reason: "SDK ingest. pilot_decisions table records full attribution (account_id, tenant_id, ip, user-agent, received_at). Adding commercial_audit_log per decision would double-write at ingest rate (up to 50/request).",
  },

  // --- Audited transitively (test regex can't follow function call chains) ---
  {
    file:   "insurance.ts",
    route:  "POST /policies/:id/recompute",
    reason: "AUDITED transitively. Handler calls applyStateTransition() (same file) which writes commercial_audit_log INSIDE the same db.transaction() wrapper. Verified by hand in slice 5; test regex can't follow the function call chain.",
  },
  {
    file:   "admin.ts",
    route:  "POST /recompute-all",
    reason: "AUDITED transitively. Verified slice 6: recomputeAllWarranties() in src/lib/recompute-scheduler.ts iterates warranties and calls applyStateTransition() inside db.transaction(), which writes commercial_audit_log on state change. Same caveat as insurance recompute — no audit row on no-op recomputes. Test regex can't follow the cross-file transitive call.",
  },

  // --- Auth events where the canonical record IS the trail ---
  {
    file:   "auth.ts",
    route:  "POST /login",
    reason: "Captured by users.last_login_at + ip_lockouts/failed_attempts. Adding role_audit_log per login multiplies volume against no incremental forensic value.",
  },
  {
    file:   "auth.ts",
    route:  "POST /refresh",
    reason: "refresh_tokens table records issuance with created_at and revoked flag. Operational events visible without role_audit_log.",
  },
  {
    file:   "auth.ts",
    route:  "POST /logout",
    reason: "Revokes a refresh token; state visible in refresh_tokens.revoked. No additional audit needed.",
  },

  // --- Commercial engine routes: verified slice 6 ---
  // Engine writes per-table HMAC tamper-evidence rather than commercial_audit_log.
  // 3 routes verified-justified; 2 have actor-attribution gaps (in TEMPORARY block below).
  // ----------------------------------------------------------------------
  {
    file:   "commercial.ts",
    route:  "POST /invoice/generate",
    reason: "JUSTIFIED. Engine writes commercial_billing_ledgers with HMAC signature. Invoice IS its own tamper-evident record. No actor-attribution gap because invoices are generated against the requesting tenant, not against another user.",
  },
  {
    file:   "commercial.ts",
    route:  "POST /insurance/audit",
    reason: "JUSTIFIED. Engine writes underwriting_audit_snapshots with chained_hash (golden-thread). Risk-band changes have a canonical tamper-evident chain in their own table; adding commercial_audit_log would duplicate.",
  },
  {
    file:   "commercial.ts",
    route:  "POST /subscription/create",
    reason: "JUSTIFIED. Engine writes tenant_commercial_subscriptions with HMAC signature. Subscription row is self-attesting.",
  },

  // --- Open gap NOT audited — team decision pending ---
  //
  // Self-registration is the only TEMPORARY entry slice 6b did NOT close.
  // Defensible to not audit since the new user row IS the canonical record:
  // users.created_at + users.tenant_id captures who provisioned themselves
  // and when. But team consensus is still needed before either auditing it
  // or removing this entry permanently. See docs/audit-coverage.md.
  // ----------------------------------------------------------------------
  {
    file:   "auth.ts",
    route:  "POST /register",
    reason: "TEMPORARY — defensible to not audit self-registration since user row IS the record (users.created_at + tenant_id captures actor and time). Team decision needed before removal. See docs/audit-coverage.md.",
  },
];

interface MutationRoute {
  file:    string;
  method:  string;
  pathStr: string;
  /** Handler function name, OR null for inline `(req, res) => ...` handlers. */
  handler: string | null;
}

function listRouteFiles(): string[] {
  return fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(ROUTES_DIR, f));
}

function enumerateMutationRoutes(filePath: string): MutationRoute[] {
  const source = fs.readFileSync(filePath, "utf-8");
  const fileName = path.basename(filePath);
  const out: MutationRoute[] = [];
  const seen = new Set<string>();   // dedup METHOD path keys across the two regexes

  ROUTE_WITH_HANDLER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_WITH_HANDLER.exec(source)) !== null) {
    const key = `${m[1].toUpperCase()} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: fileName, method: m[1].toUpperCase(), pathStr: m[2], handler: m[3] });
  }

  ROUTE_WITH_INLINE.lastIndex = 0;
  while ((m = ROUTE_WITH_INLINE.exec(source)) !== null) {
    const key = `${m[1].toUpperCase()} ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: fileName, method: m[1].toUpperCase(), pathStr: m[2], handler: null });
  }

  return out;
}

/**
 * Returns true if the file shows evidence of using audit logging.
 *
 * Pre-slice-6c: every route file defined its own audit helper with an
 * INSERT INTO statement local to the file. `AUDIT_PATTERN.test(source)`
 * was sufficient.
 *
 * Post-slice-6c: audit helpers were consolidated into src/lib/audit.ts.
 * Route files now import `auditLog`/`commercialAuditLog` from `../lib/audit`
 * and call them. No INSERT INTO remains in the route source. The import
 * itself is the proof of audit-helper use; combined with a helper call
 * in the relevant scope (caller's responsibility to check), it counts
 * as audited.
 *
 * We accept either pattern so files updated to either style validate.
 */
function fileHasAuditEvidence(source: string): boolean {
  if (AUDIT_PATTERN.test(source)) return true;
  if (/from\s+["']\.\.\/lib\/audit["']/.test(source)) return true;
  return false;
}

function handlerWritesAudit(filePath: string, handlerName: string | null): boolean {
  const source = fs.readFileSync(filePath, "utf-8");

  // Inline-arrow handlers (handler === null): we can't isolate the body
  // cleanly, so fall back to file-level audit presence. False-positive
  // risk: if a file mixes audited and unaudited inline handlers, the
  // unaudited one passes. Mitigation: there are currently no such files;
  // if one appears, refactor it into named handlers or add to allowlist.
  //
  // Slice 6c note: inline handlers in regulatoryIngest.ts (POST /onboard,
  // PATCH /frameworks/:code) used to fail this check because slice 6c
  // moved INSERT INTO to ../lib/audit.ts. fileHasAuditEvidence() now also
  // accepts the import as proof.
  if (handlerName === null) {
    return fileHasAuditEvidence(source);
  }

  // Named handler — extract its function body.
  // Matches `async function NAME(...) { ... }` or `function NAME(...) { ... }`
  // by counting braces. We don't try to handle const-arrow exports because
  // none exist in the current codebase; if they appear, extend here.
  const fnHeader = new RegExp(`(?:async\\s+)?function\\s+${handlerName}\\s*\\(`).exec(source);
  if (!fnHeader) {
    // Handler is imported from another module or defined unusually.
    // Fall back to file-level check.
    return fileHasAuditEvidence(source);
  }

  // Find the matching closing brace of the function by counting depth from
  // the first `{` after the header.
  let i = fnHeader.index + fnHeader[0].length;
  while (i < source.length && source[i] !== "{") i++;
  if (i >= source.length) return false;

  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const body = source.slice(start, i);

  // Direct audit insert in the handler body.
  if (AUDIT_PATTERN.test(body)) return true;

  // Handler calls an audit helper. Confirm the file has either the legacy
  // local INSERT INTO or the post-slice-6c import from ../lib/audit.
  if (AUDIT_HELPER_CALL.test(body) && fileHasAuditEvidence(source)) return true;

  return false;
}

function isAllowlisted(route: MutationRoute): AllowlistEntry | undefined {
  return ALLOWLIST.find(
    (a) => a.file === route.file && a.route === `${route.method} ${route.pathStr}`,
  );
}

describe("audit log coverage", () => {
  const files = listRouteFiles();

  test("at least one route file exists", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("every mutation route is audited or explicitly allowlisted", () => {
    const gaps: string[] = [];

    for (const filePath of files) {
      const routes = enumerateMutationRoutes(filePath);
      for (const route of routes) {
        const allowed = isAllowlisted(route);
        if (allowed) continue;

        const audited = handlerWritesAudit(filePath, route.handler);
        if (!audited) {
          gaps.push(
            `${route.file}: ${route.method} ${route.pathStr} (handler: ${route.handler}) ` +
            `— no audit insert found in handler scope and not on allowlist`,
          );
        }
      }
    }

    if (gaps.length > 0) {
      const message =
        `Found ${gaps.length} mutation route(s) without audit coverage:\n\n` +
        gaps.map((g) => `  • ${g}`).join("\n") +
        `\n\n` +
        `To fix:\n` +
        `  1. If the route should be audited: add an INSERT INTO commercial_audit_log\n` +
        `     (or role_audit_log) inside the handler — ideally in the same db.transaction\n` +
        `     block as the mutation it logs.\n` +
        `  2. If the route should NOT be audited: add an entry to ALLOWLIST in\n` +
        `     tests/audit-coverage.test.ts with a reason, AND record the decision in\n` +
        `     docs/audit-coverage.md.\n`;
      throw new Error(message);
    }
  });

  test("allowlist entries reference real routes", () => {
    const realRoutes = new Set<string>();
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      for (const r of enumerateMutationRoutes(filePath)) {
        realRoutes.add(`${fileName}:${r.method} ${r.pathStr}`);
      }
    }

    const stale = ALLOWLIST.filter((a) => !realRoutes.has(`${a.file}:${a.route}`));
    if (stale.length > 0) {
      throw new Error(
        `Allowlist contains stale entries (route no longer exists):\n` +
        stale.map((s) => `  • ${s.file}: ${s.route}`).join("\n") +
        `\nRemove them from ALLOWLIST.`,
      );
    }
  });
});
