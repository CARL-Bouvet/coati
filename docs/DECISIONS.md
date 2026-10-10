# Coati — design decisions (technical)

Product decisions (pricing, legal, market) live in a separate private repo, not published here.
One line per decision still in force. A decision only reopens on new evidence, never on a hunch.

| # | Decision — why |
|---|---|
| T1 | Chromium first, Firefox second — the side panel API diverges (`chrome.sidePanel` per tab vs `browser.sidebarAction` per window); one codebase stays possible with a split manifest + `webextension-polyfill`. |
| T2 | A local broker written by us, not a third-party library — nothing existing combines local-CLI reuse + per-origin policy. |
| T3 | WebSocket transport, not `fetch` — Local Network Access gates `fetch` to `127.0.0.1` behind a user permission a service worker can't request itself; WebSockets still escape that (crbug.com/421156866). |
| T4 | No secret in `chrome.storage.local` (unencrypted on disk) — the pairing key lives in `chrome.storage.session`; model credentials never leave the broker. |
| T5 | No `<all_urls>`: `activeTab` + optional host permissions — shrinks the blast radius of a compromised content script, avoids manual store review. |
| T6 | The content script sends sanitized text, never HTML; the broker treats that text as data, never as an instruction — a hostile page writes to the DOM the content script reads; this is the main injection vector for this extension shape. |
| T7 | Default model provider of the public repo: `ollama`, fully local. `claude-api` (BYOK) is the second built-in provider. |
| T8 | One repo, one common provider interface (`broker/src/providers/types.ts`): two built-in providers plus external modules loaded dynamically from `config.json`, outside the repo — see `docs/MODULES.md`. |
| T9 | An external provider module (dependencies included) never enters the public repo or the default compiled binary — dynamic loading only, from a path given in `config.json`. |
| T10 | Superseded by the reading-levels rework (`docs/ROADMAP.md` L2) — per-site declarative, signed recipes are no longer the plan. |
| T20 | The threat boundary is the OS user account, and the code enforces it: exact `Host` allowlist, then peer UID on Linux, before any routing; not enforced on macOS/Windows, stated at startup. |
| T21 | Superseded by Native Messaging pairing (T48) — session tokens no longer exist. |
| T22–T23 | Superseded by Native Messaging pairing (T48) — the "one-click" pairing path and `/pair` for Chromium are both removed. |
| T24 | Port 8787 fixed — `config.port` is no longer read; the service worker address and the CSP's `connect-src` are literal. |
| T25 | Provider availability checked only when the panel opens, no billed call (`provider.status`, 60 s cache). |
| T26 | No automatic provider switch — only a user-issued `settings.set` changes it; switching providers changes who receives page content. |
| T45 | Generic page reading comes before any paid module — visible-block heuristics (`checkVisibility`, shadow DOM, repeated sibling blocks) benefit every site for free. |
| T48 | Native Messaging delivers the extension a key drawn fresh on every broker start (`broker-key.json`, mode 0600); the legacy pasted-secret path (`legacyPairing`) stays off by default, for Flatpak/Snap browsers only. |
| T49 | Handshake `v: 2` is a mutual HMAC challenge-response, broker proves first; key never crosses the wire; nonces/proofs validated as `^[0-9a-f]{64}$` before any decoding; constant-time comparison; cap of 16 concurrent unauthenticated connections. Peer UID not enforced on macOS/Windows — file permissions on the key carry that case instead. |
| T50–T53 | UI/UX decisions for the read button, first-run checklist, model picker, and Ollama responsiveness tuning (timeouts, warm-up, context sizing) — still in force, detail in commit history rather than here. |
| T54 | Point-to-element, screenshot-on-ask, and official-doc search are bounded so they never make Coati act on a page and never add a new permission. Click-after-consent (rule D) is explicitly NOT covered by this decision — it needs its own entry before any code. |
| T55 | `<all_urls>` is optional-only, requested once when "See the screen" is turned on, never in `host_permissions`. |
| T56 | Replaced: the Brave/Tavily search and the `docSearch` message were removed; search will run in the browser's default engine (see `docs/ROADMAP.md`). |
| T57 | "Page on demand": a `chat` can offer page metadata only, letting the model ask for the real content (a literal marker in its streamed answer) only when it needs it, instead of sending page text on every question. Why: cost (most questions don't need the page) and latency; the marker-in-text approach works identically across every provider (no native tool-calling API required, no per-provider branching); detection lives in one shared place (`model/page-marker.ts`) rather than duplicated per provider. |
| T58 | "Search in the browser": when the panel announces `abilities: ["search"]`, the model may reply `[[SEARCH: <query>]]`; the extension runs the query in the browser's default engine in a background tab, reads the results and at most two pages, and the broker re-runs the question with them fenced as data and numbered `[S1]…`. Why: no search key or service of ours, the user's own engine, and the same marker mechanism as T57 (one detector, any provider). No confirmation: the query is shown in a status line and the count is reported under the answer (`done.search`). One automatic search per question; a second one is only offered to the user as a button (`done.suggest`). |
| T59 | "Click and type, confirmed": when the panel announces `abilities: ["act"]` and the page was read with its elements, the model may reply `[[CLICK eN]]` or `[[TYPE eN: <text>]]`; the broker sends `action.request`, the extension shows the target and asks the user (Allow / Refuse), acts only on Allow, and reports `action.result`; the page is re-read and the question goes on. One action at a time, `MAX_ACTIONS_PER_QUESTION` 5. Why: T54 asked for it; same marker mechanism as T57/T58; every action stays a user gesture. `by: "user"` lets the lighter variant (Coati highlights, the user clicks) use the same wire. |

## Superseded, kept for the record
- T54/T55 (permanent screen switch): to be replaced — the model proposes a screenshot, the user accepts in one click (`docs/ROADMAP.md` L4).
- T56 (Brave/Tavily search): replaced by T58.

## Hard constraint — the gesture rule
Every action Coati performs on a page is a gesture of the user. Coati never acts by itself: no
background loop, no multi-page crawl, no unprompted interaction (subscribe, like, publish). A click
or a keystroke happens only after the user has seen the target and pressed Allow, one action at a
time (T59); some gestures are refused even then: paying, sending a message, deleting, publishing,
signing in. This is load-bearing: Cloudflare's bot taxonomy, platform ToS, and the Chrome Web Store
all draw the same line, and crossing it loses all three protections at once. The named exception:
opening a YouTube transcript is one click on a button YouTube already shows, only in direct
response to the user's own click or question, on the tab they are looking at — never on page load, never
looped, never on another tab.
