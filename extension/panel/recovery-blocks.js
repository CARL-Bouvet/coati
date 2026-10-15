// Coati side panel — error recovery blocks and broker error text (split of panel.js).
import { t } from "../lib/i18n-page.js";
import { api } from "../lib/browser-compat.js";
import { describeError } from "../lib/labels.js";
import { panelState } from "./panel-state.js";
import { pendingRetries } from "./chat-stream.js";
import { currentProvider, currentProviderLinks, openProviderSettings, SESSION_AUTH_PROVIDERS } from "./model-status.js";
import { retryRequest } from "./request-watch.js";

// --- Quota / rate-limit / overloaded / model-missing recovery -------------
// ("parcours panne model")
//
// quota-exceeded: no credit left at the provider — a billing link plus a
// retry (the user may have just topped up).
// rate-limited / provider-overloaded: too many requests, or the provider
// itself overloaded — the fix is waiting, so the block is a disabled "retry"
// button with a plain-text countdown when the broker gave retryAfterSec,
// enabled immediately otherwise (no reduced-motion concern either way: it's
// text, not an animation).
// model-missing: the provider is fine, this one model isn't available on the
// account — the fix is a settings change, no retry offered.
const QUOTA_RATE_TEXT = {
  // Opens the provider's settings card — see AUTH_REQUIRED_TEXT above.
  openSettings: t("panel_open_settings"),
  retryNow: t("panel_retry_now"),
};

/** A new-tab external link (keysUrl/billingUrl) — target=_blank + rel
 * noopener, never innerHTML, same discipline as every other recovery block. */
export function buildExternalLink(label, href) {
  const link = document.createElement("a");
  link.className = "recovery-copy";
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = label;
  return link;
}

/** Spec (parcours-panne-modele-02-10.md): "Add credit at [Provider]"
 * (billingUrl, external) + "Retry". Falls back to "Open settings"
 * when the provider/billing page isn't known (ollama has no billing page at
 * all, and reaches this with currentProviderLinks() undefined). */
export function buildQuotaRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  const links = currentProviderLinks();
  if (links?.billingUrl) {
    block.appendChild(buildExternalLink(t("panel_recharge_at", [links.name]), links.billingUrl));
  } else {
    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "recovery-copy";
    settingsBtn.textContent = QUOTA_RATE_TEXT.openSettings;
    settingsBtn.addEventListener("click", () => openProviderSettings(currentProvider));
    block.appendChild(settingsBtn);
  }
  if (pendingRetries.has(msg.id)) appendRetryButton(block, msg);
  return block;
}

/** "model-unavailable" (uncertain diagnosis — model unreachable, or the
 * broker's own 120s timeout): Retry (when the payload survived a reload)
 * + a provider-aware "Open settings" (falls back to the tutorial when
 * no provider is known yet). */
export function buildModelUnavailableRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  if (pendingRetries.has(msg.id)) appendRetryButton(block, msg);
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "recovery-copy";
  settingsBtn.textContent = t("neverConnectedAction");
  settingsBtn.addEventListener("click", () => openProviderSettings(currentProvider));
  block.appendChild(settingsBtn);
  return block;
}

/** provider-overloaded: Retry only (spec: never "open settings" —
 * the provider itself is busy, nothing to fix here). */
export function buildProviderOverloadRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  appendRetryButton(block, msg);
  return block;
}

/** model-missing: the provider is reachable, it's specifically this model
 * that's refused — the fix is always a settings change, no retry. */
export function buildModelMissingRecoveryBlock() {
  const block = document.createElement("div");
  block.className = "recovery-block";
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "recovery-copy";
  settingsBtn.textContent = t("neverConnectedAction");
  settingsBtn.addEventListener("click", () => openProviderSettings(currentProvider));
  block.appendChild(settingsBtn);
  return block;
}

export function buildRateLimitRecoveryBlock(msg) {
  const block = document.createElement("div");
  block.className = "recovery-block";
  appendRetryButton(block, msg);
  return block;
}

/** Builds and appends the shared retry button (rate-limited/provider-
 * overloaded/quota-exceeded/model-unavailable all use the exact same
 * mechanics: a countdown when the broker gave retryAfterSec, an immediately
 * enabled button otherwise). */
function appendRetryButton(block, msg) {
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "recovery-retry";
  retryBtn.textContent = QUOTA_RATE_TEXT.retryNow;
  block.appendChild(retryBtn);
  armRateLimitRetry(retryBtn, msg);
  return retryBtn;
}

/** Disables `button` until `msg.retryAfterSec` elapses, updating its label
 * every second with a plain-text countdown — no CSS animation, so this is
 * reduced-motion-safe by construction. Enabled right away when the broker
 * sent no retryAfterSec, or once pendingRetries/activeRequestId allow it. */
function armRateLimitRetry(button, msg) {
  const canRetry = () => pendingRetries.has(msg.id) && !panelState.activeRequestId;
  let remaining = msg.retryAfterSec ?? 0;
  const tick = () => {
    if (remaining > 0) {
      button.disabled = true;
      button.textContent = t("panel_retry_countdown", [String(remaining)]);
      remaining -= 1;
      setTimeout(tick, 1000);
      return;
    }
    button.textContent = QUOTA_RATE_TEXT.retryNow;
    button.disabled = !canRetry();
  };
  tick();
  button.addEventListener("click", () => {
    if (!canRetry()) return;
    retryRequest(msg);
  });
}

/** "session" | "key" | "unknown" — which remedy an auth-required needs. */
export function authKindFor(provider) {
  if (!provider) return "unknown";
  return SESSION_AUTH_PROVIDERS.has(provider) ? "session" : "key";
}

/** Maps a terminal broker `error` to a French message that names its own
 * remedy (deliverable B5, third banner: "broker reachable but the model
 * failed"). The other two B5 causes — broker unreachable, no pairing token —
 * are connection-level states handled separately by applyConnectionBanner();
 * this one is per-request, so it renders inline in the conversation like any
 * other error, not as a banner. */
export function describeBrokerError(message) {
  // docs/PROTOCOL.md "Broker limits" — the broker sends this fixed id,
  // then closes the connection with code 1009; the normal reconnect flow
  // (backoff/alarm) takes over from there, same as any other drop.
  if (message.id === "oversized") {
    return t("panel_error_oversized");
  }
  switch (message.code) {
    case "model-unavailable":
      // Covers both the broker's own 120s model-call timeout and a model
      // that can't be reached at all (broker/src/model.ts, MODEL_TIMEOUT_MS)
      // — the broker itself is fine, the model is the problem.
      return t("panel_error_model_unavailable", [message.message || t("panel_unavailable")]);
    case "auth-required": {
      // Provider-aware (see AUTH_REQUIRED_TEXT): the actionable part (copy
      // `claude auth login --claudeai`, or open the settings; then retry) is
      // rendered separately by renderMessage() via msg.authRequired/msg.authKind
      // — see buildAuthRecoveryBlock() below.
      const kind = authKindFor(currentProvider);
      if (kind !== "key") return AUTH_REQUIRED_TEXT[kind];
      // Spec (parcours-panne-modele-02-10.md): "[Provider] refused the key."
      // — named when the provider is known, generic fallback otherwise
      // (ollama has no key at all so never reaches this branch anyway).
      const name = currentProviderLinks()?.name;
      return name ? t("panel_auth_key_refused_named", [name]) : AUTH_REQUIRED_TEXT.key;
    }
    case "cancelled":
      return t("panel_request_cancelled");
    case "context-too-large":
      return t("panel_error_context_too_large_warn");
    case "quota-exceeded":
      // docs/PROTOCOL.md "error.message contract for auth-required,
      // quota-exceeded et rate-limited": message is already a fixed,
      // ready-to-display sentence (broker/src/messages.ts) — shown as-is,
      // never demoted to a secondary "Detail: …" line like model-unavailable.
      return `⚠ ${message.message || t("common_error_quota_exceeded")}`;
    case "rate-limited":
      return `⚠ ${message.message || t("common_error_rate_limited")}`;
    case "provider-overloaded":
      // Same fixed-message contract as
      // quota-exceeded/rate-limited above — never "fix your settings".
      return `⚠ ${message.message || t("common_error_provider_overloaded")}`;
    case "model-missing":
      return `⚠ ${message.message || t("common_error_model_missing")}`;
    case "model-stalled":
    case "model-timeout":
      // Plain words, no "Detail" line: the reason is fully known.
      return `⚠ ${describeError(message.code)}`;
    default:
      // Covers "bad-request" and any other/unknown code: a localised label
      // keyed on `code` (extension/lib/labels.js, shared with options.js),
      // the broker's English `message` demoted to a secondary "Detail: …"
      // line — never shown on its own (bug report gap 3).
      return `⚠ ${describeError(message.code, message.message)}`;
  }
}

// `auth-required` (docs/PROTOCOL.md "Expired session or unverified
// credentials") has two remedies: a CLI session to reopen (`claude-cli`,
// personal module) or an API key the provider refused (`claude-api`,
// `openai-compat`, anything else). The error itself carries no provider id,
// so the panel uses the one from the last provider.status-result; unknown
// (no answer yet) gets a text naming both remedies.
export const AUTH_REQUIRED_TEXT = {
  session: t("panel_auth_session_expired"),
  key: t("panel_auth_key_refused"),
  unknown: t("panel_auth_unknown"),
  copy: t("panel_copy"),
  copied: t("panel_copied"),
  copyFailed: t("panel_copy_failed"),
  // This button opens the provider's own
  // settings card (openProviderSettings), no longer the tutorial — labelled
  // as what it does. "Connect a model" stays for the never-connected notice.
  openSettings: t("panel_open_settings"),
  retrySession: t("panel_retry_session"),
  retryKey: t("panel_retry_key"),
};
