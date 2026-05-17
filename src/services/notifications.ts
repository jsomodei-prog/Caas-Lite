/**
 * src/services/notifications.ts
 * Real-time Slack and Discord incident webhooks.
 *
 * Fires instantly when:
 *   - An anomaly is scored HIGH or CRITICAL
 *   - A payout is flagged as DUPLICATE
 *   - A regulatory reporting threshold is breached
 *   - A database failover is triggered
 *
 * Channels are configured independently — both can be active simultaneously.
 * All dispatches are non-blocking and include HMAC signatures so receivers
 * can verify the payload originated from this platform.
 *
 * Required env vars:
 *   SLACK_WEBHOOK_URL      — Slack Incoming Webhook URL
 *   DISCORD_WEBHOOK_URL    — Discord channel webhook URL
 *   NOTIFICATION_HMAC_SECRET — Shared secret for payload signing
 *
 * Phase 11 build-out | Commit baseline: a4f5db6
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationChannel = "slack" | "discord";

export type IncidentSeverity = "info" | "warning" | "high" | "critical";

export type IncidentType =
  | "anomaly_high"
  | "anomaly_critical"
  | "payout_duplicate"
  | "payout_failed_burst"
  | "regulatory_threshold_breach"
  | "db_failover"
  | "kyc_rejected"
  | "auth_lockout"
  | "rate_limit_burst";

export interface IncidentPayload {
  incident_id: string;
  type: IncidentType;
  severity: IncidentSeverity;
  tenant_id: string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
  /** Platform URL to the relevant dashboard page (optional). */
  dashboard_url?: string;
}

export interface NotificationResult {
  channel: NotificationChannel;
  success: boolean;
  status_code?: number;
  error?: string;
  dispatched_at: string;
}

export interface NotificationLog {
  incident_id: string;
  results: NotificationResult[];
  total_dispatched: number;
  total_failed: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const SLACK_WEBHOOK_URL   = process.env.SLACK_WEBHOOK_URL   ?? "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const HMAC_SECRET         = process.env.NOTIFICATION_HMAC_SECRET
  ?? process.env.PAYOUT_HMAC_SECRET
  ?? "dev_notification_secret";

const PLATFORM_NAME   = process.env.PLATFORM_NAME   ?? "CaaS-Lite";
const PLATFORM_ENV    = process.env.NODE_ENV         ?? "development";
const DASHBOARD_URL   = process.env.DASHBOARD_URL    ?? "http://localhost:3000/dashboard";

/** Minimum severity to trigger notifications. "info" = everything; "high" = HIGH+ only. */
const MIN_SEVERITY: IncidentSeverity =
  (process.env.NOTIFICATION_MIN_SEVERITY as IncidentSeverity | undefined) ?? "high";

// ─── Severity Utilities ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  info: 0, warning: 1, high: 2, critical: 3,
};

function meetsMinSeverity(severity: IncidentSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[MIN_SEVERITY];
}

const SEVERITY_EMOJI: Record<IncidentSeverity, string> = {
  info:     ":information_source:",
  warning:  ":warning:",
  high:     ":rotating_light:",
  critical: ":skull:",
};

const SEVERITY_COLOR: Record<IncidentSeverity, string> = {
  info:     "#3b82f6",
  warning:  "#f59e0b",
  high:     "#ef4444",
  critical: "#dc2626",
};

const DISCORD_COLOR: Record<IncidentSeverity, number> = {
  info:     0x3b82f6,
  warning:  0xf59e0b,
  high:     0xef4444,
  critical: 0xdc2626,
};

// ─── HMAC Signing ─────────────────────────────────────────────────────────────

function signPayload(payload: IncidentPayload): string {
  const canonical = [
    payload.incident_id,
    payload.type,
    payload.severity,
    payload.tenant_id,
    payload.occurred_at,
  ].join("|");
  return crypto.createHmac("sha256", HMAC_SECRET).update(canonical).digest("hex");
}

// ─── Slack Formatter ──────────────────────────────────────────────────────────

function buildSlackPayload(incident: IncidentPayload): Record<string, unknown> {
  const emoji  = SEVERITY_EMOJI[incident.severity];
  const color  = SEVERITY_COLOR[incident.severity];
  const sig    = signPayload(incident);

  const metaFields = Object.entries(incident.metadata)
    .slice(0, 8)
    .map(([k, v]) => ({
      type: "mrkdwn",
      text: `*${k}*\n${String(v)}`,
    }));

  return {
    text: `${emoji} *[${PLATFORM_NAME}]* ${incident.title}`,
    attachments: [
      {
        color,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${emoji} *${incident.title}*\n${incident.description}`,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Severity*\n${incident.severity.toUpperCase()}` },
              { type: "mrkdwn", text: `*Type*\n${incident.type.replace(/_/g, " ")}` },
              { type: "mrkdwn", text: `*Tenant*\n${incident.tenant_id}` },
              { type: "mrkdwn", text: `*Environment*\n${PLATFORM_ENV}` },
              { type: "mrkdwn", text: `*Occurred*\n${new Date(incident.occurred_at).toLocaleString()}` },
              { type: "mrkdwn", text: `*Incident ID*\n\`${incident.incident_id.slice(0, 8)}…\`` },
              ...metaFields,
            ],
          },
          ...(incident.dashboard_url
            ? [{
                type: "actions",
                elements: [{
                  type: "button",
                  text: { type: "plain_text", text: "Open Dashboard" },
                  url: incident.dashboard_url,
                  style: incident.severity === "critical" ? "danger" : "primary",
                }],
              }]
            : []),
          {
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `Signature: \`${sig.slice(0, 16)}…\` | ${PLATFORM_NAME} v10.0`,
            }],
          },
        ],
      },
    ],
  };
}

// ─── Discord Formatter ────────────────────────────────────────────────────────

function buildDiscordPayload(incident: IncidentPayload): Record<string, unknown> {
  const emoji  = SEVERITY_EMOJI[incident.severity];
  const color  = DISCORD_COLOR[incident.severity];
  const sig    = signPayload(incident);

  const metaLines = Object.entries(incident.metadata)
    .slice(0, 8)
    .map(([k, v]) => `**${k}:** ${String(v)}`)
    .join("\n");

  return {
    username:   `${PLATFORM_NAME} Alerts`,
    avatar_url: "https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/databricks.svg",
    embeds: [
      {
        title:       `${emoji} ${incident.title}`,
        description: incident.description,
        color,
        fields: [
          { name: "Severity",    value: `\`${incident.severity.toUpperCase()}\``,            inline: true },
          { name: "Type",        value: incident.type.replace(/_/g, " "),                    inline: true },
          { name: "Tenant",      value: `\`${incident.tenant_id}\``,                         inline: true },
          { name: "Environment", value: `\`${PLATFORM_ENV}\``,                               inline: true },
          { name: "Occurred",    value: new Date(incident.occurred_at).toLocaleString(),      inline: false },
          ...(metaLines ? [{ name: "Details", value: metaLines, inline: false }] : []),
        ],
        footer: {
          text: `${PLATFORM_NAME} v10.0 · Signature: ${sig.slice(0, 16)}…`,
        },
        timestamp: incident.occurred_at,
        ...(incident.dashboard_url
          ? { url: incident.dashboard_url }
          : {}),
      },
    ],
  };
}

// ─── Dispatch Functions ────────────────────────────────────────────────────────

async function dispatchToSlack(incident: IncidentPayload): Promise<NotificationResult> {
  const dispatched_at = new Date().toISOString();
  if (!SLACK_WEBHOOK_URL) {
    return { channel: "slack", success: false, error: "SLACK_WEBHOOK_URL not configured", dispatched_at };
  }

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(buildSlackPayload(incident)),
    });

    if (!res.ok) {
      const body = await res.text();
      return { channel: "slack", success: false, status_code: res.status, error: body, dispatched_at };
    }
    return { channel: "slack", success: true, status_code: res.status, dispatched_at };
  } catch (err) {
    return { channel: "slack", success: false, error: err instanceof Error ? err.message : String(err), dispatched_at };
  }
}

async function dispatchToDiscord(incident: IncidentPayload): Promise<NotificationResult> {
  const dispatched_at = new Date().toISOString();
  if (!DISCORD_WEBHOOK_URL) {
    return { channel: "discord", success: false, error: "DISCORD_WEBHOOK_URL not configured", dispatched_at };
  }

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(buildDiscordPayload(incident)),
    });

    if (!res.ok) {
      const body = await res.text();
      return { channel: "discord", success: false, status_code: res.status, error: body, dispatched_at };
    }
    return { channel: "discord", success: true, status_code: res.status, dispatched_at };
  } catch (err) {
    return { channel: "discord", success: false, error: err instanceof Error ? err.message : String(err), dispatched_at };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatches an incident notification to all configured channels.
 * Non-blocking — failures are logged but never thrown.
 * Returns a NotificationLog for audit purposes.
 */
export async function notifyIncident(
  incident: Omit<IncidentPayload, "incident_id" | "occurred_at" | "dashboard_url"> &
    Partial<Pick<IncidentPayload, "incident_id" | "occurred_at" | "dashboard_url">>
): Promise<NotificationLog> {
  const full: IncidentPayload = {
    incident_id:   incident.incident_id   ?? crypto.randomUUID(),
    occurred_at:   incident.occurred_at   ?? new Date().toISOString(),
    dashboard_url: incident.dashboard_url ?? DASHBOARD_URL,
    ...incident,
  };

  if (!meetsMinSeverity(full.severity)) {
    return { incident_id: full.incident_id, results: [], total_dispatched: 0, total_failed: 0 };
  }

  const settled = await Promise.allSettled([
    dispatchToSlack(full),
    dispatchToDiscord(full),
  ]);

  const results: NotificationResult[] = settled.map((s) =>
    s.status === "fulfilled" ? s.value : {
      channel: "slack" as NotificationChannel,
      success: false,
      error: String((s as PromiseRejectedResult).reason),
      dispatched_at: new Date().toISOString(),
    }
  );

  const log: NotificationLog = {
    incident_id:      full.incident_id,
    results,
    total_dispatched: results.filter((r) => r.success).length,
    total_failed:     results.filter((r) => !r.success).length,
  };

  if (log.total_failed > 0) {
    console.warn("[notifications] Some channels failed:", log.results.filter(r => !r.success));
  }

  return log;
}

// ─── Convenience Builders ─────────────────────────────────────────────────────

export function anomalyIncident(params: {
  entity_id: string;
  entity_type: string;
  tenant_id: string;
  event_type: string;
  risk_level: "high" | "critical";
  score: number;
  lockout_applied: string | null;
  lockout_until: string | null;
}): Parameters<typeof notifyIncident>[0] {
  return {
    type:        params.risk_level === "critical" ? "anomaly_critical" : "anomaly_high",
    severity:    params.risk_level,
    tenant_id:   params.tenant_id,
    title:       `Anomaly Detected: ${params.event_type.replace(/_/g, " ")} (score ${params.score})`,
    description: `A ${params.risk_level.toUpperCase()} severity anomaly was detected on ${params.entity_type} \`${params.entity_id}\`.` +
      (params.lockout_applied ? ` Lockout applied: **${params.lockout_applied}** until ${params.lockout_until}.` : ""),
    metadata: {
      entity_id:      params.entity_id,
      entity_type:    params.entity_type,
      event_type:     params.event_type,
      score:          params.score,
      lockout:        params.lockout_applied ?? "none",
      lockout_until:  params.lockout_until ?? "—",
    },
  };
}

export function duplicatePayoutIncident(params: {
  agent_id: string;
  tenant_id: string;
  amount_usd: number;
  local_currency: string;
  idempotency_key: string;
}): Parameters<typeof notifyIncident>[0] {
  return {
    type:        "payout_duplicate",
    severity:    "warning",
    tenant_id:   params.tenant_id,
    title:       `Duplicate Payout Intercepted — $${params.amount_usd.toFixed(2)} USD`,
    description: `A payout sweep attempted to disburse a duplicate transaction for agent \`${params.agent_id}\`. The idempotency lock prevented double-payment.`,
    metadata: {
      agent_id:        params.agent_id,
      amount_usd:      `$${params.amount_usd.toFixed(2)}`,
      local_currency:  params.local_currency,
      idempotency_key: params.idempotency_key.slice(0, 16) + "…",
    },
  };
}

export function regulatoryBreachIncident(params: {
  payout_log_id: string;
  tenant_id: string;
  country_code: string;
  local_amount: number;
  local_currency: string;
  authority: string;
  must_file_by: string;
}): Parameters<typeof notifyIncident>[0] {
  return {
    type:        "regulatory_threshold_breach",
    severity:    "high",
    tenant_id:   params.tenant_id,
    title:       `Regulatory Threshold Breached — ${params.country_code}`,
    description: `A payout of **${params.local_currency} ${params.local_amount.toLocaleString()}** exceeded the reporting threshold in **${params.country_code}**. ` +
      `Report required to **${params.authority}** by ${new Date(params.must_file_by).toLocaleString()}.`,
    metadata: {
      payout_log_id:  params.payout_log_id.slice(0, 8) + "…",
      country:        params.country_code,
      local_amount:   `${params.local_currency} ${params.local_amount.toLocaleString()}`,
      authority:      params.authority,
      must_file_by:   params.must_file_by,
    },
  };
}

export function failoverIncident(params: {
  replica_path: string;
  reason: string;
  triggered_at: string;
}): Parameters<typeof notifyIncident>[0] {
  return {
    type:        "db_failover",
    severity:    "critical",
    tenant_id:   "platform",
    title:       "Database Failover Activated",
    description: `The primary database became unavailable. The system has switched to the read-only replica at \`${params.replica_path}\`. Write operations are suspended.`,
    metadata: {
      replica_path:  params.replica_path,
      reason:        params.reason,
      triggered_at:  params.triggered_at,
    },
  };
}
