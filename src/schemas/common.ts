/**
 * src/schemas/common.ts
 *
 * Reusable Zod primitives. Keep these tight — every schema in the codebase
 * is going to compose these, so loosening any of them silently widens the
 * accepted input across the whole API.
 */

import { z } from "zod";

/** ISO-3166-1 alpha-2 country code (uppercase). */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "Country code must be ISO-3166-1 alpha-2 (e.g. 'GH', 'NG')");

/** ISO-4217 currency code. Input is uppercased before validation to preserve
 *  the legacy behavior of the FX route's `String(req.params.currency).toUpperCase()`.
 *  Slice 6: consider tightening to reject mixed-case input outright. */
export const CurrencyCode = z.string()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Currency code must be ISO-4217 (e.g. 'GHS', 'USD')"));

/** ISO 8601 date, e.g. 2026-05-20. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be ISO 8601 (YYYY-MM-DD)");

/** ISO 8601 datetime, with or without milliseconds, requires timezone. */
export const IsoDateTime = z.string().datetime({ offset: true });

/**
 * Tenant ID — we don't know the canonical format across the codebase, so
 * accept a conservative slug. Tighten later if the tenant scheme is stricter.
 */
export const TenantId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Tenant ID must be a slug");

/** Pagination query params. Coerces from string because they arrive as query strings. */
export const Pagination = z.object({
  limit:  z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Queue job priority — narrow to known values. */
export const QueuePriority = z.enum(["low", "normal", "high", "critical"]);

/**
 * Queue job type — NARROW THIS to the actual job types your queue accepts.
 * The current /admin/queue/enqueue handler casts a raw string into the job
 * type, which is the slice 6 "type coercion into privileged enum" finding.
 * Adjust this list to match src/services/queue.ts.
 */
export const QueueJobType = z.enum([
  "fx_rate_refresh",
  // TODO(slice 2 review): expand to the full enum from src/services/queue.ts.
  // Listed values are placeholders pending a read of the queue module.
]);

/** Risk level — used by anomalies query. */
export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);

/** Severity used by notifications. */
export const NotificationSeverity = z.enum(["low", "medium", "high", "critical"]);

/** Anomaly notification types. */
export const NotificationType = z.enum([
  "anomaly_low",
  "anomaly_medium",
  "anomaly_high",
  "anomaly_critical",
  // TODO(slice 2 review): expand against src/services/notifications.ts.
]);
