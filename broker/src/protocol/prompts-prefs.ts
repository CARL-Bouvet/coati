// PromptEntry / SitePrefs / PrefsData wire types and their id/site-key
// validators (docs/PROTOCOL.md "Prompt library and per-site preferences").
// Split out of protocol.ts.

// "My prompts by site" — docs/DECISIONS.md T41.
// Replaces the flat `{ name, body }` shape. `id` is assigned by the broker,
// never by the client (see PromptsSaveMessage). See docs/PROTOCOL.md
// "Prompt library and per-site preferences" for the full contract.
export interface PromptEntry {
  id: string;
  site: string;
  title?: string;
  body: string;
}

export const PROMPT_ID_PREFIX = "p_";
export const PROMPT_ID_RE = /^p_[0-9a-f]{12}$/;
export const POPULAR_SITE_KEY_RE = /^@[a-z0-9-]{1,40}$/;
export const USER_SITE_KEY_RE = /^[a-z0-9.-]{1,253}$/;
export const SUGGESTION_ID_RE = /^coati:[a-z0-9-]{1,40}:[a-z0-9-]{1,40}$/;

export const PROMPT_TITLE_MAX = 120;
export const PROMPT_BODY_MAX = 8000;
export const PREFS_ORDER_MAX = 200;
export const PREFS_SITES_MAX = 500;

/** `"*"` (all sites), a popular-site key (`@youtube`…), or a user site key
 * (lower-case hostname, `www.` already stripped by the caller). Never used
 * to build a file path — see docs/PROTOCOL.md. */
export function isValidSiteKey(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v === "*") return true;
  if (POPULAR_SITE_KEY_RE.test(v)) return true;
  if (v.startsWith("www.")) return false;
  return USER_SITE_KEY_RE.test(v);
}

/** An item of `order`/`removed`: a prompt id or a Coati suggestion id. */
export function isValidOrderItem(v: unknown): v is string {
  return typeof v === "string" && (PROMPT_ID_RE.test(v) || SUGGESTION_ID_RE.test(v));
}

export function isValidPromptId(v: unknown): v is string {
  return typeof v === "string" && PROMPT_ID_RE.test(v);
}

/** One site's slice of prefs.json: which order the panel/page shows items
 * in, and which Coati suggestions the user removed from that site. Both
 * optional and independent — see docs/PROTOCOL.md "prefs.get / prefs.set". */
export interface SitePrefs {
  order?: string[];
  removed?: string[];
}

export interface PrefsData {
  sites: Record<string, SitePrefs>;
}
