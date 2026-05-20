/**
 * src/middleware/error-handler.ts
 *
 * Global error-handling middleware. Replaces the inline handler that used to
 * live at the bottom of app.ts (around line 587 of the slice-1 baseline).
 *
 * Sanitization rules (slice 2 decision, gated by two conditions):
 *
 *   exposeInternals = (NODE_ENV !== "production")
 *                  && (app.locals.exposeErrors !== false)
 *
 *   ┌─────────────────────────┬─────────────────────────────────────────────┐
 *   │ Error is AppError       │ Always send `code`, `status`, `request_id`. │
 *   │   .expose === true      │ Send `.message` and `.details` to client.   │
 *   │   .expose === false     │ Send generic message unless exposeInternals.│
 *   ├─────────────────────────┼─────────────────────────────────────────────┤
 *   │ Anything else thrown    │ 500. Generic message unless exposeInternals.│
 *   │                         │ Stack ONLY included when exposeInternals.   │
 *   └─────────────────────────┴─────────────────────────────────────────────┘
 *
 * The runtime flag `app.locals.exposeErrors` defaults to true outside prod
 * and is intentionally settable. During a prod incident, an operator can
 * `app.locals.exposeErrors = true` via an admin endpoint or REPL without
 * a redeploy. We do NOT add such an endpoint in this slice — flagging only.
 *
 * Logging: this slice uses console.error to preserve current behavior.
 * Slice 3 swaps it for pino with `redact` paths covering Authorization,
 * cookie, password, token, dev_hmac_secret, *_secret, *_key.
 */

import type { Request, Response, NextFunction, Application } from "express";
import { AppError, isAppError } from "../lib/errors";
import { childLogger } from "../lib/pino";

const log = childLogger("error-handler");

interface ErrorResponseBody {
  error:      string;
  code:       string;
  request_id: string;
  details?:   unknown;
  stack?:     string;       // only when exposeInternals === true
  cause?:     unknown;      // only when exposeInternals === true
}

function shouldExposeInternals(app: Application): boolean {
  if (process.env.NODE_ENV === "production") return false;
  // app.locals.exposeErrors defaults to true; only an explicit `false` hides.
  return app.locals.exposeErrors !== false;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const appErr = isAppError(err) ? err : AppError.from(err);
  const requestId = req.id ?? (req.headers["x-request-id"] as string | undefined) ?? "unknown";
  const expose    = shouldExposeInternals(req.app);

  // Log every error with full context, regardless of what we send to the client.
  // Pino's redact paths (see src/lib/pino.ts) strip secrets from req.headers
  // and any *_secret / token / password fields the error may have captured.
  // We do NOT log req.body — it's in the redact list, but logging it would be
  // wasted work anyway and risks leaking through if redact rules drift.
  log.error(
    {
      err:        appErr,
      req_id:     requestId,
      method:     req.method,
      path:       req.originalUrl ?? req.url,
      status:     appErr.status,
      code:       appErr.code,
      tenant_id:  req.headers["x-tenant-id"] ?? undefined,
    },
    "request errored",
  );

  // Decide what the client actually sees.
  const clientMessage =
    appErr.expose || expose
      ? appErr.message
      : appErr.status >= 500
        ? "Internal Server Error"
        : "Request rejected";

  const body: ErrorResponseBody = {
    error:      clientMessage,
    code:       appErr.code,
    request_id: requestId,
  };

  // Details (Zod issues, conflict reasons, etc.) are safe to expose for 4xx
  // that opted in via `expose: true`. Never expose details on 5xx unless
  // we're explicitly in expose-internals mode.
  if (appErr.details !== undefined && (appErr.expose || expose)) {
    body.details = appErr.details;
  }

  if (expose) {
    if (appErr.stack) body.stack = appErr.stack;
    if (appErr.cause !== undefined) {
      body.cause = appErr.cause instanceof Error
        ? { name: appErr.cause.name, message: appErr.cause.message, stack: appErr.cause.stack }
        : appErr.cause;
    }
  }

  // If headers have already been sent (e.g. an async handler errored after
  // res.write), we can't send JSON — best we can do is destroy the connection.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(appErr.status).json(body);
}
