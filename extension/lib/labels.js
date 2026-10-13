// Shared labels for provider names and broker error codes — the single
// source of truth for text the panel and the options page both need to keep
// in sync (bug report "panel and settings", gaps 3 and 4). Text itself now
// lives in `_locales/<lang>/messages.json` (common_* keys) via lib/i18n.js;
// this module only maps ids/codes to message keys. Loaded the same way as
// the other lib/*.js modules (plain ESM import, no build).
import { t } from "./i18n-page.js";

// One id per BUILT-IN provider, used everywhere (panel status suffix,
// options provider list, error text) — never a different name in one place
// and another elsewhere. Any provider id NOT in this table (an externally
// loaded module, see docs/ARCHITECTURE.md) has no built-in text here: the caller
// falls back to the `label` the broker sent for it — see providerLabel()
// below.
const PROVIDER_LABEL_KEYS = {
  "claude-api": "common_provider_claude_api",
  ollama: "common_provider_ollama",
  "openai-compat": "common_provider_openai_compat",
};

/** @param {string} id */
export function providerLabelKnown(id) {
  const key = PROVIDER_LABEL_KEYS[id];
  return key ? t(key) : undefined;
}

// Resolved eagerly (see EXTRACTION_TIMEOUT_LABEL below for why that's safe)
// — kept for backward compatibility with existing callers/tests that index
// it directly (broker/test/ui-labels.test.ts) rather than going through
// providerLabel()/providerLabelKnown().
export const PROVIDER_LABELS = Object.fromEntries(
  Object.entries(PROVIDER_LABEL_KEYS).map(([id, key]) => [id, t(key)]),
);

// Connection-status labels — shared base for panel.js's renderStatusLabel()
// and options.js's applyStatus() (the two
// were kept as separate copies). "no-token" differs slightly between the two
// callers (panel adds "— see settings"), so it's the one entry callers may
// override rather than being forced through here.
const CONNECTION_STATUS_KEYS = {
  connected: "common_status_connected",
  connecting: "common_status_connecting",
  handshaking: "common_status_connecting",
  "handshake-timeout": "common_status_connecting",
  disconnected: "common_status_disconnected",
  "no-token": "common_status_no_token",
  // docs/PROTOCOL.md ("Handshake v: 2"):
  // "no-host" = the native-messaging host is unreachable; "broker-untrusted"
  // = a program is listening on the port but didn't prove it's the broker.
  "no-host": "common_status_no_host",
  "broker-untrusted": "common_status_broker_untrusted",
  "pairing-retry": "common_status_pairing_retry",
  unknown: "common_status_unknown",
};

export const CONNECTION_STATUS_LABELS = Object.fromEntries(
  Object.entries(CONNECTION_STATUS_KEYS).map(([state, key]) => [state, t(key)]),
);

/** @param {string} id @param {string} [fallback] - broker-sent label, used
 * only if this build doesn't know the id (forward compat). */
export function providerLabel(id, fallback) {
  return providerLabelKnown(id) ?? fallback ?? id;
}

// Label per broker ErrorCode (broker/src/protocol.ts's ErrorCode). This is
// the primary, human-facing line. The broker's `message` is English
// technical detail (docs/PROTOCOL.md) and is NEVER
// shown alone — describeError() below always appends it as a secondary
// "Detail: …" line, never as the primary text.
const ERROR_CODE_KEYS = {
  "bad-request": "common_error_bad_request",
  unauthorized: "common_error_unauthorized",
  "model-unavailable": "common_error_model_unavailable",
  // No text for 60 s after the first
  // word / no first word before the deadline.
  "model-stalled": "common_error_model_stalled",
  "model-timeout": "common_error_model_timeout",
  "auth-required": "common_error_auth_required",
  "quota-exceeded": "common_error_quota_exceeded",
  "rate-limited": "common_error_rate_limited",
  "context-too-large": "common_error_context_too_large",
  // Admin brief named this
  // "error_vision_unsupported" (the plan's own shorthand); kept under the
  // `common_error_*` prefix instead, to match every other entry in THIS
  // table literally rather than introduce a one-off naming scheme.
  "vision-unsupported": "common_error_vision_unsupported",
  cancelled: "common_error_cancelled",
  internal: "common_error_internal",
};

/**
 * @param {string} code - broker ErrorCode. Anything unrecognized (an
 *   older/newer broker) falls back to a generic label rather than surfacing
 *   the raw code.
 * @param {string} [message] - broker's English technical detail. Shown only
 *   as a secondary "Detail: …" line, appended after the label — never
 *   returned on its own.
 * @returns {string} ready-to-display text, one or two lines (\n-joined).
 */
export function describeError(code, message) {
  const key = ERROR_CODE_KEYS[code];
  const label = key ? t(key) : t("common_error_generic");
  return message ? `${label}\n${t("common_error_detail", [message])}` : label;
}

// Provider-unavailability `reason` (SettingsMessage.available[].reason,
// broker/src/protocol.ts) is free English text, not a closed code set (it
// can embed a path or URL — see broker/src/providers/*.ts) — there is no
// `code` to key a label table on. So the label here is always the same
// generic sentence; the broker's own words become the secondary
// "Detail: …" line, per the same never-alone rule as describeError().

// chrome.scripting.executeScript has
// no built-in deadline, so a hostile or pathological page could leave the
// panel waiting forever for page content. panel.js races extraction against
// EXTRACTION_TIMEOUT_MS and surfaces this label when it loses. The i18n API
// is available synchronously as soon as this module loads (no async init),
// so this can stay a plain constant like before.
export const EXTRACTION_TIMEOUT_LABEL = t("common_extraction_timeout");

// T47 (docs/DECISIONS.md): neither Chrome/Brave's
// injection-refused error nor Firefox's names the three gestures that grant
// access, so the panel names them itself instead of trying to mine an origin
// out of an error message. Shared with panel.js's looksLikeAccessDenied()
// call sites so the three gestures are worded identically everywhere.
export const ACCESS_DENIED_HINT = t("common_access_denied_hint");

/**
 * @param {string} [reason] - broker's free-text English reason, or absent.
 * @returns {string} ready-to-display text, one or two lines (\n-joined).
 */
export function describeProviderUnavailable(reason) {
  const label = t("common_provider_unavailable");
  return reason ? `${label}\n${t("common_error_detail", [reason])}` : label;
}

// Shared by panel/page-request.js's transient "Reading the page (~N k
// tokens)…" status line and chat-stream.js's done.page mention line
// (docs/PROTOCOL.md "Page on demand") — one token-count estimate/format
// pair, used in both places so the two numbers read the same way.

/** A page's character count has no token count attached client-side (only
 * the broker's `done.usage` does) — ~4 chars/token is the same rough ratio
 * docs/PROTOCOL.md already uses for its own dev-level context-fit maths.
 * @param {number} chars @returns {number} */
export function estimateTokensFromChars(chars) {
  return Math.round((chars || 0) / 4);
}

/** @param {number} tokens @returns {string} e.g. "3.2" for 3200, "12" for 12000. */
export function formatTokensK(tokens) {
  const k = (tokens || 0) / 1000;
  // Decimal separator of the page's own language ("0,8" in French).
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || undefined;
  return k < 10
    ? k.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : Math.round(k).toLocaleString(lang);
}
