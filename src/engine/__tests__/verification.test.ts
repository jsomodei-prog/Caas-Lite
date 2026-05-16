/**
 * verification.test.ts — Unit tests for the VerificationEngine
 */

import { VerificationEngine } from '../verification';
import type { DomainEvent, PolicyTemplate } from '../../types/domain';
import type { PolicyEngine } from '../policy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt-test-001',
    type: 'access.mfa_enrolled',
    occurredAt: '2026-05-14T10:00:00.000Z',
    receivedAt: '2026-05-14T10:00:01.000Z',
    source: 'okta',
    actor: { id: 'user@example.com', name: 'Alice', kind: 'human' },
    metadata: {},
    environment: 'production',
    ...overrides,
  };
}

function makeMockPolicyEngine(policies: PolicyTemplate[]): PolicyEngine {
  return {
    getApplicablePolicies: (_type: string, _env: string) => policies,
    getPolicy: (id: string) => policies.find((p) => p.id === id),
    listPolicies: () => policies,
    reload: async () => undefined,
    size: policies.length,
  } as unknown as PolicyEngine;
}

const MFA_POLICY: PolicyTemplate = {
  id: 'soc2-cc6.1-mfa',
  name: 'MFA Enrollment',
  framework: 'SOC2',
  controlId: 'CC6.1',
  description: 'Actor must be human',
  appliesTo: ['access.mfa_enrolled'],
  conditions: [{ field: 'actor.kind', operator: 'eq', value: 'human' }],
  failureSeverity: 'high',
  version: '1.0.0',
  enabled: true,
};

const DEPLOY_POLICY: PolicyTemplate = {
  id: 'soc2-cc7.2-deploy',
  name: 'Deploy Approval',
  framework: 'SOC2',
  controlId: 'CC7.2',
  description: 'Deploy must be approved',
  appliesTo: ['deploy.completed'],
  environments: ['production'],
  conditions: [
    { field: 'metadata.approved', operator: 'eq', value: true },
    { field: 'metadata.approver', operator: 'exists' },
  ],
  failureSeverity: 'critical',
  version: '1.0.0',
  enabled: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationEngine', () => {
  describe('verify — single condition policy', () => {
    it('passes when condition is met', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([MFA_POLICY]));
      const result = await engine.verify(makeEvent({ actor: { id: 'u1', name: 'Alice', kind: 'human' } }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('pass');
      expect(result.value.alerts).toHaveLength(0);
    });

    it('fails when condition is not met', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([MFA_POLICY]));
      const result = await engine.verify(makeEvent({ actor: { id: 's1', name: 'Bot', kind: 'service' } }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('fail');
      expect(result.value.alerts).toHaveLength(1);
      expect(result.value.alerts[0]!.severity).toBe('high');
    });
  });

  describe('verify — multiple condition policy (AND logic)', () => {
    it('passes when all conditions met', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([DEPLOY_POLICY]));
      const event = makeEvent({
        type: 'deploy.completed',
        metadata: { approved: true, approver: 'bob@example.com' },
      });
      const result = await engine.verify(event);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('pass');
    });

    it('fails when one condition is missing', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([DEPLOY_POLICY]));
      const event = makeEvent({
        type: 'deploy.completed',
        metadata: { approved: true }, // missing approver
      });
      const result = await engine.verify(event);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('fail');
      const failedConditions = result.value.verificationResults[0]!.conditionResults.filter((c) => !c.passed);
      expect(failedConditions).toHaveLength(1);
      expect(failedConditions[0]!.condition.field).toBe('metadata.approver');
    });
  });

  describe('verify — force-fail event types', () => {
    it('always fails for secret.exposed regardless of conditions', async () => {
      const noCondPolicy: PolicyTemplate = {
        ...MFA_POLICY,
        id: 'secret-exposed',
        appliesTo: ['secret.exposed'],
        conditions: [], // would normally pass
      };
      const engine = new VerificationEngine(makeMockPolicyEngine([noCondPolicy]));
      const result = await engine.verify(makeEvent({ type: 'secret.exposed' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('fail');
    });
  });

  describe('verify — no applicable policies', () => {
    it('returns inconclusive when no policies match', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([]));
      const result = await engine.verify(makeEvent({ type: 'unknown.custom.event' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.overallOutcome).toBe('inconclusive');
      expect(result.value.alerts).toHaveLength(0);
    });
  });

  describe('condition operators', () => {
    function policyWithCondition(field: string, operator: PolicyTemplate['conditions'][0]['operator'], value?: unknown): PolicyTemplate {
      return {
        ...MFA_POLICY,
        id: 'op-test',
        conditions: [{ field, operator, value }],
      };
    }

    it('neq — passes when values differ', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('actor.kind', 'neq', 'service')]));
      const result = await engine.verify(makeEvent());
      expect(result.ok && result.value.overallOutcome).toBe('pass');
    });

    it('exists — passes when field is present', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('actor.id', 'exists')]));
      const result = await engine.verify(makeEvent());
      expect(result.ok && result.value.overallOutcome).toBe('pass');
    });

    it('exists — fails when field is absent', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('metadata.nonexistent', 'exists')]));
      const result = await engine.verify(makeEvent({ metadata: {} }));
      expect(result.ok && result.value.overallOutcome).toBe('fail');
    });

    it('contains — matches substring', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('actor.id', 'contains', 'example')]));
      const result = await engine.verify(makeEvent({ actor: { id: 'user@example.com', name: 'U', kind: 'human' } }));
      expect(result.ok && result.value.overallOutcome).toBe('pass');
    });

    it('gt — passes when value is greater', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('metadata.score', 'gt', 50)]));
      const result = await engine.verify(makeEvent({ metadata: { score: 99 } }));
      expect(result.ok && result.value.overallOutcome).toBe('pass');
    });

    it('matches — passes regex', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([policyWithCondition('actor.id', 'matches', '^user@')]));
      const result = await engine.verify(makeEvent({ actor: { id: 'user@example.com', name: 'U', kind: 'human' } }));
      expect(result.ok && result.value.overallOutcome).toBe('pass');
    });
  });

  describe('buildEvidenceRecord', () => {
    it('produces a record with integrity hash and previousHash', async () => {
      const engine = new VerificationEngine(makeMockPolicyEngine([MFA_POLICY]));
      const event = makeEvent();
      const verifyResult = await engine.verify(event);
      expect(verifyResult.ok).toBe(true);
      if (!verifyResult.ok) return;

      const record = engine.buildEvidenceRecord(verifyResult.value, 'genesis');
      expect(record.id).toBeDefined();
      expect(record.integrity).toMatch(/^[a-f0-9]{64}$/);
      expect(record.previousHash).toBe('genesis');
      expect(record.overallOutcome).toBe('pass');
    });
  });
});
