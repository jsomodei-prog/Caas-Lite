/**
 * verification.ts — Verification Engine
 *
 * Core compliance logic. Receives a DomainEvent, loads all applicable
 * PolicyTemplates from the PolicyEngine, evaluates each policy's conditions
 * against the event data, and returns structured VerificationResults.
 *
 * Usage:
 *   const engine = new VerificationEngine(policyEngine);
 *   const results = await engine.verify(domainEvent);
 *   // results.verificationResults — per-policy outcomes
 *   // results.overallOutcome      — aggregated pass/fail/inconclusive
 *   // results.alerts              — ComplianceAlert[] for any failures
 */

import * as crypto from 'crypto';
import {
  type DomainEvent,
  type PolicyTemplate,
  type PolicyCondition,
  type VerificationResult,
  type ConditionResult,
  type VerifiedEvidenceRecord,
  type ComplianceAlert,
  type VerificationOutcome,
  type Result,
  ok,
} from '../types/domain';
import { type PolicyEngine } from './policy';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Event types that are ALWAYS a failure regardless of conditions.
// The policy JSON for these entries has empty conditions (which would
// otherwise produce 'pass'). We intercept them here.
// ---------------------------------------------------------------------------
const FORCE_FAIL_EVENT_TYPES = new Set<string>([
  'secret.exposed',
  'audit.log_tampered',
]);

// ---------------------------------------------------------------------------
// Field resolver — resolves dot-notation paths against a DomainEvent
// ---------------------------------------------------------------------------

/**
 * Resolves a dot-notation field path against the DomainEvent.
 * Supports top-level fields and nested paths up to arbitrary depth.
 *
 * Examples:
 *   "actor.kind"          → event.actor.kind
 *   "metadata.approved"   → event.metadata.approved
 *   "environment"         → event.environment
 */
function resolveField(event: DomainEvent, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = event;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

function evaluateCondition(
  event: DomainEvent,
  condition: PolicyCondition,
): ConditionResult {
  const resolved = resolveField(event, condition.field);

  let passed = false;
  let explanation = '';

  switch (condition.operator) {
    case 'eq': {
      passed = resolved === condition.value;
      explanation = passed
        ? `"${condition.field}" equals expected value "${String(condition.value)}"`
        : `"${condition.field}" is "${String(resolved)}" but expected "${String(condition.value)}"`;
      break;
    }

    case 'neq': {
      passed = resolved !== condition.value;
      explanation = passed
        ? `"${condition.field}" correctly differs from "${String(condition.value)}"`
        : `"${condition.field}" must not equal "${String(condition.value)}" but it does`;
      break;
    }

    case 'exists': {
      passed = resolved !== undefined && resolved !== null;
      explanation = passed
        ? `"${condition.field}" is present`
        : `"${condition.field}" is missing or null`;
      break;
    }

    case 'contains': {
      if (Array.isArray(resolved)) {
        passed = resolved.includes(condition.value);
        explanation = passed
          ? `array "${condition.field}" contains "${String(condition.value)}"`
          : `array "${condition.field}" does not contain "${String(condition.value)}"`;
      } else if (typeof resolved === 'string') {
        passed = resolved.includes(String(condition.value ?? ''));
        explanation = passed
          ? `"${condition.field}" contains substring "${String(condition.value)}"`
          : `"${condition.field}" does not contain "${String(condition.value)}"`;
      } else {
        passed = false;
        explanation = `"${condition.field}" is not a string or array — cannot apply "contains"`;
      }
      break;
    }

    case 'gt': {
      const num = Number(resolved);
      const threshold = Number(condition.value);
      passed = !isNaN(num) && !isNaN(threshold) && num > threshold;
      explanation = passed
        ? `"${condition.field}" (${num}) is greater than ${threshold}`
        : `"${condition.field}" (${String(resolved)}) is not greater than ${threshold}`;
      break;
    }

    case 'lt': {
      const num = Number(resolved);
      const threshold = Number(condition.value);
      passed = !isNaN(num) && !isNaN(threshold) && num < threshold;
      explanation = passed
        ? `"${condition.field}" (${num}) is less than ${threshold}`
        : `"${condition.field}" (${String(resolved)}) is not less than ${threshold}`;
      break;
    }

    case 'matches': {
      if (typeof resolved !== 'string') {
        passed = false;
        explanation = `"${condition.field}" is not a string — cannot apply regex "matches"`;
      } else {
        const pattern = new RegExp(String(condition.value ?? ''));
        passed = pattern.test(resolved);
        explanation = passed
          ? `"${condition.field}" matches pattern /${String(condition.value)}/`
          : `"${condition.field}" does not match pattern /${String(condition.value)}/`;
      }
      break;
    }

    default: {
      passed = false;
      explanation = `unknown operator "${condition.operator}"`;
    }
  }

  return { condition, resolvedValue: resolved, passed, explanation };
}

// ---------------------------------------------------------------------------
// VerificationEngine
// ---------------------------------------------------------------------------

export interface VerificationBatch {
  event: DomainEvent;
  verificationResults: VerificationResult[];
  overallOutcome: VerificationOutcome;
  alerts: ComplianceAlert[];
}

export class VerificationEngine {
  private readonly policyEngine: PolicyEngine;

  constructor(policyEngine: PolicyEngine) {
    this.policyEngine = policyEngine;
  }

  // -------------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------------

  /**
   * Verifies a single DomainEvent against all applicable policies.
   * Returns a VerificationBatch with per-policy results and aggregated outcome.
   */
  async verify(event: DomainEvent): Promise<Result<VerificationBatch>> {
    logger.info('verification: processing event', {
      eventId: event.id,
      type: event.type,
      source: event.source,
      environment: event.environment,
    });

    const policies = this.policyEngine.getApplicablePolicies(event.type, event.environment);

    if (policies.length === 0) {
      logger.warn('verification: no applicable policies found', {
        eventId: event.id,
        type: event.type,
        environment: event.environment,
      });

      // Return an inconclusive result when no policies match
      const result: VerificationResult = {
        eventId: event.id,
        policyId: 'none',
        controlId: 'N/A',
        framework: 'SOC2',
        outcome: 'inconclusive',
        conditionResults: [],
        evaluatedAt: new Date().toISOString(),
        summary: `No policies found for event type "${event.type}" in environment "${event.environment}". Manual review recommended.`,
      };

      return ok({
        event,
        verificationResults: [result],
        overallOutcome: 'inconclusive',
        alerts: [],
      });
    }

    const verificationResults: VerificationResult[] = [];
    const alerts: ComplianceAlert[] = [];

    for (const policy of policies) {
      const result = this.evaluatePolicy(event, policy);
      verificationResults.push(result);

      if (result.outcome === 'fail') {
        alerts.push(this.buildAlert(event, policy, result));
      }

      logger.info('verification: policy evaluated', {
        eventId: event.id,
        policyId: policy.id,
        outcome: result.outcome,
        summary: result.summary,
      });
    }

    const overallOutcome = this.aggregateOutcome(verificationResults);

    logger.info('verification: batch complete', {
      eventId: event.id,
      totalPolicies: policies.length,
      passed: verificationResults.filter((r) => r.outcome === 'pass').length,
      failed: verificationResults.filter((r) => r.outcome === 'fail').length,
      inconclusive: verificationResults.filter((r) => r.outcome === 'inconclusive').length,
      overallOutcome,
    });

    return ok({ event, verificationResults, overallOutcome, alerts });
  }

  // -------------------------------------------------------------------------
  // Policy evaluation
  // -------------------------------------------------------------------------

  private evaluatePolicy(event: DomainEvent, policy: PolicyTemplate): VerificationResult {
    const evaluatedAt = new Date().toISOString();

    // Force-fail for dangerous event types regardless of conditions
    if (FORCE_FAIL_EVENT_TYPES.has(event.type)) {
      return {
        eventId: event.id,
        policyId: policy.id,
        controlId: policy.controlId,
        framework: policy.framework,
        outcome: 'fail',
        conditionResults: [],
        evaluatedAt,
        summary: `Event type "${event.type}" is unconditionally treated as a control failure (${policy.controlId}).`,
      };
    }

    // No conditions defined → pass (opt-in model)
    if (policy.conditions.length === 0) {
      return {
        eventId: event.id,
        policyId: policy.id,
        controlId: policy.controlId,
        framework: policy.framework,
        outcome: 'pass',
        conditionResults: [],
        evaluatedAt,
        summary: `Policy "${policy.name}" has no conditions — event type presence is sufficient.`,
      };
    }

    // Evaluate every condition; all must pass (AND logic)
    const conditionResults: ConditionResult[] = policy.conditions.map((cond) =>
      evaluateCondition(event, cond),
    );

    const allPassed = conditionResults.every((r) => r.passed);
    const failedConditions = conditionResults.filter((r) => !r.passed);

    const outcome: VerificationOutcome = allPassed ? 'pass' : 'fail';
    const summary = allPassed
      ? `All ${conditionResults.length} condition(s) passed for policy "${policy.name}" (${policy.controlId}).`
      : `${failedConditions.length} of ${conditionResults.length} condition(s) failed for policy "${policy.name}" (${policy.controlId}): ${failedConditions.map((r) => r.explanation).join('; ')}`;

    return {
      eventId: event.id,
      policyId: policy.id,
      controlId: policy.controlId,
      framework: policy.framework,
      outcome,
      conditionResults,
      evaluatedAt,
      summary,
    };
  }

  // -------------------------------------------------------------------------
  // Outcome aggregation
  // -------------------------------------------------------------------------

  /**
   * Aggregate outcome across all policy results:
   * - Any 'fail'          → 'fail'
   * - All 'pass'          → 'pass'
   * - Otherwise           → 'inconclusive'
   */
  private aggregateOutcome(results: VerificationResult[]): VerificationOutcome {
    if (results.some((r) => r.outcome === 'fail')) return 'fail';
    if (results.every((r) => r.outcome === 'pass')) return 'pass';
    return 'inconclusive';
  }

  // -------------------------------------------------------------------------
  // Alert construction
  // -------------------------------------------------------------------------

  private buildAlert(
    event: DomainEvent,
    policy: PolicyTemplate,
    result: VerificationResult,
  ): ComplianceAlert {
    return {
      id: crypto.randomUUID(),
      eventId: event.id,
      policyId: policy.id,
      controlId: policy.controlId,
      framework: policy.framework,
      severity: policy.failureSeverity,
      message: result.summary,
      event,
      verificationResult: result,
      triggeredAt: new Date().toISOString(),
      acknowledged: false,
    };
  }

  // -------------------------------------------------------------------------
  // Evidence record builder (called by the receiver after vault write)
  // -------------------------------------------------------------------------

  /**
   * Constructs a VerifiedEvidenceRecord ready for vault insertion.
   * The caller must supply the previousHash from the vault's last record.
   */
  buildEvidenceRecord(
    batch: VerificationBatch,
    previousHash: string,
  ): VerifiedEvidenceRecord {
    const id = crypto.randomUUID();
    const recordedAt = new Date().toISOString();

    // Compute integrity hash over the record body (excluding the integrity field itself)
    const body = JSON.stringify({
      id,
      event: batch.event,
      verificationResults: batch.verificationResults,
      overallOutcome: batch.overallOutcome,
      previousHash,
      recordedAt,
    });

    const integrity = crypto.createHash('sha256').update(body).digest('hex');

    return {
      id,
      event: batch.event,
      verificationResults: batch.verificationResults,
      overallOutcome: batch.overallOutcome,
      integrity,
      previousHash,
      recordedAt,
    };
  }
}
