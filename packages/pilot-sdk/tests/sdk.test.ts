/**
 * tests/sdk.test.ts
 * Unit tests for @caas/pilot-sdk.
 *
 * The SDK has four critical behavioural contracts that must hold:
 *   1. Never throws into the host process (constructor, record, flush).
 *   2. Queue is bounded — oldest entries drop FIFO on overflow.
 *   3. Network failures are routed to onError, never raised.
 *   4. flush() returns within SHUTDOWN_FLUSH_BUDGET_MS regardless of state.
 *
 * Each contract has at least one test. The HTTP behaviour is verified
 * against a local stub server using Node's built-in `http` module so
 * the test has no external dependencies.
 */

import http from "http";
import { AddressInfo } from "net";
import { CaaSPilot, type PilotDecision } from "../src/index";

// ─── Stub server ──────────────────────────────────────────────────────────────

interface StubServer {
  baseUrl:       string;
  receivedBodies: unknown[];
  close:         () => Promise<void>;
  /** Forces the server to respond with the given status to all requests. */
  setStatus:     (status: number) => void;
  /** Forces the server to hang forever (test timeout behaviour). */
  setHang:       (hang: boolean) => void;
}

function startStubServer(): Promise<StubServer> {
  return new Promise((resolve) => {
    const state = { status: 202, hang: false };
    const received: unknown[] = [];

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (state.hang) return; // never respond
        try {
          received.push(JSON.parse(body));
        } catch { received.push(body); }
        res.statusCode = state.status;
        res.end(JSON.stringify({ accepted: 1 }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl:        `http://127.0.0.1:${port}`,
        receivedBodies: received,
        setStatus:      (s) => { state.status = s; },
        setHang:        (h) => { state.hang   = h; },
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("@caas/pilot-sdk — construction contract", () => {

  test("constructor never throws on missing apiKey", () => {
    const errors: Error[] = [];
    const pilot = new CaaSPilot({
      apiKey:  "",
      baseUrl: "http://localhost:9999",
      onError: (e) => errors.push(e),
    });
    expect(pilot).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/apiKey and baseUrl/);
    pilot.stop();
  });

  test("constructor never throws on missing baseUrl", () => {
    const errors: Error[] = [];
    const pilot = new CaaSPilot({
      apiKey:  "caas_x",
      baseUrl: "",
      onError: (e) => errors.push(e),
    });
    expect(errors.length).toBeGreaterThan(0);
    pilot.stop();
  });

  test("disabled SDK silently drops record() calls", () => {
    const pilot = new CaaSPilot({ apiKey: "", baseUrl: "" });
    expect(() => pilot.record({ decision_class: "x" })).not.toThrow();
    pilot.stop();
  });
});

describe("@caas/pilot-sdk — record() contract", () => {

  test("record() returns synchronously and never throws", () => {
    const pilot = new CaaSPilot({
      apiKey:  "caas_test",
      baseUrl: "http://127.0.0.1:1",   // unreachable port
    });
    const start = Date.now();
    pilot.record({ decision_class: "fraud_score", risk_score: 0.5 });
    expect(Date.now() - start).toBeLessThan(50);
    pilot.stop();
  });

  test("record() drops oldest when queue exceeds maxQueueSize (FIFO)", () => {
    const pilot = new CaaSPilot({
      apiKey:       "caas_test",
      baseUrl:      "http://127.0.0.1:1",
      maxQueueSize: 3,
      // Don't start background flush — we want to inspect queue state directly
      flushIntervalMs: 60_000,
    });
    // Inject 5 decisions into a queue of size 3
    pilot.record({ client_decision_id: "1" });
    pilot.record({ client_decision_id: "2" });
    pilot.record({ client_decision_id: "3" });
    pilot.record({ client_decision_id: "4" });
    pilot.record({ client_decision_id: "5" });

    // Access internal queue for assertion. This is the one place the test
    // reaches past the public API; documented as intentional.
    const queue = (pilot as unknown as { queue: PilotDecision[] }).queue;
    expect(queue.length).toBe(3);
    expect(queue[0].client_decision_id).toBe("3");   // oldest two dropped
    expect(queue[2].client_decision_id).toBe("5");

    pilot.stop();
  });
});

describe("@caas/pilot-sdk — network behaviour", () => {
  let server: StubServer;

  beforeEach(async () => { server = await startStubServer(); });
  afterEach(async  () => { await server.close(); });

  test("posts decisions to the configured endpoint", async () => {
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key_64_hex_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 50,
    });
    pilot.record({ decision_class: "fraud_score", risk_score: 0.7 });

    // Wait for at least one background flush cycle
    await wait(200);

    expect(server.receivedBodies.length).toBeGreaterThan(0);
    const body = server.receivedBodies[0] as { decisions: PilotDecision[] };
    expect(body.decisions).toBeDefined();
    expect(body.decisions[0].decision_class).toBe("fraud_score");

    pilot.stop();
  });

  test("HTTP 500 responses are surfaced to onError, not thrown", async () => {
    server.setStatus(500);
    const errors: Error[] = [];
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 50,
      onError:         (e) => errors.push(e),
    });
    pilot.record({ decision_class: "x" });
    await wait(200);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/HTTP 500/);
    pilot.stop();
  });

  test("failed batches are re-queued at the front (retry preserves order)", async () => {
    server.setStatus(500);
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 50,
    });
    pilot.record({ client_decision_id: "a" });
    pilot.record({ client_decision_id: "b" });
    await wait(150);

    // The 500 means both decisions should be re-queued. Recovery: flip
    // the server to 202 and wait for next flush.
    server.setStatus(202);
    await wait(200);

    expect(server.receivedBodies.length).toBeGreaterThan(0);
    const successful = server.receivedBodies.find((b) => {
      const body = b as { decisions: PilotDecision[] };
      return body.decisions?.some(d => d.client_decision_id === "a");
    });
    expect(successful).toBeDefined();

    pilot.stop();
  });

  test("timeout failures are surfaced to onError, not thrown", async () => {
    server.setHang(true);
    const errors: Error[] = [];
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 50,
      timeoutMs:       100,
      onError:         (e) => errors.push(e),
    });
    pilot.record({ decision_class: "x" });
    await wait(400);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => /timed out/i.test(e.message))).toBe(true);
    pilot.stop();
  });
});

describe("@caas/pilot-sdk — flush() contract", () => {
  let server: StubServer;
  beforeEach(async () => { server = await startStubServer(); });
  afterEach(async  () => { await server.close(); });

  test("flush() drains the queue when network is healthy", async () => {
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 60_000,   // long, so only flush() drains
    });
    for (let i = 0; i < 5; i++) pilot.record({ client_decision_id: String(i) });

    await pilot.flush();

    const totalReceived = server.receivedBodies.reduce((s, b) => {
      const body = b as { decisions?: PilotDecision[] };
      return s + (body.decisions?.length ?? 0);
    }, 0);
    expect(totalReceived).toBe(5);
  });

  test("flush() returns within ~5s even if network never responds", async () => {
    server.setHang(true);
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         server.baseUrl,
      flushIntervalMs: 60_000,
      timeoutMs:       200,
    });
    for (let i = 0; i < 3; i++) pilot.record({ client_decision_id: String(i) });

    const start = Date.now();
    await pilot.flush();
    const elapsed = Date.now() - start;

    // The budget is 5s. Give a small grace margin for slow CI.
    expect(elapsed).toBeLessThan(6_000);
  });

  test("flush() never throws even with malformed baseUrl", async () => {
    const pilot = new CaaSPilot({
      apiKey:          "caas_test_key",
      baseUrl:         "http://[invalid",
      flushIntervalMs: 60_000,
    });
    pilot.record({ decision_class: "x" });

    await expect(pilot.flush()).resolves.toBeUndefined();
  });
});
