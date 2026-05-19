/**
 * src/public/badge.ts
 * Phase 15 — Trust Badge embeddable client.
 *
 * Embed on a customer-facing page (their site, their dashboard, etc.):
 *
 *   <div id="caas-badge"
 *        data-tenant="acme_corp"
 *        data-signature="a4f5db6..."
 *        data-base-url="https://api.caas.example.com"></div>
 *   <script src="https://cdn.caas.example.com/badge.js" defer></script>
 *
 * The script reads the data-attributes, polls the badge endpoint every
 * 30 seconds (with a one-shot initial fetch), and replaces the div's
 * contents with an SVG matching the current state.
 *
 * States:
 *   green   ACTIVE — pilot in good standing
 *   amber   anomaly ratio approaching threshold (drift detected)
 *   red     warranty voided (compliance drift or anomaly ratio breach)
 *
 * Compiles to ES2017 plain JS. No framework dependency.
 *
 * TODO(phase15): publish as @caas/trust-badge with a versioned CDN URL.
 */

interface BadgeStateResponse {
  badge_state:      "green" | "amber" | "red";
  state_reason:     string | null;
  state_changed_at: string;
}

interface BadgeConfig {
  tenantId:    string;
  signature:   string;
  baseUrl:     string;
  pollMs:      number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 30_000;
const ELEMENT_ID      = "caas-badge";

const SVG_BY_STATE: Record<BadgeStateResponse["badge_state"], string> = {
  green: renderShield("#16a34a", "Verified",   "✓"),
  amber: renderShield("#d97706", "Monitoring", "!"),
  red:   renderShield("#dc2626", "Suspended",  "✕"),
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function readConfig(el: HTMLElement): BadgeConfig | null {
  const tenantId  = el.dataset.tenant;
  const signature = el.dataset.signature;
  const baseUrl   = el.dataset.baseUrl;

  if (!tenantId || !signature || !baseUrl) {
    // Silent fail — same philosophy as the SDK. The embedder shouldn't get
    // a broken page just because they forgot a data attribute. Log to the
    // console for developer visibility.
    // eslint-disable-next-line no-console
    console.warn("[caas-badge] Missing data attributes; badge disabled.");
    return null;
  }

  const pollAttr = el.dataset.pollMs;
  const pollMs   = pollAttr ? Math.max(parseInt(pollAttr, 10) || DEFAULT_POLL_MS, 5_000) : DEFAULT_POLL_MS;

  return { tenantId, signature, baseUrl: baseUrl.replace(/\/+$/, ""), pollMs };
}

async function fetchBadgeState(cfg: BadgeConfig): Promise<BadgeStateResponse | null> {
  try {
    const url = `${cfg.baseUrl}/api/v1/badge/${encodeURIComponent(cfg.tenantId)}` +
                `?sig=${encodeURIComponent(cfg.signature)}`;
    const res = await fetch(url, { method: "GET", credentials: "omit" });
    if (!res.ok) return null;
    return (await res.json()) as BadgeStateResponse;
  } catch {
    return null;   // Network failure → leave previous render in place
  }
}

function render(el: HTMLElement, state: BadgeStateResponse | null): void {
  if (!state) {
    // First-render failure: show a neutral placeholder rather than nothing.
    // On subsequent failures, render() isn't called (we keep the prior state).
    if (!el.hasChildNodes()) {
      el.innerHTML = renderShield("#6b7280", "Loading", "…");
    }
    return;
  }

  el.innerHTML = SVG_BY_STATE[state.badge_state];
  el.setAttribute("title",
    state.state_reason ?? `CaaS pilot status: ${state.badge_state}`);
  el.setAttribute("data-state", state.badge_state);
}

function renderShield(color: string, label: string, glyph: string): string {
  // Compact, self-contained SVG. 144x40 fits inline on most pages.
  // No external font imports — uses the page's default sans-serif.
  return `
    <svg width="144" height="40" viewBox="0 0 144 40" xmlns="http://www.w3.org/2000/svg"
         role="img" aria-label="CaaS pilot status: ${label}">
      <rect x="0" y="0" width="144" height="40" rx="6" fill="${color}"/>
      <text x="12" y="26" font-family="system-ui, sans-serif" font-size="18"
            font-weight="700" fill="white">${glyph}</text>
      <text x="32" y="17" font-family="system-ui, sans-serif" font-size="9"
            font-weight="600" fill="white" opacity="0.85">CaaS PILOT</text>
      <text x="32" y="30" font-family="system-ui, sans-serif" font-size="13"
            font-weight="700" fill="white">${label}</text>
    </svg>
  `.trim();
}

function start(): void {
  const el = document.getElementById(ELEMENT_ID);
  if (!el) return;

  const cfg = readConfig(el);
  if (!cfg) return;

  // Initial fetch + render
  void (async () => {
    const state = await fetchBadgeState(cfg);
    render(el, state);
  })();

  // Background polling. Page-visibility-aware: don't poll when hidden.
  setInterval(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const state = await fetchBadgeState(cfg);
    if (state) render(el, state);
  }, cfg.pollMs);
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

// Exported for testability. The compiled JS runs the entrypoint above
// automatically; consumers don't need to call anything.
export { start, fetchBadgeState, renderShield };
