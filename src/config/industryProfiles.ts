/**
 * src/config/industryProfiles.ts
 * Pluggable compliance data-validation objects.
 * Profiles: Healthcare (HIPAA), Logistics (ISO 28000), Retail (PCI-DSS 4.0),
 *           Government.
 * Each profile exposes:
 *  - metadata         : identifier, version, display name, regulatory body.
 *  - requiredFields   : field-level validation rules for transaction/report payloads.
 *  - validators       : pure functions that return ValidationError[] for a payload.
 *  - reportRequirements: structured requirements for SHA-256 signed compliance reports.
 *  - retentionPolicy  : data-retention constraints in days.
 *  - auditRules       : conditions that must trigger an audit log entry.
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

// ─── Shared Types ─────────────────────────────────────────────────────────────

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "iso8601"
  | "uuid"
  | "email"
  | "phone_e164"
  | "currency_code"
  | "ipv4"
  | "ipv6"
  | "enum";

export interface FieldRule {
  name: string;
  type: FieldType;
  required: boolean;
  /** Enum members (when type === "enum"). */
  allowedValues?: readonly string[];
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Custom regex pattern the string value must match. */
  pattern?: RegExp;
  /** Human-readable description used in compliance reports. */
  description: string;
}

export interface ValidationError {
  field: string;
  rule: string;
  message: string;
}

export interface ReportRequirement {
  section: string;
  mandatory_fields: string[];
  frequency: "real-time" | "daily" | "weekly" | "monthly" | "annually";
  signed: boolean;
  description: string;
}

export interface AuditRule {
  id: string;
  description: string;
  /**
   * Predicate run against the payload.
   * Returns true when this rule determines an audit log entry is required.
   */
  trigger: (payload: Record<string, unknown>) => boolean;
}

export interface RetentionPolicy {
  /** Minimum retention period in days (regulatory floor). */
  min_days: number;
  /** Maximum retention period in days (regulatory ceiling, 0 = no ceiling). */
  max_days: number;
  /** Whether data must be encrypted at rest during retention. */
  encrypted_at_rest: boolean;
  /** Whether audit logs must be tamper-evident (e.g. HMAC-signed rows). */
  tamper_evident_audit_log: boolean;
  description: string;
}

export interface IndustryProfile {
  metadata: {
    id: string;
    display_name: string;
    version: string;
    regulatory_body: string;
    effective_date: string;
    description: string;
  };
  requiredFields: FieldRule[];
  retentionPolicy: RetentionPolicy;
  reportRequirements: ReportRequirement[];
  auditRules: AuditRule[];
  /**
   * Validates an arbitrary payload against this profile's field rules.
   * Returns a flat list of validation errors (empty = valid).
   */
  validate(payload: Record<string, unknown>): ValidationError[];
}

// ─── Shared Validation Utilities ─────────────────────────────────────────────

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_E164_RE = /^\+[1-9]\d{1,14}$/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const IPV4_RE =
  /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const IPV6_RE = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

function validateField(
  rule: FieldRule,
  value: unknown
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldLabel = rule.name;

  if (value === undefined || value === null || value === "") {
    if (rule.required) {
      errors.push({
        field: fieldLabel,
        rule: "required",
        message: `${fieldLabel} is required`,
      });
    }
    return errors;
  }

  switch (rule.type) {
    case "string": {
      if (typeof value !== "string") {
        errors.push({ field: fieldLabel, rule: "type", message: `${fieldLabel} must be a string` });
        break;
      }
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        errors.push({ field: fieldLabel, rule: "minLength", message: `${fieldLabel} must be at least ${rule.minLength} characters` });
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        errors.push({ field: fieldLabel, rule: "maxLength", message: `${fieldLabel} must be at most ${rule.maxLength} characters` });
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push({ field: fieldLabel, rule: "pattern", message: `${fieldLabel} does not match required format` });
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || isNaN(value)) {
        errors.push({ field: fieldLabel, rule: "type", message: `${fieldLabel} must be a number` });
        break;
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push({ field: fieldLabel, rule: "min", message: `${fieldLabel} must be ≥ ${rule.min}` });
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push({ field: fieldLabel, rule: "max", message: `${fieldLabel} must be ≤ ${rule.max}` });
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push({ field: fieldLabel, rule: "type", message: `${fieldLabel} must be a boolean` });
      }
      break;
    }
    case "iso8601": {
      if (typeof value !== "string" || !ISO8601_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "iso8601", message: `${fieldLabel} must be an ISO 8601 UTC datetime (e.g. 2024-01-15T09:00:00Z)` });
      }
      break;
    }
    case "uuid": {
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "uuid", message: `${fieldLabel} must be a valid UUID` });
      }
      break;
    }
    case "email": {
      if (typeof value !== "string" || !EMAIL_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "email", message: `${fieldLabel} must be a valid email address` });
      }
      break;
    }
    case "phone_e164": {
      if (typeof value !== "string" || !PHONE_E164_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "phone_e164", message: `${fieldLabel} must be a valid E.164 phone number (e.g. +233201234567)` });
      }
      break;
    }
    case "currency_code": {
      if (typeof value !== "string" || !CURRENCY_CODE_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "currency_code", message: `${fieldLabel} must be an ISO 4217 currency code (e.g. GHS)` });
      }
      break;
    }
    case "ipv4": {
      if (typeof value !== "string" || !IPV4_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "ipv4", message: `${fieldLabel} must be a valid IPv4 address` });
      }
      break;
    }
    case "ipv6": {
      if (typeof value !== "string" || !IPV6_RE.test(value)) {
        errors.push({ field: fieldLabel, rule: "ipv6", message: `${fieldLabel} must be a valid IPv6 address` });
      }
      break;
    }
    case "enum": {
      if (!rule.allowedValues || !rule.allowedValues.includes(String(value))) {
        errors.push({
          field: fieldLabel,
          rule: "enum",
          message: `${fieldLabel} must be one of: ${rule.allowedValues?.join(", ")}`,
        });
      }
      break;
    }
  }

  return errors;
}

function buildValidator(
  fields: FieldRule[]
): (payload: Record<string, unknown>) => ValidationError[] {
  return (payload) => {
    const errors: ValidationError[] = [];
    for (const rule of fields) {
      errors.push(...validateField(rule, payload[rule.name]));
    }
    return errors;
  };
}

// ─── Profile: Healthcare — HIPAA ─────────────────────────────────────────────

const hipaaFields: FieldRule[] = [
  { name: "transaction_id", type: "uuid", required: true, description: "Unique transaction identifier (used as PHI audit trail anchor)" },
  { name: "covered_entity_id", type: "string", required: true, minLength: 2, maxLength: 80, description: "HIPAA covered entity NPI or identifier" },
  { name: "patient_encounter_ref", type: "string", required: false, maxLength: 100, description: "De-identified encounter reference (no direct PHI)" },
  { name: "transaction_type", type: "enum", required: true, allowedValues: ["837P", "837I", "835", "270", "271", "276", "277", "278", "820", "834"] as const, description: "HIPAA X12 transaction set identifier" },
  { name: "amount_usd", type: "number", required: true, min: 0, max: 10_000_000, description: "Claim or payment amount in USD" },
  { name: "service_date", type: "iso8601", required: true, description: "Date of service in ISO 8601 UTC" },
  { name: "submitted_at", type: "iso8601", required: true, description: "Submission timestamp in ISO 8601 UTC" },
  { name: "payer_id", type: "string", required: true, minLength: 2, maxLength: 40, description: "Payer identifier (insurer NPI / CMS payer ID)" },
  { name: "place_of_service_code", type: "string", required: true, pattern: /^\d{2}$/, description: "CMS Place of Service code (two-digit)" },
  { name: "de_identified", type: "boolean", required: true, description: "Whether all PHI has been de-identified per 45 CFR §164.514" },
  { name: "authorization_code", type: "string", required: false, maxLength: 50, description: "Prior-authorization code when applicable" },
];

export const hipaaProfile: IndustryProfile = {
  metadata: {
    id: "healthcare-hipaa",
    display_name: "Healthcare — HIPAA",
    version: "2024-01",
    regulatory_body: "U.S. Department of Health & Human Services (HHS)",
    effective_date: "1996-08-21",
    description:
      "Health Insurance Portability and Accountability Act compliance profile covering Privacy Rule, Security Rule, and Transaction & Code Set standards for electronic healthcare transactions.",
  },
  requiredFields: hipaaFields,
  retentionPolicy: {
    min_days: 6 * 365,   // 6 years (45 CFR §164.530(j))
    max_days: 0,          // No regulatory ceiling
    encrypted_at_rest: true,
    tamper_evident_audit_log: true,
    description: "HIPAA requires covered entities to retain policies and documentation for 6 years from creation or last effective date. PHI must be encrypted at rest (AES-256 minimum) and audit logs must be tamper-evident.",
  },
  reportRequirements: [
    {
      section: "Privacy Rule Compliance",
      mandatory_fields: ["transaction_id", "covered_entity_id", "de_identified", "submitted_at"],
      frequency: "annually",
      signed: true,
      description: "Annual attestation that PHI access controls, minimum-necessary policies, and patient rights procedures are in place (45 CFR §164.520–164.530).",
    },
    {
      section: "Breach Notification",
      mandatory_fields: ["transaction_id", "covered_entity_id", "service_date", "submitted_at"],
      frequency: "real-time",
      signed: true,
      description: "Breach notification must be filed within 60 days of discovery (45 CFR §164.410). Real-time flagging enables timely HHS reporting.",
    },
    {
      section: "Security Rule — Access Log",
      mandatory_fields: ["transaction_id", "covered_entity_id", "submitted_at", "payer_id"],
      frequency: "daily",
      signed: true,
      description: "Daily signed access log export per Security Rule audit controls requirement (45 CFR §164.312(b)).",
    },
  ],
  auditRules: [
    {
      id: "hipaa-phi-access",
      description: "Log every access to a record where de_identified = false.",
      trigger: (p) => p["de_identified"] === false,
    },
    {
      id: "hipaa-large-claim",
      description: "Audit any claim exceeding USD 100,000.",
      trigger: (p) => typeof p["amount_usd"] === "number" && (p["amount_usd"] as number) > 100_000,
    },
    {
      id: "hipaa-auth-required-type",
      description: "Audit all 278 (authorization) transactions.",
      trigger: (p) => p["transaction_type"] === "278",
    },
  ],
  validate: buildValidator(hipaaFields),
};

// ─── Profile: Logistics — ISO 28000 ──────────────────────────────────────────

const iso28000Fields: FieldRule[] = [
  { name: "shipment_id", type: "uuid", required: true, description: "Globally unique shipment identifier" },
  { name: "tenant_id", type: "uuid", required: true, description: "Originating tenant identifier" },
  { name: "origin_country_code", type: "string", required: true, pattern: /^[A-Z]{2}$/, description: "ISO 3166-1 alpha-2 origin country code" },
  { name: "destination_country_code", type: "string", required: true, pattern: /^[A-Z]{2}$/, description: "ISO 3166-1 alpha-2 destination country code" },
  { name: "incoterm", type: "enum", required: true, allowedValues: ["EXW","FCA","CPT","CIP","DAP","DPU","DDP","FAS","FOB","CFR","CIF"] as const, description: "ICC Incoterms 2020 code" },
  { name: "declared_value_usd", type: "number", required: true, min: 0, description: "Declared customs value in USD" },
  { name: "hs_code", type: "string", required: true, pattern: /^\d{6,10}$/, description: "Harmonized System tariff code (6–10 digits)" },
  { name: "gross_weight_kg", type: "number", required: true, min: 0, description: "Gross weight in kilograms" },
  { name: "carrier_id", type: "string", required: true, minLength: 2, maxLength: 60, description: "Regulated carrier SCAC or IATA code" },
  { name: "departure_at", type: "iso8601", required: true, description: "Scheduled departure datetime (UTC)" },
  { name: "arrival_at", type: "iso8601", required: false, description: "Actual or estimated arrival datetime (UTC)" },
  { name: "hazmat", type: "boolean", required: true, description: "Whether the shipment contains hazardous materials" },
  { name: "hazmat_un_number", type: "string", required: false, pattern: /^UN\d{4}$/, description: "UN hazmat number (required when hazmat = true)" },
  { name: "customs_cleared", type: "boolean", required: true, description: "Customs clearance status" },
  { name: "security_seal_id", type: "string", required: false, maxLength: 80, description: "Physical or electronic security seal identifier" },
];

export const iso28000Profile: IndustryProfile = {
  metadata: {
    id: "logistics-iso28000",
    display_name: "Logistics — ISO 28000",
    version: "2022",
    regulatory_body: "International Organization for Standardization (ISO)",
    effective_date: "2022-10-01",
    description:
      "ISO 28000:2022 Supply Chain Security Management Systems compliance profile covering threat assessment, security planning, and continuous improvement requirements for logistics operators.",
  },
  requiredFields: iso28000Fields,
  retentionPolicy: {
    min_days: 5 * 365,  // 5 years (ISO 28000 §9.1 evidence retention)
    max_days: 0,
    encrypted_at_rest: true,
    tamper_evident_audit_log: true,
    description: "ISO 28000 requires documented evidence of security management activities to be retained for a minimum of 5 years. Electronic records must be protected against unauthorised modification.",
  },
  reportRequirements: [
    {
      section: "Security Risk Assessment",
      mandatory_fields: ["shipment_id", "origin_country_code", "destination_country_code", "carrier_id", "departure_at"],
      frequency: "monthly",
      signed: true,
      description: "Monthly signed security risk assessment covering active trade lanes (ISO 28000 §6.1.2).",
    },
    {
      section: "Hazardous Materials Manifest",
      mandatory_fields: ["shipment_id", "hazmat", "hazmat_un_number", "carrier_id", "departure_at"],
      frequency: "real-time",
      signed: true,
      description: "Real-time signed manifest for every hazmat shipment; filed with carrier before departure.",
    },
    {
      section: "Customs & Compliance Audit",
      mandatory_fields: ["shipment_id", "hs_code", "declared_value_usd", "customs_cleared", "destination_country_code"],
      frequency: "weekly",
      signed: true,
      description: "Weekly aggregated customs compliance report covering declared values and clearance status.",
    },
  ],
  auditRules: [
    {
      id: "iso28000-hazmat",
      description: "Audit all shipments flagged as hazardous materials.",
      trigger: (p) => p["hazmat"] === true,
    },
    {
      id: "iso28000-high-value",
      description: "Audit shipments with declared value exceeding USD 500,000.",
      trigger: (p) => typeof p["declared_value_usd"] === "number" && (p["declared_value_usd"] as number) > 500_000,
    },
    {
      id: "iso28000-customs-hold",
      description: "Audit arrived shipments that have not cleared customs.",
      trigger: (p) =>
        p["customs_cleared"] === false && p["arrival_at"] !== undefined && p["arrival_at"] !== null,
    },
    {
      id: "iso28000-missing-seal",
      description: "Audit high-value shipments without a security seal.",
      trigger: (p) =>
        typeof p["declared_value_usd"] === "number" &&
        (p["declared_value_usd"] as number) > 50_000 &&
        (!p["security_seal_id"] || p["security_seal_id"] === ""),
    },
  ],
  validate(payload) {
    const errors = buildValidator(iso28000Fields)(payload);
    // Cross-field: hazmat_un_number required when hazmat = true.
    if (payload["hazmat"] === true && !payload["hazmat_un_number"]) {
      errors.push({
        field: "hazmat_un_number",
        rule: "cross_field",
        message: "hazmat_un_number is required when hazmat is true",
      });
    }
    // Cross-field: arrival must be after departure when both provided.
    if (payload["departure_at"] && payload["arrival_at"]) {
      const dep = new Date(payload["departure_at"] as string).getTime();
      const arr = new Date(payload["arrival_at"] as string).getTime();
      if (!isNaN(dep) && !isNaN(arr) && arr < dep) {
        errors.push({
          field: "arrival_at",
          rule: "cross_field",
          message: "arrival_at must not be before departure_at",
        });
      }
    }
    return errors;
  },
};

// ─── Profile: Retail — PCI-DSS 4.0 ───────────────────────────────────────────

const pciDss4Fields: FieldRule[] = [
  { name: "transaction_id", type: "uuid", required: true, description: "Unique payment transaction identifier" },
  { name: "merchant_id", type: "string", required: true, minLength: 5, maxLength: 30, description: "Card network merchant identifier" },
  { name: "terminal_id", type: "string", required: false, maxLength: 20, description: "POS terminal or gateway identifier" },
  { name: "card_brand", type: "enum", required: true, allowedValues: ["Visa", "Mastercard", "Amex", "Discover", "UnionPay", "JCB"] as const, description: "Payment card brand" },
  { name: "card_last_four", type: "string", required: true, pattern: /^\d{4}$/, description: "Last four digits of the PAN (full PAN must never be stored)" },
  { name: "amount", type: "number", required: true, min: 0, description: "Transaction amount in the smallest currency unit (e.g. pesewas)" },
  { name: "currency_code", type: "currency_code", required: true, description: "ISO 4217 currency code" },
  { name: "transaction_type", type: "enum", required: true, allowedValues: ["purchase", "refund", "authorisation", "void", "capture"] as const, description: "Card transaction type" },
  { name: "authorisation_code", type: "string", required: false, maxLength: 10, description: "Issuer authorisation code" },
  { name: "response_code", type: "string", required: true, pattern: /^\d{2}$/, description: "ISO 8583 response code" },
  { name: "cvv_verified", type: "boolean", required: true, description: "Whether CVV2/CVC2 was verified (value must not be stored post-auth)" },
  { name: "three_ds_status", type: "enum", required: false, allowedValues: ["Y", "N", "A", "U", "R", "C"] as const, description: "3D Secure authentication status" },
  { name: "initiated_at", type: "iso8601", required: true, description: "Transaction initiation timestamp (UTC)" },
  { name: "ip_address", type: "ipv4", required: false, description: "Cardholder IP address for CNP transactions" },
  { name: "is_card_not_present", type: "boolean", required: true, description: "Whether this is a Card-Not-Present transaction" },
  { name: "tokenized", type: "boolean", required: true, description: "Whether the PAN is represented by a network or gateway token" },
];

export const pciDss4Profile: IndustryProfile = {
  metadata: {
    id: "retail-pci-dss-4",
    display_name: "Retail — PCI-DSS 4.0",
    version: "4.0",
    regulatory_body: "Payment Card Industry Security Standards Council (PCI SSC)",
    effective_date: "2022-03-31",
    description:
      "PCI Data Security Standard v4.0 compliance profile for merchants and service providers that store, process, or transmit cardholder data. Includes all 12 PCI-DSS requirements mapped to field validation and audit triggers.",
  },
  requiredFields: pciDss4Fields,
  retentionPolicy: {
    min_days: 365,      // 12 months transaction log (PCI-DSS Req 10.7)
    max_days: 3 * 365, // 36 months maximum recommended for dispute resolution
    encrypted_at_rest: true,
    tamper_evident_audit_log: true,
    description: "PCI-DSS 4.0 Requirement 10.7 mandates audit logs be retained for at least 12 months, with a minimum of 3 months immediately available. Cardholder data environments must use strong cryptography for data at rest.",
  },
  reportRequirements: [
    {
      section: "Self-Assessment Questionnaire (SAQ)",
      mandatory_fields: ["transaction_id", "merchant_id", "card_brand", "card_last_four", "tokenized"],
      frequency: "annually",
      signed: true,
      description: "Annual SAQ submission attesting scope of cardholder data environment and compensating controls (PCI-DSS Req 12.3).",
    },
    {
      section: "Suspicious Activity Monitoring",
      mandatory_fields: ["transaction_id", "merchant_id", "amount", "currency_code", "initiated_at", "response_code"],
      frequency: "daily",
      signed: true,
      description: "Daily signed suspicious-activity report covering declined, reversed, and anomalous transactions (PCI-DSS Req 10.6).",
    },
    {
      section: "CNP Fraud Summary",
      mandatory_fields: ["transaction_id", "merchant_id", "is_card_not_present", "three_ds_status", "ip_address", "initiated_at"],
      frequency: "weekly",
      signed: true,
      description: "Weekly Card-Not-Present fraud pattern report with 3D Secure adoption metrics (PCI-DSS 4.0 Req 6.4).",
    },
  ],
  auditRules: [
    {
      id: "pci-pan-storage-check",
      description: "Audit any record where tokenized = false (full PAN risk).",
      trigger: (p) => p["tokenized"] === false,
    },
    {
      id: "pci-high-value-cnp",
      description: "Audit CNP transactions exceeding 10,000 currency units.",
      trigger: (p) =>
        p["is_card_not_present"] === true &&
        typeof p["amount"] === "number" &&
        (p["amount"] as number) > 10_000,
    },
    {
      id: "pci-failed-3ds",
      description: "Audit CNP transactions where 3DS status is N (failed) or U (unknown).",
      trigger: (p) =>
        p["is_card_not_present"] === true &&
        (p["three_ds_status"] === "N" || p["three_ds_status"] === "U"),
    },
    {
      id: "pci-declined-burst",
      description: "Audit transactions with decline response code (51, 05, 14, etc.).",
      trigger: (p) => {
        const declineCodes = new Set(["05", "14", "41", "43", "51", "54", "57", "62"]);
        return typeof p["response_code"] === "string" && declineCodes.has(p["response_code"] as string);
      },
    },
  ],
  validate(payload) {
    const errors = buildValidator(pciDss4Fields)(payload);
    // PCI-DSS: full PAN must never appear — reject if card_last_four looks like full PAN.
    const lastFour = payload["card_last_four"];
    if (typeof lastFour === "string" && lastFour.length > 4) {
      errors.push({
        field: "card_last_four",
        rule: "pci_pan_exposure",
        message: "card_last_four must contain exactly 4 digits; storing full PAN violates PCI-DSS Req 3.3",
      });
    }
    // PCI-DSS: CVV must not be stored — flag if payload carries cvv field.
    if ("cvv" in payload || "cvc" in payload || "card_verification_value" in payload) {
      errors.push({
        field: "cvv",
        rule: "pci_cvv_storage",
        message: "CVV/CVC must not be stored after authorisation (PCI-DSS Req 3.3.2)",
      });
    }
    // Cross-field: CNP requires IP address.
    if (payload["is_card_not_present"] === true && !payload["ip_address"]) {
      errors.push({
        field: "ip_address",
        rule: "cross_field",
        message: "ip_address is required for Card-Not-Present transactions",
      });
    }
    return errors;
  },
};

// ─── Profile: Government ──────────────────────────────────────────────────────

const governmentFields: FieldRule[] = [
  { name: "transaction_id", type: "uuid", required: true, description: "Unique government payment or disbursement identifier" },
  { name: "ministry_code", type: "string", required: true, pattern: /^[A-Z]{2,10}-\d{3,6}$/, description: "Ministry or department code in format DEPT-XXXXXX" },
  { name: "programme_code", type: "string", required: true, minLength: 3, maxLength: 30, description: "Government programme or vote-head code" },
  { name: "fiscal_year", type: "string", required: true, pattern: /^\d{4}\/\d{4}$/, description: "Fiscal year in format YYYY/YYYY (e.g. 2024/2025)" },
  { name: "economic_classification", type: "enum", required: true, allowedValues: ["compensation", "goods_services", "capex", "transfers", "debt_service"] as const, description: "GFS 2014 economic classification" },
  { name: "amount_g_h_s", type: "number", required: true, min: 0, max: 1_000_000_000, description: "Disbursement amount in GHS" },
  { name: "beneficiary_id", type: "string", required: true, minLength: 3, maxLength: 60, description: "National ID, contractor registration, or agency identifier" },
  { name: "beneficiary_type", type: "enum", required: true, allowedValues: ["individual", "contractor", "ngo", "agency", "inter_government"] as const, description: "Category of payment beneficiary" },
  { name: "payment_channel", type: "enum", required: true, allowedValues: ["momo", "bank_transfer", "cheque", "petty_cash"] as const, description: "Payment disbursement channel" },
  { name: "authorising_officer_id", type: "string", required: true, minLength: 3, maxLength: 60, description: "Staff ID of authorising officer (Commitment Control)" },
  { name: "procurement_method", type: "enum", required: false, allowedValues: ["open_tender", "restricted_tender", "single_source", "quotation", "framework"] as const, description: "PPRA procurement method used (required for capex / goods_services)" },
  { name: "contract_ref", type: "string", required: false, maxLength: 80, description: "Contract or purchase order reference number" },
  { name: "initiated_at", type: "iso8601", required: true, description: "Disbursement initiation timestamp (UTC)" },
  { name: "approved_at", type: "iso8601", required: false, description: "Treasury or CFO approval timestamp (UTC)" },
  { name: "audit_trail_ref", type: "string", required: false, maxLength: 120, description: "External GIFMIS or IPSAS audit trail reference" },
];

export const governmentProfile: IndustryProfile = {
  metadata: {
    id: "government",
    display_name: "Government",
    version: "GFS-2014-v2",
    regulatory_body: "Ministry of Finance / Controller and Accountant-General",
    effective_date: "2014-01-01",
    description:
      "Government Finance Statistics (GFS 2014) and IPSAS-aligned compliance profile for public sector disbursements, procurement, and inter-agency transfers. Enforces commitment control, segregation of duties, and Parliamentary appropriation limits.",
  },
  requiredFields: governmentFields,
  retentionPolicy: {
    min_days: 7 * 365,  // 7 years — standard public accounts statutory period
    max_days: 0,
    encrypted_at_rest: true,
    tamper_evident_audit_log: true,
    description: "Public financial management regulations typically mandate 7-year retention of financial records. All records must be tamper-evident and available for auditor-general inspection on demand.",
  },
  reportRequirements: [
    {
      section: "Monthly Expenditure Statement",
      mandatory_fields: ["transaction_id", "ministry_code", "programme_code", "fiscal_year", "economic_classification", "amount_g_h_s", "initiated_at"],
      frequency: "monthly",
      signed: true,
      description: "Signed monthly financial statement reconciling vote expenditure against approved appropriation (PFMA §41).",
    },
    {
      section: "Procurement & Contract Register",
      mandatory_fields: ["transaction_id", "ministry_code", "procurement_method", "contract_ref", "beneficiary_id", "amount_g_h_s"],
      frequency: "weekly",
      signed: true,
      description: "Weekly signed procurement register for Public Procurement Regulatory Authority (PPRA) submission.",
    },
    {
      section: "Real-time High-Value Disbursement Alert",
      mandatory_fields: ["transaction_id", "ministry_code", "amount_g_h_s", "authorising_officer_id", "initiated_at"],
      frequency: "real-time",
      signed: true,
      description: "Real-time signed alert for disbursements above the commitment control threshold (configurable, default GHS 100,000).",
    },
    {
      section: "Annual Accounts Summary",
      mandatory_fields: ["fiscal_year", "ministry_code", "economic_classification", "amount_g_h_s"],
      frequency: "annually",
      signed: true,
      description: "Annual consolidated accounts for submission to the Auditor-General (IPSAS 1).",
    },
  ],
  auditRules: [
    {
      id: "gov-high-value",
      description: "Audit any disbursement exceeding GHS 100,000.",
      trigger: (p) =>
        typeof p["amount_g_h_s"] === "number" && (p["amount_g_h_s"] as number) > 100_000,
    },
    {
      id: "gov-single-source",
      description: "Audit all single-source procurements.",
      trigger: (p) => p["procurement_method"] === "single_source",
    },
    {
      id: "gov-missing-approval",
      description: "Audit capex and goods_services payments lacking an approved_at timestamp.",
      trigger: (p) =>
        (p["economic_classification"] === "capex" ||
          p["economic_classification"] === "goods_services") &&
        (!p["approved_at"] || p["approved_at"] === ""),
    },
    {
      id: "gov-petty-cash-limit",
      description: "Audit petty-cash disbursements exceeding GHS 500.",
      trigger: (p) =>
        p["payment_channel"] === "petty_cash" &&
        typeof p["amount_g_h_s"] === "number" &&
        (p["amount_g_h_s"] as number) > 500,
    },
    {
      id: "gov-inter-government-transfer",
      description: "Audit all inter-government transfers.",
      trigger: (p) => p["beneficiary_type"] === "inter_government",
    },
  ],
  validate(payload) {
    const errors = buildValidator(governmentFields)(payload);
    // Cross-field: procurement_method required for capex and goods_services.
    if (
      (payload["economic_classification"] === "capex" ||
        payload["economic_classification"] === "goods_services") &&
      !payload["procurement_method"]
    ) {
      errors.push({
        field: "procurement_method",
        rule: "cross_field",
        message: "procurement_method is required for capex and goods_services transactions",
      });
    }
    // Cross-field: contract_ref required when procurement_method is open_tender or restricted_tender.
    if (
      (payload["procurement_method"] === "open_tender" ||
        payload["procurement_method"] === "restricted_tender") &&
      !payload["contract_ref"]
    ) {
      errors.push({
        field: "contract_ref",
        rule: "cross_field",
        message: "contract_ref is required for open_tender and restricted_tender procurement",
      });
    }
    // Fiscal year format cross-check: years must be consecutive.
    if (typeof payload["fiscal_year"] === "string") {
      const parts = (payload["fiscal_year"] as string).split("/");
      if (parts.length === 2) {
        const y1 = parseInt(parts[0], 10);
        const y2 = parseInt(parts[1], 10);
        if (!isNaN(y1) && !isNaN(y2) && y2 !== y1 + 1) {
          errors.push({
            field: "fiscal_year",
            rule: "cross_field",
            message: "fiscal_year years must be consecutive (e.g. 2024/2025)",
          });
        }
      }
    }
    return errors;
  },
};

// ─── Profile Registry ─────────────────────────────────────────────────────────

export type ProfileId =
  | "healthcare-hipaa"
  | "logistics-iso28000"
  | "retail-pci-dss-4"
  | "government";

export const INDUSTRY_PROFILES: Record<ProfileId, IndustryProfile> = {
  "healthcare-hipaa": hipaaProfile,
  "logistics-iso28000": iso28000Profile,
  "retail-pci-dss-4": pciDss4Profile,
  government: governmentProfile,
};

/**
 * Resolves a profile by ID.  Throws if the ID is not registered.
 */
export function getProfile(id: ProfileId): IndustryProfile {
  const profile = INDUSTRY_PROFILES[id];
  if (!profile) {
    throw new Error(
      `Unknown industry profile: "${id}". Valid values: ${Object.keys(INDUSTRY_PROFILES).join(", ")}`
    );
  }
  return profile;
}

/**
 * Validates a payload against a named profile and returns all errors.
 * Callers can use the result to gate transaction processing or report generation.
 */
export function validateAgainstProfile(
  profileId: ProfileId,
  payload: Record<string, unknown>
): ValidationError[] {
  return getProfile(profileId).validate(payload);
}

/**
 * Returns all audit rules from a profile that are triggered by the given payload.
 */
export function getTriggeredAuditRules(
  profileId: ProfileId,
  payload: Record<string, unknown>
): AuditRule[] {
  return getProfile(profileId).auditRules.filter((rule) => rule.trigger(payload));
}

/**
 * Returns the list of all registered profile IDs.
 */
export function listProfileIds(): ProfileId[] {
  return Object.keys(INDUSTRY_PROFILES) as ProfileId[];
}
