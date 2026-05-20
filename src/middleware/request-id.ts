/**
 * src/middleware/request-id.ts
 *
 * Assigns a stable request ID to every inbound request:
 *   - If the client sends `X-Request-ID` AND it matches a safe pattern, reuse it.
 *   - Otherwise, generate a UUIDv4.
 *
 * Why validate the inbound header (slice 2 tightening):
 *   The previous inline version in app.ts trusted any inbound value blindly.
 *   That lets a caller embed newlines, ANSI escapes, multi-megabyte strings,
 *   or another tenant's request ID into our logs and error responses.
 *   We constrain to a printable, bounded character class.
 *
 *   This is NOT a security boundary against a malicious operator with a
 *   compromised log pipeline — it's hygiene. Request IDs are still
 *   user-influenced data; the rule for slice 3 (pino) will be: log them as
 *   structured fields, never interpolate into format strings.
 *
 * Express type augmentation:
 *   We attach `req.id` for ergonomics so handlers can write `req.id` instead
 *   of fishing it back out of headers. The header is still set on the
 *   request (for downstream services) and the response (for clients).
 */

import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";

declare module "express-serve-static-core" {
  interface Request {
    /** Stable per-request ID. Set by requestIdMiddleware before any other middleware reads it. */
    id: string;
  }
}

/**
 * Acceptable inbound IDs:
 *   - 8 to 128 characters
 *   - Alphanumerics, hyphen, underscore only
 *   - Covers UUIDv4, ULID, nanoid, and most upstream trace ID formats
 *   - Excludes whitespace, control chars, ANSI escapes, JSON-breaking punctuation
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const REQUEST_ID_HEADER = "x-request-id";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

  const id = (typeof candidate === "string" && SAFE_REQUEST_ID.test(candidate))
    ? candidate
    : randomUUID();

  req.id = id;
  req.headers[REQUEST_ID_HEADER] = id;
  res.setHeader("X-Request-ID", id);
  next();
}
