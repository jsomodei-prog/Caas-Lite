/**
 * policy.ts — Policy Template Engine
 *
 * Manages the lifecycle of compliance policy templates. Loads policies from
 * disk (POLICY_TEMPLATE_PATH) or the bundled defaults, validates their
 * structure, and serves them to the Verification Engine via a query interface.
 *
 * Public API:
 *   PolicyEngine.create()                           — factory (async)
 *   engine.getApplicablePolicies(type, env)         — main query path
 *   engine.getPolicy(id)                            — lookup by ID
 *   engine.listPolicies(filter?)                    — admin / dashboard use
 *   engine.reload()                                 — hot-reload from disk
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type PolicyTemplate,
  type EventType,
  type ComplianceFramework,
  type Result,
  ok,
  err,
} from '../types/domain';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_OPERATORS = new Set([
  'eq', 'neq', 'contains', 'exists', 'gt', 'lt', 'matches',
]);

function validatePolicy(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return 'policy must be an object';
  const p = raw as Record<string, unknown>;

  if (typeof p['id'] !== 'string' || p['id'].trim() === '') return 'missing required string field: id';
  if (typeof p['name'] !== 'string' || p['name'].trim() === '') return 'missing required string field: name';
  if (typeof p['framework'] !== 'string') return 'missing required string field: framework';
  if (typeof p['controlId'] !== 'string') return 'missing required string field: controlId';
  if (typeof p['description'] !== 'string') return 'missing required string field: description';
  if (typeof p['version'] !== 'string') return 'missing required string field: version';
  if (typeof p['enabled'] !== 'boolean') return 'missing required boolean field: enabled';
  if (typeof p['failureSeverity'] !== 'string') return 'missing required string field: failureSeverity';
  if (!Array.isArray(p['appliesTo'])) return 'appliesTo must be an array';
  if ((p['appliesTo'] as unknown[]).some((t) => typeof t !== 'string')) {
    return 'all entries in appliesTo must be strings';
  }
  if (!Array.isArray(p['conditions'])) return 'conditions must be an array';
  for (const cond of p['conditions'] as unknown[]) {
    if (typeof cond !== 'object' || cond === null) return 'each condition must be an object';
    const c = cond as Record<string, unknown>;
    if (typeof c['field'] !== 'string') return 'condition.field must be a string';
    if (typeof c['operator'] !== 'string') return 'condition.operator must be a string';
    if (!VALID_OPERATORS.has(c['operator'] as string)) {
      return `unknown operator "${c['operator'] as string}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PolicyFilter
// ---------------------------------------------------------------------------

export interface PolicyFilter {
  framework?: ComplianceFramework;
  eventType?: EventType;
  environment?: string;
  enabledOnly?: boolean;
}

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------

export class PolicyEngine {
  private readonly store: Map<string, PolicyTemplate> = new Map();
  private readonly policyDir: string;

  private constructor(policyDir: string) {
    this.policyDir = policyDir;
  }

  static async create(): Promise<PolicyEngine> {
    const policyDir = process.env['POLICY_TEMPLATE_PATH']
      ? path.resolve(process.env['POLICY_TEMPLATE_PATH'])
      : path.resolve(process.cwd(), 'policies');

    const engine = new PolicyEngine(policyDir);
    await engine.reload();
    return engine;
  }

  async reload(): Promise<void> {
    const loaded: PolicyTemplate[] = [];
    const errors: string[] = [];

    if (!fs.existsSync(this.policyDir)) {
      logger.warn('policy: policyDir not found', { policyDir: this.policyDir });
    } else {
      const files = fs.readdirSync(this.policyDir).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const filePath = path.join(this.policyDir, file);
        const result = this.loadFile(filePath);
        if (!result.ok) {
          errors.push(`${file}: ${result.error.message}`);
          continue;
        }
        loaded.push(...result.value);
      }
    }

    if (errors.length > 0) {
      logger.warn('policy: some policy files failed validation', { errors });
    }

    this.store.clear();
    let skipped = 0;
    for (const policy of loaded) {
      if (this.store.has(policy.id)) {
        logger.warn('policy: duplicate policy id', { id: policy.id });
      }
      if (!policy.enabled) {
        skipped++;
        continue;
      }
      this.store.set(policy.id, policy);
    }

    logger.info('policy: engine loaded', {
      total: this.store.size,
      skipped,
      policyDir: this.policyDir,
    });
  }

  private loadFile(filePath: string): Result<PolicyTemplate[]> {
    let raw: unknown;
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      raw = JSON.parse(text);
    } catch (e) {
      return err(new Error(`failed to parse JSON: ${(e as Error).message}`));
    }

    const items: unknown[] = Array.isArray(raw) ? raw : [raw];
    const policies: PolicyTemplate[] = [];

    for (let i = 0; i < items.length; i++) {
      const validationError = validatePolicy(items[i]);
      if (validationError) {
        logger.warn('policy: invalid policy skipped', { filePath, index: i, reason: validationError });
        continue;
      }
      policies.push(items[i] as PolicyTemplate);
    }

    return ok(policies);
  }
watch(): void {
    if (this.watcher) return;
    if (!fs.existsSync(this.policyDir)) {
      logger.warn('policy: policyDir not found — hot-reload disabled', { policyDir: this.policyDir });
      return;
    }
    this.watcher = fs.watch(this.policyDir, (_event, filename) => {
      if (!filename?.endsWith('.json')) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        logger.info('policy: change detected — reloading', { file: filename });
        void this.reload();
      }, 500);
    });
    this.watcher.on('error', (e) => {
      logger.error('policy: watcher error', { error: (e as Error).message });
    });
    logger.info('policy: hot-reload watcher active', { policyDir: this.policyDir });
  }

  stopWatch(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    logger.info('policy: hot-reload watcher stopped');
  }
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  getApplicablePolicies(eventType: EventType, environment = 'production'): PolicyTemplate[] {
    const results: PolicyTemplate[] = [];

    for (const policy of this.store.values()) {
      if (!policy.enabled) continue;
      if (!policy.appliesTo.includes(eventType)) continue;
      if (
        policy.environments &&
        policy.environments.length > 0 &&
        !policy.environments.includes(environment)
      ) {
        continue;
      }
      results.push(policy);
    }

    logger.debug('policy: applicable policies resolved', {
      eventType,
      environment,
      count: results.length,
      policyIds: results.map((p) => p.id),
    });

    return results;
  }

  getPolicy(id: string): PolicyTemplate | undefined {
    return this.store.get(id);
  }

  listPolicies(filter?: PolicyFilter): PolicyTemplate[] {
    let results = [...this.store.values()];

    if (filter?.framework) {
      results = results.filter((p) => p.framework === filter.framework);
    }
    if (filter?.eventType) {
      results = results.filter((p) => p.appliesTo.includes(filter.eventType!));
    }
    if (filter?.environment) {
      results = results.filter(
        (p) =>
          !p.environments ||
          p.environments.length === 0 ||
          p.environments.includes(filter.environment!),
      );
    }
    if (filter?.enabledOnly) {
      results = results.filter((p) => p.enabled);
    }

    return results;
  }

  get size(): number {
    return this.store.size;
  }
}
