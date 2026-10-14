# Contributing to Coati

Thanks for looking. Coati is small and the easiest way to help is to try it and tell us what
happened.

## Who we need most

- **Testers on macOS and Windows.** Installers and the local program are exercised in CI, but
  real machines find what CI cannot.
- **People running other local runtimes and models**: LM Studio, a llama.cpp server, vLLM, through
  the OpenAI-compatible address. Tell us what works with a
  [compatibility report](../../issues/new?template=compatibility_report.md).
- **Firefox users.** Install, pairing and the sidebar are the parts to check.

## Run it

```sh
bun install                       # repo root
bun test                          # root tests
cd broker && bun install && bun test   # local program tests
bun scripts/lab/build-lab.ts      # builds the lab: the panel and settings on fixture pages
bash scripts/ci/e2e.sh            # end to end: installer + compiled binary + handshake
```

`scripts/build.sh` builds the two extension packages (`dist/coati-chrome.zip`,
`dist/coati-firefox.zip`); `docs/INSTALL.md` explains how to load them.

## Rules

[CLAUDE.md](CLAUDE.md) is the rulebook: product rules, security rules, code conventions. Short
version: English everywhere, no `innerHTML`, no new dependency without a real need, user-facing
text through `extension/_locales`, and `bun test` green from the root and from `broker/`. The
wire format is `docs/PROTOCOL.md`; the reasons behind choices are in `docs/DECISIONS.md`; the map
of the code is `docs/ARCHITECTURE.md`.

Everything here is public: no prices, no personal data, no pointers to files outside the repo.

## Reporting

- **Bug**: open an issue with the bug report template (OS, browser, versions, model).
- **Vulnerability**: not in a public issue. See [SECURITY.md](SECURITY.md).
