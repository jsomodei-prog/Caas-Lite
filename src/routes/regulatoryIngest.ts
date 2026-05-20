/**
 * src/routes/regulatoryIngest.ts
 *
 * Phase 14 — Dynamic Regulatory Ingestion Router.
 *
 * Replaces the previously hardcoded compliance profile constants
 * (./config/industryProfiles, ./config/countryRequirements) with a runtime-
 * configurable framework store backed by the regulatory_frameworks,
 * regulatory_field_rules, and regulatory_consent_purposes tables
 * (migration 016).
 *
 * Endpoints (all under /api/v1/regulatory, all gated by global_super_admin):
 *
 *   POST   /onboard               Onboard a new regulatory framework.
 *   GET    /frameworks            List frameworks with optional filters.
 *   GET    /frameworks/:code      Fetch one framework + its rules + purposes.
 *   PATCH  /frameworks/:code      Toggle is_active / merge metadata.
 *
 * Auth:
 *   All routes use `requireGlobalSuperAdmin()` from ./middleware/dualPlaneAuth.
 *   That middleware:
 *     - resolves the principal via the global injectPlaneContext() mount,
 *     - enforces BUSINESS plane + role === "global_super_admin",
 *     - writes an access metric for every evaluation (no need for the route
 *       to log access separately),
 *     - responds with 401 / 403 itself; handlers never see a denied request.
 *
 * The actor's user id is read off `req.dualPlanePrincipal.user_id` for
 * audit columns (created_by_user_id on the framework row).
 *
 * Validation:
 *   The exported `validateFrameworkPayload()` routine performs structural
 *   validation (no external dependencies — handwritten checks matching the
 *   no-Zod, no-Knex style of the rest of the codebase) plus cross-field
 *   semantic checks (regex compilability, duplicate field_keys, length
 *   boundary sanity).
 *
 * Phase 14 build-out
 */

import { Router, type Request, type Response } from "express";
import type { Database as DB } from "better-sqlite3";

import { requireGlobalSuperAdmin } from "../middleware/dualPlaneAuth";
import { commercialAuditLog } from "../lib/audit";

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELD_KEY_RE       = /^[a-z_][a-z0-9_]*$/;
const FRAMEWORK_CODE_RE  = /^[A-Z][A-Z0-9_]*$/;
const REGION_CODE_RE     = /^[A-Z]{2}$/;
const REGEX_FLAGS_RE     = /^[gimsuy]*$/;
const ISO_DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;
const ISO8601_RE         = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const DATA_TYPES = new Set([
  "string", "number", "boolean", "date", "email", "phone", "identifier",
]);
type DataType = "string" | "number" | "boolean" | "date" | "email" | "phone" | "identifier";

const MAX_FIELD_RULES         = 200;
const MAX_CONSENT_PURPOSES    = 100;
const MAX_ALLOWED_VALUES      = 500;
const MAX_REGEX_LENGTH        = 2048;
const MAX_DESCRIPTION_LENGTH  = 8192;
const MAX_ERROR_MSG_LENGTH    = 1024;

// ─── Payload Types ────────────────────────────────────────────────────────────

export interface FieldRuleInput {
  field_key:         string;
  field_label:       string;
  data_type:         DataType;
  is_required?:      boolean;
  is_sensitive?:     boolean;
  min_length?:       number;
  max_length?:       number;
  validation_regex?: string;
  regex_flags?:      string;
  error_message?:    string;
  allowed_values?:   string[];
  constraints?:      Record<string, unknown>;
  display_order?:    number;
}

export interface ConsentPurposeInput {
  purpose_code:               string;
  purpose_label:              string;
  description?:               string;
  lawful_basis?:              string;
  requires_explicit_consent?: boolean;
  retention_days?:            number;
}

export interface FrameworkOnboardingPayload {
  framework_code:    string;
  framework_name:    string;
  region_code:       string;
  region_name:       string;
  regulator_name?:   string;
  version:           string;
  description?:      string;
  source_url?:       string;
  effective_date?:   string;
  is_active?:        boolean;
  metadata?:         Record<string, unknown>;
  field_rules:       FieldRuleInput[];
  consent_purposes?: ConsentPurposeInput[];
}

export interface ValidationResult {
  valid:   boolean;
  data?:   FrameworkOnboardingPayload;
  errors?: string[];
}

// ─── Validator Helpers ────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

function isOptionalString(v: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return v === undefined || (typeof v === "string" && v.length <= max);
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isOptionalBool(v: unknown): boolean {
  return v === undefined || typeof v === "boolean";
}

function isOptionalInt(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return (
    v === undefined ||
    (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max)
  );
}

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

// ─── Payload Validator ────────────────────────────────────────────────────────

/**
 * Validates a framework onboarding payload.
 *
 * Performs handwritten structural validation (no external deps), then layers
 * on cross-field semantic checks:
 *   - validation_regex strings must actually compile,
 *   - field_keys must be unique within field_rules,
 *   - purpose_codes must be unique within consent_purposes,
 *   - min_length must not exceed max_length,
 *   - allowed_values must not contain duplicates.
 */
export function validateFrameworkPayload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(payload)) {
    return { valid: false, errors: ["Payload must be a JSON object."] };
  }

  // ── Top-level scalar checks ─────────────────────────────────────────────
  const {
    framework_code, framework_name, region_code, region_name,
    regulator_name, version, description, source_url, effective_date,
    is_active, metadata, field_rules, consent_purposes,
  } = payload as Record<string, unknown>;

  if (!isString(framework_code, 1, 64)) {
    errors.push("framework_code: must be a 1–64 char string.");
  } else if (!FRAMEWORK_CODE_RE.test(framework_code)) {
    errors.push("framework_code: must be UPPER_SNAKE_CASE (e.g. GH_ACT_843).");
  }

  if (!isString(framework_name, 1, 255)) {
    errors.push("framework_name: must be a 1–255 char string.");
  }

  if (!isString(region_code, 2, 2)) {
    errors.push("region_code: must be a 2-char string.");
  } else if (!REGION_CODE_RE.test(region_code)) {
    errors.push("region_code: must be an ISO 3166-1 alpha-2 code (e.g. GH, NG).");
  }

  if (!isString(region_name, 1, 128)) {
    errors.push("region_name: must be a 1–128 char string.");
  }

  if (!isOptionalString(regulator_name, 255)) {
    errors.push("regulator_name: must be a string up to 255 chars when present.");
  }

  if (!isString(version, 1, 32)) {
    errors.push("version: must be a 1–32 char string.");
  }

  if (!isOptionalString(description, MAX_DESCRIPTION_LENGTH)) {
    errors.push(`description: must be a string up to ${MAX_DESCRIPTION_LENGTH} chars.`);
  }

  if (source_url !== undefined) {
    if (!isString(source_url, 1, 1024) || !isValidUrl(source_url)) {
      errors.push("source_url: must be a valid URL up to 1024 chars.");
    }
  }

  if (effective_date !== undefined) {
    if (typeof effective_date !== "string" || !ISO_DATE_RE.test(effective_date)) {
      errors.push("effective_date: must be YYYY-MM-DD when present.");
    }
  }

  if (!isOptionalBool(is_active)) {
    errors.push("is_active: must be a boolean when present.");
  }

  if (metadata !== undefined && !isObject(metadata)) {
    errors.push("metadata: must be an object when present.");
  }

  // ── field_rules array ────────────────────────────────────────────────────
  if (!Array.isArray(field_rules) || field_rules.length === 0) {
    errors.push("field_rules: must be a non-empty array.");
  } else if (field_rules.length > MAX_FIELD_RULES) {
    errors.push(`field_rules: at most ${MAX_FIELD_RULES} rules allowed.`);
  } else {
    const seenFieldKeys = new Set<string>();
    field_rules.forEach((rule, idx) => {
      const prefix = `field_rules[${idx}]`;

      if (!isObject(rule)) {
        errors.push(`${prefix}: must be an object.`);
        return;
      }

      const {
        field_key, field_label, data_type,
        is_required, is_sensitive,
        min_length, max_length,
        validation_regex, regex_flags,
        error_message, allowed_values, constraints, display_order,
      } = rule;

      if (!isString(field_key, 1, 128)) {
        errors.push(`${prefix}.field_key: must be a 1–128 char string.`);
      } else if (!FIELD_KEY_RE.test(field_key)) {
        errors.push(`${prefix}.field_key: must be snake_case starting with a letter or underscore.`);
      } else if (seenFieldKeys.has(field_key)) {
        errors.push(`${prefix}.field_key: duplicate field_key "${field_key}".`);
      } else {
        seenFieldKeys.add(field_key);
      }

      if (!isString(field_label, 1, 255)) {
        errors.push(`${prefix}.field_label: must be a 1–255 char string.`);
      }

      if (typeof data_type !== "string" || !DATA_TYPES.has(data_type)) {
        errors.push(
          `${prefix}.data_type: must be one of ${[...DATA_TYPES].join(", ")}.`
        );
      }

      if (!isOptionalBool(is_required)) {
        errors.push(`${prefix}.is_required: must be boolean.`);
      }
      if (!isOptionalBool(is_sensitive)) {
        errors.push(`${prefix}.is_sensitive: must be boolean.`);
      }

      if (!isOptionalInt(min_length, 0, 10_000)) {
        errors.push(`${prefix}.min_length: must be an integer 0–10000.`);
      }
      if (!isOptionalInt(max_length, 1, 10_000)) {
        errors.push(`${prefix}.max_length: must be an integer 1–10000.`);
      }
      if (
        typeof min_length === "number" &&
        typeof max_length === "number" &&
        min_length > max_length
      ) {
        errors.push(
          `${prefix}: min_length (${min_length}) cannot exceed max_length (${max_length}).`
        );
      }

      if (validation_regex !== undefined) {
        if (!isString(validation_regex, 1, MAX_REGEX_LENGTH)) {
          errors.push(`${prefix}.validation_regex: must be a string up to ${MAX_REGEX_LENGTH} chars.`);
        } else {
          const flags = typeof regex_flags === "string" ? regex_flags : "";
          if (!REGEX_FLAGS_RE.test(flags)) {
            errors.push(`${prefix}.regex_flags: may only contain g, i, m, s, u, y.`);
          } else {
            try {
              // eslint-disable-next-line no-new
              new RegExp(validation_regex, flags);
            } catch (err) {
              errors.push(`${prefix}.validation_regex: invalid — ${(err as Error).message}.`);
            }
          }
        }
      } else if (regex_flags !== undefined && !REGEX_FLAGS_RE.test(String(regex_flags))) {
        errors.push(`${prefix}.regex_flags: may only contain g, i, m, s, u, y.`);
      }

      if (!isOptionalString(error_message, MAX_ERROR_MSG_LENGTH)) {
        errors.push(`${prefix}.error_message: must be a string up to ${MAX_ERROR_MSG_LENGTH} chars.`);
      }

      if (allowed_values !== undefined) {
        if (!Array.isArray(allowed_values)) {
          errors.push(`${prefix}.allowed_values: must be an array when present.`);
        } else if (allowed_values.length > MAX_ALLOWED_VALUES) {
          errors.push(`${prefix}.allowed_values: at most ${MAX_ALLOWED_VALUES} entries allowed.`);
        } else {
          const seen = new Set<string>();
          const dups = new Set<string>();
          allowed_values.forEach((v, i) => {
            if (!isString(v, 1, 255)) {
              errors.push(`${prefix}.allowed_values[${i}]: must be a 1–255 char string.`);
            } else if (seen.has(v)) {
              dups.add(v);
            } else {
              seen.add(v);
            }
          });
          if (dups.size > 0) {
            errors.push(`${prefix}.allowed_values: duplicate values — ${[...dups].join(", ")}.`);
          }
        }
      }

      if (constraints !== undefined && !isObject(constraints)) {
        errors.push(`${prefix}.constraints: must be an object when present.`);
      }

      if (!isOptionalInt(display_order, 0, 10_000)) {
        errors.push(`${prefix}.display_order: must be an integer 0–10000.`);
      }
    });
  }

  // ── consent_purposes array (optional) ───────────────────────────────────
  if (consent_purposes !== undefined) {
    if (!Array.isArray(consent_purposes)) {
      errors.push("consent_purposes: must be an array when present.");
    } else if (consent_purposes.length > MAX_CONSENT_PURPOSES) {
      errors.push(`consent_purposes: at most ${MAX_CONSENT_PURPOSES} entries allowed.`);
    } else {
      const seenPurposeCodes = new Set<string>();
      consent_purposes.forEach((purpose, idx) => {
        const prefix = `consent_purposes[${idx}]`;

        if (!isObject(purpose)) {
          errors.push(`${prefix}: must be an object.`);
          return;
        }

        const {
          purpose_code, purpose_label, description: pDesc,
          lawful_basis, requires_explicit_consent, retention_days,
        } = purpose;

        if (!isString(purpose_code, 1, 128)) {
          errors.push(`${prefix}.purpose_code: must be a 1–128 char string.`);
        } else if (!FIELD_KEY_RE.test(purpose_code)) {
          errors.push(`${prefix}.purpose_code: must be snake_case.`);
        } else if (seenPurposeCodes.has(purpose_code)) {
          errors.push(`${prefix}.purpose_code: duplicate purpose_code "${purpose_code}".`);
        } else {
          seenPurposeCodes.add(purpose_code);
        }

        if (!isString(purpose_label, 1, 255)) {
          errors.push(`${prefix}.purpose_label: must be a 1–255 char string.`);
        }

        if (!isOptionalString(pDesc, 2048)) {
          errors.push(`${prefix}.description: must be a string up to 2048 chars when present.`);
        }

        if (!isOptionalString(lawful_basis, 128)) {
          errors.push(`${prefix}.lawful_basis: must be a string up to 128 chars when present.`);
        }

        if (!isOptionalBool(requires_explicit_consent)) {
          errors.push(`${prefix}.requires_explicit_consent: must be boolean when present.`);
        }

        if (!isOptionalInt(retention_days, 0, 36_500)) {
          errors.push(`${prefix}.retention_days: must be an integer 0–36500 when present.`);
        }
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // ── Coerce to typed payload with defaults ──────────────────────────────
  const data: FrameworkOnboardingPayload = {
    framework_code:  framework_code as string,
    framework_name:  framework_name as string,
    region_code:     region_code    as string,
    region_name:     region_name    as string,
    regulator_name:  regulator_name as string | undefined,
    version:         version        as string,
    description:     description    as string | undefined,
    source_url:      source_url     as string | undefined,
    effective_date:  effective_date as string | undefined,
    is_active:       is_active === undefined ? true : (is_active as boolean),
    metadata:        (metadata as Record<string, unknown> | undefined) ?? {},
    field_rules:     (field_rules as FieldRuleInput[]).map((r) => ({
      field_key:        r.field_key,
      field_label:      r.field_label,
      data_type:        r.data_type,
      is_required:      r.is_required  ?? false,
      is_sensitive:     r.is_sensitive ?? false,
      min_length:       r.min_length,
      max_length:       r.max_length,
      validation_regex: r.validation_regex,
      regex_flags:      r.regex_flags ?? "",
      error_message:    r.error_message,
      allowed_values:   r.allowed_values,
      constraints:      r.constraints ?? {},
      display_order:    r.display_order ?? 0,
    })),
    consent_purposes: ((consent_purposes as ConsentPurposeInput[] | undefined) ?? []).map((p) => ({
      purpose_code:              p.purpose_code,
      purpose_label:             p.purpose_label,
      description:               p.description,
      lawful_basis:              p.lawful_basis,
      requires_explicit_consent: p.requires_explicit_consent ?? false,
      retention_days:            p.retention_days,
    })),
  };

  return { valid: true, data };
}

// ─── Router Factory ───────────────────────────────────────────────────────────

/**
 * Builds the regulatory-ingestion router.
 *
 * Mounted in src/app.ts as:
 *   apiV1.use("/regulatory", createRegulatoryIngestRouter(db));
 *
 * Every route is internally gated by requireGlobalSuperAdmin(). The
 * `injectPlaneContext()` middleware mounted globally in app.ts ensures
 * `req.dualPlanePrincipal` is populated before this router runs.
 */
export function createRegulatoryIngestRouter(db: DB): Router {
  const router = Router();

  // Apply the guard once at the router level so every sub-route inherits it.
  router.use(requireGlobalSuperAdmin());

  // ── Prepared statements (cached on the router for hot-path performance) ──
  const stmts = {
    findByCode: db.prepare(`
      SELECT * FROM regulatory_frameworks WHERE framework_code = ?
    `),
    insertFramework: db.prepare(`
      INSERT INTO regulatory_frameworks (
        framework_code, framework_name, region_code, region_name,
        regulator_name, version, description, source_url, effective_date,
        is_active, metadata, created_by_user_id, created_at, updated_at
      ) VALUES (
        @framework_code, @framework_name, @region_code, @region_name,
        @regulator_name, @version, @description, @source_url, @effective_date,
        @is_active, @metadata, @created_by_user_id, @created_at, @updated_at
      )
    `),
    insertFieldRule: db.prepare(`
      INSERT INTO regulatory_field_rules (
        framework_id, field_key, field_label, data_type,
        is_required, is_sensitive, min_length, max_length,
        validation_regex, regex_flags, error_message,
        allowed_values, constraints, display_order,
        created_at, updated_at
      ) VALUES (
        @framework_id, @field_key, @field_label, @data_type,
        @is_required, @is_sensitive, @min_length, @max_length,
        @validation_regex, @regex_flags, @error_message,
        @allowed_values, @constraints, @display_order,
        @created_at, @updated_at
      )
    `),
    insertConsentPurpose: db.prepare(`
      INSERT INTO regulatory_consent_purposes (
        framework_id, purpose_code, purpose_label, description,
        lawful_basis, requires_explicit_consent, retention_days,
        created_at, updated_at
      ) VALUES (
        @framework_id, @purpose_code, @purpose_label, @description,
        @lawful_basis, @requires_explicit_consent, @retention_days,
        @created_at, @updated_at
      )
    `),
    listFrameworks: db.prepare(`
      SELECT * FROM regulatory_frameworks
      ORDER BY created_at DESC
    `),
    listFrameworksByRegion: db.prepare(`
      SELECT * FROM regulatory_frameworks
      WHERE region_code = ?
      ORDER BY created_at DESC
    `),
    listFrameworksByActive: db.prepare(`
      SELECT * FROM regulatory_frameworks
      WHERE is_active = ?
      ORDER BY created_at DESC
    `),
    listFrameworksByRegionAndActive: db.prepare(`
      SELECT * FROM regulatory_frameworks
      WHERE region_code = ? AND is_active = ?
      ORDER BY created_at DESC
    `),
    getFieldRules: db.prepare(`
      SELECT * FROM regulatory_field_rules
      WHERE framework_id = ?
      ORDER BY display_order ASC, field_key ASC
    `),
    getConsentPurposes: db.prepare(`
      SELECT * FROM regulatory_consent_purposes
      WHERE framework_id = ?
      ORDER BY purpose_code ASC
    `),
    updateFrameworkActive: db.prepare(`
      UPDATE regulatory_frameworks
      SET is_active = ?, updated_at = ?
      WHERE framework_code = ?
    `),
    updateFrameworkMetadata: db.prepare(`
      UPDATE regulatory_frameworks
      SET metadata = ?, updated_at = ?
      WHERE framework_code = ?
    `),
    updateFrameworkActiveAndMetadata: db.prepare(`
      UPDATE regulatory_frameworks
      SET is_active = ?, metadata = ?, updated_at = ?
      WHERE framework_code = ?
    `),
  };

  // Transactional insert: framework + its field rules + its consent purposes.
  // better-sqlite3 transactions are synchronous — perfect for this workload.
  const insertFrameworkTx = db.transaction((args: {
    framework: Parameters<typeof stmts.insertFramework.run>[0];
    fieldRules: FieldRuleInput[];
    consentPurposes: ConsentPurposeInput[];
    now: string;
  }): number => {
    const info = stmts.insertFramework.run(args.framework);
    const frameworkId = Number(info.lastInsertRowid);

    for (const rule of args.fieldRules) {
      stmts.insertFieldRule.run({
        framework_id:     frameworkId,
        field_key:        rule.field_key,
        field_label:      rule.field_label,
        data_type:        rule.data_type,
        is_required:      rule.is_required  ? 1 : 0,
        is_sensitive:     rule.is_sensitive ? 1 : 0,
        min_length:       rule.min_length  ?? null,
        max_length:       rule.max_length  ?? null,
        validation_regex: rule.validation_regex ?? null,
        regex_flags:      rule.regex_flags ?? "",
        error_message:    rule.error_message   ?? null,
        allowed_values:   rule.allowed_values ? JSON.stringify(rule.allowed_values) : null,
        constraints:      JSON.stringify(rule.constraints ?? {}),
        display_order:    rule.display_order ?? 0,
        created_at:       args.now,
        updated_at:       args.now,
      });
    }

    for (const purpose of args.consentPurposes) {
      stmts.insertConsentPurpose.run({
        framework_id:              frameworkId,
        purpose_code:              purpose.purpose_code,
        purpose_label:             purpose.purpose_label,
        description:               purpose.description ?? null,
        lawful_basis:              purpose.lawful_basis ?? null,
        requires_explicit_consent: purpose.requires_explicit_consent ? 1 : 0,
        retention_days:            purpose.retention_days ?? null,
        created_at:                args.now,
        updated_at:                args.now,
      });
    }

    return frameworkId;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /onboard — onboard a new regulatory framework
  // ──────────────────────────────────────────────────────────────────────────
  router.post("/onboard", (req: Request, res: Response): void => {
    const validation = validateFrameworkPayload(req.body);

    if (!validation.valid || !validation.data) {
      res.status(400).json({
        error:   "VALIDATION_FAILED",
        message: "The submitted framework payload failed validation.",
        details: validation.errors ?? [],
      });
      return;
    }

    const payload  = validation.data;
    const actorId  = req.dualPlanePrincipal?.user_id ?? null;

    // Uniqueness check (the UNIQUE constraint will also catch races).
    const existing = stmts.findByCode.get(payload.framework_code);
    if (existing) {
      res.status(409).json({
        error:   "FRAMEWORK_EXISTS",
        message: `A framework with code "${payload.framework_code}" is already registered.`,
      });
      return;
    }

    const now = new Date().toISOString();

    let frameworkId: number;
    try {
      frameworkId = insertFrameworkTx({
        framework: {
          framework_code:     payload.framework_code,
          framework_name:     payload.framework_name,
          region_code:        payload.region_code,
          region_name:        payload.region_name,
          regulator_name:     payload.regulator_name ?? null,
          version:            payload.version,
          description:        payload.description    ?? null,
          source_url:         payload.source_url     ?? null,
          effective_date:     payload.effective_date ?? null,
          is_active:          payload.is_active ? 1 : 0,
          metadata:           JSON.stringify(payload.metadata ?? {}),
          created_by_user_id: actorId,
          created_at:         now,
          updated_at:         now,
        },
        fieldRules:      payload.field_rules,
        consentPurposes: payload.consent_purposes ?? [],
        now,
      });
    } catch (err) {
      // Most likely a UNIQUE constraint violation racing the findByCode check above.
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE")) {
        res.status(409).json({
          error:   "FRAMEWORK_EXISTS",
          message: `A framework with code "${payload.framework_code}" was concurrently created.`,
        });
        return;
      }
      console.error("[regulatoryIngest] onboard failed:", err);
      res.status(500).json({
        error:   "ONBOARD_FAILED",
        message: msg,
      });
      return;
    }

    console.info(
      `[regulatoryIngest] Framework onboarded: ${payload.framework_code} ` +
      `(id=${frameworkId}, actor=${actorId ?? "unknown"}, ` +
      `rules=${payload.field_rules.length}, purposes=${(payload.consent_purposes ?? []).length})`
    );

    // Slice 6b: audit the framework onboarding. Regulatory frameworks are
    // global (not tenant-scoped), so we use tenant_id='_global' as the
    // canonical marker for "this audit row applies to a system-wide action."
    // NOTE: residual atomicity gap — insertFrameworkTx and this audit are
    // not in the same transaction. If the audit insert fails after the
    // framework row commits, we'd have an unaudited framework. Acceptable
    // for now (framework onboarding is rare; failure window microseconds);
    // flagged for a follow-up that pushes the audit call inside
    // insertFrameworkTx as a callback.
    commercialAuditLog(
      db, "_global", actorId, "regulatory_framework", String(frameworkId),
      "onboard", null, payload.framework_code,
      {
        framework_name: payload.framework_name,
        region_code:    payload.region_code,
        version:        payload.version,
        rules:          payload.field_rules.length,
        purposes:       (payload.consent_purposes ?? []).length,
      }
    );

    res.status(201).json({
      framework_id:          frameworkId,
      framework_code:        payload.framework_code,
      region_code:           payload.region_code,
      version:               payload.version,
      field_rule_count:      payload.field_rules.length,
      consent_purpose_count: (payload.consent_purposes ?? []).length,
      message:               `Framework "${payload.framework_name}" onboarded successfully.`,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /frameworks — list frameworks with optional filters
  //   ?region_code=GH
  //   ?is_active=true|false
  // ──────────────────────────────────────────────────────────────────────────
  router.get("/frameworks", (req: Request, res: Response): void => {
    const regionFilter   = req.query.region_code  as string | undefined;
    const activeFilterQ  = req.query.is_active    as string | undefined;

    let rows: unknown[];

    const regionOk = regionFilter !== undefined && REGION_CODE_RE.test(regionFilter);
    const activeProvided = activeFilterQ !== undefined;
    const activeValue = activeFilterQ === "true" ? 1 : activeFilterQ === "false" ? 0 : null;

    if (activeProvided && activeValue === null) {
      res.status(400).json({
        error:   "INVALID_FILTER",
        message: "is_active must be 'true' or 'false'.",
      });
      return;
    }

    if (regionOk && activeProvided) {
      rows = stmts.listFrameworksByRegionAndActive.all(regionFilter, activeValue);
    } else if (regionOk) {
      rows = stmts.listFrameworksByRegion.all(regionFilter);
    } else if (activeProvided) {
      rows = stmts.listFrameworksByActive.all(activeValue);
    } else {
      rows = stmts.listFrameworks.all();
    }

    res.json({ count: rows.length, data: rows });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /frameworks/:code — fetch one framework with rules + purposes
  // ──────────────────────────────────────────────────────────────────────────
  router.get("/frameworks/:code", (req: Request, res: Response): void => {
    const code = String(req.params.code);
    if (!FRAMEWORK_CODE_RE.test(code)) {
      res.status(400).json({
        error:   "INVALID_CODE",
        message: "framework code must be UPPER_SNAKE_CASE.",
      });
      return;
    }

    const framework = stmts.findByCode.get(code) as
      | { id: number; metadata: string; [k: string]: unknown }
      | undefined;

    if (!framework) {
      res.status(404).json({
        error:   "FRAMEWORK_NOT_FOUND",
        message: `No framework found with code "${code}".`,
      });
      return;
    }

    const fieldRulesRaw = stmts.getFieldRules.all(framework.id) as Array<{
      allowed_values: string | null;
      constraints:    string;
      [k: string]:    unknown;
    }>;
    const consentPurposes = stmts.getConsentPurposes.all(framework.id);

    // Parse JSON columns on the way out.
    const fieldRules = fieldRulesRaw.map((r) => ({
      ...r,
      allowed_values: r.allowed_values ? safeJsonParse(r.allowed_values, []) : null,
      constraints:    safeJsonParse(r.constraints, {}),
    }));

    res.json({
      ...framework,
      metadata:         safeJsonParse(framework.metadata, {}),
      field_rules:      fieldRules,
      consent_purposes: consentPurposes,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /frameworks/:code — toggle is_active / merge metadata
  // Body: { is_active?: boolean, metadata?: object }
  // ──────────────────────────────────────────────────────────────────────────
  router.patch("/frameworks/:code", (req: Request, res: Response): void => {
    const code = String(req.params.code);
    if (!FRAMEWORK_CODE_RE.test(code)) {
      res.status(400).json({
        error:   "INVALID_CODE",
        message: "framework code must be UPPER_SNAKE_CASE.",
      });
      return;
    }

    if (!isObject(req.body)) {
      res.status(400).json({
        error:   "INVALID_BODY",
        message: "Request body must be a JSON object.",
      });
      return;
    }

    const { is_active, metadata } = req.body as {
      is_active?: unknown;
      metadata?:  unknown;
    };

    const errs: string[] = [];
    if (is_active !== undefined && typeof is_active !== "boolean") {
      errs.push("is_active: must be boolean when present.");
    }
    if (metadata !== undefined && !isObject(metadata)) {
      errs.push("metadata: must be an object when present.");
    }
    if (is_active === undefined && metadata === undefined) {
      errs.push("Provide at least one of: is_active, metadata.");
    }
    if (errs.length > 0) {
      res.status(400).json({ error: "VALIDATION_FAILED", details: errs });
      return;
    }

    const existing = stmts.findByCode.get(code) as
      { id: number; is_active: number; metadata: string; [k: string]: unknown } | undefined;
    if (!existing) {
      res.status(404).json({ error: "FRAMEWORK_NOT_FOUND" });
      return;
    }

    const now = new Date().toISOString();
    let info: { changes: number };

    if (is_active !== undefined && metadata !== undefined) {
      info = stmts.updateFrameworkActiveAndMetadata.run(
        (is_active as boolean) ? 1 : 0,
        JSON.stringify(metadata),
        now,
        code,
      ) as { changes: number };
    } else if (is_active !== undefined) {
      info = stmts.updateFrameworkActive.run(
        (is_active as boolean) ? 1 : 0,
        now,
        code,
      ) as { changes: number };
    } else {
      info = stmts.updateFrameworkMetadata.run(
        JSON.stringify(metadata),
        now,
        code,
      ) as { changes: number };
    }

    const updated = stmts.findByCode.get(code) as { metadata: string; [k: string]: unknown };

    // Slice 6b: audit framework toggle/update. is_active is the security-critical
    // field — flipping it to false silently disables downstream compliance checks
    // for that framework. The audit row is the only forensic trail of "who turned
    // it off and when". Records both is_active and metadata transitions when
    // either changed; null values indicate no change for that field.
    const actorId = req.dualPlanePrincipal?.user_id ?? null;
    commercialAuditLog(
      db, "_global", actorId, "regulatory_framework", String(existing.id),
      "update",
      JSON.stringify({
        is_active: is_active !== undefined ? Boolean(existing.is_active) : null,
        metadata:  metadata  !== undefined ? safeJsonParse(existing.metadata, {}) : null,
      }),
      JSON.stringify({
        is_active: is_active !== undefined ? is_active : null,
        metadata:  metadata  !== undefined ? metadata  : null,
      }),
      { framework_code: code, db_changes: info.changes }
    );

    console.info(
      `[regulatoryIngest] Framework updated: ${code} ` +
      `(actor=${req.dualPlanePrincipal?.user_id ?? "unknown"}, changes=${info.changes})`
    );

    res.json({
      ...updated,
      metadata: safeJsonParse(updated.metadata, {}),
    });
  });

  return router;
}

// ─── Small helpers (kept private to this file) ────────────────────────────────

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// Suppress unused-warning on ISO8601_RE — reserved for future timestamp fields.
void ISO8601_RE;
