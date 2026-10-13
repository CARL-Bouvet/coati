// handleMessage: the post-handshake message dispatch switch. Routes each
// authenticated ClientMessage to its own handler module. Split out of
// server.ts (lot F5).

import type { ClientMessage } from "../protocol.ts";
import { send } from "../ws-send.ts";
import { buildPrompt } from "../model.ts";
import { listPrompts, savePrompt, deletePrompt, setPromptSite, withDirLock, type PromptsDirs } from "../prompts.ts";
import { getPrefs, setSitePrefs, moveInPrefs, type PrefsDirs } from "../prefs.ts";
import { DEFAULT_CONFIG, DEFAULT_OLLAMA_URL } from "../config.ts";
import { isValidKeyFormat } from "../key-format.ts";
import { listModelEntries as listOllamaModelEntries, matchesModel, warmupModel } from "../providers/ollama.ts";
import { t, type Lang } from "../messages.ts";
import { handleStreamingRequest, handleChatPageOnDemand, type PageOnDemandConnState } from "./chat.ts";
import { buildSettingsPayload, testProviderConnection, type SettingsCtx } from "./settings.ts";
import { buildModelsPayload } from "./models.ts";

export function handleMessage(
  ws: { send(data: string): unknown },
  message: ClientMessage,
  active: Map<string, AbortController>,
  promptsDirs: PromptsDirs,
  settingsCtx: SettingsCtx,
  lang: Lang,
  connState: PageOnDemandConnState,
): void {
  switch (message.type) {
    case "hello":
    case "auth":
      // Duplicate hello/auth after an already-authed handshake: no-op.
      return;
    case "chat": {
      // Amendement 2026-10-09 (lot 7, "page on demand" — docs/PROTOCOL.md
      // "Page on demand", point 2): `page` only ever takes effect when
      // `context` is ABSENT — a `chat` carrying both behaves exactly as
      // before this amendment (byte-identical: `context` wins, `page` is
      // simply never looked at).
      // A chat that may ask for a search (`abilities`) or run one at once
      // (`searchQuery`) takes the same path, with or without a page.
      const asksSearch = !message.image && (message.abilities !== undefined || message.searchQuery !== undefined);
      if ((message.page && !message.context) || asksSearch) {
        handleChatPageOnDemand(ws, message, active, settingsCtx, lang, connState);
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
            {
              kind: "chat",
              text: message.text,
              context: message.context,
              image: message.image,
              history: message.history,
              pageUnreadable: message.pageUnreadable,
            },
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
      connState.clientRequests.get(message.target)?.({ kind: "content", level: message.level, context: message.context });
      return;
    }
    case "page.decline": {
      connState.clientRequests.get(message.target)?.({ kind: "decline" });
      return;
    }
    case "search.content": {
      connState.clientRequests.get(message.target)?.({ kind: "search", content: message });
      return;
    }
    case "search.decline": {
      connState.clientRequests.get(message.target)?.({ kind: "search-decline", reason: message.reason });
      return;
    }
    case "open.content": {
      connState.clientRequests.get(message.target)?.({ kind: "open", pages: message.pages });
      return;
    }
    case "open.decline": {
      connState.clientRequests.get(message.target)?.({ kind: "open-decline", reason: message.reason });
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
      if (message.apiKey) {
        const cfg = settingsCtx.getConfig();
        const provider = message.provider ?? cfg.provider ?? DEFAULT_CONFIG.provider!;
        if (!isValidKeyFormat(provider, message.baseUrl ?? cfg.baseUrl, message.apiKey)) {
          send(ws, { type: "error", id: message.id, code: "bad-request", message: t("auth.apiKeyFormat", lang) });
          return;
        }
      }
      const updated = settingsCtx.applySettings({
        provider: message.provider,
        model: message.model,
        apiKey: message.apiKey,
        baseUrl: message.baseUrl,
        clearKey: message.clearKey,
      });
      void buildSettingsPayload(updated, lang).then((payload) => {
        send(ws, { type: "settings", id: message.id, ...payload });
      });
      return;
    }
    case "settings.test": {
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
        // A remembered model the provider no longer lists is forgotten.
        if (payload.current.model && payload.current.model !== settingsCtx.getConfig().model) {
          settingsCtx.applySettings({ model: payload.current.model });
        }
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
