/**
 * caas-hook-snippet.ts — CaaS Lite 5-Minute Integration Hook
 * Phase 7: Lite Pilot Onboarding
 *
 * FINTECH USAGE:
 *   await sendToCaasVault("client_finco_001", process.env.WEBHOOK_SECRET, "credit.decision.automated",
 *     { applicantId: "app-789", decision: "approved", mfa: true, model: "credit-score-v3" });
 *
 * E-COMMERCE USAGE:
 *   await sendToCaasVault("client_shopco_001", process.env.WEBHOOK_SECRET, "fraud.check.completed",
 *     { orderId: "ord-456", riskScore: 0.12, passed: true });
 *
 * SHADOW SCAN MODE (7-day trial — no alerts, full logging):
 *   await sendToCaasVault("client_001", secret, "user.login",
 *     { userId: "u-123", mfa: false, mode: "shadow_scan" });
 */

import * as crypto from "crypto";

export interface CaaSVaultResponse {
  status:      "accepted" | "error";
  eventId:     string;
  message?:    string;
  shadowScan?: boolean;
}

function generateId(): string {
  return crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

function computeSignature(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf-8").digest("hex");
}

export async function sendToCaasVault(
  clientId:      string,
  webhookSecret: string,
  eventType:     string,
  modelPayload:  Record<string, unknown>,
  endpoint:      string = "http://localhost:3000/webhook"
): Promise<CaaSVaultResponse> {
  const eventId    = generateId();
  const occurredAt = new Date().toISOString();
  const timestamp  = Math.floor(Date.now() / 1000).toString();
  const isShadow   = modelPayload["mode"] === "shadow_scan";

  const body = JSON.stringify({
    id: eventId, type: eventType, occurredAt,
    source: "caas-hook-snippet",
    actor: { id: clientId, name: "CaaS Hook Integration", kind: "service" },
    metadata: modelPayload,
    environment: isShadow ? "shadow_scan" : "production",
  });

  const signature = computeSignature(webhookSecret, body);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-caas-signature": signature,
        "x-caas-timestamp": timestamp,
        "x-caas-event-id":  eventId,
        "x-client-id":      clientId,
      },
      body,
    });

    if (response.status === 202) {
      const data = await response.json() as { eventId?: string };
      return { status: "accepted", eventId: data.eventId ?? eventId, shadowScan: isShadow };
    }
    const errData = await response.json().catch(() => ({})) as { error?: string };
    return { status: "error", eventId, message: errData.error ?? "HTTP " + response.status, shadowScan: isShadow };
  } catch (err) {
    return { status: "error", eventId, message: (err as Error).message, shadowScan: isShadow };
  }
}