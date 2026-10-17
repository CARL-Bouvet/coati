# Roadmap

Base version scope: Google search and YouTube get first-class handling; other sites go through
the generic page reader.

## Already done

- Show an element, the user clicks (rule 9).
- Acts only when asked; other pages limited and counted (rules 10, 11).
- No pay/send/delete/publish/sign-in action exists (rule 13).
- Password fields skipped (rule 6, text level).
- Links in answers clickable only under the link rules; searches asked once a page was read need
  the user's Allow (rule 16, T61, T62).
- Page on demand: the model asks for the page (text or dev level), every answer says whether
  it read the page and how many tokens it used (rules 1, 2, 5, 8 — see `docs/PROTOCOL.md`).
- Dev mode switch, confirmed once; sensitive-data warning before sending dev-level content to
  an online model (rules 5, 8).

## Lots, in order

**L1 — Screenshot on demand (rule 7).** The model asks for a screenshot and the panel shows a
one-click accept (`extension/panel/screenshot.js` holds the capture code). Needs a new signal in
`docs/PROTOCOL.md`, changes in `extension/panel/*.js` and in the broker prompt.

**L2 — Grey icon (rule 19).** `chrome.action.setIcon` with a grey variant when the tab isn't
accessible, back to colour after the granting click. `extension/background/*.js`, grey icon
variants.

**L3 — Advanced browser search (rules 14, 15, 16). Shipped (Chromium).** The model emits
`[[SEARCH: …]]` up to 4 times per question; the panel runs each in the default engine
(`chrome.search.query`) in a background tab and returns the results. The model then picks up to 6
result pages with `[[OPEN: …]]`, and the panel returns their text plus structured product data
(prices, ratings). Needs "all sites". Results are read on Google, Bing, Brave Search and
DuckDuckGo; Firefox (`browser.search`) and other engines are in "Help wanted".

**L4 — Click and type, confirmed (rules 12, 13). Planned, after v0.1.0.** The model would emit a
click or type marker; the panel would check the element on the live page, refuse forbidden gestures
(paying, sending, deleting, publishing, signing in), show the element highlighted, and act only on
"Allow", one action at a time. Its intrusiveness is to be judged before it ships.

**L5 — Models used on this computer. Planned, right after v0.1.0.** The local program keeps, per
model, a few measured numbers: speed, how often the model asked for the page, errors. The settings
show them, so the user compares the models he tried on his own machine. Stored locally only (rule
20), clearable from the settings. Changes in `broker/src/handlers/`, `docs/PROTOCOL.md` and
`extension/options/`.

## Security hardening

Low-severity items, none blocking.

- Search: an engine `!bang` in a model-written query can redirect the results tab; `[[eN]]` and
  `<think>` tokens echoed from page text are not stripped; a question's cost and tabs (up to 4
  searches, 6 pages, 2 tabs left open) have no user gate.
- Pairing: the legacy secret is permanent and travels through the clipboard; the Firefox caller
  check is weak (defense in depth); the extension clears its key on a 4401 received before
  `hello`; a crash can leave a stale `broker-key.json`; secrets are not zeroized; origin and key
  rejections differ in timing.
- Broker: credentials in a URL reach the logs; provider
  responses are not size-capped; the openai-compat reachability error echoes `baseUrl`; `act.params`
  is not validated broker-side.
- Extension: the open guard misses single-label hosts and private TLDs; the optional `<all_urls>`
  permission is unused; saved prompts have no cap; extraction loops have no element or time cap;
  dev extraction keeps `contenteditable` drafts; a hostile page can close the connection at dev
  level; history is plaintext in `storage.local` (30 days).
- Packaging: systemd/launchd hardening and macOS log permissions;
  signed releases and build provenance.

## Risks

- Chrome Web Store: an extension that types into pages may be reviewed as automation (L4); the
  new `search` permission (L3) needs its own justification.
- The dev reading level widens the prompt-injection surface (HTML attributes) — rule 16 limits
  the damage.
- Small local models often answer without asking for the page; the "did not read the page"
  line under the answer is how the user notices.
- A structure level (accessibility tree) between text and dev may come back if a real need
  shows up.

## Help wanted

- Firefox and other search engines for browser search (L3): `browser.search` coverage and
  engines beyond Google, Bing, Brave Search and DuckDuckGo (Qwant, Startpage, Ecosia…).
- Windows testing: the installer and native-host path are least exercised there.
- Chinese translation review: `extension/_locales/zh_CN` is machine-translated and needs a
  native speaker's pass.
- Developer-tools button: a Coati button inside the browser's developer tools ("Analyse this
  element"), dev mode only.
