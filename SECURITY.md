# Security

## Reporting a vulnerability

Use GitHub's private reporting: repo **Security** tab → **Report a vulnerability**, or directly
[github.com/CARL-Bouvet/coati/security/advisories/new](https://github.com/CARL-Bouvet/coati/security/advisories/new).
Reports are visible only to maintainers. Please don't open a public issue for a vulnerability.

Useful in a report: version (or commit), OS and browser, reproduction steps, and what an attacker
gains.

## Threat boundary

The security boundary is your user account on the machine, not the process. See
`docs/PROTOCOL.md`, "Threat boundary", for detail.

- The broker listens on `127.0.0.1` only — another machine on the network can't reach it.
- A web page can't connect to the broker: it checks the connection's `Origin` and requires a
  cryptographic proof (handshake `v: 2`) before processing anything.
- Another extension can't obtain the broker's key. Only the native host delivers it, and the
  browser only launches that host for Coati's own extension id. Rewriting a connection's headers
  isn't enough.
- The key never crosses the connection: each side proves it holds the key without sending it.
  The broker ignores anything from a connection that hasn't made that proof.
- Model credentials stay in the broker, on your machine. The extension never holds them.

A program running under your account, or an administrator of the machine, can read the key. That
is outside what Coati protects against.

## What the local program accepts

- WebSocket connections on `127.0.0.1:8787` only, after the Origin check and the handshake.
- A closed set of typed JSON messages (`docs/PROTOCOL.md`) — anything else is rejected
  (`bad-request`), never executed.
- On Linux, connections are also checked against the calling process's UID; not enforced on
  macOS/Windows, where the key's file permissions (0600) are the remaining protection.

## What the extension never does

- Never stores a secret in `chrome.storage.local` (unencrypted on disk).
- Never sends model credentials — it never holds any.
- Never reads a password field's value, at any reading level.
- Never executes page-sourced HTML (no `innerHTML` from page content).
- Never opens a link on its own: a link in an answer opens only when you click it, in a new tab.

## Links in answers

A page or a search result can hide an instruction that makes the model write a fake link (a fake
support page, a fake download). A link in an answer is clickable only if it is `https` to a domain
name (no IP address, port or `user@`, nothing local), and its domain is always shown next to it,
in `xn--…` form when it uses look-alike characters. Once the conversation has read a page or
searched, only links found in the sources or the current page are clickable; any other stays text,
marked "not in the sources". A domain imitating a source or the current page, or a label that
reads as another domain, stays text too. With nothing read, a link can only come from the model's
memory: clickable, marked "from memory, check it". The rules: `docs/DECISIONS.md` (T61).

## Prompt injection

Coati does not claim to prevent prompt injection — page content is adversarial by construction.
What it does: treat page content as data, never as an instruction, fenced separately from the
system prompt; limit what the model's output can actually do (rules 10–13, 16 in `CLAUDE.md` —
no background action, no click/type without the user confirming a named target, no automated
payment/send/delete/publish/sign-in); and never auto-click a link the model merely mentions.

## Known limits

- **Caller account check.** Linux rejects a connection from another account at open time.
  macOS/Windows have no such check — protection there rests on the key file's permissions
  (readable by your account only).
- **Windows.** Unix permissions don't apply; the data folder is protected by the ACL the
  installer sets (your account, `SYSTEM`, Administrators). A profile moved to a shared location,
  or permissions changed by hand, can make the key readable by another account.
- **Legacy pairing (Flatpak/Snap browsers).** Off by default. Once enabled, the pairing secret is
  permanent and readable by any program under your account; it never rotates on its own — see
  `docs/INSTALL.md` to renew it.
- **Unsigned binaries.** Published executables carry no Apple/Microsoft developer signature;
  verify against the release's `SHA256SUMS` (`docs/INSTALL.md`).
- **Unauthenticated connection cap (macOS, Windows).** On these two systems another local account
  can open all 16 allowed unauthenticated connections and block legitimate pairing (denial of
  service) — without ever obtaining the key itself.
