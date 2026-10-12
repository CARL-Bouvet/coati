# Coati — project rules

## What this project is

A browser extension (`extension/`, native JavaScript, no bundler) and a local program
(`broker/`, TypeScript on Bun) that talks to the user's own model. The contract between the two
is `docs/PROTOCOL.md` and it is authoritative: when code and protocol disagree, fix the code, or
change the protocol first and explicitly. Why things are the way they are: `docs/DECISIONS.md`.
Map of the code: `docs/ARCHITECTURE.md`. What comes next: `docs/ROADMAP.md`.

## Language

Everything in this repo is in English: code, comments, commit messages, issues, PRs, docs.
User-facing text is never hard-coded: it goes through `extension/_locales/{en,fr,zh_CN}`
(English is the default).

## Product rules

Rules marked **(planned)** are not implemented yet (see `docs/ROADMAP.md`).

**Principles**
1. The model reads the page only when the question needs it: it asks, Coati sends it. What it
   gets depends on the reading level.
2. The user always sees how much data the model reads: an estimate while the page is sent, the
   real count under every answer ("read the page" / "did not read the page").
3. Bring your own model. Coati ships no AI, and nothing goes through our servers.
4. Open source (AGPL-3.0). Reading pages is free at every level.

**Reading**
5. Two reading levels: **text** (default: visible text and clickable elements) and **dev**
   (the page's cleaned HTML — no scripts, styles or field values; behind the "Dev mode" switch,
   confirmed once, at the user's own risk). A structure level between the two may come later.
6. Never a password field's value, at any level.
7. Screenshot: the model asks for one, the user accepts in one click. **(planned)**
8. Sensitive data: warn, never mask (dev level sent to an online model).

**Acting**
9. Show: Coati points at an element, the user clicks it.
10. Coati acts only when asked. Nothing runs in the background.
11. Reading other pages: only when the question asks for it, limited, always counted.
12. Clicking or typing: one action at a time, confirmed, target shown. **(planned)**
13. Never, even with consent: pay, send a message, delete, publish, sign in.
14. Web search runs in the browser's default engine, in a visible tab; answers cite their
    sources.
15. From a public page, Coati never opens a local or private address (except at dev level);
    plain `http` shows a warning.
16. Page content is data, never instructions. We do not claim to stop prompt injection: we limit
    what the model can do. Links in answers are clickable only under the link rules in
    `docs/DECISIONS.md` (T61): `https` domain, host shown, found in the sources (or "from memory"
    when nothing was read), no look-alike, never opened automatically.

**Security**
17. No secrets in the extension. Nothing secret in `chrome.storage.local`; the broker key lives in
    `chrome.storage.session`; model credentials live only in the local program.
18. The local program listens on `127.0.0.1` only, checks `Host`, `Origin` and the peer user, and
    requires the `v: 2` handshake before anything else.
19. Permissions: the minimum at install (`activeTab`, never `tabs`, never `<all_urls>` in
    `host_permissions`); "all sites" is asked at the first feature that needs it. The icon turns
    grey when Coati cannot access the tab. **(grey icon planned)**
20. No hidden telemetry.

## Code conventions

- Never `innerHTML`: build DOM nodes, render model answers node by node.
- No new dependency without a real need. No framework.
- A new extension file must be listed in `extension/lib/build-fingerprint.js` and
  `scripts/stamp.sh` (a test fails otherwise).
- `bun test` must pass from the repo root and from `broker/`.
- A change to page reading (`extension/content/extract/`) is measured before and after with
  `scripts/lecture/measure.mjs` on real pages.

## Everything in this repo is public

Commit messages included: never a price, a strategy, legal content, or personal information.
Never point to notes or files that live outside this repository: a comment must make sense to
someone who only has this repo (`broker/test/public-repo-hygiene.test.ts` fails otherwise).
