// Coati — pure detector for obvious sensitive-data patterns in page HTML
// (project rule 8: "Sensitive data: warn, never mask"). Used by
// panel/page-request.js before a dev-level extraction leaves for an online
// model. No network, no DOM, no state: a string in, a list of kinds out —
// testable on its own (broker/test/sensitive-scan.test.ts).
//
// Deliberately conservative: false negatives are fine (the user can still
// decide to send), false positives on ordinary page text are not — each
// pattern below is checked structurally (Luhn, IBAN mod-97), not just by
// shape, before it counts as a match.

/** @typedef {"api-key" | "card" | "iban"} SensitiveKind */

const API_KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style secret key
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub personal access token
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bAKIA[A-Z0-9]{12,}\b/, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/, // long bearer token
];

/** Luhn checksum, used to tell a plausible card number from an arbitrary
 * run of digits (phone numbers, order ids, …). */
function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Scans for 13-19 digit runs (spaces/dashes allowed as separators, as on
 * a physical card) that also pass Luhn. */
function hasCardNumber(text) {
  const candidates = text.match(/\b(?:\d[ -]?){12,18}\d\b/g) || [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
  });
}

/** IBAN mod-97 check (ISO 7064): move the first 4 chars to the end, map
 * letters to A=10..Z=35, the remainder mod 97 must be 1. */
function passesIbanCheck(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/** Country code + 2 check digits + 11-30 alphanumeric (IBAN's own length
 * range across issuing countries), then mod-97 validated. */
function hasIban(text) {
  const candidates = text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) || [];
  return candidates.some((candidate) => passesIbanCheck(candidate));
}

/**
 * @param {string} html
 * @returns {SensitiveKind[]} the kinds found, each at most once, in a
 *   stable order (api-key, card, iban) — empty when nothing matched.
 */
export function scanForSensitiveData(html) {
  if (typeof html !== "string" || html.length === 0) return [];
  const kinds = [];
  if (API_KEY_PATTERNS.some((pattern) => pattern.test(html))) kinds.push("api-key");
  if (hasCardNumber(html)) kinds.push("card");
  if (hasIban(html.toUpperCase())) kinds.push("iban");
  return kinds;
}
