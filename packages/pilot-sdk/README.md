# @caas/pilot-sdk

A silent, bounded-queue Listen Mode client for shadow governance pilots.

The SDK pipes your AI decisions to the CaaS platform without ever blocking, throwing, or interfering with your application's normal operation. Designed for pilot deployments where any disruption is unacceptable.

## Install

```bash
npm install @caas/pilot-sdk
```

Requires Node.js 18 or higher. No runtime dependencies — uses only Node built-ins.

## Quick start

```typescript
import { CaaSPilot } from "@caas/pilot-sdk";

const pilot = new CaaSPilot({
  apiKey:  process.env.CAAS_API_KEY!,
  baseUrl: "https://api.caas.example.com",
});

// Wherever your AI decisions happen:
pilot.record({
  decision_class:     "fraud_score",
  risk_score:         0.83,
  client_decision_id: transactionId,
  payload:            { reason: "velocity", flagged_fields: ["amount", "ip"] },
});

// On graceful shutdown:
process.on("SIGTERM", async () => {
  await pilot.flush();
  process.exit(0);
});
```

## Design contract

The SDK guarantees four properties:

1. **Never throws into the host process.** Constructor, `record()`, and `flush()` will not propagate exceptions. Misconfiguration silently disables the SDK and routes errors to `onError`.
2. **Never blocks.** `record()` returns synchronously after enqueueing; HTTP I/O runs on a background timer.
3. **Bounded memory.** The in-memory queue caps at `maxQueueSize` (default 1000). When full, oldest entries are dropped (FIFO).
4. **`flush()` returns within 5s.** Regardless of network state. Use it in shutdown handlers.

## Configuration

| Option | Default | Description |
|---|---|---|
| `apiKey` | (required) | Your CaaS API key (`caas_...`). |
| `baseUrl` | (required) | CaaS endpoint, no trailing slash. |
| `timeoutMs` | `2000` | Per-request HTTP timeout. |
| `flushIntervalMs` | `1000` | How often the background flush runs. |
| `maxQueueSize` | `1000` | Hard cap on in-memory queue. |
| `batchSize` | `50` | Max decisions per HTTP request. |
| `onError` | (no-op) | `(err: Error, context: string) => void`. Visibility into failures. |

## Decision shape

All fields optional except as your platform requires:

```typescript
interface PilotDecision {
  client_decision_id?: string;            // your correlation key
  decision_class?:     string;            // e.g. "fraud_score", "content_mod"
  risk_score?:         number;            // your numeric confidence/risk
  payload?:            Record<string, unknown>;   // free-form, capped at 8KB on the server
}
```

## Troubleshooting

**The SDK seems disabled and I don't know why.** Pass an `onError` callback when constructing the client. Misconfigured SDKs emit a clear error to that callback at construction time.

**My decisions aren't arriving on the platform.** Set `onError` and check for HTTP status codes or timeouts. Common causes: wrong `baseUrl`, expired API key, network egress blocked.

**My host process won't exit cleanly.** The background timer is `unref()`'d, so it shouldn't keep the event loop alive. If it does, call `pilot.stop()` explicitly before exit.

**I see decisions arriving in batches I didn't intend.** That's by design — the SDK batches up to `batchSize` per HTTP request to reduce overhead. Set `batchSize: 1` if you need one-per-request, with the understanding that this multiplies network calls.

## License

Proprietary. See `LICENSE` for terms.
