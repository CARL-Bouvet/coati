// Central table of every broker-generated, human-readable sentence — one
// entry per stable code, three languages. Goal G6 (docs/PROTOCOL.md "Langue
// de la connexion"): the product ships in en (default), fr, zh_CN, following
// the browser UI language the client reports in its `hello`. Callers never
// hand-write a French (or English) sentence inline any more — they look up a
// stable CODE for the given connection's language via t(). The code stays
// stable even when wording changes; nothing outside this file should
// string-match a message's TEXT (tests included — match on `code`/regex
// against the code's own known wording only for the language under test).
//
// This table does NOT cover:
//  - `model-unavailable` / `internal` ErrorMessage.message — that stays raw
//    English technical detail forever, by contract (docs/PROTOCOL.md
//    "Journalisation": "Contrat error.message pour model-unavailable et
//    internal" — the panel picks its own label from `code` alone, never from
//    `message`);
//  - `provider.status-result.reason` and `settings`'s `available[].` — no,
//    wait: `provider.status-result.reason` is a stable, English, non-displayed
//    code by contract (never translated); but `settings`'s
//    `available[].reason` (Availability.reason, providers/types.ts) IS
//    user-visible (extension/options.js shows it verbatim after "Détail :")
//    and IS covered here, via the `availability.*` codes below;
//  - the model's own reply language (see model.ts's buildSystemPrompt/
//    buildPrompt "reply language" instruction, and the per-pageKind summary
//    labels) — prompt-construction concerns, kept local to model.ts since
//    they shape a prompt rather than a wire-protocol sentence.

export type Lang = "en" | "fr" | "zh_CN";
export const DEFAULT_LANG: Lang = "en";
export const SUPPORTED_LANGS: readonly Lang[] = ["en", "fr", "zh_CN"];

/**
 * Normalises a BCP 47 UI-language tag — what the client sends in `hello.lang`,
 * straight from `chrome.i18n.getUILanguage()` (e.g. "fr", "en-US", "zh-CN") —
 * to one of Coati's three shipped languages. docs/PROTOCOL.md "Langue de la
 * connexion": fr* -> fr; zh* -> zh_CN EXCEPT the Traditional-leaning subtags
 * (Hant/TW/HK/MO), which fall through to the "everything else" case below,
 * same as any other unrecognised tag; missing/empty/anything else -> en.
 * Never throws on a malformed tag — worst case, en.
 */
export function normalizeLang(raw: string | null | undefined): Lang {
  if (typeof raw !== "string") return DEFAULT_LANG;
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0) return DEFAULT_LANG;
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("zh")) {
    if (/-(hant|tw|hk|mo)(-|$)/.test(lower)) return DEFAULT_LANG;
    return "zh_CN";
  }
  return DEFAULT_LANG;
}

type Catalog = Record<string, Record<Lang, string>>;

// zh_CN is a verbatim copy of the English wording for every key below except
// where a comment says otherwise — machine-placeholder, pending a translator
// pass (see docs/README.md's existing "traduction automatique" disclosure
// convention for the extension; the broker side needs the same treatment).
// KEYS STILL NEEDING A REAL zh_CN TRANSLATION: every key in this file (24)
// — see this worker's report for the exact count and file.
const MESSAGES: Catalog = {
  // --- auth-required (docs/PROTOCOL.md "Fournisseur de modèle": shown
  // verbatim to a human, unlike model-unavailable/internal) ---------------
  "auth.apiKeyRejected": {
    en: "API key rejected — check it in settings.",
    fr: "Clé API refusée — vérifiez-la dans les réglages.",
    zh_CN: "API 密钥被拒绝 — 请在设置中检查。",
  },

  // --- quota-exceeded / rate-limited (docs/PROTOCOL.md "Fournisseur de
  // modèle", amendement 2026-10-01, goal U1) — same contract as
  // auth.apiKeyRejected above: shown verbatim to a human, never
  // model-unavailable/internal's raw English technical detail. -------------
  "provider.quotaExceeded": {
    en: "Your account with the provider has no credit left. Add credit on their website, or pick a free model in settings.",
    fr: "Votre compte chez le fournisseur n'a plus de crédit. Rechargez-le sur son site, ou choisissez un modèle gratuit dans les réglages.",
    zh_CN: "您在该提供商的账户余额不足。请在其官网充值，或在设置中选择一个免费模型。",
  },
  "provider.rateLimited": {
    en: "The provider is receiving too many requests right now. Wait a moment and try again.",
    fr: "Le fournisseur reçoit trop de requêtes en ce moment. Patientez un instant puis réessayez.",
    zh_CN: "该提供商当前请求过多。请稍等片刻后重试。",
  },

  // --- settings.test-result (docs/PROTOCOL.md "settings.test") -----------
  "settingsTest.success.claude-api": {
    en: "Connection to the Anthropic API succeeded.",
    fr: "Connexion à l'API Anthropic réussie.",
    zh_CN: "连接到 Anthropic API 成功。",
  },
  "settingsTest.success.ollama": {
    en: "Connection to Ollama succeeded.",
    fr: "Connexion à Ollama réussie.",
    zh_CN: "连接到 Ollama 成功。",
  },
  "settingsTest.success.openai-compat": {
    en: "Connection to the server succeeded.",
    fr: "Connexion au serveur réussie.",
    zh_CN: "连接到服务器成功。",
  },
  "settingsTest.success.default": {
    en: "Connection succeeded.",
    fr: "Connexion réussie.",
    zh_CN: "连接成功。",
  },
  "settingsTest.timeout": {
    en: "The check timed out — try again.",
    fr: "La vérification a dépassé le délai imparti — réessayez.",
    zh_CN: "检查超时 — 请重试。",
  },
  "settingsTest.failure.claude-api": {
    en: "Could not reach the Anthropic API — check your key or your network connection.",
    fr: "Impossible de joindre l'API Anthropic — vérifiez la clé ou votre connexion réseau.",
    zh_CN: "无法连接到 Anthropic API — 请检查密钥或网络连接。",
  },
  "settingsTest.failure.ollama": {
    en: "Ollama isn't responding — check that it's running on this machine.",
    fr: "Ollama ne répond pas — vérifiez qu'il est bien lancé sur cette machine.",
    zh_CN: "Ollama 无响应 — 请确认其在本机上运行。",
  },
  "settingsTest.failure.openai-compat": {
    en: "Could not reach the server — check the address and your network connection.",
    fr: "Impossible de joindre le serveur — vérifiez l'adresse et votre connexion réseau.",
    zh_CN: "无法连接到服务器 — 请检查地址和网络连接。",
  },
  "settingsTest.failure.default": {
    en: "Could not reach this provider.",
    fr: "Impossible de joindre ce fournisseur.",
    zh_CN: "无法连接到此提供商。",
  },
  // --- settings.test-result's `code: "model-missing"` (docs/PROTOCOL.md,
  // amendement 2026-10-01, goal U2) — ollama only: the daemon answered but
  // the configured model isn't installed, distinct from "ollama isn't
  // responding" (settingsTest.failure.ollama above). ---------------------
  "settingsTest.failure.ollama.modelMissing": {
    en: "This model isn't installed in Ollama — pull it or pick another in settings.",
    fr: "Ce modèle n'est pas installé dans Ollama — téléchargez-le ou choisissez-en un autre dans les réglages.",
    zh_CN: "该模型未在 Ollama 中安装 — 请拉取该模型或在设置中选择其他模型。",
  },

  // --- testProviderConnection's own pre-flight checks (settings.test,
  // before any network call is even attempted) ----------------------------
  "testConnection.unknownProvider": {
    en: "Unknown provider.",
    fr: "Fournisseur inconnu.",
    zh_CN: "未知提供商。",
  },
  "testConnection.noApiKey": {
    en: "No API key configured — add one in settings.",
    fr: "Aucune clé API configurée — ajoutez-la dans les réglages.",
    zh_CN: "未配置 API 密钥 — 请在设置中添加。",
  },
  "testConnection.noOllamaModel": {
    en: "No Ollama model configured — pick one in settings.",
    fr: "Aucun modèle Ollama configuré — choisissez-en un dans les réglages.",
    zh_CN: "未配置 Ollama 模型 — 请在设置中选择。",
  },
  "testConnection.noBaseUrl": {
    en: "No server address configured — add one in settings.",
    fr: "Aucune adresse de serveur configurée — ajoutez-en une dans les réglages.",
    zh_CN: "未配置服务器地址 — 请在设置中添加。",
  },
  "testConnection.noModel": {
    en: "No model configured — pick one in settings.",
    fr: "Aucun modèle configuré — choisissez-en un dans les réglages.",
    zh_CN: "未配置模型 — 请在设置中选择。",
  },

  // --- Availability.reason (settings's available[].reason — shown verbatim
  // by extension/options.js after "Détail : ") ----------------------------
  "availability.claudeApi.noKey": {
    en: "no Anthropic API key configured",
    fr: "aucune clé API Anthropic configurée",
    zh_CN: "未配置 Anthropic API 密钥",
  },
  "availability.ollama.unreachable": {
    en: "Ollama unreachable at {url}",
    fr: "Ollama injoignable sur {url}",
    zh_CN: "Ollama 在 {url} 不可访问",
  },
  "availability.ollama.modelNotFound": {
    en: 'model "{model}" not found in Ollama (ollama pull {model})',
    fr: 'modèle « {model} » introuvable dans Ollama (ollama pull {model})',
    zh_CN: '在 Ollama 中未找到模型 "{model}"（ollama pull {model}）',
  },
  "availability.openaiCompat.noBaseUrl": {
    en: "no base URL configured",
    fr: "aucune adresse de serveur configurée",
    zh_CN: "未配置服务器地址",
  },
  "availability.openaiCompat.invalidBaseUrl": {
    en: "base URL must be https://, or http:// restricted to loopback",
    fr: "l'adresse doit être en https://, ou en http:// restreinte à la boucle locale",
    zh_CN: "地址必须为 https://，或 http:// 且仅限回环地址",
  },
  "availability.openaiCompat.cannotReach": {
    en: "cannot reach {url}: {detail}",
    fr: "impossible de joindre {url} : {detail}",
    zh_CN: "无法连接到 {url}：{detail}",
  },
};

export type MessageCode = keyof typeof MESSAGES;

/** Every registered code — used by the parity test ("every code has
 * fr/en/zh_CN", mission G6 item 6) and by anything that wants to iterate the
 * whole catalog. */
export function messageCodes(): MessageCode[] {
  return Object.keys(MESSAGES) as MessageCode[];
}

/** Looks up `code` for `lang`, falling back to DEFAULT_LANG if somehow the
 * requested language is missing an entry (never happens for a code in this
 * file — TypeScript's Record<Lang, string> already guarantees every language
 * has one — but keeps this function total for a future catalog that might
 * not). `params` are substituted as `{name}` — every param must be provided,
 * a leftover `{name}` in the output signals a caller bug, not a runtime
 * failure (never throws). */
export function t(code: MessageCode, lang: Lang, params?: Record<string, string>): string {
  const entry = MESSAGES[code];
  let text = entry[lang] ?? entry[DEFAULT_LANG];
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      text = text.split(`{${key}}`).join(value);
    }
  }
  return text;
}
