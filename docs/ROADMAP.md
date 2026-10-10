# Roadmap

Base version scope: Google search and YouTube get first-class handling; other sites go through
the generic page reader. One lot = one worker = one review.

## Already done

- Show an element, the user clicks (rule 9).
- Acts only when asked; other pages limited and counted (rules 10, 11).
- No pay/send/delete/publish/sign-in action exists (rule 13).
- Password fields skipped (rule 6, text level).
- Model links never clickable — Markdown rendering shows links as text (rule 16, half).
- Page on demand: the model asks for the page (text or dev level), every answer says whether
  it read the page and how many tokens it used (rules 1, 2, 5, 8 — see `docs/PROTOCOL.md`).
- Dev mode switch, confirmed once; sensitive-data warning before sending dev-level content to
  an online model (rules 5, 8).

## Lots, in order

**L1 — Screenshot on demand (rule 7).** The "See the screen" switch is gone; the model asks,
the panel shows a one-click accept (`extension/panel/screenshot.js` keeps the capture code). New signal in `docs/PROTOCOL.md`,
`extension/panel/*.js`, broker prompt changes.

**L2 — Grey icon (rule 19).** `chrome.action.setIcon` with a grey variant when the tab isn't
accessible, back to colour after the granting click. `extension/background/*.js`, grey icon
variants.

**L3 — Browser search (rules 14, 15, 16). Shipped (Chromium).** The model emits `[[SEARCH: …]]`;
the panel runs it in the default engine (`chrome.search.query`) in a background tab, reads the
results and the first 2 pages, leaves the tabs open. Needs "all sites". Firefox
(`browser.search`) is in "Help wanted".

**L4 — Click and type, confirmed (rules 12, 13). Shipped (to be judged for intrusiveness).** The model
emits `[[CLICK eN]]` or `[[TYPE eN: …]]`; the panel checks the element on the live page, refuses
forbidden gestures (`extension/content/forbidden-gesture.js`), shows a card with the element
highlighted, and acts only on "Allow". Clicking the highlighted element oneself counts as the
action done. One action at a time, 5 per question, the page is re-read afterwards.
`extension/panel/action-card.js`, `extension/content/pointer.js`.

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

- **Firefox and other search engines** for browser search (L3) — `browser.search` coverage and
  non-Google default engines.
- **Windows testing** — the installer and native-host path are least exercised there.
- **Chinese translation review** — `extension/_locales/zh_CN` is machine-translated and needs a
  native speaker's pass.
