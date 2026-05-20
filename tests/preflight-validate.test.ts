/**
 * tests/preflight-validate.test.ts
 *
 * Pre-flight verification of src/middleware/validate.ts before applying it
 * across ~37 sub-router routes in Phase 15 slice 7.
 *
 * What this test verifies:
 *   1. validate() emits AppError.badRequest via next(err) on schema failure
 *      (does NOT write to res itself).
 *   2. The error has status=400, code="BAD_REQUEST", and details={section, issues}
 *      where issues is an array of {path, code, message}.
 *   3. On success, req.body / req.query / req.params are REPLACED with the
 *      parsed Zod output (defaults populated, unknown keys stripped).
 *   4. .strict() schemas reject unknown keys.
 *   5. Each section (params, query, body) validates independently; omitting a
 *      section means it's untouched.
 *   6. The req.query getter-assignment fallback works (Express 5 quirk noted
 *      in validate.ts source comments).
 *   7. A schema that throws inside .transform is wrapped via AppError.from
 *      rather than crashing the request.
 *
 * Test harness:
 *   We mount validate() on throwaway Express apps and fire real HTTP requests
 *   via supertest. Each app gets a minimal error handler that serializes the
 *   AppError to JSON so we can assert on the wire shape. The handler is
 *   deliberately unsanitized — the real app uses a sanitizer middleware that
 *   gates exposure based on AppError.expose; we want the full structure
 *   visible here to verify what validate() emits.
 *
 * If this suite passes, validate() works as the slice 7 enumeration doc
 * assumes. If it fails, fix validate() before applying schemas to real
 * routes.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { z } from "zod";
import { validate } from "../src/middleware/validate";
import { AppError, isAppError } from "../src/lib/errors";

// ─── Test Harness ────────────────────────────────────────────────────────────

/**
 * Builds a throwaway Express app with:
 *   - JSON body parsing
 *   - `validate(schemas)` applied to the given route
 *   - A handler that echoes req.body / req.query / req.params so tests can
 *     verify the parsed-and-replaced shapes
 *   - An unsanitized error handler that serializes AppError to JSON
 *
 * The error handler mirrors what the real app handler would emit MINUS the
 * sanitizer step — we want every field visible here.
 */
function buildApp(
  method: "get" | "post" | "patch",
  path: string,
  schemas: Parameters<typeof validate>[0],
) {
  const app = express();
  app.use(express.json());

  app[method](
    path,
    validate(schemas),
    (req: Request, res: Response): void => {
      res.status(200).json({
        body:   req.body,
        query:  req.query,
        params: req.params,
      });
    },
  );

  // Unsanitized error handler — deliberately exposes everything for assertion.
  // Production apps gate this on AppError.expose; tests do not.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      res.status(err.status).json({
        error:   err.message,
        code:    err.code,
        details: err.details,
      });
      return;
    }
    // Anything that escapes as a non-AppError is a bug in validate() — surface it.
    res.status(500).json({
      error:    "Unexpected non-AppError escaped validate()",
      escaped:  String(err),
    });
  });

  return app;
}

// ─── 1. Failure shape ─────────────────────────────────────────────────────────

describe("validate() failure shape", () => {
  it("emits status=400 with code=BAD_REQUEST when body fails schema", async () => {
    const schema = z.object({ name: z.string().min(1) }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app).post("/echo").send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
    expect(res.body.error).toBe("Invalid request body");
  });

  it("includes section='body' and issues[] in details on body failure", async () => {
    const schema = z.object({
      name: z.string().min(1),
      age:  z.number().int(),
    }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app).post("/echo").send({ name: "", age: "not-a-number" });

    expect(res.body.details).toMatchObject({ section: "body" });
    expect(Array.isArray(res.body.details.issues)).toBe(true);
    expect(res.body.details.issues.length).toBeGreaterThan(0);

    // Each issue carries {path, code, message} — the SafeIssue shape.
    for (const issue of res.body.details.issues) {
      expect(issue).toHaveProperty("path");
      expect(issue).toHaveProperty("code");
      expect(issue).toHaveProperty("message");
      expect(Array.isArray(issue.path)).toBe(true);
    }

    // Ensure paths reference the failing fields.
    const paths = res.body.details.issues.map((i: { path: string[] }) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["name", "age"]));
  });

  it("uses section='params' on params failure", async () => {
    const schema = z.object({ id: z.string().uuid() }).strict();
    const app = buildApp("get", "/items/:id", { params: schema });

    const res = await request(app).get("/items/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid path parameters");
    expect(res.body.details.section).toBe("params");
  });

  it("uses section='query' on query failure", async () => {
    const schema = z.object({
      limit: z.coerce.number().int().min(1).max(100),
    }).strict();
    const app = buildApp("get", "/list", { query: schema });

    const res = await request(app).get("/list?limit=9999");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query parameters");
    expect(res.body.details.section).toBe("query");
  });

  it("strips raw input from the error payload (no echo of submitted values)", async () => {
    // The SafeIssue type omits Zod's `received`/`expected` raw input fields.
    // This guards against a future change that re-introduces them — which
    // would risk echoing misrouted secrets back to clients.
    const schema = z.object({ token: z.string().min(64) }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app)
      .post("/echo")
      .send({ token: "this-is-a-secret-that-should-not-be-echoed" });

    expect(res.status).toBe(400);
    const issuesJson = JSON.stringify(res.body.details.issues);
    expect(issuesJson).not.toContain("this-is-a-secret-that-should-not-be-echoed");
  });
});

// ─── 2. Success path — replacement + defaults + stripping ────────────────────

describe("validate() success path", () => {
  it("replaces req.body with the parsed output", async () => {
    const schema = z.object({
      name: z.string(),
      age:  z.number(),
    }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app).post("/echo").send({ name: "Alice", age: 30 });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ name: "Alice", age: 30 });
  });

  it("populates default values from the schema into req.body", async () => {
    const schema = z.object({
      tier:        z.enum(["LITE", "GROWTH"]).default("LITE"),
      pilot_days:  z.number().int().default(30),
    }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app).post("/echo").send({});

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ tier: "LITE", pilot_days: 30 });
  });

  it("strips unknown keys when the schema is .strict()? — NO: .strict() REJECTS them", async () => {
    // Important behavior to pin down: .strict() does NOT silently strip,
    // it REJECTS with an unrecognized_keys issue. .strip() (the default for
    // bare z.object) silently strips. Test both to make the contract explicit.
    const strictSchema = z.object({ name: z.string() }).strict();
    const app = buildApp("post", "/echo", { body: strictSchema });

    const res = await request(app).post("/echo").send({ name: "Alice", extra: "rejected" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
    const codes = res.body.details.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain("unrecognized_keys");
  });

  it("strips unknown keys when the schema uses default (non-strict) z.object", async () => {
    // Companion to the test above — confirms that a bare z.object STRIPS
    // rather than rejects. Slice 7 convention is .strict() everywhere, so
    // this case shouldn't occur in production schemas, but the test makes
    // the behavior explicit so future schema authors know what each mode does.
    const lenientSchema = z.object({ name: z.string() }); // no .strict()
    const app = buildApp("post", "/echo", { body: lenientSchema });

    const res = await request(app).post("/echo").send({ name: "Alice", extra: "ignored" });

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ name: "Alice" }); // extra was silently stripped
  });

  it("coerces query string numbers via z.coerce.number()", async () => {
    const schema = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict();
    const app = buildApp("get", "/list", { query: schema });

    const res = await request(app).get("/list?limit=25");

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ limit: 25 });
    expect(typeof res.body.query.limit).toBe("number");
  });

  it("replaces req.query even though Express 5 may make it a getter", async () => {
    // This is the explicit fallback case noted in validate.ts:
    //   try { req.query = r.data } catch { Object.defineProperty(...) }
    // We can't easily force the getter to throw in a unit test, but we CAN
    // verify the post-condition that req.query reflects the parsed shape.
    // If a future Express upgrade breaks the fallback, this test catches it.
    const schema = z.object({
      page: z.coerce.number().int().default(1),
    }).strict();
    const app = buildApp("get", "/list", { query: schema });

    const res = await request(app).get("/list");

    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ page: 1 });
  });

  it("replaces req.params with the parsed output", async () => {
    const schema = z.object({
      id: z.string().uuid(),
    }).strict();
    const app = buildApp("get", "/items/:id", { params: schema });

    const uuid = "11111111-1111-4111-8111-111111111111";
    const res = await request(app).get(`/items/${uuid}`);

    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id: uuid });
  });
});

// ─── 3. Section independence ─────────────────────────────────────────────────

describe("validate() section independence", () => {
  it("leaves req.body untouched when only params schema is provided", async () => {
    const schema = z.object({ id: z.string().uuid() }).strict();
    const app = buildApp("post", "/items/:id", { params: schema });

    const uuid = "11111111-1111-4111-8111-111111111111";
    const res = await request(app)
      .post(`/items/${uuid}`)
      .send({ anything: "goes", extra: 123 });

    expect(res.status).toBe(200);
    // Body is untouched — validate() didn't strip or reject the extra keys.
    expect(res.body.body).toEqual({ anything: "goes", extra: 123 });
  });

  it("validates all three sections when all are provided", async () => {
    const app = buildApp("patch", "/items/:id", {
      params: z.object({ id: z.string().uuid() }).strict(),
      query:  z.object({ force: z.enum(["true", "false"]).optional() }).strict(),
      body:   z.object({ name: z.string().min(1) }).strict(),
    });

    const uuid = "22222222-2222-4222-8222-222222222222";
    const res = await request(app)
      .patch(`/items/${uuid}?force=true`)
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id: uuid });
    expect(res.body.query).toEqual({ force: "true" });
    expect(res.body.body).toEqual({ name: "Updated" });
  });

  it("short-circuits on the first failing section (params before body)", async () => {
    // If both params and body would fail, params is checked first per the
    // validate() implementation (params → query → body order). The error
    // should report section=params.
    const app = buildApp("post", "/items/:id", {
      params: z.object({ id: z.string().uuid() }).strict(),
      body:   z.object({ name: z.string().min(1) }).strict(),
    });

    const res = await request(app)
      .post("/items/not-a-uuid")
      .send({ name: "" }); // body would also fail, but params fails first

    expect(res.status).toBe(400);
    expect(res.body.details.section).toBe("params");
  });
});

// ─── 4. Defensive handling of buggy schemas ──────────────────────────────────

describe("validate() defensive error handling", () => {
  it("wraps a throwing .transform() via AppError.from rather than crashing", async () => {
    // A buggy schema (e.g. .transform that throws) shouldn't crash the
    // request. validate.ts catches and wraps via AppError.from.
    const schema = z.object({
      x: z.string().transform(() => {
        throw new Error("schema bug");
      }),
    }).strict();
    const app = buildApp("post", "/echo", { body: schema });

    const res = await request(app).post("/echo").send({ x: "anything" });

    // AppError.from wraps a plain Error as a 500 (INTERNAL). Confirms the
    // try/catch in validate.ts caught the throw rather than letting it
    // become an unhandled rejection.
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
  });
});
