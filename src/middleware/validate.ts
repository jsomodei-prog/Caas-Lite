/**
 * src/middleware/validate.ts
 *
 * Zod-driven request validation middleware factory.
 *
 * Usage:
 *   import { z } from "zod";
 *   import { validate } from "../middleware/validate";
 *
 *   const SweepBody = z.object({
 *     dryRun: z.boolean().optional(),
 *     reason: z.string().min(1).max(500).optional(),
 *   });
 *
 *   router.post("/payouts/sweep",
 *     validate({ body: SweepBody }),
 *     async (req, res) => {
 *       // req.body is now typed as z.infer<typeof SweepBody>
 *       ...
 *     });
 *
 * Design notes:
 *   - Parses (not just validates). Replaces req.body / req.query / req.params
 *     with the parsed, coerced output. This is what makes z.coerce.number()
 *     work on query strings without each handler re-parsing.
 *   - Throws AppError.badRequest with Zod issues as `details`. The global
 *     error handler decides what's safe to expose. We do NOT expose `path`
 *     or `message` ourselves — that's the handler's job per the sanitizer
 *     gating rule.
 *   - Schemas are optional per section. Omitting `body` means body is not
 *     touched — handlers that legitimately accept arbitrary payloads (e.g.
 *     queue.enqueue's `payload` field) keep working.
 *   - We do NOT validate headers here. Tenant ID, role, tier headers are
 *     handled by dualPlaneAuth / requireBusinessPlane upstream; duplicating
 *     that logic in Zod would create two sources of truth.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodTypeAny, ZodError, ZodIssue } from "zod";
import { AppError } from "../lib/errors";

export interface ValidateSchemas {
  body?:   ZodTypeAny;
  query?:  ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Slim, JSON-safe representation of Zod issues. We strip everything the
 * client doesn't need (like the raw input that triggered the failure, which
 * may echo secrets if a misrouted credential lands in a field).
 */
interface SafeIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

function toSafeIssues(err: ZodError): SafeIssue[] {
  return err.issues.map((i: ZodIssue): SafeIssue => ({
    path:    i.path,
    code:    i.code,
    message: i.message,
  }));
}

export function validate(schemas: ValidateSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) {
        const r = schemas.params.safeParse(req.params);
        if (!r.success) {
          return next(AppError.badRequest("Invalid path parameters", {
            section: "params",
            issues:  toSafeIssues(r.error),
          }));
        }
        req.params = r.data as typeof req.params;
      }

      if (schemas.query) {
        const r = schemas.query.safeParse(req.query);
        if (!r.success) {
          return next(AppError.badRequest("Invalid query parameters", {
            section: "query",
            issues:  toSafeIssues(r.error),
          }));
        }
        // Express 5 makes req.query a getter on some versions — assign via
        // Object.defineProperty fallback if direct assignment is rejected.
        try {
          req.query = r.data as typeof req.query;
        } catch {
          Object.defineProperty(req, "query", { value: r.data, writable: true, configurable: true });
        }
      }

      if (schemas.body) {
        const r = schemas.body.safeParse(req.body);
        if (!r.success) {
          return next(AppError.badRequest("Invalid request body", {
            section: "body",
            issues:  toSafeIssues(r.error),
          }));
        }
        req.body = r.data;
      }

      next();
    } catch (err) {
      // Defensive: a buggy schema (e.g. .transform that throws) shouldn't
      // crash the request. Wrap and pass to the handler.
      next(AppError.from(err));
    }
  };
}
