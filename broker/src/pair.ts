// Renders the broker's self-served pairing page — GET /pair, Firefox only,
// see docs/PROTOCOL.md "Page `/pair` (Firefox seulement)" (amendement
// 2026-09-25, replaces "Appairage en un clic"). This page is served by the
// broker over plain HTTP to 127.0.0.1 — it is NOT an extension page, so the
// extension's CSP (manifest.json, content_security_policy) does not apply to
// it. An inline <style> block is acceptable here for that reason; nowhere
// else in this codebase. NO <script>, NO button, NO extension id: this page
// only ever displays the permanent secret (to copy by hand into the Firefox
// extension's options page) and the read-only list of already-pinned uuids.
// Response headers (Cache-Control, CSP, etc.) are set by the caller
// (server.ts) — this module only builds the HTML body.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PinnedUuidView {
  uuid: string;
  pinnedAt: string;
  lastSeen: string;
}

export interface PairPageOptions {
  /** Port the broker is actually listening on. */
  port: number;
  /** The pairing secret (docs/PROTOCOL.md handshake step 2) — permanent, not
   * a session token. Displayed for the user to copy by hand. */
  token: string;
  /** Read-only view of the currently pinned Firefox uuids, most-recently
   * pinned first. */
  pinned: PinnedUuidView[];
  /** Absolute path of firefox-extension-uuids.txt, shown so the user knows
   * where to revoke a pin by hand. */
  pinsFilePath: string;
}

export function renderPairPage({ port, token, pinned, pinsFilePath }: PairPageOptions): string {
  const safeToken = escapeHtml(token);
  const safePort = escapeHtml(String(port));
  const safePinsFilePath = escapeHtml(pinsFilePath);

  const pinnedRows = pinned.length
    ? pinned
        .map(
          (p) =>
            `      <tr><td><code>${escapeHtml(p.uuid)}</code></td><td>${escapeHtml(p.pinnedAt)}</td><td>${escapeHtml(p.lastSeen)}</td></tr>`,
        )
        .join("\n")
    : `      <tr><td colspan="3"><em>Aucune extension Firefox épinglée pour l'instant.</em></td></tr>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connecter Coati (Firefox)</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 560px;
    margin: 48px auto;
    padding: 0 16px;
    color: #1f2430;
    line-height: 1.5;
  }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; margin-top: 32px; }
  p.help { color: #555; }
  code, pre {
    display: block;
    margin-top: 8px;
    padding: 8px;
    background: #f3f3f6;
    border-radius: 6px;
    word-break: break-all;
    font-size: 13px;
    user-select: all;
  }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e0e0e6; }
  th { color: #555; font-weight: 600; }
</style>
</head>
<body>
  <h1>Connecter Coati — Firefox</h1>
  <p class="help">
    Cette page ne sert qu'à épingler une extension Coati pour Firefox sur le broker qui tourne
    sur cette machine (127.0.0.1:${safePort}). Sous Chromium, cette page n'est pas nécessaire :
    l'extension s'appaire seule.
  </p>

  <h2>Secret permanent</h2>
  <p class="help">
    Copiez ce secret, puis collez-le dans les options de l'extension Coati (Firefox) pour
    l'épingler. Ce geste n'est nécessaire qu'une fois par installation.
  </p>
  <code>${safeToken}</code>

  <h2>Extensions Firefox épinglées</h2>
  <p class="help">
    Liste en lecture seule. Pour révoquer un épinglage, supprimez sa ligne dans
    <code style="display:inline;padding:2px 4px;">${safePinsFilePath}</code> à la main.
  </p>
  <table>
    <thead><tr><th>uuid</th><th>épinglé le</th><th>vu le</th></tr></thead>
    <tbody>
${pinnedRows}
    </tbody>
  </table>
</body>
</html>
`;
}
