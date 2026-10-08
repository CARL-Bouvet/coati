// Coati side panel — "Regarder l'écran" (plan-montrer-voir-chercher-08-10.md
// §3B, lot B3). captureScreen() turns the active tab's pixels into the
// `chat.image` payload (docs/PROTOCOL.md §3): `captureVisibleTab` JPEG
// q 0.8 -> createImageBitmap -> OffscreenCanvas resized to <= 1280 px on the
// long side -> re-encoded JPEG q 0.75, q 0.55 if still > 700 KiB, failure if
// still too big after that.
//
// The pure size/quality maths (computeResizeDimensions, isWithinBudget,
// nextQuality) are exported separately from captureScreen() itself, which
// touches chrome.tabs/createImageBitmap/OffscreenCanvas — none of those
// exist under `bun test` (no browser), so only the maths is unit-tested;
// captureScreen() itself needs the Chromium e2e the admin runs separately.
//
// B0 finding (08/10): `captureVisibleTab` needs `activeTab` (icon click,
// keyboard shortcut, or a context-menu click that grants it) — the broad
// `optional_host_permissions` ("http://*/*", "https://*/*") do NOT satisfy
// it. captureScreen() never tries to request anything itself; panel.js
// classifies the rejection and tells the user which gesture to make.

export const MAX_LONG_SIDE_PX = 1280;
export const CAPTURE_QUALITY = 0.8; // captureVisibleTab's own JPEG quality
export const PRIMARY_QUALITY = 0.75; // first re-encode attempt
export const FALLBACK_QUALITY = 0.55; // only tried if PRIMARY_QUALITY is still too big
export const MAX_ENCODED_BYTES = 700 * 1024; // 700 KiB

/** Thrown by captureScreen() when even FALLBACK_QUALITY stays over budget. */
export class ScreenshotTooBigError extends Error {
  constructor(bytes) {
    super(`screenshot still ${bytes} bytes after quality 0.55`);
    this.name = "ScreenshotTooBigError";
    this.bytes = bytes;
  }
}

/**
 * Resize target so the long side is <= `maxSide`, aspect ratio kept, both
 * sides rounded to whole pixels and never below 1. Pure, no DOM/canvas.
 * @param {number} width
 * @param {number} height
 * @param {number} [maxSide]
 * @returns {{width: number, height: number}}
 */
export function computeResizeDimensions(width, height, maxSide = MAX_LONG_SIDE_PX) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** @param {number} bytes @returns {boolean} */
export function isWithinBudget(bytes) {
  return bytes <= MAX_ENCODED_BYTES;
}

/**
 * Given the quality just tried and the byte size it produced, what to try
 * next — `null` means "stop: either it's within budget, or there's nothing
 * left to try" (caller then checks isWithinBudget() itself to tell those
 * two apart, see captureScreen()).
 * @param {number} triedQuality
 * @param {number} bytes
 * @returns {number|null}
 */
export function nextQuality(triedQuality, bytes) {
  if (isWithinBudget(bytes)) return null;
  if (triedQuality === PRIMARY_QUALITY) return FALLBACK_QUALITY;
  return null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function encodeAt(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return blob;
}

/**
 * Captures the active tab of `windowId`, resizes and re-encodes it, and
 * returns the exact `chat.image` shape (docs/PROTOCOL.md §3). Throws
 * whatever `chrome.tabs.captureVisibleTab` rejects with (panel.js
 * classifies it — activeTab missing vs. an internal chrome:// page vs.
 * anything else) or ScreenshotTooBigError.
 * @param {number|undefined} windowId
 * @returns {Promise<{mediaType: "image/jpeg", data: string, width: number, height: number}>}
 */
/** "data:image/jpeg;base64,…" → Blob, without fetch (CSP-safe). Pure. */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma); // after "data:"
  const mediaType = header.split(";")[0] || "application/octet-stream";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

export async function captureScreen(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: Math.round(CAPTURE_QUALITY * 100),
  });
  // Decode the data: URL by hand — fetch(dataUrl) is blocked by the panel's
  // CSP (connect-src has no data:), found by the admin's Chromium e2e 08/10.
  const rawBlob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(rawBlob);
  const { width, height } = computeResizeDimensions(bitmap.width, bitmap.height);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);

  let quality = PRIMARY_QUALITY;
  let blob = await encodeAt(canvas, quality);
  let next = nextQuality(quality, blob.size);
  if (next !== null) {
    quality = next;
    blob = await encodeAt(canvas, quality);
  }
  if (!isWithinBudget(blob.size)) throw new ScreenshotTooBigError(blob.size);

  const data = arrayBufferToBase64(await blob.arrayBuffer());
  return { mediaType: "image/jpeg", data, width, height };
}

// --- Error classification (pure — no chrome.* here) -------------------------

// B0 (08/10): verified exact string from a real Chromium.
const NEEDS_GESTURE_RE = /activeTab|all_urls|permission/i;

/** True when `err` is captureVisibleTab's "no activeTab" rejection — the
 * user needs to click the icon / use the shortcut on THIS tab, then ask
 * again (B0 finding: the broad host permission does not help here). */
export function captureNeedsGesture(err) {
  const message = err && typeof err.message === "string" ? err.message : String(err ?? "");
  return NEEDS_GESTURE_RE.test(message);
}

// Internal browser pages refuse script/capture access outright, with no
// gesture able to fix it — checked on the tab's URL BEFORE even trying to
// capture (same pattern as unreadable.js's isPdfUrl() before extraction).
const INTERNAL_URL_RE = /^(chrome|chrome-extension|edge|brave|about|moz-extension|view-source):/i;

/** @param {string|undefined} url @returns {boolean} */
export function isInternalBrowserUrl(url) {
  return typeof url === "string" && INTERNAL_URL_RE.test(url.trim());
}
