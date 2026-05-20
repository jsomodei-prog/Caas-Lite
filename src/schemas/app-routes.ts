/**
 * src/schemas/app-routes.ts
 *
 * Zod schemas for endpoints mounted directly in src/app.ts (i.e. not in a
 * createXxxRouter() factory).
 *
 * Routes covered:
 *   POST   /api/v1/payouts/sweep
 *   GET    /api/v1/payouts
 *   GET    /api/v1/anomalies
 *   GET    /api/v1/fx/rates/:currency
 *   POST   /api/v1/admin/backups
 *   POST   /api/v1/admin/queue/enqueue
 *   POST   /api/v1/admin/queue/retry/:jobId
 *   GET    /api/v1/admin/queue/job/:jobId
 *   GET    /api/v1/admin/receipts
 *   POST   /api/v1/admin/receipts/bulk-statement
 *   POST   /api/v1/admin/notify/test
 *
 * Routes that live inside sub-routers (auth, users, commercial, regulatory)
 * keep their schemas next to those routers — they aren't this slice's scope,
 * but the same `validate(...)` pattern applies. Flagged for slice 2 follow-up.
 */

import { z } from "zod";
import {
  CountryCode, CurrencyCode, IsoDate, Pagination, QueuePriority, QueueJobType,
  RiskLevel, NotificationSeverity, NotificationType,
} from "./common";

// ── /api/v1/payouts/sweep ──────────────────────────────────────────────────
// The current handler ignores body. Schema is permissive but bounded — we
// reject unknown fields to catch caller typos early.

export const PayoutSweepBody = z.object({
  dryRun: z.boolean().optional(),
  reason: z.string().min(1).max(500).optional(),
}).strict();

// ── /api/v1/payouts (GET) ──────────────────────────────────────────────────

export const PayoutsListQuery = Pagination;

// ── /api/v1/anomalies (GET) ────────────────────────────────────────────────

export const AnomaliesQuery = Pagination.extend({
  risk_level: RiskLevel.optional(),
  since:      IsoDate.optional(),
});

// ── /api/v1/fx/rates/:currency (GET) ───────────────────────────────────────

export const FxRateParams = z.object({
  currency: CurrencyCode,
});

// ── /api/v1/admin/queue/enqueue ────────────────────────────────────────────
// `payload` stays z.unknown() — the queue itself owns payload validation per
// job type. Slice 5/6: push payload-shape validation down into the queue.

export const QueueEnqueueBody = z.object({
  type:           QueueJobType,
  payload:        z.unknown(),
  priority:       QueuePriority.optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
}).strict();

// ── /api/v1/admin/queue/retry/:jobId  and  /api/v1/admin/queue/job/:jobId ──

export const QueueJobParams = z.object({
  jobId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

// ── /api/v1/admin/receipts/bulk-statement ──────────────────────────────────

export const BulkStatementBody = z.object({
  tenantId:    z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  countryCode: CountryCode,
  periodStart: IsoDate,
  periodEnd:   IsoDate,
}).strict().refine(
  (v) => v.periodStart <= v.periodEnd,
  { message: "periodStart must be on or before periodEnd", path: ["periodEnd"] },
);

// ── /api/v1/admin/notify/test ──────────────────────────────────────────────
// The current handler hard-codes title/description; we still accept overrides
// so the test endpoint can exercise different notification shapes. All fields
// optional, all bounded.

export const NotifyTestBody = z.object({
  type:        NotificationType.optional(),
  severity:    NotificationSeverity.optional(),
  title:       z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  metadata:    z.record(z.string(), z.unknown()).optional(),
}).strict();

// ── /api/v1/admin/backups (POST) ───────────────────────────────────────────
// Current handler accepts no body. Reject unknown fields to surface caller bugs.

export const AdminBackupBody = z.object({}).strict();

// Exports for the route mounting in app.ts. Group by mount point for clarity.
export type PayoutSweepBodyT      = z.infer<typeof PayoutSweepBody>;
export type PayoutsListQueryT     = z.infer<typeof PayoutsListQuery>;
export type AnomaliesQueryT       = z.infer<typeof AnomaliesQuery>;
export type FxRateParamsT         = z.infer<typeof FxRateParams>;
export type QueueEnqueueBodyT     = z.infer<typeof QueueEnqueueBody>;
export type QueueJobParamsT       = z.infer<typeof QueueJobParams>;
export type BulkStatementBodyT    = z.infer<typeof BulkStatementBody>;
export type NotifyTestBodyT       = z.infer<typeof NotifyTestBody>;
export type AdminBackupBodyT      = z.infer<typeof AdminBackupBody>;
