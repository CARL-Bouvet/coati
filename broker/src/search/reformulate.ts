// One short extra model call BEFORE a doc-search pipeline run — turns the
// user's own (possibly conversational, possibly non-English) question into
// a standalone search query ≤ 12 words, in the page's language, no quotes,
// no `site:` operator (doc-search.ts's own ladder adds that scope) —
// docs/PROTOCOL.md 2026-10-08 amendment, "recherche sur demande explicite"
// §3. Same active provider as the real answer; a short ~20 s timeout and an
// early-stop on a too-long/empty/multi-paragraph reply ("junk") both fall
// back to fallbackQuery() — this must never hang the request, and never
// feed the search engine a bad query, on a slow/misbehaving provider.
//
// NOTE: ProviderRuntimeOptions/StreamAnswerOptions expose no generic
// "max output tokens" knob (no provider-agnostic one exists in this
// codebase) — "low max tokens" is approximated by the instruction itself
// ("output ONLY the query, one line") plus REFORMULATE_MAX_OUTPUT_CHARS
// aborting the stream once the reply is clearly not a short query anymore.

import { buildPrompt, type BuiltPrompt } from "../model.ts";
import type { HistoryEntry } from "../protocol.ts";
import type { Lang } from "../messages.ts";
import type { ModelProvider, ProviderRuntimeOptions } from "../providers/types.ts";
import { stripSearchTriggerPhrase } from "./intent.ts";
import { DOC_SEARCH_QUERY_MAX_CHARS, capAtWordBoundary } from "./doc-search.ts";

export const REFORMULATE_TIMEOUT_MS = 20_000;
// Early-stop guard on the OUTPUT stream, not a real token limit — see NOTE
// above. A genuine ≤ 12-word query is a few dozen characters at most; this
// is generous on purpose so a slightly verbose reply doesn't needlessly
// fall back.
const REFORMULATE_MAX_OUTPUT_CHARS = 300;

export interface ReformulateOptions {
  provider: ModelProvider;
  providerOpts: ProviderRuntimeOptions;
  question: string;
  pageTitle?: string;
  pageUrl?: string;
  /** Full history — only the last 2 exchanges (≤ 4 entries) are used. */
  history?: HistoryEntry[];
  lang: Lang;
  /** Appended to the fallback query (e.g. the site's registrable domain or
   * hostname) — absent/empty when none is known. */
  siteName: string;
  timeoutMs?: number;
  /** External cancellation (e.g. the whole chat.docSearch request was
   * cancelled/the connection closed) — aborts the model call immediately,
   * same outcome as a timeout (falls back to fallbackQuery(), the caller
   * is expected to re-check its own cancellation state right after). */
  signal?: AbortSignal;
}

const INSTRUCTION: Record<Lang, string> = {
  en:
    "Task: turn the user's request below into a single, standalone web search query. Rules: at most 12 " +
    "words, no quotes, never use the \"site:\" operator, same language as the request/page, output ONLY " +
    "the query text on one line, nothing else (no explanation, no leading/trailing punctuation).",
  fr:
    "Tâche : transforme la demande de l'utilisateur ci-dessous en une seule requête de recherche web " +
    "autonome. Règles : 12 mots maximum, pas de guillemets, jamais l'opérateur « site: », même langue que " +
    "la demande/la page, réponds UNIQUEMENT avec le texte de la requête sur une ligne, rien d'autre (pas " +
    "d'explication, pas de ponctuation finale).",
  zh_CN:
    "任务:将下面用户的请求转换为一个独立的网页搜索查询。规则:最多12个词,不要加引号,不要使用site:操作符," +
    "使用与请求/页面相同的语言,只输出查询文本本身,不要有任何解释或多余的标点。",
};

function isJunk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > REFORMULATE_MAX_OUTPUT_CHARS) return true;
  if (trimmed.includes("\n\n")) return true; // reads like an explanation, not a one-line query
  return false;
}

/** Best-effort fallback when the reformulation call fails/times out/returns
 * junk: the user's own question with the trigger phrase stripped, plus the
 * site name, capped to DOC_SEARCH_QUERY_MAX_CHARS. Exported for tests and
 * for the server to use directly when the provider gate already failed
 * before any call could even be attempted. */
export function fallbackQuery(question: string, lang: Lang, siteName: string): string {
  const stripped = stripSearchTriggerPhrase(question, lang);
  const base = stripped.length > 0 ? stripped : question;
  const withSite = siteName ? `${base} ${siteName}` : base;
  return capAtWordBoundary(withSite, DOC_SEARCH_QUERY_MAX_CHARS);
}

/** Runs the extra model call. Never throws — any failure (timeout, provider
 * error, junk output) resolves to fallbackQuery() instead. */
export async function reformulateSearchQuery(opts: ReformulateOptions): Promise<string> {
  const fallback = fallbackQuery(opts.question, opts.lang, opts.siteName);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? REFORMULATE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort);
  try {
    const context =
      opts.pageTitle || opts.pageUrl ? { kind: "page" as const, title: opts.pageTitle, url: opts.pageUrl } : undefined;
    const built: BuiltPrompt = buildPrompt(
      {
        kind: "chat",
        text: `${INSTRUCTION[opts.lang]}\n\nUser request: ${opts.question}`,
        context,
        history: opts.history && opts.history.length > 0 ? opts.history.slice(-4) : undefined,
      },
      opts.lang,
    );
    let out = "";
    for await (const event of opts.provider.streamAnswer(built, {
      ...opts.providerOpts,
      signal: controller.signal,
      timeoutMs,
      inactivityTimeoutMs: timeoutMs,
    })) {
      if (event.kind !== "delta") continue;
      out += event.text;
      if (out.length > REFORMULATE_MAX_OUTPUT_CHARS) break; // clearly not a short query — stop early, fall back
    }
    if (isJunk(out)) return fallback;
    const oneLine = out.trim().split("\n")[0]!.trim();
    const words = oneLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) return fallback;
    return words.slice(0, 12).join(" ").replace(/^["'“”]+|["'“”]+$/g, "");
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}
