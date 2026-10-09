// handleMessage: the post-handshake message dispatch switch. Routes each
// authenticated ClientMessage to its own handler module. Split out of
// server.ts (lot F5).

import type { ClientMessage } from "../protocol.ts";
import { send } from "../ws-send.ts";
import { buildPrompt } from "../model.ts";
import { listPrompts, savePrompt, deletePrompt, setPromptSite, withDirLock, type PromptsDirs } from "../prompts.ts";
import { getPrefs, setSitePrefs, moveInPrefs, type PrefsDirs } from "../prefs.ts";
import { DEFAULT_OLLAMA_URL } from "../config.ts";
import { listModelEntries as listOllamaModelEntries, matchesModel, warmupModel } from "../providers/ollama.ts";
import { detectSearchIntent } from "../search/intent.ts";
import type { Lang } from "../messages.ts";
import { handleStreamingRequest, handleChatDocSearch, handleChatPageOnDemand, type PageOnDemandConnState } from "./chat.ts";
import { buildSettingsPayload, testProviderConnection, testSearchConnection, type SettingsCtx } from "./settings.ts";
import { buildModelsPayload } from "./models.ts";

export function handleMessage(
  ws: { send(data: string): unknown },
  message: ClientMessage,
  active: Map<string, AbortController>,
  promptsDirs: PromptsDirs,
  settingsCtx: SettingsCtx,
  lang: Lang,
  // Amendement 2026-10-08 (lot C1): only ever used by a `chat.docSearch`
  // request — dataDir for discover.ts's cache, connState for the "one
  // search in flight per connection" rule (R5). Every other message type
  // ignores both.
  dataDir: string,
  connState: { docSearching: boolean; closed: boolean } & PageOnDemandConnState,
): void {
  switch (message.type) {
    case "hello":
    case "auth":
      // Duplicate hello/auth after an already-authed handshake: no-op.
      return;
    case "chat": {
      // Amendement 2026-10-08 (bis, "explicit search on demand" —
      // docs/PROTOCOL.md): the panel no longer has a search button —
      // `chat.docSearch.origin` now just means "this chat's tab is http(s),
      // a search is ALLOWED for this origin" and is sent on every chat for
      // such a tab. Whether a search actually runs is decided HERE, on the
      // message TEXT alone (fr/en/zh intent phrases, search/intent.ts) —
      // never on the mere presence of `docSearch`. `docSearch.origin` can be
      // "" (no http(s) tab) and intent can still be detected: the pipeline
      // then runs unscoped (open web), see doc-search.ts's ladder.
      if (detectSearchIntent(message.text, lang)) {
        handleChatDocSearch(
          ws,
          { ...message, docSearch: message.docSearch ?? { origin: "" } },
          active,
          settingsCtx,
          lang,
          dataDir,
          connState,
        );
        return;
      }
      // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md
      // "Page on demand", point 2): `page` only ever takes effect when
      // `context` is ABSENT — a `chat` carrying both behaves exactly as
      // before this amendment (byte-identical: `context` wins, `page` is
      // simply never looked at).
      if (message.page && !message.context) {
        handleChatPageOnDemand(ws, { ...message, page: message.page }, active, settingsCtx, lang, connState);
        return;
      }
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "chat",
        logContextKind: message.context?.kind,
        logTextLength: message.text.length + (message.context?.text?.length ?? 0),
        logPageKind: message.context?.pageKind,
        logFactsCount: message.context?.facts?.length ?? 0,
        logItemsCount: message.context?.items?.length ?? 0,
        tooLargeText: message.text,
        budgetContext: message.context,
        // Amendement 2026-10-08 (lot B1): `image` is never logged beyond its
        // presence (docs/PROTOCOL.md §3) — see logRequestReceived's own call
        // site below, which only ever gets booleans/counts, never content.
        image: message.image,
        build: () =>
          buildPrompt(
            { kind: "chat", text: message.text, context: message.context, image: message.image, history: message.history },
            lang,
          ),
      });
      return;
    }
    case "page.content": {
      // Amendement 2026-10-09 (lot 7): resolves the pending `page.request`
      // this answers, if any — a `target` with no matching entry (late
      // arrival after PAGE_REQUEST_TIMEOUT_MS, or one that never had a
      // matching request) is silently ignored, same tolerance as `cancel`
      // naming an unknown id.
      connState.pageRequests.get(message.target)?.({ kind: "content", level: message.level, context: message.context });
      return;
    }
    case "page.decline": {
      connState.pageRequests.get(message.target)?.({ kind: "decline" });
      return;
    }
    case "summarize": {
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "summarize",
        logContextKind: message.context.kind,
        logTextLength: message.context.text?.length ?? 0,
        logPageKind: message.context.pageKind,
        logFactsCount: message.context.facts?.length ?? 0,
        logItemsCount: message.context.items?.length ?? 0,
        budgetContext: message.context,
        build: () => buildPrompt({ kind: "summarize", context: message.context }, lang),
      });
      return;
    }
    case "act": {
      handleStreamingRequest(ws, message, active, settingsCtx, {
        logType: "act",
        logContextKind: undefined,
        logTextLength: message.text.length,
        logPageKind: undefined,
        logFactsCount: 0,
        logItemsCount: 0,
        tooLargeText: message.text,
        build: () =>
          buildPrompt(
            {
              kind: "act",
              action: message.action,
              text: message.text,
              params: message.params,
            },
            lang,
          ),
      });
      return;
    }
    case "prompts.list": {
      send(ws, { type: "prompts", id: message.id, items: listPrompts(promptsDirs) });
      return;
    }
    case "prompts.save": {
      void savePrompt(promptsDirs, message.prompt)
        .then((items) => {
          send(ws, { type: "prompts", id: message.id, items });
        })
        .catch(() => {
          send(ws, { type: "error", id: message.id, code: "bad-request", message: "prompts.save: unknown id" });
        });
      return;
    }
    case "prompts.delete": {
      void deletePrompt(promptsDirs, message.promptId).then((items) => {
        send(ws, { type: "prompts", id: message.id, items });
      });
      return;
    }
    case "prompts.move": {
      const prefsDirs: PrefsDirs = promptsDirs;
      void withDirLock(promptsDirs.dataDir, () => {
        const items = setPromptSite(promptsDirs, message.promptId, message.site);
        const sites = moveInPrefs(prefsDirs, message.promptId, message.site, message.order);
        return { items, sites };
      })
        .then(({ items, sites }) => {
          send(ws, { type: "prompts", id: message.id, items, prefs: { sites } });
        })
        .catch(() => {
          send(ws, { type: "error", id: message.id, code: "bad-request", message: "prompts.move: unknown id" });
        });
      return;
    }
    case "prefs.get": {
      const prefsDirs: PrefsDirs = promptsDirs;
      send(ws, { type: "prefs", id: message.id, sites: getPrefs(prefsDirs) });
      return;
    }
    case "prefs.set": {
      const prefsDirs: PrefsDirs = promptsDirs;
      void setSitePrefs(prefsDirs, message.site, message.prefs).then((sites) => {
        send(ws, { type: "prefs", id: message.id, sites });
      });
      return;
    }
    case "cancel": {
      active.get(message.target)?.abort();
      return;
    }
    case "settings.get": {
      void buildSettingsPayload(settingsCtx.getConfig(), lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.set": {
      const updated = settingsCtx.applySettings({
        provider: message.provider,
        model: message.model,
        apiKey: message.apiKey,
        baseUrl: message.baseUrl,
        searchProvider: message.searchProvider,
        searchApiKey: message.searchApiKey,
        clearKey: message.clearKey,
      });
      void buildSettingsPayload(updated, lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.test": {
      // Amendement 2026-10-08 (lot C1, docs/PROTOCOL.md §9): target "search"
      // tests a search engine instead of a model provider. The reply keeps
      // the exact same shape either way ("shape is unchanged") — the
      // engine id (open-ended ProviderId shape already, see
      // search/types.ts's SearchProviderId) is echoed back in `provider`.
      if (message.target === "search") {
        void testSearchConnection(message.searchProvider, settingsCtx.getConfig(), lang).then(
          ({ ok, message: resultMessage, code }) => {
            send(ws, {
              type: "settings.test-result",
              id: message.id,
              provider: message.searchProvider,
              ok,
              message: resultMessage,
              code,
            });
          },
        );
        return;
      }
      void testProviderConnection(message.provider, settingsCtx.getConfig(), lang).then(
        ({ ok, message: resultMessage, code, creditUnchecked }) => {
          send(ws, {
            type: "settings.test-result",
            id: message.id,
            provider: message.provider,
            ok,
            message: resultMessage,
            code,
            ...(creditUnchecked ? { creditUnchecked: true } : {}),
          });
        },
      );
      return;
    }
    case "provider.status": {
      void settingsCtx.getProviderStatus().then((result) => {
        // baseUrl is NOT a secret (amendement 2026-09-30 bis). Sent for
        // openai-compat so the panel can name the real provider (OpenAI,
        // Mistral, OpenRouter, DeepSeek…) and link to its key/billing pages
        // without asking for `settings` — a `settings` broadcast would
        // re-render an open options page (amendement 2026-10-02 ter).
        const baseUrl = result.provider === "openai-compat" ? settingsCtx.getConfig().baseUrl : undefined;
        send(ws, {
          type: "provider.status-result",
          id: message.id,
          provider: result.provider,
          state: result.state,
          reason: result.reason,
          checkedAt: result.checkedAt,
          ...(baseUrl ? { baseUrl } : {}),
        });
      });
      return;
    }
    case "models.list": {
      // Amendement 2026-10-07: lists all usable models from every configured
      // source, regardless of the active provider (root-cause fix for Ollama
      // models disappearing when active provider is claude-cli).
      void buildModelsPayload(settingsCtx.getConfig()).then((payload) => {
        send(ws, { type: "models", id: message.id, ...payload });
      });
      return;
    }
    case "model.warmup": {
      // Amendement 2026-10-07 (bis): pre-load the active Ollama model into
      // memory so the first summarize/chat request doesn't wait for a cold load.
      void (async () => {
        const config = settingsCtx.getConfig();
        if (settingsCtx.providerId !== "ollama") {
          send(ws, { type: "model.warmup-result", id: message.id, state: "skipped" });
          return;
        }
        const model = config.model?.trim();
        if (!model) {
          send(ws, { type: "model.warmup-result", id: message.id, state: "skipped" });
          return;
        }
        // Determine context tokens for the model (from show cache or default).
        const ollamaUrl = config.ollamaUrl ?? DEFAULT_OLLAMA_URL;
        // Use models.list entries to find the contextTokens if already cached,
        // otherwise default to 8192.
        let contextTokens = 8192;
        try {
          const entries = await listOllamaModelEntries({ ollamaUrl });
          const entry = entries.find((e) => matchesModel(e.name, model));
          if (entry?.contextTokens !== undefined) contextTokens = entry.contextTokens;
        } catch {
          // fallback to 8192
        }
        const result = await warmupModel(model, contextTokens, { ollamaUrl });
        send(ws, {
          type: "model.warmup-result",
          id: message.id,
          state: result.state,
          ...(result.ms !== undefined ? { ms: result.ms } : {}),
        });
      })();
      return;
    }
  }
}
