# Coati protocol

The contract between the extension and the local broker. This document describes the current
state only — amendment history lives in the broker's own source comments, not here.

## Overview

The extension never calls a model provider directly and holds no credential. It talks to the
broker — a small program running on the same machine — over a single authenticated WebSocket.
The broker builds the prompt, calls the configured model provider, and streams the answer back.

## Transport

- WebSocket, `ws://127.0.0.1:8787/ws`. Port 8787 is fixed in the broker (`config.ts`'s
  `FIXED_PORT`) and in the extension's CSP — not configurable.
- Every HTTP/WebSocket request is checked, before any routing: the `Host` header must exactly
  match `127.0.0.1:8787` (`localhost` and `[::1]` are refused); on Linux, the connecting
  process's UID must equal the broker's own (`/proc/net/tcp[6]` lookup) — not enforced on
  macOS/Windows.
- `Origin` must be `chrome-extension://<an allowed id>` or a well-formed
  `moz-extension://<uuid>` (any uuid — the handshake key is what actually authenticates, not the
  origin). A missing or other `Origin` gets a plain HTTP 403 before the WebSocket upgrade and
  before the peer-UID lookup; such a request never counts toward the connection cap below.
- Up to `MAX_UNAUTH_CONNECTIONS` = 16 connections may be open and not yet authenticated at once;
  further ones are rejected and logged (rate-limited log line, one per 10 s window).

## Pairing

A native program the browser itself launches — Native Messaging host id `com.getcoati.broker`
(Chromium) / `coati@getcoati.com` (Firefox) — hands the extension a key drawn fresh on every
broker start (`broker-key.json`, mode 0600). Same executable as the broker
(`native-host.ts`), reads exactly one Native Messaging frame (`{ type: "key.get", v: 1 }`),
replies with exactly one (`{ type: "key", v: 1, key }` or `{ type: "error", v: 1, code }`), and
exits. Caller is verified twice: the browser's own Native Messaging allowlist, then,
defense-in-depth, `verifyCaller()` checking the invocation arguments match the expected
Chromium origin or Firefox id+manifest-path shape.

**Legacy pairing** (`legacyPairing` in `config.json`, off by default — for Flatpak/Snap
browsers, which can't launch a native host): a permanent secret printed by
`coati-broker --show-pairing-secret`, pasted once into the extension's settings, kept in memory
only. Usable as an alternate key (`key: "pasted"`) in the same handshake below.

## Handshake `v: 2`

Mutual HMAC challenge-response. The key never crosses the wire; the broker proves it first.

1. Client → broker: `hello` — `{ type: "hello", v: 2, nonce: cN, key?: "native" | "pasted", lang? }`.
   `cN` is 64 lowercase hex chars (32 random bytes), fresh per connection. `key` selects which
   secret to use (native broker key by default; `"pasted"` only if `legacyPairing` is on).
2. Broker → client: `challenge` — `{ type: "challenge", v: 2, nonce: bN, proof: bP }`, where
   `bP = HMAC(K, cN:bN)`.
3. Client → broker: `auth` — `{ type: "auth", v: 2, proof: eP }`, where `eP = HMAC(K, cN:bN)`.
4. Broker compares `eP` to its own expectation in constant time. Match → `hello-ok` (see below).
   Mismatch, malformed nonce/proof, wrong message order, or no `hello` within 3 s (armed at
   connection open, never reset) → the one generic failure below.

Every handshake failure — wrong key, malformed or out-of-order message, timeout — produces the exact same wire
message, so a probing client can't tell them apart:
```json
{"type":"error","id":"hello","code":"unauthorized","message":"unauthorized"}
```
followed by WebSocket close code **4401**. The real reason goes only to the broker's own stderr.

On success: `{ type: "hello-ok", v: 2, features: string[] }`. `features` is an open-ended list
of capability words this broker build understands (currently `"elements"`, `"vision"`,
`"history"`, `"pageOnDemand"`, `"search"`) — the extension only offers a capability's UI when
its word is present.

## Client → broker messages

All carry an `id` (string) except `hello`/`auth`, which belong to the handshake, not this table.

| Type | Key fields | Purpose |
|---|---|---|
| `chat` | `text`, `context?`, `image?`, `history?`, `page?`, `devMode?`, `abilities?`, `searchQuery?`, `pageUnreadable?` | Ask the model a question. `context` carries page/selection content up front; `page` (title/url/kind?/chars), sent only when `context` is absent, offers the page's metadata only — see "Page on demand" below. `abilities` (`"search"`) lists what the panel can do beyond reading; `searchQuery` (1–200 chars) asks the broker to search right away — see "Search"; `pageUnreadable` (`true`) says the current page is one the browser does not let Coati read (an internal browser page, a PDF viewer): the question carries no page and the model is told so |
| `page.content` | `target` (the `chat`'s own id), `level` (`"text"`\|`"dev"`), `context` | Answers a `page.request`: the page's content, same `Context` shape a `chat` would have carried up front (for `level: "dev"`, `context.text` holds cleaned HTML). |
| `page.decline` | `target` | Answers a `page.request`: the user declined to share the page. |
| `search.content` | `target`, `query`, `results: [{ n, title, url, snippet }]` | Answers a `search.request`: the results, no page. |
| `search.decline` | `target`, `reason` (`"no-access"`\|`"no-result"`\|`"blocked"`\|`"failed"`) | Answers a `search.request`: nothing could be searched or read (`"blocked"`: the user refused the search). |
| `open.content` | `target`, `pages: [{ n, url, title, text }]` | Answers an `open.request`: the pages read. |
| `open.decline` | `target`, `reason` (`"no-access"`\|`"blocked"`\|`"failed"`) | Answers an `open.request`: no page could be opened. |
| `summarize` | `context` | Summarize a page/selection. |
| `prompts.list` | — | List saved prompts. |
| `prompts.save` | `prompt: { id?, site, title?, body }` | Create (no `id`) or update (with `id`) a saved prompt. |
| `prompts.delete` | `promptId` | Delete a saved prompt. |
| `prompts.move` | `promptId`, `site`, `order` | Move a prompt to another site bucket and/or reorder. |
| `prefs.get` | — | Read per-site preferences. |
| `prefs.set` | `site`, `prefs` | Write per-site preferences. |
| `cancel` | `target` (the `id` of an in-flight request) | Cancel a running `chat`/`summarize`. |
| `settings.get` | — | Read current provider/model configuration. |
| `settings.set` | `provider?`, `model?`, `apiKey?`, `baseUrl?`, `clearKey?`, `removeBaseUrl?` | Change configuration. `apiKey` is write-only (never echoed back); `""` forgets the stored value, omitted leaves it unchanged. A non-empty `apiKey` is format-checked first (`sk-ant-` for `claude-api`; for `openai-compat`, `sk-or-` at openrouter.ai and `sk-` at api.openai.com; otherwise non-empty and without whitespace): a malformed key is refused with `bad-request`, a localized message, and nothing is applied. `openai-compat` can hold several services at once, one active: a valid `baseUrl` makes that address the active service (added to the configured services when new; the model last used on it comes back unless the same message names a `model`), and every other service keeps its address, model and key. A key is stored per URL origin and only ever sent to that origin. `clearKey: "openai-compat"` forgets the active service's key; `removeBaseUrl` removes that service and its key (unless another service shares the origin) and is the only way a service goes away. An empty `baseUrl` is refused. |
| `settings.test` | `provider` | Free connectivity probe for a provider. |
| `provider.status` | — | Check whether the active model provider will likely work right now (never billed). |
| `models.list` | — | List every usable model across configured sources, plus host capacity. A provider with `listModels()` offers exactly that list (`claude-api`: `/v1/models` with the stored key, nothing when there is no key or the key fails); a remembered model (`lastModels`) absent from the list is forgotten in favour of the provider's default, never offered. |
| `model.warmup` | — | Ask the broker to pre-load the active Ollama model. |

## Broker → client messages

| Type | Key fields | Purpose |
|---|---|---|
| `chunk` | `id`, `delta` | One streamed fragment of a model answer. |
| `done` | `id`, `usage: { inputTokens, outputTokens }`, `historyKept?`, `page?`, `search?`, `suggest?` | End of stream; token usage (summed over every provider call this request made, see "Page on demand"); how many `history` entries were actually used; `page: { level, chars, sentChars, truncated }` present only when the page was actually read; `search: { queries, results, pages, chars, capped? }` only when a search returned results; `suggest: { search }` when the model asked for a further search that was not run |
| `page.request` | `id` (the `chat`'s own id), `level` (`"text"`\|`"dev"`), `discard?` | The model asked to read the page — see "Page on demand" below. |
| `search.request` | `id` (the `chat`'s own id), `query`, `discard?` | The model asked to search the web — see "Search" below. |
| `open.request` | `id` (the `chat`'s own id), `refs: [{ n, url }]`, `discard?` | The model asked to open search results — see "Search" below. |
| `error` | `id`, `code`, `message`, `retryAfterSec?`, `reason?` | A request failed — see error codes below. |
| `prompts` | `id`, `items`, `prefs?` | Reply to `prompts.list`/`prompts.save`/`prompts.delete`/`prompts.move`. |
| `prefs` | `id`, `sites` | Reply to `prefs.get`/`prefs.set`. |
| `hello-ok` | `v: 2`, `features` | Handshake succeeded. |
| `challenge` | `v: 2`, `nonce`, `proof` | Handshake step 2 (see above). |
| `settings` | `id`, `provider`, `model?`, `available`, `models?`, `baseUrl?`, `services?` | Reply to `settings.get`/`settings.set`. `available` lists every known provider, including unavailable ones, with a `reason`. `baseUrl` is the active openai-compat address, sent only while `openai-compat` is the active provider. `services` lists every configured openai-compat service, active or not: `{ baseUrl, model?, hasKey }` (`hasKey` is a boolean; the key is never sent); absent when none. |
| `settings.test-result` | `id`, `provider`, `ok`, `message`, `code?`, `creditUnchecked?` | Reply to `settings.test`. |
| `provider.status-result` | `id`, `provider`, `state` (`"ok"`\|`"ko"`\|`"unknown"`), `reason`, `checkedAt`, `baseUrl?` | Reply to `provider.status`. |
| `models` | `id`, `current`, `entries`, `sources`, `host` | Reply to `models.list` — each entry carries `provider`, `model`, `local`, and when known `sizeBytes`, `thinks?`, `fit?` (`"gpu"`\|`"shared"`\|`"too-big"`), `gpuPercent?`, `contextTokens?`, `vision?`. `host` reports rounded `ramGb`/`vramGb`/`unifiedMemory?`, read locally, never sent anywhere external. |
| `model.warmup-result` | `id`, `state` (`"loaded"`\|`"already"`\|`"skipped"`\|`"failed"`), `ms?` | Reply to `model.warmup`. |
| `progress` | `id`, `stage` (`"loading"`\|`"reading"`\|`"thinking"`) | Sent before the first chunk, Ollama only. |

## Error codes

`bad-request`, `unauthorized`, `model-unavailable`, `auth-required`, `quota-exceeded`,
`rate-limited`, `model-missing`, `provider-overloaded`, `context-too-large`, `cancelled`,
`model-stalled`, `vision-unsupported`, `page-unavailable`, `internal`.

`page-unavailable`: the client never answered a `page.request` (with `page.content` or
`page.decline`) or a `search.request` (with `search.content` or `search.decline`) or an `open.request` (with `open.content` or `open.decline`) within `PAGE_REQUEST_TIMEOUT_MS` (`SEARCH_REQUEST_TIMEOUT_MS` for a `search.request`).


## Limits

| Constant | Value | Meaning |
|---|---|---|
| `MAX_MESSAGE_BYTES` | 256 KiB | Largest client message, except `chat` carrying an image. |
| `MAX_IMAGE_MESSAGE_BYTES` | 1.5 MiB | Largest `chat` message when it carries an `image`. |
| `IMAGE_MAX_DECODED_BYTES` | 1 MiB | Largest decoded image. |
| `IMAGE_MAX_SIDE` | 2000 px | Largest image dimension. |
| `MAX_CONTEXT_CHARS` | 40,000 | Largest page/selection text accepted; also the cap for a `page.content` at `level: "text"`. |
| `MAX_DEV_CONTEXT_CHARS` | 400,000 | Largest `page.content` at `level: "dev"` (cleaned HTML) accepted — further fit to the active model's own context window, see "Page on demand". |
| `PAGE_REQUEST_TIMEOUT_MS` | 120,000 | Time the broker waits for `page.content`/`page.decline` after a `page.request`. |
| `SEARCH_REQUEST_TIMEOUT_MS` | 300,000 | Wait for the answer to a `search.request` (the user may be deciding). |
| `SEARCH_MAX_PER_QUESTION` | 4 | Automatic searches per question. |
| `SEARCH_MAX_RESULTS` | 8 | Results accepted in a `search.content`. |
| `SEARCH_MAX_OPENED` | 6 | Pages opened per question. |
| `OPEN_MAX_REFS` | 3 | Refs in one `[[OPEN: …]]` / `open.request`. |
| `OPEN_PAGE_MAX_CHARS` | 6000 | Characters of one page in an `open.content`. |
| `SEARCH_BUDGET_LOCAL_CHARS` | 32,000 | Snippet + page characters per question, local model. |
| `SEARCH_BUDGET_ONLINE_CHARS` | 64,000 | Snippet + page characters per question, online model. |
| `CHAT_MAX_MODEL_TURNS` | 10 | Model calls per question. |
| `SEARCH_QUERY_MAX_CHARS` | 200 | Longest search query. |
| `HISTORY_MAX_ENTRIES` | 20 | Largest `history` array accepted. |
| `MAX_CONCURRENT_STREAMS` | 3 | Concurrent `chat`/`summarize` per connection. |
| `FIRST_TOKEN_TIMEOUT_LOCAL_MS` | 300,000 | Time to first activity, local provider (Ollama). |
| `FIRST_TOKEN_TIMEOUT_REMOTE_MS` | 120,000 | Time to first activity, remote provider. |
| `INACTIVITY_TIMEOUT_MS` | 60,000 | Silence mid-answer before `model-stalled`. |
| `SETTINGS_TEST_TIMEOUT_MS` | 20,000 | `settings.test` probe timeout. |
| `HOST_FRAME_TIMEOUT_MS` | 5000 | Native-host stdin read timeout. |
| `MAX_FRAME_BYTES` | 4096 | Native Messaging frame length cap. |

## Page on demand

A `chat` that carries `page` (title/url/kind?/chars) and no `context` at all shows the model only
that metadata, plus a trusted instruction: if the request is about this page or something it
shows, reply with exactly `[[READ_PAGE]]` and nothing else; `[[READ_PAGE_DEV]]` (the page's full
cleaned HTML) is offered only when `devMode: true`. Otherwise the model answers directly, without
ever reading the page — this is the cost/latency win over sending page content on every `chat`.
After a `text`-level read, when `devMode` is true and the dev marker hasn't been used yet for this
question, the re-run prompt still offers `[[READ_PAGE_DEV]]` alongside the page's text — a
question can escalate text→dev, never the other way, and nothing is offered at all after a `dev`
read.

The broker scans the streamed answer for either marker in one shared place (`model/page-marker.ts`
+ `handlers/chat.ts`), regardless of which provider is active — never per provider. Text is held
back only for as long as it could still be forming a marker; once decided, it is forwarded (or,
for a marker, never forwarded at all):

- Marker at the very start of the answer: the provider stream is aborted, nothing was shown, the
  broker sends `page.request { id: <chat id>, level }`.
- Marker appearing later, mid-answer: same abort, but `page.request` also carries `discard: true`
  — the client must clear whatever of that answer it already displayed.
- The client answers with `page.content` (content merged into a fresh prompt, same question
  re-run) or `page.decline` (a trusted note replaces the content: "the user declined..."). No
  answer within `PAGE_REQUEST_TIMEOUT_MS` fails the request with `page-unavailable`. A
  `page.content.level` other than the one `page.request` actually asked for is a protocol
  breach — `bad-request`, the request stops, nothing is re-run.
- At most one read per level and two reads per question. A marker beyond that cap is stripped
  from the forwarded text and otherwise ignored — no further `page.request`, no abort.
- Thinking/reasoning content is never scanned for a marker.

`done.usage` on a page-on-demand request is the sum of every provider call the question made
(the initial metadata-only call, plus one per `page.request` round trip). `done.page` is present
only when the page was actually read, reporting the level, the content's own length, how much of
it actually reached the model (`sentChars`), and whether it was truncated (dev level only, fit to
the active model's context window — Ollama's own `contextTokens` tier when known, else a fixed
8192-token fallback on lookup failure; 200,000 tokens for `claude-api`/`claude-cli`, 32,768 for
any other provider; ~3.5 chars/token, 2000 tokens reserved for the answer).

## Search

Offered to the model only when the `chat` carries `abilities` including `"search"` (the panel sets
it when the browser can search). The model works in steps, one marker per reply, each alone or
mid-answer; anything else stays ordinary text. Detection, abort and `discard` work exactly as for
the page markers (same detector, same place).

- `[[SEARCH: <query>]]` — one line, 1 to 200 characters, no `]]`. Broker → client
  `search.request { id, query, discard? }`. The client runs the query in the browser's default
  engine and answers `search.content { target, query, results }` (results and snippets only; it
  opens no page on its own) or `search.decline`. Once a page was read in the conversation, the
  client first asks the user to allow the query and answers `search.decline "blocked"` on a
  refusal; the wait for that answer is `SEARCH_REQUEST_TIMEOUT_MS`.
- `[[OPEN: S<n> S<m> …]]` — 1 to `OPEN_MAX_REFS` result numbers already received in this
  question, separated by spaces or commas. Broker → client `open.request { id, refs: [{ n, url }],
  discard? }`, `url` being the one the client reported for result `S<n>`. The client opens those
  pages and answers `open.content { target, pages: [{ n, url, title, text }] }` (`n` among the
  requested refs, each at most once; `url` the page's final address; a page it could not read is
  simply absent) or `open.decline { target, reason }` (`"no-access"`\|`"blocked"`\|`"failed"`).
  A page whose final address (after redirects) fails the open guard or is on another site than
  the result is not read: it is absent.
  Unknown refs and refs already opened are dropped; with none left, the marker is stripped and
  ignored. Refs beyond the pages still allowed are dropped from the request.
- `S<n>` numbering is continuous over every search of the question: a result's number is the
  count of results received in earlier searches plus its rank in its own `search.content`. A
  result dropped for budget keeps its number, unused, so client and broker always agree.
- No answer to `search.request`/`open.request` within `PAGE_REQUEST_TIMEOUT_MS` fails the request
  with `page-unavailable`. A `search.content` with more than `SEARCH_MAX_RESULTS` results, an
  `open.content` with a page over `OPEN_PAGE_MAX_CHARS` characters, more pages than refs, or an
  `n` not requested, is refused (`context-too-large` for sizes, `bad-request` for the rest).
- Per question: at most `SEARCH_MAX_PER_QUESTION` searches, `SEARCH_MAX_OPENED` pages, and a
  cumulative budget of snippet + page characters — `SEARCH_BUDGET_LOCAL_CHARS` for a local
  model (`ollama`, or `openai-compat` on a loopback address), `SEARCH_BUDGET_ONLINE_CHARS`
  otherwise. Results and pages that no longer fit are dropped whole, in order, and the model is
  told. Once a limit is reached the marker is no longer offered; a marker past a limit is
  stripped from the text and ignored (no request, no abort) and `done.search.capped` is set; a
  further `[[SEARCH: …]]` also reports its query in `done.suggest.search`.
- Re-run: every search's results and every opened page are fenced as data, numbered `[S<n>]`,
  with an instruction to cite them and to copy links exactly from them; they are never
  instructions. A decline, a page that could not be read, or a dropped entry becomes a trusted
  note. With the search ability the model also gets a short method: 2-3 varied queries, open
  primary pages rather than "best X" lists and affiliate pages, a second search on the names
  found, then a list or table with one link per proposal. While searches or pages are left, it
  is told to search again or open pages itself when the results fall short, never to ask the
  user to search.
- `chat.searchQuery`: the broker sends `search.request` at once, without a prior model call
  (the button offered by `done.suggest`).
- `done.search { queries, results, pages, chars, capped? }` is present when at least one search
  returned results: `queries` the queries that did, `results`/`pages` how many reached the model,
  `chars` their total characters.
- Every marker (page, search, open) shares one bound: at most `CHAT_MAX_MODEL_TURNS`
  model calls per question; the last call is offered no marker, and any marker it writes is
  stripped. After a read or a search, a reply whose only content was stripped markers gets one
  more call, offered no marker and told to answer now.

## Prompt construction

The broker is the only place a prompt is assembled (`model.ts`'s `buildSystemPrompt`/
`buildPrompt`). Page content, selection text, screenshots, and prior
`history` turns are all fenced with a per-request random nonce and explicitly labelled data —
never instructions — in the system prompt. A model provider or external module receives the
already-built prompt; it never sees raw, unfenced page content.

## Model providers

Built in: `ollama` (local, no credential needed), `claude-api` (BYOK, Anthropic key stored by
the broker), `openai-compat` (any OpenAI-compatible HTTP endpoint — LM Studio, OpenAI, Mistral,
OpenRouter, DeepSeek, ...).

External providers load dynamically from a path in `config.json`'s `modules`, each exporting a
default `createProvider(host, options)` returning a `ModelProvider`
(`id`, `label`, `isAvailable`, `checkStatus`, `streamAnswer`, optionally `listModels`,
`defaultModel`, `testConnection`, `vision`). Never from a relative path, never from a URL — only
a file already on the machine, named by the user's own config. A module that fails to load is
logged and skipped, never fatal; a configured provider matching no loaded module is reported
unavailable by `settings.get`, never silently swapped for another.
