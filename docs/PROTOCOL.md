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
- `Origin` is checked first: it must be `chrome-extension://<an allowed id>` or a well-formed
  `moz-extension://<uuid>` (any uuid — the handshake key is what actually authenticates, not the
  origin). A missing or other `Origin` gets a plain HTTP 403 before the WebSocket upgrade and
  before the peer-UID lookup; such a request never counts toward the connection cap below.
- Then, before any routing, the `Host` header must exactly match `127.0.0.1:8787` (`localhost`
  and `[::1]` are refused), and on Linux the connecting process's UID must equal the broker's own
  (`/proc/net/tcp[6]` lookup; a lookup that finds nothing is refused) — not enforced on
  macOS/Windows. A failure is a plain HTTP 403. Any path other than `/ws`,
  `/oauth/callback` (see "OAuth sign-in") and `/auth/callback` (see "ChatGPT sign-in") is a 404.
- `GET /auth/callback` is the ChatGPT sign-in return path: exact path, `GET` only, no `Origin`
  required (a top-level navigation), `Host` exactly `127.0.0.1:<port>` where `<port>` is the port
  the broker listens on (`localhost` is refused, unlike `/oauth/callback`), and the peer-UID
  check applies.
- Up to `MAX_UNAUTH_CONNECTIONS` = 16 connections may be open and not yet authenticated at once;
  a further one is closed at once with code 4401 and no `error` frame, and logged (rate-limited
  log line, one per 10 s window).
- Before authentication, a frame over `MAX_MESSAGE_BYTES` is a handshake failure (see below).
  After authentication, an oversized frame gets `error { id: "oversized", code: "bad-request" }`
  and the connection closes with code 1009.

## Pairing

A native program the browser itself launches — Native Messaging host id `com.getcoati.broker`
(Chromium) / `coati@getcoati.com` (Firefox) — hands the extension a key drawn fresh on every
broker start (`broker-key.json`, mode 0600, written only after the port is bound and removed on
a clean exit). Same executable as the broker (`native-host.ts`; the broker switches to host mode
on a `--native-host` argument, a `chrome-extension://…/` origin argument or the Firefox id), reads
exactly one Native Messaging frame (`{ type: "key.get", v: 1 }`) within `HOST_FRAME_TIMEOUT_MS`,
replies with exactly one (`{ type: "key", v: 1, key }` or `{ type: "error", v: 1, code }`), and
exits 0. Error codes: `forbidden-caller`, `bad-request` (not valid JSON or not `key.get`),
`broker-not-running` (no valid key file, or its `pid` is not a live process of the same account),
`internal`. A frame with an invalid length (outside 1–`MAX_FRAME_BYTES` bytes), a timeout or an
early end of input sends nothing and exits 1. Caller is verified twice: the browser's own
Native Messaging allowlist, then, defense-in-depth, `verifyCaller()` checking the invocation
arguments match the pinned Chromium origin or the Firefox id plus a manifest-path argument.

**Legacy pairing** (`legacyPairing` in `config.json`, off by default — for Flatpak/Snap
browsers, which can't launch a native host): a permanent secret printed by
`coati-broker --show-pairing-secret`, pasted once into the extension's settings, kept in memory
only. Usable as an alternate key (`key: "pasted"`) in the same handshake below.

## Handshake `v: 2`

Mutual HMAC challenge-response. The key never crosses the wire; the broker proves it first.

1. Client → broker: `hello` — `{ type: "hello", v: 2, nonce: cN, key?: "native" | "pasted", lang? }`.
   `cN` is 64 lowercase hex chars (32 random bytes), fresh per connection. `key` selects which
   secret to use (native broker key by default; `"pasted"` only if `legacyPairing` is on).
   `lang` is the client's UI language as a BCP 47 tag; the broker keeps it for the connection
   to localize user-facing messages (unrecognized or absent → English).
2. Broker → client: `challenge` — `{ type: "challenge", v: 2, nonce: bN, proof: bP }`, where
   `bN` is 64 hex chars and `bP = HMAC-SHA256(K, "coati-v2-broker:" + cN + ":" + bN)`.
3. Client → broker: `auth` — `{ type: "auth", v: 2, proof: eP }`, where
   `eP = HMAC-SHA256(K, "coati-v2-extension:" + cN + ":" + bN)`. The two labels differ, so a
   proof can't be replayed in the other direction. Proofs are lowercase hex.
4. Broker compares `eP` to its own expectation in constant time. Match → `hello-ok` (see below).
   Mismatch, malformed nonce/proof, a `hello` that isn't `v: 2`, wrong message order, or no
   completed handshake within 3 s (armed at connection open, never reset) → the one generic
   failure below.

Every handshake failure — wrong key, malformed or out-of-order message, timeout — produces the exact same wire
message, so a probing client can't tell them apart:
```json
{"type":"error","id":"hello","code":"unauthorized","message":"unauthorized"}
```
followed by WebSocket close code **4401**. The real reason goes only to the broker's own stderr.

On success: `{ type: "hello-ok", v: 2, features: string[] }`. `features` is an open-ended list
of capability words this broker build understands (currently `"elements"`, `"vision"`,
`"history"`, `"pageOnDemand"`, `"search"`, `"run-log"`) — the extension only offers a capability's UI when
its word is present.

## Client → broker messages

All carry an `id` (string) except `hello`/`auth`, which belong to the handshake, not this table.

| Type | Key fields | Purpose |
|---|---|---|
| `chat` | `text`, `context?`, `image?`, `history?`, `page?`, `devMode?`, `abilities?`, `searchQuery?`, `pageUnreadable?`, `readPart?` | Ask the model a question. `context` carries page/selection content up front; `page` (title/url/kind?/chars), sent only when `context` is absent, offers the page's metadata only (`title` and `url` at most 300 characters each; a malformed `page` is dropped, not refused) — see "Page on demand" below. `image` (`{ mediaType: "image/jpeg"|"image/png", data` base64`, width, height }`, both sides at most 2000 px, at most 1 MiB decoded, bytes matching the declared type) is a screenshot of the tab; an invalid one is dropped, and the question goes through as text. `history` is the earlier turns, `[{ role: "user"|"assistant", text }]`, oldest first. `devMode` only matters with `page`. `abilities` (`"search"`) lists what the panel can do beyond reading; `searchQuery` (1–200 chars) asks the broker to search right away — see "Search"; `pageUnreadable` (`true`) says the current page is one the browser does not let Coati read (an internal browser page, a PDF viewer): the question carries no page and the model is told so; `readPart` (`{ from, level }`, only with `context`) continues a reading the previous `done.page` left unfinished: the broker reads `context.text` from character `from` (`0 < from < context.text.length`, else `bad-request`), and `facts`, `items` and `elements` are ignored (already read in the first part); for `level: "dev"`, `context.text` is cleaned HTML |
| `page.content` | `target` (the `chat`'s own id), `level` (`"text"`\|`"dev"`), `context` | Answers a `page.request`: the page's content, same `Context` shape a `chat` would have carried up front (for `level: "dev"`, `context.text` holds cleaned HTML). |
| `page.decline` | `target` | Answers a `page.request`: the user declined to share the page. |
| `search.content` | `target`, `query`, `results: [{ n, title, url, snippet }]` | Answers a `search.request`: the results, no page. |
| `search.decline` | `target`, `reason` (`"no-access"`\|`"no-result"`\|`"blocked"`\|`"failed"`) | Answers a `search.request`: nothing could be searched or read (`"blocked"`: the user refused the search). |
| `open.content` | `target`, `pages: [{ n, url, title, text }]`, `failed?: [{ n, reason, status? }]` | Answers an `open.request`: the pages read, and the requested pages that could not be. |
| `open.decline` | `target`, `reason` (`"no-access"`\|`"blocked"`\|`"failed"`) | Answers an `open.request`: no page could be opened. |
| `summarize` | `context` (required), `readPart?` | Summarize a page/selection. `readPart` is as in `chat`, with `level: "text"` only. |
| `run.get` | `target` (the `id` of a `chat`) | Read the run log of a `chat`, in flight or among the last 5 finished; replied with `run`. See "Run log". |
| `prompts.list` | — | List saved prompts. |
| `prompts.save` | `prompt: { id?, site, title?, body }` | Create (no `id`) or update (with `id`: `title` and `body` change, `site` is ignored) a saved prompt. `body` is 1–`PROMPT_BODY_MAX` characters, `title` at most `PROMPT_TITLE_MAX` (trimmed; empty means none). `id` has the form `p_` + 12 hex chars; an unknown `id` is a `bad-request`. |
| `prompts.delete` | `promptId` | Delete a saved prompt. |
| `prompts.move` | `promptId`, `site`, `order` | Move a prompt to another site bucket and/or reorder (`order`: prompt ids or `coati:<a>:<b>` suggestion ids). An unknown `promptId` is a `bad-request`. |
| `prefs.get` | — | Read per-site preferences. |
| `prefs.set` | `site`, `prefs: { order?, removed? }` | Write per-site preferences. A `site` key is `*`, `@<name>` (a popular-site bucket) or a bare hostname without `www.`; `order` and `removed` hold prompt or suggestion ids. |
| `cancel` | `target` (the `id` of an in-flight request) | Cancel a running `chat`/`summarize`, including one waiting on a `page.request`/`search.request`/`open.request`; that request ends with `error` `cancelled`. An unknown `target` is ignored. |
| `settings.get` | — | Read current provider/model configuration. |
| `settings.set` | `provider?`, `model?`, `apiKey?`, `baseUrl?`, `clearKey?`, `removeBaseUrl?`, `welcomed?` | Change configuration. `apiKey` is write-only (never echoed back); `""` forgets the stored value, omitted leaves it unchanged. A non-empty `apiKey` is format-checked first (`sk-ant-` for `claude-api`; for `openai-compat`, `sk-or-` at openrouter.ai and `sk-` at api.openai.com; otherwise non-empty and without whitespace; at most 512 printable ASCII characters in all): a malformed key is refused with `bad-request` and nothing is applied. `baseUrl` (at most 512 characters) must be `https://`, or `http://` on a loopback host (`localhost`, `127.0.0.1`, `[::1]`); anything else is a `bad-request`. `provider` and `clearKey` only need to look like a provider id; an unknown id is not refused here (see "Model providers"). A `provider` switch without `model` brings back the model last used with that provider, or none: never the previous provider's model. `openai-compat` can hold several services at once, one active: a valid `baseUrl` makes that address the active service (added to the configured services when new; the model last used on it comes back unless the same message names a `model`), and every other service keeps its address, model and key. A key is stored per URL origin and only ever sent to that origin. `clearKey: "openai-compat"` forgets the active service's key; `removeBaseUrl` removes that service and its key (unless another service shares the origin) and is the only way a service goes away. An empty `baseUrl` is refused. `chatgpt` takes no key: a non-empty `apiKey` while it is the target provider is a `bad-request`, nothing applied. `clearKey: "chatgpt"` signs out of ChatGPT: the broker revokes the refresh token at the discovery `revocation_endpoint`, then clears the tokens locally (the host id, client id, subject and email are kept); if revocation fails the tokens are still cleared and the reply's `account` carries `revokeUnconfirmed: true`. `welcomed: true` dismisses the one-time "You're using your ChatGPT plan" notice. |
| `oauth.start` | `service` (`"openrouter"`\|`"chatgpt"`), `consent?` (`true`) | Begin a browser sign-in; replied with `oauth.started`. `consent: true` is for `"chatgpt"` only and adds `prompt=consent` (the "allow plan usage" retry). See "OAuth sign-in" and "ChatGPT sign-in". |
| `settings.test` | `provider` | Free connectivity probe for a provider, bounded by `SETTINGS_TEST_TIMEOUT_MS`. A provider with no free probe of its own (an external module) gets a minimal real model call instead. |
| `provider.status` | — | Check whether the active model provider will likely work right now (never billed); see "Provider availability". |
| `models.list` | — | List every usable model across configured sources, plus host capacity. A provider with `listModels()` offers exactly that list (`claude-api`: `/v1/models` with the stored key, nothing when there is no key or the key fails); a remembered model (`lastModels`) absent from the list is forgotten in favour of the provider's default, never offered. |
| `model.warmup` | — | Ask the broker to pre-load the active Ollama model. |

## Broker → client messages

| Type | Key fields | Purpose |
|---|---|---|
| `chunk` | `id`, `delta` | One streamed fragment of a model answer. |
| `done` | `id`, `usage: { inputTokens, outputTokens }`, `historyKept?`, `page?`, `search?`, `suggest?` | End of stream; token usage (summed over every provider call this request made, see "Page on demand"; `usage.uncounted: true` when at least one call was cut by the broker before the server reported its count: `inputTokens`/`outputTokens` are then the sum of the counted calls only, a floor); how many `history` entries were actually used; `page: { level, chars, from, sentChars, truncated }` present when page content reached the model (`summarize`, `chat` with `context`, `page.content`): `chars` is the content's length, `from` where the part read starts, `sentChars` its length, `truncated` is `from + sentChars < chars`, and the next part starts at `from + sentChars`; `search: { queries, results, pages, chars, capped? }` only when a search returned results; `suggest: { search }` when the model asked for a further search that was not run; `limits?` and `reasoned?` for a `chat`, see "Run log" |
| `page.request` | `id` (the `chat`'s own id), `level` (`"text"`\|`"dev"`), `discard?` | The model asked to read the page — see "Page on demand" below. |
| `search.request` | `id` (the `chat`'s own id), `query`, `discard?` | The model asked to search the web — see "Search" below. |
| `open.request` | `id` (the `chat`'s own id), `refs: [{ n, url }]`, `discard?` | The model asked to open search results — see "Search" below. |
| `error` | `id`, `code`, `message`, `retryAfterSec?` | A request failed — see error codes below. `retryAfterSec` appears only with `rate-limited`, when the provider sent a `Retry-After` header. An `error` ending a `chat` may also carry `limits?` and `reasoned?`, as `done` does. |
| `prompts` | `id`, `items`, `prefs?` | Reply to `prompts.list`/`prompts.save`/`prompts.delete`/`prompts.move`. |
| `prefs` | `id`, `sites` | Reply to `prefs.get`/`prefs.set`. |
| `run` | `id`, `target`, `found`, `run?` | Reply to `run.get`. `found: false` (no `run`) when `target` is unknown or already evicted, never an error. See "Run log". |
| `hello-ok` | `v: 2`, `features` | Handshake succeeded. |
| `challenge` | `v: 2`, `nonce`, `proof` | Handshake step 2 (see above). |
| `settings` | `id`, `provider`, `model?`, `available`, `models?`, `catalog?`, `account?`, `recentModels?`, `baseUrl?`, `services?` | Reply to `settings.get`/`settings.set`. `available` lists every known provider as `{ id, label, available, reason?, configured }`, including unavailable ones; `reason` is a localized sentence, present when `available` is false, and `configured` says the provider has what it needs at all (a stored key, a reachable daemon), whatever the selected model. `models` lists the active provider's installed models when it can enumerate them. `catalog` lists the same models with the facts their online service gives, in the service's order (`claude-api` and `openai-compat`): `{ id, name?, maker?, created?, price?, usdPerToken? }`, `name` the service's display name, `maker` the `author/` prefix of an OpenRouter id, `created` the service's date in Unix seconds, `usdPerToken` `{ prompt, completion }` OpenRouter's rates, `price` `"free"` (both rates 0) or `"paid"`; both absent when the service gives no price or a variable one. Coati reads no model name and orders nothing. `account` is sent while OpenRouter is the active service with a key, from its free `GET /api/v1/key`: `{ boughtCredit?, freeRequests? }`, `boughtCredit` false while the account has never bought credit (`is_free_tier`), `freeRequests` `{ used, limit, remaining }` the free-model requests of the current UTC day; absent when the call fails. While `chatgpt` is the active provider, `account` is instead `{ signedIn, email?, planUsage, welcomed, revokeUnconfirmed? }`: `planUsage` is true only when the granted scopes include `chatgpt.tokens.use.direct`, `welcomed` is false until `settings.set { welcomed: true }`; no token ever crosses the WebSocket. `recentModels` lists the last 5 model ids picked through `settings.set` on the active provider (on the active address for `openai-compat`, each service keeping its own list), most recent first, without duplicates, never a default; a model the service no longer offers may remain; absent when empty. `baseUrl` is the active openai-compat address, sent only while `openai-compat` is the active provider. `services` lists every configured openai-compat service, active or not: `{ baseUrl, model?, hasKey }` (`hasKey` is a boolean; the key is never sent); absent when none. |
| `oauth.started` | `id`, `url` | Reply to `oauth.start`: the address the client opens in a new tab. |
| `settings.test-result` | `id`, `provider`, `ok`, `message`, `code?`, `creditUnchecked?` | Reply to `settings.test`. `message` is one localized sentence meant for a human. `code` is present only when `ok` is false: `auth-required`, `quota-exceeded`, `rate-limited`, `model-unavailable`, `model-missing` or `provider-overloaded`. `creditUnchecked: true` accompanies `ok: true` when the free probe cannot see the account's credit. |
| `provider.status-result` | `id`, `provider`, `state` (`"ok"`\|`"ko"`\|`"unknown"`), `reason`, `checkedAt`, `baseUrl?` | Reply to `provider.status`. |
| `models` | `id`, `current`, `entries`, `sources`, `host` | Reply to `models.list`. `current` is `{ provider, model }`. `sources` is `[{ provider, state }]` with `state` `"ok"`, `"unreachable"` or `"not-configured"`. Ollama is always queried; `openai-compat` lists its models when its address is loopback, otherwise offers its remembered model if a key is stored. `host` is `null` when the machine's capacity can't be read. Each entry carries `provider`, `model`, `local`, and when known `sizeBytes`, `thinks?`, `fit?` (`"gpu"`\|`"shared"`\|`"too-big"`), `gpuPercent?`, `contextTokens?`, `vision?`. `host` reports rounded `ramGb`/`vramGb`/`unifiedMemory?`, read locally, never sent anywhere external. |
| `model.warmup-result` | `id`, `state` (`"loaded"`\|`"already"`\|`"skipped"`\|`"failed"`), `ms?` | Reply to `model.warmup`. |
| `progress` | `id`, `stage` (`"loading"`\|`"reading"`\|`"thinking"`) | Sent before the first chunk, Ollama only. `"thinking"` is repeated every 30 s while the model keeps reasoning, so the panel does not time out on a long reasoning phase. |

## Run log

Announced by the `"run-log"` feature. Only for `chat` (every `chat`, with or without the page-on-demand loop; `summarize` has none). The broker keeps, in memory only, a log of each
question: the in-flight ones and the last 5 finished. Nothing goes to disk or to the journal, and a broker
restart empties it. It holds no page text, search snippet or opened-page text: only titles, hosts and
character counts.

`done` and `error` of a `chat` may carry:

```
limits?: {
  refused?: [{ kind: "search"|"open"|"read",
               reason: "turns"|"searches"|"pages"|"reads"|"budget"|"unknown-ref",
               count, limit? }],   // markers Coati ignored; limit = the cap (10 calls, 4 searches,
                                   // 6 pages, 2 reads, budget in characters), absent for unknown-ref
                                   // (no requested result is available to open)
  memoryFull?: { tokens, contextTokens? },   // a call stopped on length, or (Ollama) went past num_ctx and
                                             // dropped its oldest tokens (tokens > contextTokens);
                                             // tokens = input + output of that call; contextTokens = num_ctx
  cut?: true,          // the visible answer was cut after a stop marker
  answerNow?: true,    // the model wrote only markers; one forced answer call
  local?: { gpuPercent?, contextTokens, tokensPerSec?, vramGb?, unifiedMemory? }   // Ollama only
}
reasoned?: true        // at least one call of this request received reasoning text
```

`run.get { id, target }` is answered with `run { id, target, found, run? }`:

```
run: { startedAt, ms, provider, model, question,        // question = the chat's own text
  steps: [{ t, ms, kind: "call"|"search"|"open"|"read",
    // call:
    n?, inputTokens?, outputTokens?, uncounted?,
    stop?: "answer"|"marker"|"length"|"cut"|"error"|"cancelled",
    reasoning?, reasoningCut?,
    marker?: { type, query?, refs?, level? },
    decision?: "accepted"|"refused", reason?,           // refused: same reasons as limits.refused
    // search/open/read (the client's answer):
    answer?: "results"|"pages"|"page"|"declined"|"failed",
    results?, pages?: [{ n, title, host, chars }], declineReason?, chars? }],
  limits }
```

`reasoning` is the text the provider sent as reasoning for that call; across a run it is capped at 100 000
characters (head and tail kept, `reasoningCut: true`).

## OAuth sign-in

`oauth.start { service: "openrouter" }` makes the broker draw a `code_verifier` and a `state`
(32 random bytes each, base64url), keep that single attempt in memory for 10 minutes, and reply
`oauth.started { url }` with `https://openrouter.ai/auth?callback_url=http://localhost:<port>/oauth/callback&code_challenge=…&code_challenge_method=S256&state=…`.
The client opens `url` in a new tab.

`GET /oauth/callback?code&state` is the OpenRouter return route (the ChatGPT one is below). It is
a top-level navigation, so it skips the `Origin` check (for this exact path only); `Host` may be
`127.0.0.1:<port>` or `localhost:<port>`; the peer-UID check applies. An unknown, expired or
already used `state` gets the generic failure page and no exchange. Otherwise the broker POSTs
`{ code, code_verifier, code_challenge_method: "S256" }` to
`https://openrouter.ai/api/v1/auth/keys` (no redirects, bounded time), stores the returned key as
`settings.set { provider: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", apiKey }`
would, and pushes a `settings` message (`id: "oauth"`) to every authenticated connection. No
model is chosen: the user picks one from the service's list. The reply is a static HTML page in the language of the requesting connection, with
`Content-Security-Policy: default-src 'none'`, `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`; neither the code nor the key appears in it or in any log.

## ChatGPT sign-in

`oauth.start { service: "chatgpt", consent? }` keeps one pending attempt (shared with the
OpenRouter one) for 10 minutes: `state` and `code_verifier` (32 random bytes each, base64url) and
a `nonce`; `state` is single-use and compared in constant time. The reply is
`oauth.started { url }` with `https://auth.openai.com/api/accounts/authorize?` and:

- `response_type=code`, `code_challenge` (S256 of the verifier), `code_challenge_method=S256`,
  `state`, `nonce`.
- `client_id`: `dynamic_agent_client` on the first sign-in, then the issued `oaiapp_…` id.
- `agent_name_hint=Coati`, first sign-in only.
- `ext_agent_host_id`: `urn:uuid:<v4>`, drawn once per install and persisted.
- `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
  `resource=https://api.openai.com/v1`.
- `redirect_uri=http://127.0.0.1:<port>/auth/callback`, `<port>` being the port the broker
  listens on; the code exchange sends the same value.
- `login_hint` (the saved email) when re-signing in with a known account; `prompt=consent` when
  `consent` is true. `id_token_hint` is never sent: the URL goes to the client.

`GET /auth/callback?code&state&client_id&scope?` (see "Transport"):

- An unknown, expired or already used `state`: generic failure page, no exchange.
- `error=access_denied`: state checked, nothing exchanged or stored, own page text.
- A returned `client_id` different from the one in use on a re-sign-in: rejected.
- Otherwise the broker POSTs a form (`grant_type=authorization_code`, the issued `client_id`,
  `code`, `code_verifier`, `redirect_uri`, `resource`; no client secret) to
  `https://auth.openai.com/api/accounts/oauth/token` (no redirects, bounded time).
- The ID token is accepted only if its RS256 signature verifies against the JWKS
  (`https://auth.openai.com/.well-known/jwks.json`) and `iss` is `https://auth.openai.com`, `aud`
  is the issued client id, `exp` is in the future and `nonce` matches. `sub` is the account
  identity.
- A grant without `chatgpt.tokens.use.direct` in `scope` keeps the tokens (identity, email) with
  `planUsage: false`; the page says plan usage was not allowed, and the client may retry with
  `consent: true`.
- On success the provider becomes `chatgpt` and a `settings` message (`id: "oauth"`) goes to every
  authenticated connection. No model is chosen. The reply page has the same headers and the same
  rule as above: no code or token in it or in any log.

Storage: `chatgpt-auth.json` in the config directory, mode 0600, written atomically, separate from
`config.json`. It holds the host id, client id, issuer, subject, email, ID/access/refresh tokens,
expiry, scopes and `welcomed`; access token, expiry, scopes and refresh token are replaced
together. Refresh is a form POST (`grant_type=refresh_token`, `client_id`, `refresh_token`,
`resource`, no `scope`) at the token endpoint, single-flight inside the broker, started 5 minutes
before expiry and never before the server's `earliest_refresh_at`. A terminal refresh error
(`invalid_grant`, `invalid_refresh_token`, `refresh_token_expired`, `refresh_token_reused`)
clears the tokens and ends in `auth-required`.

Environment overrides: `COATI_CHATGPT_AUTH_BASE` replaces the server-to-server auth endpoints
only (token, JWKS, discovery and its revocation endpoint); the authorize URL the browser opens
and the ID token `iss` never change. `COATI_CHATGPT_API_BASE` replaces
`https://api.openai.com/v1` for models and responses.

## Error codes

`bad-request`, `unauthorized`, `model-unavailable`, `auth-required`, `quota-exceeded`,
`rate-limited`, `model-missing`, `provider-overloaded`, `context-too-large`, `cancelled`,
`model-stalled`, `model-empty`, `vision-unsupported`, `page-unavailable`, `internal`.

`bad-request` also covers a malformed or unknown message that carries an `id` (one without an
`id` gets no reply), a fourth concurrent `chat`/`summarize`, and a wrong answer to a
`page.request`/`search.request`/`open.request` (see "Page on demand" and "Search"). A configured
provider the broker doesn't know fails `chat`/`summarize` with `model-unavailable`; a `chat` with an
`image` for a model without vision fails with `vision-unsupported`. `model-stalled`: no output for
`INACTIVITY_TIMEOUT_MS` mid-answer. `model-empty`: the model ended with no visible text
(for instance only markers that were ignored), even after the one "answer now" retry.

`page-unavailable`: the client never answered a `page.request` (with `page.content` or
`page.decline`) or an `open.request` (with `open.content` or `open.decline`) within
`PAGE_REQUEST_TIMEOUT_MS`, or a `search.request` (with `search.content` or `search.decline`) within
`SEARCH_REQUEST_TIMEOUT_MS`.


## Limits

| Constant | Value | Meaning |
|---|---|---|
| `MAX_MESSAGE_BYTES` | 256 KiB | Largest client message, except one carrying a valid `image` or page content (`chat`/`summarize` with `context`, `page.content`). |
| `MAX_LARGE_MESSAGE_BYTES` | 1.5 MiB | Largest message in those cases. |
| `IMAGE_MAX_DECODED_BYTES` | 1 MiB | Largest decoded image. |
| `IMAGE_MAX_SIDE` | 2000 px | Largest image dimension. |
| `MAX_CONTEXT_CHARS` | 40,000 | Largest `chat.text`. A breach is `context-too-large`. |
| `FACTS_MAX` / `ITEMS_MAX` / `ELEMENTS_MAX` | 40 / 40 / 120 | Entries in `context.facts` / `items` / `elements`; a breach is `context-too-large`. Per-field caps: fact label 60 and value 160 characters; item title 160, price 40, location 80, detail 200; element label 80. |
| `PAGE_META_TITLE_MAX` / `PAGE_META_URL_MAX` | 300 / 300 | `chat.page.title` / `url`; a `page` over either is dropped whole. |
| `MAX_PAGE_CHARS` | 400,000 | Largest `context` (`text`, `facts`, `items` and `elements` characters together), at any level, in a `chat`, a `summarize` or a `page.content`; a breach is `context-too-large`. Below it the broker fits the content to the active model's window (see "Fitting the page"), never refuses. |
| `PAGE_REQUEST_TIMEOUT_MS` | 120,000 | Time the broker waits for the answer to a `page.request` or an `open.request`. |
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
| `HISTORY_MAX_ENTRIES` | 20 | Entries of `history` kept (the newest 20; older ones are dropped, not refused). |
| `HISTORY_ENTRY_TEXT_MAX` | 8000 | Longest `history` entry text; a longer entry, or one with another role than `user`/`assistant`, is dropped. |
| `HISTORY_CHAR_BUDGET` | 24,000 | Characters of `history` sent to a provider other than Ollama; oldest entries go first. Ollama trims to its own context tier. |
| `PROMPT_TITLE_MAX` / `PROMPT_BODY_MAX` | 120 / 8000 | Characters of a saved prompt's `title` / `body`. |
| `PREFS_ORDER_MAX` | 200 | Entries in a `prefs` `order`/`removed` list or a `prompts.move` `order`. |
| `MAX_CONCURRENT_STREAMS` | 3 | Concurrent `chat`/`summarize` per connection; a fourth gets `bad-request`. |
| `FIRST_TOKEN_TIMEOUT_LOCAL_MS` | 300,000 | Time to first activity, local provider (Ollama, or `openai-compat` on a loopback address). |
| `FIRST_TOKEN_TIMEOUT_REMOTE_MS` | 120,000 | Time to first activity, remote provider. |
| `INACTIVITY_TIMEOUT_MS` | 60,000 | Silence mid-answer before `model-stalled`. |
| `SETTINGS_TEST_TIMEOUT_MS` | 20,000 | `settings.test` probe timeout. |
| `HOST_FRAME_TIMEOUT_MS` | 5000 | Native-host stdin read timeout. |
| `MAX_FRAME_BYTES` | 4096 | Native Messaging frame length cap. |

## Page on demand

A `chat` that carries `page` (title/url/kind?/chars) and no `context` at all shows the model only
that metadata, plus a trusted instruction: if the request is about this page or something it
shows, reply with exactly `[[READ_PAGE]]` and nothing else; `[[READ_PAGE_DEV]]` (the page's full
cleaned HTML) is offered only when `devMode: true`; without it, `[[READ_PAGE_DEV]]` is ordinary
text. Otherwise the model answers directly, without
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
  `page.content.level` other than the one `page.request` actually asked for, or an answer of
  another kind (a `search.content` to a `page.request`), is a protocol breach — `bad-request`, the
  request stops, nothing is re-run. A `page.content` over the size limits is `context-too-large`
  (see Limits); one over `MAX_PAGE_CHARS` is refused, one that merely exceeds the model's window is
  cut (see "Fitting the page").
- At most one read per level and two reads per question. A marker beyond that cap is stripped
  from the forwarded text and otherwise ignored — no further `page.request`, no abort.
- Thinking/reasoning content is never scanned for a marker.

`done.usage` on a page-on-demand request is the sum of every provider call the question made
(the initial metadata-only call, plus one per `page.request` round trip). `done.page` reports what
was read (see "Fitting the page").

## Fitting the page

Page content (`context` in a `chat` or `summarize`, `page.content` at either level) is fit to the
active model's context window. The window is Ollama's own `contextTokens` of the model (the
`num_ctx` the request will use), 8192 tokens when that lookup fails; 200,000 tokens for
`claude-api`/`claude-cli`; 32,768 for any other provider. The room for content is the window
minus the answer reserve minus the rest of the prompt (instructions, question, facts, items,
elements, history: Ollama trims history within its tier, other providers reserve
`HISTORY_CHAR_BUDGET`). Ollama counts 3 characters per token with 1024 tokens reserved (the same
rule as its `num_ctx` choice); the others 3.5 characters per token with 2000 reserved. Only
`text` gives way: the part read is `context.text` from `readPart.from` (0 without it), cut at the
last line break in the final 2% of the room. What does not fit is reported in `done.page`
(`truncated: true`), never sent silently; the client asks for the next part with a `chat` or
`summarize` carrying the same content and `readPart.from = done.page.from + done.page.sentChars`.
The broker keeps no state between parts. A continuation also tells the model which characters it
holds, so it answers the same question from that part alone.

## Search

Offered to the model only when the `chat` carries `abilities` including `"search"` (the panel sets
it when the browser can search) or a `searchQuery`; a `chat` with an `image` and no `page` is answered directly and ignores
both. The model works in steps, one marker per reply, each alone or
mid-answer; anything else stays ordinary text. Detection, abort and `discard` work exactly as for
the page markers (same detector, same place).

- `[[SEARCH: <query>]]` — one line, 1 to 200 characters, no `]]`. Broker → client
  `search.request { id, query, discard? }`. The client runs the query in the browser's default
  engine and answers `search.content { target, query, results }` (results and snippets only; it
  opens no page on its own) or `search.decline`. Once a page was read in the conversation, the
  client first asks the user to allow the query and answers `search.decline "blocked"` on a
  refusal; the wait for that answer is `SEARCH_REQUEST_TIMEOUT_MS`.
- `[[OPEN: S<n> S<m> …]]` — result numbers (`S1` to `S999`) already received in this question,
  separated by spaces or commas; a repeated number counts once, only the first `OPEN_MAX_REFS` are kept.
  Any other body (an address, a bare number) names no result. `[[OPEN:` is detected even when
  search was not offered, so it is never shown as text. Broker → client `open.request { id, refs: [{ n, url }],
  discard? }`, `url` being the one the client reported for result `S<n>`. The client opens those
  pages and answers `open.content { target, pages: [{ n, url, title, text }] }` (`n` among the
  requested refs, each at most once; `url` the page's final address) or
  `open.decline { target, reason }` (`"no-access"`\|`"blocked"`\|`"failed"`).
  A requested page the client tried and could not read is listed in `failed: [{ n, reason, status? }]`
  (`n` among the requested refs, in no more than one of `pages` / `failed`; `reason` is `"http"`
  (the server answered an error, `status` its code, 400 to 599), `"empty"` (no text) or
  `"failed"` (anything else: no load, a browser error page, a final address that fails the open
  guard or is on another site than the result). The broker tells the model those pages were not
  read; a requested page in neither list is told as "not read", so a client without `failed`
  keeps working. A refused `failed` (unknown `n`, repeated, in `pages` too, unknown `reason`)
  is a `bad-request`.
  Unknown refs and refs already opened are dropped; with none left, the marker is stripped and
  ignored. Refs beyond the pages still allowed are dropped from the request.
- `S<n>` numbering is continuous over every search of the question: a result's number is the
  count of results received in earlier searches plus its rank in its own `search.content`. A
  result dropped for budget keeps its number, unused, so client and broker always agree. The
  client leaves out a result it already sent for the question, which keeps its first number; a
  search whose results were all sent before answers `search.content` with no results, and the
  model is told so. When the engine hides a result's address behind its own link, `url` is the
  origin of the site the engine shows, the client opens the page through the engine's link, and
  the page must end on that site.
- No answer to `open.request` within `PAGE_REQUEST_TIMEOUT_MS`, or to `search.request` within
  `SEARCH_REQUEST_TIMEOUT_MS`, fails the request with `page-unavailable`. An answer of the wrong
  kind is a `bad-request`. A `search.content` with more than `SEARCH_MAX_RESULTS` results or an
  `open.content` with a page over `OPEN_PAGE_MAX_CHARS` characters is refused with
  `context-too-large`; an `open.content` page whose `n` was not requested, or repeated, with
  `bad-request`. A refusal ends the request.
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

The broker is the only place a prompt is assembled (`model/render.ts`'s `buildSystemPrompt`,
`model/build.ts`'s `buildPrompt`). Page content, selection text, screenshots, and prior
`history` turns are all fenced with a per-request random nonce and explicitly labelled data —
never instructions — in the system prompt. A model provider or external module receives the
already-built prompt; it never sees raw, unfenced page content.

## Model providers

Built in: `ollama` (local, no credential needed), `claude-api` (BYOK, Anthropic key stored by
the broker), `openai-compat` (any OpenAI-compatible HTTP endpoint — LM Studio, OpenAI, Mistral,
OpenRouter, DeepSeek, ...), `chatgpt` (the user's ChatGPT Plus or Pro plan through "Sign in with
ChatGPT"; tokens stored by the broker, see "ChatGPT sign-in").

`chatgpt` calls `POST /v1/responses` with `store: false`, `stream: true`, the system prompt as
`instructions` and the history as `input` (images as `input_image` parts). It never sends
`system`-role items, `previous_response_id`, `temperature`, `top_p`, `max_output_tokens`,
`metadata`, `user`, `truncation`, `prompt` or hosted tools. An answer succeeds only on
`response.completed`; `response.incomplete` is a length stop; `response.failed` or a stream cut
before `completed` is an error. A 401 before the first chunk triggers one refresh and one retry.
The catalog is `GET /v1/models`, `models[]` entries with `visibility == "list"`, in the server's
order, as `{ id: slug, name: display_name }`; there is no default model, the user picks one.
Errors: 403 not eligible and 401 after refresh give `auth-required`; 429
`subscription_sharing_usage_limit_exceeded` gives `quota-exceeded`; 503, `usage_unavailable` and
`user_unavailable` give `provider-overloaded`; `unsupported_capability` on an image gives
`vision-unsupported`; `route_not_supported` and `chatpass_*` give `internal`.

External providers load dynamically from a path in `config.json`'s `modules`, each exporting a
default `createProvider(host, options)` returning a `ModelProvider`
(`id`, `label`, `isAvailable`, `checkStatus`, `streamAnswer`, optionally `listModels`,
`defaultModel`, `testConnection`, `vision`, `supportsVision`). Never from a relative path, never
from a URL — only a file already on the machine, named by the user's own config. A module that
fails to load is logged and skipped, never fatal; modules load once, at broker start. A
configured provider matching no loaded module fails `chat`/`summarize` with `model-unavailable`,
naming the missing id, and is never silently swapped for another.

### Provider availability

`provider.status` answers for the active provider only, from a probe that is never billed:
`provider.status-result { state, reason, checkedAt }`, where `reason` is a short stable English
code for the panel's logic, not for display. Answers are cached for 60 s per provider, model,
address and key presence; concurrent requests share one probe; a successful `settings.set` clears
the cache. A probe that throws, or an unknown provider, gives `unknown` / `probe-failed`.

| Provider | `state` / `reason` |
|---|---|
| `ollama` | `ko` / `ollama-unreachable`; `ko` / `model-missing` (the configured model isn't installed); `ko` / `no-model-chosen` (models installed, none configured); `ko` / `no-model-installed` (no model configured and none installed); else `ok` / `ready` |
| `claude-api` | `ko` / `no-key`; else the free `GET /v1/models` probe of `settings.test`: `ok` / `ready`, `ko` / `key-rejected` (401), `ko` / `model-missing` (model not in the key's list, or 403), `unknown` / `probe-failed` (anything else) |
| `openai-compat` | `ko` / `no-base-url` (none, or one that fails the address rule); `ko` / `key-rejected` (HTTP 401/403 on `GET /models`); `unknown` / `probe-failed` (another HTTP status); `unknown` / `base-url-unreachable`; else `ok` / `ready` |

| `chatgpt` | `ko` / `not-signed-in` (no tokens); `ko` / `plan-usage-off` (scope missing); else the free `GET /v1/models` probe: `ok` / `ready`, `ko` / `signed-out` (401, even after a refresh), `ko` / `not-eligible` (403), `unknown` / `probe-failed` (anything else) |

`baseUrl` is added to the result for `openai-compat` when one is configured.
