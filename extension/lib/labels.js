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
  "model-empty": "common_error_model_empty",
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

/** The page's language as a locale tag for number and date formats ("0,8" in French); the
 * locale folder names ("zh_CN") are not valid tags. */
export const pageLang = () => (typeof document !== "undefined" && document.documentElement.lang.replace("_", "-")) || undefined;

/** @param {number} n @param {number} min fraction digits kept, even if zero @returns {string} */
const formatDecimal = (n, min) => n.toLocaleString(pageLang(), { minimumFractionDigits: min, maximumFractionDigits: 1 });

/** @param {number} tokens @returns {string} e.g. "3.2" for 3200, "12" for 12000. */
export function formatTokensK(tokens) {
  const k = (tokens || 0) / 1000;
  return k < 10 ? formatDecimal(k, 1) : Math.round(k).toLocaleString(pageLang());
}

const percentOf = (part, whole) => Math.round((part / whole) * 100);

/** The "which part was read" line for a `done.page` that did not cover the
 * whole page, or `undefined` when it did. */
function pageReadPart(page) {
  if (!(page.chars > 0)) return undefined;
  const to = page.from + page.sentChars;
  if (page.from > 0) {
    return page.truncated
      ? t("panel_page_mention_part_middle", [String(percentOf(page.from, page.chars)), String(percentOf(to, page.chars))])
      : t("panel_page_mention_part_end", [String(percentOf(page.from, page.chars))]);
  }
  if (!page.truncated) return undefined;
  const need = formatTokensK(estimateTokensFromChars(page.chars));
  const fit = formatTokensK(estimateTokensFromChars(page.sentChars));
  return t("panel_page_mention_part_start", [String(percentOf(page.sentChars, page.chars)), need, fit]);
}

/** The discreet line under a finished answer (docs/PROTOCOL.md `done.page`).
 * Without `done.page`, only an answer that could have asked for the page
 * on demand (`pageOnDemand`) says it did not read it.
 * @returns {string|undefined} */
export function buildPageMention(pageOnDemand, message) {
  const usage = message.usage || {};
  const total = (usage.inputTokens || 0) + (usage.outputTokens || 0);
  // `uncounted`: the total is a floor ("at least"); with nothing counted, the line says so instead of a false 0.
  const kTokens = usage.uncounted && total === 0 ? undefined : formatTokensK(total);
  const atLeast = usage.uncounted && total > 0;
  const mention = (key) => {
    if (kTokens === undefined) return t(`${key}_uncounted`);
    return atLeast ? t(key.replace("panel_page_mention_", "panel_limits_") + "_at_least", [kTokens]) : t(key, [kTokens]);
  };
  const page = message.page;
  if (!page) return mention(pageOnDemand ? "panel_page_mention_not_read" : "panel_limits_tokens");
  const base = mention(page.level === "dev" ? "panel_page_mention_read_dev" : "panel_page_mention_read_text");
  const part = pageReadPart(page);
  return part ? `${base} · ${part}` : base;
}

/** Where "Read the rest" resumes after a `done.page`, or `undefined` when the page was read to its end. */
export function nextReadPart(page) {
  return page && page.truncated ? { from: page.from + page.sentChars, level: page.level } : undefined;
}

const REFUSED_KEYS = {
  turns: "panel_limits_refused_turns",
  searches: "panel_limits_refused_searches",
  pages: "panel_limits_refused_pages",
  reads: "panel_limits_refused_reads",
  budget: "panel_limits_refused_budget",
  "unknown-ref": "panel_limits_refused_unknown_ref",
};

/** One sentence per fact of `done.limits`, heaviest first (docs/PROTOCOL.md "Run log"). The budget cap is in
 * characters, shown in k. A `usage.uncounted` run adds its own sentence. Never names the model.
 * @returns {string[]} */
export function limitSentences(limits, usage) {
  const out = [];
  const mem = limits?.memoryFull;
  if (mem) {
    const key = mem.tokens > mem.contextTokens ? "panel_limits_memory_overflow" : "panel_limits_memory_full_ctx";
    out.push(mem.contextTokens > 0 ? t(key, [formatTokensK(mem.tokens), formatTokensK(mem.contextTokens)]) : t("panel_limits_memory_full"));
  }
  const seen = new Set();
  for (const r of limits?.refused ?? []) {
    const key = REFUSED_KEYS[r?.reason];
    if (!key || seen.has(r.reason)) continue;
    seen.add(r.reason);
    if (r.reason === "unknown-ref") out.push(t(key));
    else if (r.limit > 0) out.push(t(key, [r.reason === "budget" ? formatTokensK(r.limit) : String(r.limit)]));
  }
  if (limits?.cut) out.push(t("panel_limits_cut"));
  if (limits?.answerNow) out.push(t("panel_limits_answer_now"));
  if (usage?.uncounted) out.push(t("panel_limits_uncounted"));
  return out;
}

/** "Model · 2 limits · 14 tokens/s": the count only from one limit up, the speed only when measured (Ollama). */
export function limitsSummary(limits) {
  const parts = [t("panel_limits_summary")];
  // Uncounted tokens are Coati's own measuring gap, not a limit the model hit.
  const n = limitSentences(limits).length;
  if (n === 1) parts.push(t("panel_limits_count_one"));
  else if (n > 1) parts.push(t("panel_limits_count_many", [String(n)]));
  const speed = limits?.local?.tokensPerSec;
  if (speed > 0) parts.push(t("panel_limits_speed_short", [String(Math.round(speed))]));
  return parts.join(" · ");
}

/** The Ollama block: `[label, value]` rows for what is known of `limits.local`. @returns {[string, string][]} */
export function hardwareRows(local) {
  if (!local) return [];
  const rows = [];
  if (local.gpuPercent >= 0) rows.push([t("panel_limits_hw_gpu"), t("panel_limits_hw_gpu_value", [String(Math.round(local.gpuPercent))])]);
  if (local.contextTokens > 0) rows.push([t("panel_limits_hw_context"), t("panel_limits_hw_context_value", [formatTokensK(local.contextTokens)])]);
  if (local.tokensPerSec > 0) rows.push([t("panel_limits_hw_speed"), t("panel_limits_hw_speed_value", [String(Math.round(local.tokensPerSec))])]);
  if (local.vramGb > 0) {
    // The broker reports decimal GB; cards are sold and read in binary GB.
    const gb = formatDecimal(Math.round(((local.vramGb * 1e9) / 2 ** 30) * 10) / 10, 0);
    rows.push([t(local.unifiedMemory ? "panel_limits_hw_shared" : "panel_limits_hw_vram"), t("panel_limits_hw_gb_value", [gb])]);
  }
  return rows;
}
