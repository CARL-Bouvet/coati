# Roadmap

Base version scope: Google search and YouTube get first-class handling; other sites go through
the generic page reader. One lot = one worker = one review.

## Already done

- Show an element, the user clicks (rule 9).
- Acts only when asked; other pages limited and counted (rules 10, 11).
- No pay/send/delete/publish/sign-in action exists (rule 13).
- Password fields skipped (rule 6, text level).
- Model links never clickable — Markdown rendering shows links as text (rule 16, half).

## Lots, in order

**L1 — Data counter (rule 2).** Show an estimate before sending, the real count during and
after. `extension/panel/*.js`, `panel.html`, `panel.css`; broker: `done` already carries token
usage when the provider returns it.

**L2 — Reading levels (rules 1, 5, 6).** `context.readingLevel: "text" | "source" | "dev"`,
absent = `text`. Level picker next to "Read page". Touches `docs/PROTOCOL.md`,
`extension/content/extract/*`, `extension/panel/*.js`. Source level: no script content, no field
values, size capped. Password value: never, at any level. Check against
`scripts/lecture/measure.mjs` before/after, plus unit tests on the stripping.

**L3 — Sensitive data warning (rule 8).** Before sending source/dev-level content to a remote
model: scan for tokens, API keys, card numbers, IBANs; warn, never mask. `extension/panel/*.js`,
broker prompts.

**L4 — Screenshot on demand (rule 7).** Remove the permanent "See the screen" switch; the model
asks, the panel shows a one-click accept. New signal in `docs/PROTOCOL.md`,
`extension/panel/*.js`, broker prompt changes.

**L5 — Grey icon (rule 19).** `chrome.action.setIcon` with a grey variant when the tab isn't
accessible, back to colour after the granting click. `extension/background/*.js`, grey icon
variants.

**L6 — Browser search (rules 14, 15, 16).** Search in the browser's default engine
(`chrome.search.query` / Firefox `browser.search`), in a visible tab; read results plus 2-3
pages; only links Coati found are clickable. Never opens a local/private address from a public
page (except dev level); plain `http` shows a warning. Brave/Tavily search
(`broker/src/search/*`) will be removed once this ships. Touches `extension/background/*.js`,
`extension/panel/*.js`, `docs/PROTOCOL.md`, `broker/src/handlers|protocol|model`.

**L7 — Click and type, confirmed (rules 12, 13).** After v0.1.0. The model proposes one action;
the panel shows the target and asks; the user confirms; one action at a time. Hard block list:
pay, send, delete, publish, sign in. `docs/PROTOCOL.md`, `extension/content/*`,
`extension/panel/*.js`.

## Risks

- Chrome Web Store: an extension that types into pages may be reviewed as automation (L7); the
  new `search` permission (L6) needs its own justification.
- Source/dev reading levels widen the prompt-injection surface (HTML attributes) — rule 16
  limits the damage.
- `readingLevel` must stay versioned in `docs/PROTOCOL.md` to avoid silent behaviour drift.

## Help wanted

- **Firefox and other search engines** for browser search (L6) — `browser.search` coverage and
  non-Google default engines.
- **Windows testing** — the installer and native-host path are least exercised there.
- **Chinese translation review** — `extension/_locales/zh_CN` is machine-translated and needs a
  native speaker's pass.
