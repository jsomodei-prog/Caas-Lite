/**
 * policy.test.ts — Unit tests for the PolicyEngine
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PolicyEngine } from '../policy';
import type { PolicyTemplate } from '../../types/domain';

const MINIMAL_POLICY: PolicyTemplate = {
  id: 'test-policy-001',
  name: 'Test Policy',
  framework: 'SOC2',
  controlId: 'CC6.1',
  description: 'A test policy',
  appliesTo: ['access.mfa_enrolled'],
  conditions: [],
  failureSeverity: 'high',
  version: '1.0.0',
  enabled: true,
};

async function engineWithPolicies(policies: PolicyTemplate[]): Promise<PolicyEngine> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caas-test-'));
  fs.writeFileSync(path.join(dir, 'test.json'), JSON.stringify(policies));
  process.env['POLICY_TEMPLATE_PATH'] = dir;
  const engine = await PolicyEngine.create();
  delete process.env['POLICY_TEMPLATE_PATH'];
  return engine;
}

describe('PolicyEngine', () => {
  describe('loading', () => {
    it('loads valid policies from disk', async () => {
      const engine = await engineWithPolicies([MINIMAL_POLICY]);
      expect(engine.size).toBe(1);
    });

    it('skips disabled policies', async () => {
      const engine = await engineWithPolicies([{ ...MINIMAL_POLICY, enabled: false }]);
      expect(engine.size).toBe(0);
    });

    it('skips policies with invalid structure', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caas-test-'));
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([{ id: '' }]));
      process.env['POLICY_TEMPLATE_PATH'] = dir;
      const engine = await PolicyEngine.create();
      delete process.env['POLICY_TEMPLATE_PATH'];
      expect(engine.size).toBe(0);
    });

    it('handles missing policy directory gracefully', async () => {
      process.env['POLICY_TEMPLATE_PATH'] = '/tmp/nonexistent-caas-dir-xyz';
      const engine = await PolicyEngine.create();
      delete process.env['POLICY_TEMPLATE_PATH'];
      expect(engine.size).toBe(0);
    });
  });

  describe('getApplicablePolicies', () => {
    it('returns policies matching event type', async () => {
      const engine = await engineWithPolicies([MINIMAL_POLICY]);
      const results = engine.getApplicablePolicies('access.mfa_enrolled', 'production');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('test-policy-001');
    });

    it('returns empty array for unmatched event type', async () => {
      const engine = await engineWithPolicies([MINIMAL_POLICY]);
      const results = engine.getApplicablePolicies('deploy.completed', 'production');
      expect(results).toHaveLength(0);
    });

    it('respects environment filter', async () => {
      const policy: PolicyTemplate = {
        ...MINIMAL_POLICY,
        id: 'env-filtered',
        appliesTo: ['deploy.completed'],
        environments: ['production'],
      };
      const engine = await engineWithPolicies([policy]);
      expect(engine.getApplicablePolicies('deploy.completed', 'staging')).toHaveLength(0);
      expect(engine.getApplicablePolicies('deploy.completed', 'production')).toHaveLength(1);
    });

    it('applies to all environments when environments is omitted', async () => {
      const policy: PolicyTemplate = { ...MINIMAL_POLICY, appliesTo: ['deploy.completed'] };
      const engine = await engineWithPolicies([policy]);
      expect(engine.getApplicablePolicies('deploy.completed', 'staging')).toHaveLength(1);
      expect(engine.getApplicablePolicies('deploy.completed', 'production')).toHaveLength(1);
    });
  });

  describe('listPolicies', () => {
    it('returns all policies with no filter', async () => {
      const p2: PolicyTemplate = { ...MINIMAL_POLICY, id: 'test-002', appliesTo: ['deploy.completed'] };
      const engine = await engineWithPolicies([MINIMAL_POLICY, p2]);
      expect(engine.listPolicies()).toHaveLength(2);
    });

    it('filters by framework', async () => {
      const iso: PolicyTemplate = { ...MINIMAL_POLICY, id: 'iso-001', framework: 'ISO27001' };
      const engine = await engineWithPolicies([MINIMAL_POLICY, iso]);
      expect(engine.listPolicies({ framework: 'ISO27001' })).toHaveLength(1);
    });

    it('filters by event type', async () => {
      const deploy: PolicyTemplate = { ...MINIMAL_POLICY, id: 'dep-001', appliesTo: ['deploy.completed'] };
      const engine = await engineWithPolicies([MINIMAL_POLICY, deploy]);
      expect(engine.listPolicies({ eventType: 'deploy.completed' })).toHaveLength(1);
    });
  });

  describe('getPolicy', () => {
    it('returns policy by id', async () => {
      const engine = await engineWithPolicies([MINIMAL_POLICY]);
      const policy = engine.getPolicy('test-policy-001');
      expect(policy).toBeDefined();
      expect(policy?.name).toBe('Test Policy');
    });

    it('returns undefined for unknown id', async () => {
      const engine = await engineWithPolicies([MINIMAL_POLICY]);
      expect(engine.getPolicy('nonexistent')).toBeUndefined();
    });
  });
});
