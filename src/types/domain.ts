/**
 * domain.ts — Canonical type definitions for the CaaS Lite event pipeline.
 *
 * Every module in the platform imports from here. No circular dependencies;
 * this file has zero local imports.
 */

// ---------------------------------------------------------------------------
// Primitives & enumerations
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string, e.g. "2026-05-14T10:00:00.000Z" */
export type ISOTimestamp = string;

/** Opaque identifier — a UUID v4 string */
export type EventId = string;

/** Top-level category of the originating SaaS event */
export type EventType =
  | 'access.granted'
  | 'access.revoked'
  | 'access.mfa_enrolled'
  | 'access.mfa_disabled'
  | 'deploy.started'
  | 'deploy.completed'
  | 'deploy.failed'
  | 'deploy.rollback'
  | 'secret.rotated'
  | 'secret.accessed'
  | 'secret.exposed'
  | 'audit.log_exported'
  | 'audit.log_tampered'
  | 'policy.updated'
  | 'policy.deleted'
  | 'infra.change_applied'
  | 'infra.drift_detected'
  | 'vuln.scan_completed'
  | 'vuln.critical_found'
  | 'vendor.soc2_report_uploaded'
  | string; // extensible for custom integrations

/** Compliance frameworks supported for control mapping */
export type ComplianceFramework =
  | 'SOC2'
  | 'ISO27001'
  | 'HIPAA'
  | 'PCI-DSS'
  | 'GDPR'
  | 'NIST-CSF';

/** Outcome of a single policy evaluation */
export type VerificationOutcome = 'pass' | 'fail' | 'inconclusive';

/** Severity level for compliance alerts */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

// ---------------------------------------------------------------------------
// DomainEvent — the canonical internal event emitted by the webhook receiver
// ---------------------------------------------------------------------------

export interface DomainEventActor {
  /** Machine-readable identifier (email, service account ID, etc.) */
  id: string;
  /** Human-readable display name */
  name: string;
  /** 'human' | 'service' | 'system' */
  kind: 'human' | 'service' | 'system';
  /** IP address of the originating request, if available */
  ipAddress?: string;
}

export interface DomainEvent {
  /** Globally unique event identifier (UUID v4) */
  id: EventId;
  /** Semantic event type */
  type: EventType;
  /** ISO-8601 timestamp at which the event occurred in the source system */
  occurredAt: ISOTimestamp;
  /** ISO-8601 timestamp at which the platform received the event */
  receivedAt: ISOTimestamp;
  /** Name of the SaaS integration that originated the event (e.g. "github", "okta") */
  source: string;
  /** Actor who triggered the event */
  actor: DomainEventActor;
  /**
   * Freeform metadata from the originating system.
   * All values must be JSON-serialisable primitives or nested objects.
   */
  metadata: Record<string, unknown>;
  /**
   * Environment tag — e.g. "production", "staging".
   * Defaults to "production" when absent in the raw payload.
   */
  environment: string;
}

// ---------------------------------------------------------------------------
// PolicyTemplate — a declarative compliance rule
// ---------------------------------------------------------------------------

export interface PolicyCondition {
  /**
   * JSONPath-style field accessor relative to the DomainEvent root.
   * e.g. "actor.kind", "metadata.approved", "environment"
   */
  field: string;
  /** Comparison operator */
  operator:
    | 'eq'        // strict equality
    | 'neq'       // strict inequality
    | 'contains'  // substring / array membership
    | 'exists'    // field is present and non-null
    | 'gt'        // numeric greater-than
    | 'lt'        // numeric less-than
    | 'matches';  // RegExp (value must be a string pattern)
  /** Expected value (not required for 'exists') */
  value?: unknown;
}

export interface PolicyTemplate {
  /** Unique policy identifier, e.g. "soc2-cc6.1-mfa-enrollment" */
  id: string;
  /** Human-readable policy name */
  name: string;
  /** Compliance framework this policy maps to */
  framework: ComplianceFramework;
  /** Control identifier within the framework, e.g. "CC6.1" */
  controlId: string;
  /** Prose description of what this policy checks */
  description: string;
  /** EventTypes this policy applies to */
  appliesTo: EventType[];
  /** Optional environment filter — omit to apply to all environments */
  environments?: string[];
  /**
   * Conditions that must ALL be satisfied for the event to PASS this policy.
   * An empty array means "any event of the matching type passes".
   */
  conditions: PolicyCondition[];
  /** Severity of a failure on this policy */
  failureSeverity: AlertSeverity;
  /** SemVer string — policy version */
  version: string;
  /** Whether this policy is currently active */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// VerificationResult — output of the Verification Engine for one policy
// ---------------------------------------------------------------------------

export interface ConditionResult {
  condition: PolicyCondition;
  /** Actual value resolved from the event for the checked field */
  resolvedValue: unknown;
  passed: boolean;
  /** Human-readable explanation of why the condition passed or failed */
  explanation: string;
}

export interface VerificationResult {
  /** The DomainEvent that was evaluated */
  eventId: EventId;
  /** The policy that was evaluated */
  policyId: string;
  controlId: string;
  framework: ComplianceFramework;
  outcome: VerificationOutcome;
  /** Per-condition breakdown */
  conditionResults: ConditionResult[];
  /** ISO-8601 timestamp of evaluation */
  evaluatedAt: ISOTimestamp;
  /** Human-readable summary */
  summary: string;
}

// ---------------------------------------------------------------------------
// VerifiedEvidenceRecord — immutable record written to the Evidence Vault
// ---------------------------------------------------------------------------

export interface VerifiedEvidenceRecord {
  /** UUID v4 — unique record identifier */
  id: string;
  /** The originating event */
  event: DomainEvent;
  /** All verification results for this event */
  verificationResults: VerificationResult[];
  /** Overall outcome across all evaluated policies */
  overallOutcome: VerificationOutcome;
  /** SHA-256 hash of the canonical JSON of this record (excluding this field) */
  integrity: string;
  /** SHA-256 hash of the previous record in the vault (chain integrity) */
  previousHash: string;
  /** ISO-8601 timestamp of vault insertion */
  recordedAt: ISOTimestamp;
}

// ---------------------------------------------------------------------------
// ComplianceAlert — emitted when a policy evaluation fails
// ---------------------------------------------------------------------------

export interface ComplianceAlert {
  id: string;
  eventId: EventId;
  policyId: string;
  controlId: string;
  framework: ComplianceFramework;
  severity: AlertSeverity;
  message: string;
  event: DomainEvent;
  verificationResult: VerificationResult;
  triggeredAt: ISOTimestamp;
  /** Whether the alert has been acknowledged */
  acknowledged: boolean;
}

// ---------------------------------------------------------------------------
// Result<T, E> — typed error handling pattern (no thrown exceptions at boundaries)
// ---------------------------------------------------------------------------

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
