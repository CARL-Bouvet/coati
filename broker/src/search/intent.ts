// Detects an EXPLICIT request, inside the user's own question text, to
// search official documentation / the web — docs/PROTOCOL.md
// doc officielle" amendment, 2026-10-08 bis ("recherche sur demande
// explicite"). Replaces the old "Chercher dans la doc" button: there is no
// UI affordance left, so EVERY chat message now runs through this pure,
// synchronous classifier before any search is even considered.
//
// Design: a verb (cherche/search/搜索…) is not enough on its own — "cherche
// un hôtel" ("look for a hotel") or "search for a hotel" is an ordinary question, not a request
// to go consult documentation or the web, and must NOT trigger a search.
// Detection requires a verb AND a target (doc/web/online keyword) to both be
// present, except for a few phrases that are unambiguous requests by
// themselves ("fais une recherche", "google it").
//
// fr/en/zh_CN only (the three languages messages.ts supports) — an unknown
// Lang value (should not happen, messages.ts already normalises) falls back
// to English-only detection, same tolerant-default stance as the rest of
// this codebase.

import type { Lang } from "../messages.ts";

interface LangPatterns {
  /** A verb alone is never enough — see module doc above. */
  verb: RegExp;
  /** "the doc / the web / online" — paired with `verb` to trigger. */
  target: RegExp;
  /** Phrase(s) that are an explicit request on their own, no `target` needed. */
  standalone?: RegExp;
}

// French: cherche/recherche/regarde/consulte … (dans) la doc(umentation) /
// l'aide officielle / sur internet / sur le web / en ligne ; "fais une
// recherche" alone.
const FR: LangPatterns = {
  verb: /\b(cherch\w*|recherch\w*|regarde\w*|consult\w*)\b/i,
  target: /(\bdoc(?:umentation)?\b|l['’]?aide\s+officielle|\baide\s+officielle\b|\bsur\s+internet\b|\bsur\s+le\s+web\b|\ben\s+ligne\b)/i,
  standalone: /\bfais(?:-moi|\s+moi)?\s+une\s+recherche\b/i,
};

// English: search/look up … docs/documentation/the web/online ; "google it"
// alone.
const EN: LangPatterns = {
  verb: /\b(search|look\s*up|google)\b/i,
  target: /\b(docs?|documentation|the\s+web|online)\b/i,
  standalone: /\bgoogle\s+(it|this|that)\b/i,
};

// Chinese (simplified): 搜索/查一下/查查 … 文档/网上/网络.
const ZH: LangPatterns = {
  verb: /(搜索|查一下|查查)/,
  target: /(文档|网上|网络)/,
};

function patternsFor(lang: Lang): LangPatterns {
  if (lang === "fr") return FR;
  if (lang === "zh_CN") return ZH;
  return EN;
}

/** True iff `text` contains an explicit request to search documentation or
 * the web, in `lang`. Pure, synchronous, no network. */
export function detectSearchIntent(text: string, lang: Lang): boolean {
  const p = patternsFor(lang);
  if (p.standalone && p.standalone.test(text)) return true;
  return p.verb.test(text) && p.target.test(text);
}

/** Best-effort removal of the trigger verb/target/standalone phrase from
 * `text` — used only as the REFORMULATION FALLBACK (see search/reformulate.ts)
 * when the extra model call fails: "user question, trigger phrase
 * stripped, + site name". Never throws, never asserts the
 * phrase was actually found (a miss just means the fallback query keeps the
 * trigger word in it — harmless, still a reasonable search query). */
export function stripSearchTriggerPhrase(text: string, lang: Lang): string {
  const p = patternsFor(lang);
  let out = text;
  if (p.standalone) out = out.replace(p.standalone, " ");
  out = out.replace(p.verb, " ").replace(p.target, " ");
  return out.replace(/\s+/g, " ").trim();
}
