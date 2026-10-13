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
| T59 | "Click and type, confirmed": removed from v0.1.0, planned later (`docs/ROADMAP.md`). The model never clicks or types; "Show" (Coati points, the user clicks) stays. |
| T60 | "Advanced search": the model chains up to four `[[SEARCH: …]]` and opens the results it picks with `[[OPEN: S<n> …]]` (at most six pages, three per request); `S<n>` is numbered by the broker across the whole question; the extension no longer opens pages on its own. Per-question character budget by model locality (32,000 local, 64,000 online), ten model calls at most, a marker past a limit is stripped. A short method instruction (varied queries, primary pages, second hop on names found, one link per proposal copied from the sources). Why: one search with two automatic pages mostly read "best X" lists; the model choosing what to open reads primary pages, and the budgets keep a local model inside its context window. Supersedes T58's "one automatic search, two pages". |
| T61 | "Links in answers" (`extension/lib/link-safety.js`): a model-written link is clickable only if (1) it is `https:` to a domain name — no IP, no port, no `user@`, ≤ 2,048 characters, nothing local or private (`lib/open-guard.js`); (2) its host is shown after the label, as `URL.hostname` gives it (`xn--…` for a look-alike script); (3) it is one of the conversation's sources or the current page — otherwise, if anything in the conversation was read (page or search), it stays text marked "not in the sources", else it is clickable marked "from memory, check it"; (4) its domain does not imitate a source or the current page (same name under another suffix, or a name 1 edit away, 2 from nine letters; names under five letters only by suffix) and its label does not read as another domain; (5) it opens in a new tab, `rel="noopener noreferrer"`, never automatically. Why: the likely attack is a read page or result planting a fake support or download link; links Coati found itself carry no such risk. |
| T62 | "Search after a read": once any page was read in the conversation (page, dev HTML, an opened result, earlier turns included until the conversation is cleared), each search the model asks for first shows a card in the panel with the full query and Allow / Refuse; a refusal reaches the broker as `search.decline "blocked"` and the model answers without it. Before any read, searches run unasked; `[[OPEN]]` shows no card (it only opens results of a confirmed search); a search the user started from a button is not asked twice. An opened page is read only if its final address passes the open guard and is on the result's own site (`www.` and http→https stay). Link rule 3 compares the full address, fragment included, and a link whose domain is named in a page title sent with a question is never "from memory" (T61). Why: a read page can make the model put its content, or other conversation data, into a query, a link or a redirect that leaves the machine. |
| T63 | "Invisible elements": the text-level hidden-text filter ignores `opacity: 0` and zero-size boxes; its checks (near-zero font, clipping, off-screen, same colour as the background) stay narrow on purpose. Why: a false negative keeps text the user may not see, a false positive deletes content the user does see, and the checks are a reduction of the injection surface, not a boundary (`extension/content/extract/page-kind-structure.js`). |

## Superseded, kept for the record
- T54/T55 (permanent screen switch): to be replaced — the model proposes a screenshot, the user accepts in one click (`docs/ROADMAP.md` L4).
- T56 (Brave/Tavily search): replaced by T58.

## Hard constraint — the gesture rule
Every action Coati performs on a page is a gesture of the user. Coati never acts by itself: no
background loop, no multi-page crawl, no unprompted interaction (subscribe, like, publish). Coati
never clicks or types in a page (T59); it only points, and the user clicks. This is load-bearing: Cloudflare's bot taxonomy, platform ToS, and the Chrome Web Store
all draw the same line, and crossing it loses all three protections at once. The named exception:
opening a YouTube transcript is one click on a button YouTube already shows, only in direct
response to the user's own click or question, on the tab they are looking at — never on page load, never
looped, never on another tab.
