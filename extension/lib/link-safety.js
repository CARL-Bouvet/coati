// Verdict on a link the model wrote in an answer (docs/DECISIONS.md, "Links in
// answers"). Pure: no DOM, no chrome.*, no network.
//
// "clickable": the address is one Coati found itself (a source of the answer,
// or the current page). "memory": the model read nothing in this conversation,
// so the link can only come from its own memory — clickable, marked "check it".
// "refused": rendered as text with a reason.
//
// The host shown next to a link is `URL.hostname`, which spells an IDN host in
// punycode (`xn--…`): a look-alike written in another script stays visible.

import { isLocalHostname } from "./open-guard.js";

const MAX_LENGTH = 2048;

// Public suffixes made of two labels, common enough to matter for look-alikes.
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "ne.jp", "or.jp", "com.au", "net.au", "org.au",
  "co.nz", "com.br", "com.cn", "com.mx", "com.tr", "com.tw", "com.hk", "com.sg", "com.ar",
  "co.in", "co.kr", "co.za",
]);

// File and language endings that are not top-level domains ("Node.js" is a name, not a host).
const NOT_TLDS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "txt", "html", "htm", "css", "exe", "pdf",
  "png", "jpg", "jpeg", "gif", "svg", "yaml", "yml", "toml", "lock", "dll",
  "md", "py", "sh", "rs", "rb", "xml", "csv", "zip", "gz", "ini", "cfg", "bat", "ps1",
]);

// Edits allowed between two names before one counts as imitating the other:
// short names differ by chance (ibm / ign, github / gitlab), long ones rarely.
function maxEdits(name) {
  return name.length >= 9 ? 2 : name.length >= 5 ? 1 : 0;
}

function parse(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** Comparable form of an address: no fragment, no trailing slash. Null when unparsable. */
export function normalizeUrl(href) {
  const url = typeof href === "string" ? parse(href.trim()) : null;
  if (!url) return null;
  url.hash = "";
  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

function isDomainName(host) {
  if (!host || host.startsWith("[") || !host.includes(".")) return false;
  if (/^[\d.]+$/.test(host)) return false;
  return !isLocalHostname(host);
}

function hasSafeForm(url) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && isDomainName(url.hostname);
}

/** Last two labels, or three under a two-label public suffix (`bbc.co.uk`). */
export function registrableDomain(host) {
  const labels = host.replace(/\.$/, "").split(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) && labels.length > 2 ? labels.slice(-3).join(".") : lastTwo;
}

function splitDomain(domain) {
  const dot = domain.indexOf(".");
  return { name: domain.slice(0, dot), suffix: domain.slice(dot + 1) };
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] <= max;
}

/** The reference host `host` imitates (same name under another suffix, or a name a few edits away), or null. */
export function lookalikeOf(host, refHosts) {
  const domain = registrableDomain(host);
  const refs = refHosts.filter(Boolean).map((h) => ({ host: h, domain: registrableDomain(h) }));
  if (refs.some((r) => r.domain === domain)) return null;
  const { name } = splitDomain(domain);
  for (const ref of refs) {
    const other = splitDomain(ref.domain).name;
    const edits = maxEdits(name.length < other.length ? name : other);
    if (name === other || (edits > 0 && editDistanceAtMost(name, other, edits))) return ref.host;
  }
  return null;
}

// Host a label reads as ("paypal.com", "https://paypal.com/login"), or null when it is not an address.
function labelHost(label) {
  const text = String(label ?? "").trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
    ? text
    : /^[^/?#:@]+\.[^/?#:@.]+(?:[/?#:].*)?$/u.test(text)
      ? `https://${text}`
      : null;
  const url = withScheme ? parse(withScheme) : null;
  if (!url || !url.hostname.includes(".")) return null;
  const tld = url.hostname.split(".").pop();
  if (!/^(?:xn--[a-z\d-]+|[a-z]{2,})$/.test(tld) || NOT_TLDS.has(tld)) return null;
  return url.hostname;
}

const withoutWww = (host) => host.replace(/^www\./, "");

/** Context for linkVerdict from the answer's source addresses and the current page. */
export function linkContext(sourceUrls, pageUrl, readUntrusted) {
  const urls = new Set();
  const hosts = [];
  for (const href of [...sourceUrls, pageUrl]) {
    const normalized = normalizeUrl(href);
    if (!normalized) continue;
    urls.add(normalized);
    hosts.push(new URL(normalized).hostname);
  }
  const page = typeof pageUrl === "string" ? parse(pageUrl) : null;
  return { sourceUrls: urls, sourceHosts: hosts, pageHost: page?.hostname, readUntrusted: !!readUntrusted };
}

/**
 * ctx: { sourceUrls: Set<string> (normalized), sourceHosts: string[], pageHost?: string,
 * readUntrusted: boolean }. Returns { verdict: "clickable" | "memory" | "refused", reason?, host, like? }.
 * Reasons: "form", "misleading-label", "lookalike" (with `like`, the imitated host), "not-in-sources".
 */
export function linkVerdict(href, label, ctx) {
  const raw = typeof href === "string" ? href.trim() : "";
  const url = raw && raw.length <= MAX_LENGTH ? parse(raw) : null;
  const host = url ? url.hostname : "";
  if (!url || !hasSafeForm(url)) return { verdict: "refused", reason: "form", host };

  const shown = labelHost(label);
  if (shown && withoutWww(shown) !== withoutWww(host)) return { verdict: "refused", reason: "misleading-label", host };

  if (ctx.sourceUrls.has(normalizeUrl(raw))) return { verdict: "clickable", host };

  const like = lookalikeOf(host, [...ctx.sourceHosts, ctx.pageHost]);
  if (like) return { verdict: "refused", reason: "lookalike", host, like };

  return ctx.readUntrusted ? { verdict: "refused", reason: "not-in-sources", host } : { verdict: "memory", host };
}
