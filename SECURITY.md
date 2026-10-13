# Security

## Reporting a vulnerability

Use GitHub's private reporting: repo **Security** tab → **Report a vulnerability**, or directly
[github.com/CARL-Bouvet/coati/security/advisories/new](https://github.com/CARL-Bouvet/coati/security/advisories/new).
Reports are visible only to maintainers. Please don't open a public issue for a vulnerability.

Useful in a report: version (or commit), OS and browser, reproduction steps, and what an attacker
gains.

## Scope and trust boundary

Coati is a browser extension plus a local program (the broker) that talks to your own model.
The trust boundary is your user account on the machine, not a process: any program running under
your account can talk to the broker, and an administrator of the machine can read its key. Coati
does not defend against either. Page content is untrusted by construction.

## What Coati protects

**Pairing.** The browser launches a native host for Coati's own extension id only; it hands the
extension a key drawn fresh each time the broker starts (file mode 0600). The key never crosses
the connection: both sides prove they hold it with a mutual challenge (`docs/PROTOCOL.md`,
"Handshake `v: 2`"). The broker ignores anything from a connection that has not made the proof,
and allows 16 unproven connections at once. The extension keeps the key in session storage only.

**Local program.**
- Listens on `127.0.0.1` only. A request with the wrong `Host`, or with a missing or foreign
  `Origin`, is refused with 403 before the WebSocket upgrade.
- On Linux, the connecting process must belong to your user.
- Accepts a closed set of typed JSON messages; anything else is rejected, never executed.
- Model credentials stay in the broker's config on your machine. The extension never holds them.
  Config and key files are written 0600, in folders set to 0700 (not applicable on Windows, see
  below).

**Extension.**
- Never reads a password field's value. Dev-level reading drops every field value, scripts,
  styles and comments.
- Never builds page-sourced HTML: answers are rendered node by node.
- Permissions: `activeTab` at install; "all sites" is optional and asked at the first feature that
  needs it.
- The background script accepts internal messages only from the extension's own pages.

**What the model can do.** Page text is sent as fenced data, never as instructions.
- *Read on demand.* The model gets the page only when it asks for it; every answer says whether
  the page was read.
- *Search.* The model may search in your browser's default engine (up to 4 searches, 6 opened
  pages per question). Once a page has been read in the conversation, each search first shows its
  full query on a card with Allow / Refuse; a refused search is not run. Before any read,
  searches run without asking.
- *Open guard.* A result page is opened only if it is `http(s)`, not a local or private address
  (except at dev level), and the model can only pick results the broker numbered. After loading,
  the page is read only if its final address passes the same guard and stays on the result's own
  site.
- *Links.* A link in an answer is clickable only if it is `https` to a domain name (no IP, port or
  `user@`), with its domain shown beside it (`xn--…` for look-alike scripts). Once the
  conversation has read or searched anything, only links found in the sources or the current page
  stay clickable, compared in full (fragment included). A link whose domain is named in a page
  title sent with a question is never "from memory". A domain imitating a source, or a label reading as another
  domain, stays text. With nothing read, a link is clickable but marked "from memory, check it".
  A link opens only when you click it, in a new tab. Rules: `docs/DECISIONS.md` (T61).
- *Show.* The model can point at an element; Coati only highlights it. It never clicks, types,
  pays, sends, deletes, publishes or signs in.

## Privacy

- Your question, the page text or HTML the model asked for, the last 10 exchanges of the
  conversation and any image you attach go to the model you chose. With a local model (Ollama)
  they stay on your machine; with an online provider they go to that provider.
- Search queries go to your browser's default search engine. Opened result pages are fetched by
  your browser.
- Before dev-level HTML goes to an online model, Coati warns if it finds API keys, card numbers
  or IBANs. It never masks anything.
- No telemetry, no analytics, no server of ours. The extension page may only connect to the local
  program.
- The conversation is kept in the browser's local storage, in clear, for 30 days by default
  (adjustable in settings). No secret is stored there.

## Known limits

- **Sensitive-data warning.** It only covers dev-level HTML sent to an online model. Text level,
  screenshots and opened pages are not scanned.
- **Opened pages use your session.** A result page is read with your browser's cookies, on the
  result's own site only.
- **Search side channel.** Once you allow a search, the choice of pages the model opens can still
  carry a few bits to a site that sees the visits.
- **Shared history.** The conversation is shared across sites and replayed to the model on each
  question. Clear it to separate contexts.
- **Fake instructions.** A page can make the model relay instructions (a command to run, a link
  shown as text). Coati does not detect them; check commands and links before using them.
- **Dev mode.** It sends hidden text and attributes (`title`, `alt`, `aria-*`…) to the model and
  lifts the local-address block of the open guard. You confirm it once and accept the risk.
- **Hidden-text filters.** Text-level reading skips near-zero font, clipped, off-screen and
  same-colour text. It is a reduction, not a boundary.
- **Same-account programs.** Any process of your user account can talk to the broker. This is
  the trust boundary above.
- **Peer check.** Only Linux checks the connecting user. On macOS and Windows the key file's
  permissions are the remaining protection, and another local account can fill the 16
  unauthenticated slots and block pairing.
- **Windows folders.** The installer sets the ACL on the data and config folders (your account,
  `SYSTEM`, Administrators); Coati does not re-check it afterwards. Moving the profile or editing
  permissions by hand can expose the key.
- **Plain loopback.** Traffic between the extension and the broker is `ws://`, readable only by
  your user or root.
- **Legacy pairing** (Flatpak/Snap browsers). Off by default. When on, the secret is permanent and
  readable by any program of your account (`docs/INSTALL.md` explains how to renew it).
- **Unsigned binaries.** Release executables carry no Apple/Microsoft signature. `SHA256SUMS`
  checks integrity only (`docs/INSTALL.md`). Releases are built by CI with actions pinned by
  commit and a frozen lockfile.
