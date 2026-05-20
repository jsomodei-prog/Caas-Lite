/**
 * src/lib/errors.ts
 *
 * Centralized error type for the API surface.
 *
 * Design rationale (slice 2):
 *   - Single base class with static factories rather than a union of classes.
 *     Reason: the existing global error handler in app.ts already reads
 *     `status`/`statusCode` off thrown errors. A single base with a `status`
 *     field is a drop-in. Static factories give readable call sites:
 *         throw AppError.badRequest("X-Tenant-ID header is required");
 *     The slice 6 audit becomes a grep for `AppError.` plus a check that
 *     nothing else throws a bare `Error` with `status` hung on it.
 *
 *   - `details` is opaque to the handler — it serializes via the sanitizer,
 *     not via JSON.stringify on the raw object. This is where Zod issue lists
 *     go for 400s. Never put DB rows, secrets, or stack traces here.
 *
 *   - `expose` controls whether `.message` is safe to send to a client in
 *     production. Operator-friendly default: factories for 4xx set expose=true,
 *     the `internal()` factory sets expose=false. The error handler enforces.
 *
 *   - `cause` is preserved for log emission only. Never serialized to clients.
 *
 * This module has no runtime dependencies — safe to import from anywhere,
 * including middleware that runs before the DI container is ready.
 */

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL";

export interface AppErrorOptions {
  /** HTTP status. Required. */
  status: number;
  /** Machine-readable code. */
  code: AppErrorCode;
  /** Human-readable message. Shown to clients iff `expose` is true. */
  message: string;
  /** Whether `.message` is safe to expose to a client in production. */
  expose: boolean;
  /** Optional structured payload (e.g. Zod issues). Sanitized by the handler. */
  details?: unknown;
  /** Underlying error preserved for logs only. Never serialized to clients. */
  cause?: unknown;
}

export class AppError extends Error {
  public readonly status: number;
  public readonly code: AppErrorCode;
  public readonly expose: boolean;
  public readonly details?: unknown;
  public readonly cause?: unknown;

  // Brand for cross-realm-safe detection. `instanceof` is unreliable when
  // the same module is loaded twice (e.g. ts-jest vs ts-node, or via require
  // mid-handler as taxReceipt does — see the slice 6 cleanup list).
  public readonly isAppError = true as const;

  constructor(opts: AppErrorOptions) {
    super(opts.message);
    this.name    = "AppError";
    this.status  = opts.status;
    this.code    = opts.code;
    this.expose  = opts.expose;
    this.details = opts.details;
    this.cause   = opts.cause;

    // Preserve the stack across the super() call.
    if (typeof (Error as unknown as { captureStackTrace?: Function }).captureStackTrace === "function") {
      (Error as unknown as { captureStackTrace: (t: object, c: Function) => void })
        .captureStackTrace(this, this.constructor);
    }
  }

  // ── Factories ──────────────────────────────────────────────────────────────
  // All 4xx default to expose=true. `internal` and `from(unknown)` default to
  // expose=false so a stray throw never leaks an implementation detail.

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError({ status: 400, code: "BAD_REQUEST", message, expose: true, details });
  }

  static unauthorized(message = "Unauthorized"): AppError {
    return new AppError({ status: 401, code: "UNAUTHORIZED", message, expose: true });
  }

  static forbidden(message = "Forbidden"): AppError {
    return new AppError({ status: 403, code: "FORBIDDEN", message, expose: true });
  }

  static notFound(message = "Not Found"): AppError {
    return new AppError({ status: 404, code: "NOT_FOUND", message, expose: true });
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError({ status: 409, code: "CONFLICT", message, expose: true, details });
  }

  static unprocessable(message: string, details?: unknown): AppError {
    return new AppError({ status: 422, code: "UNPROCESSABLE", message, expose: true, details });
  }

  static tooManyRequests(message = "Too Many Requests"): AppError {
    return new AppError({ status: 429, code: "TOO_MANY_REQUESTS", message, expose: true });
  }

  /**
   * Use sparingly — only when the error genuinely is a server fault that
   * the client cannot act on. Prefer a specific 4xx factory wherever possible.
   * `message` is preserved for logs; clients see a generic string in prod.
   */
  static internal(message: string, cause?: unknown): AppError {
    return new AppError({ status: 500, code: "INTERNAL", message, expose: false, cause });
  }

  /**
   * Wrap an unknown thrown value into an AppError without losing the original.
   * Used by the global handler as a last resort.
   */
  static from(err: unknown): AppError {
    if (isAppError(err)) return err;

    // Tolerate the legacy pattern of throwing `Error` with `status` attached.
    if (err instanceof Error) {
      const status = (err as { status?: number; statusCode?: number }).status
                  ?? (err as { status?: number; statusCode?: number }).statusCode;
      if (typeof status === "number" && status >= 400 && status < 500) {
        return new AppError({
          status,
          code: status === 404 ? "NOT_FOUND"
              : status === 401 ? "UNAUTHORIZED"
              : status === 403 ? "FORBIDDEN"
              : status === 409 ? "CONFLICT"
              : status === 422 ? "UNPROCESSABLE"
              : status === 429 ? "TOO_MANY_REQUESTS"
              : "BAD_REQUEST",
          message: err.message,
          expose: true,
          cause:  err,
        });
      }
      return AppError.internal(err.message, err);
    }

    return AppError.internal("Unknown error", err);
  }
}

/** Cross-realm-safe type guard. Prefer this over `instanceof AppError`. */
export function isAppError(x: unknown): x is AppError {
  return typeof x === "object"
      && x !== null
      && (x as { isAppError?: unknown }).isAppError === true;
}
