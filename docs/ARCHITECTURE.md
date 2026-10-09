# Coati — architecture

## Map of the code, with weights

| Area | Lines | Role |
|---|---|---|
| `extension/panel/` | ~7,500 | side panel: chat, page reading, "Show", screenshot, history (39 files) |
| `extension/` root + `options/` | ~4,100 | settings page (`options.css` ~1,500, setup tutorial ~790) |
| `extension/content/` | ~2,600 | page reading (`extract/`, 9 files; `extract-dev.js`, dev level) + "Show" pointer |
| `extension/lib/` | ~2,500 | shared helpers: i18n, pairing, key entry, model list |
| `extension/_locales/` | ~2,700 | en/fr/zh_CN text (~890 each) |
| `extension/prompts/` | ~1,300 | "My prompts" page |
| `extension/background/` | ~760 | service worker (connection to the local program) |
| `extension/welcome/` | ~400 | first-run page |
| `extension/vendor/` | ~3,400 | SortableJS (third-party, prompt drag-and-drop) |
| `broker/src/` | ~11,400 | local program: handshake, protocol, model prompts, settings |
| — `broker/src/providers/` | ~2,400 | Ollama, OpenAI-compatible, Claude API |
| — `broker/src/search/` | ~1,600 | Brave/Tavily search + per-site doc search — to be replaced by browser search (`docs/ROADMAP.md` L3) |
| `broker/test/` | ~17,400 | unit + integration tests (3,441 of them) |
| `scripts/install/`, `packaging/` | ~1,850 | Linux/macOS/Windows installers, systemd/launchd/Native Messaging templates |
| `scripts/brand/` | ~990 | rebuilds the logo from source assets |

## What each top-level folder does

- **`extension/`** — the Manifest V3 extension: panel (UI + conversation state), background
  (service worker, the one WebSocket to the broker), content (page extraction, injected on
  demand), options (settings page), prompts (the "My prompts" page), welcome (first-run page).
- **`broker/`** — the local server: `src/server.ts` wires everything; `src/protocol/` is the
  wire format (`docs/PROTOCOL.md`); `src/handlers/` implements each message type;
  `src/providers/` talks to a model; `src/model.ts`/`model/` builds prompts and streams answers;
  `src/search/` is the current doc-search implementation.
- **`scripts/`** — build, install, branding, and lab/measurement tooling.
- **`packaging/`** — systemd/launchd unit templates and Native Messaging manifest templates the
  installers copy into place.

## Request flow: panel → model → panel

1. The user sends a question. The panel reads the active tab locally (text level, free) but sends
   only the page's title, address and size with the question (`chat.page`).
2. The background service worker forwards the message as-is on the single open, authenticated
   WebSocket; the broker's `server.ts` dispatches it to `broker/src/handlers/chat.ts`.
3. The broker builds the prompt (`model.ts`), fencing page data/history/screenshots as data, and
   streams the provider's answer through one shared marker scanner (`model/page-marker.ts`).
4. If the model answers `[[READ_PAGE]]` (or `[[READ_PAGE_DEV]]` in dev mode), the broker stops it
   and sends `page.request`; the panel answers `page.content` (text level: the extraction it
   already has; dev level: `content/extract-dev.js`) — `panel/page-request.js` — and the broker
   runs the question again with the page.
5. Each fragment comes back as a `chunk`; a final `done` carries token usage and, when the page
   was read, `done.page` — the line under the answer says which.

## Modules (external model providers)

A module is a `.ts`/`.js` file named by an absolute path in `config.json`'s `modules`, loaded
dynamically at broker startup — never from a relative path, never from a URL. It exports a
default `createProvider(host, options)` returning a `ModelProvider`: `id`, `label`,
`isAvailable()`, `checkStatus()`, `streamAnswer()`, and optionally `listModels()`,
`defaultModel`, `testConnection()`, `vision`. `host` gives it `buildSystemPrompt`,
`MODEL_TIMEOUT_MS`, the error classes to throw, and a prefixed logger — never a path into the
broker's own source. A module that fails to load is logged and skipped, never fatal. Full
interface and example: `docs/PROTOCOL.md`, "Model providers".

## Why

- **No bundler.** The extension is native JavaScript until a real need justifies a dependency —
  keeps the diff a store reviewer sees identical to what ships.
- **No `tabs` permission.** `activeTab` plus optional, per-origin host permissions only — a
  compromised content script's blast radius stays small, and nothing resembling "read your
  browsing history" shows up at install time.
- **Secrets only in the local program.** Browser extension storage is unencrypted on disk and
  exposed to every page visited; model credentials and the broker's own key never enter the
  extension's persistent storage.
- **Native Messaging pairing.** Only the browser can launch the native host, and only for
  Coati's own extension id — so the pairing key reaches the right extension without the user
  copying anything, and without trusting the WebSocket's `Origin` header alone.
- **Page content is data, never instructions.** Every prompt fences page text, screenshots, doc
  search results, and conversation history as labelled data, assembled in exactly one place
  (`model.ts`) — a hostile page can say anything, it still can't make the model treat its text as
  a system instruction.
- **The broker is structurally local.** `127.0.0.1` and port 8787 are literal, not configuration
  — opening the broker to the network is a threat-model change, not a setting.
- **The model never acts on a page directly.** The protocol only carries text and references
  (e.g. a numbered element for "Show"), never DOM coordinates or a click command — see the
  gesture rule in `CLAUDE.md`.
