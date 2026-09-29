// The "ollama" provider: talks to a local Ollama daemon (default
// http://127.0.0.1:11434, overridable via config's ollamaUrl) over plain HTTP
// + NDJSON streaming. This is the only provider that lets Coati honestly
// claim nothing leaves the machine — see the LOT brief. Prompt assembly
// (fencing, system prompt) lives in ../model.ts and is shared by every
// provider — see ../model.ts's header.

import { DEFAULT_OLLAMA_URL } from "../config.ts";
import {
  buildSystemPrompt,
  MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  type AnswerEvent,
  type BuiltPrompt,
  type StreamAnswerOptions,
} from "../model.ts";
import type { Availability, ModelProvider, ProviderRuntimeOptions, StatusCheck } from "./types.ts";

// Testing seam: production code always drives the real global `fetch`. Tests
// substitute a fake here so the NDJSON-parsing and availability paths can be
// exercised without a running Ollama daemon. Not part of the public API —
// only broker/test/*.test.ts should call the two functions below.
let fetchImpl: typeof fetch = fetch;
export function __setFetchImplForTests(fn: typeof fetch): void {
  fetchImpl = fn;
}
export function __resetFetchImplForTests(): void {
  fetchImpl = fetch;
}

// Short: this only pings a local daemon that, if present, answers instantly.
// Used both by isAvailable() and by the pre-flight model check in
// streamAnswer() — neither should hang the settings UI or a chat request
// waiting out the full MODEL_TIMEOUT_MS just because Ollama isn't running.
const TAGS_TIMEOUT_MS = 1500;

function resolveBaseUrl(url: string | undefined): string {
  const base = url && url.trim() ? url.trim() : DEFAULT_OLLAMA_URL;
  return base.replace(/\/+$/, "");
}

/** An installed model name from /api/tags (e.g. "llama3.2:latest") matches a
 * configured model name (e.g. "llama3.2") either exactly or by its tag-less
 * prefix — Ollama tags every pull with ":latest" unless the user asked for a
 * specific tag, and requiring the user to type that suffix would be a rough
 * edge for no safety benefit. */
function matchesModel(installedName: string, wanted: string): boolean {
  if (installedName === wanted) return true;
  return installedName.split(":")[0] === wanted;
}

async function fetchModelNames(baseUrl: string): Promise<string[]> {
  const response = await fetchImpl(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ollama /api/tags returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { models?: Array<{ name?: unknown }> };
  if (!Array.isArray(body.models)) return [];
  return body.models
    .map((m) => m.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  let names: string[];
  try {
    names = await fetchModelNames(baseUrl);
  } catch {
    return { available: false, reason: `Ollama unreachable at ${baseUrl}` };
  }
  const model = opts.model?.trim();
  if (model && !names.some((name) => matchesModel(name, model))) {
    return { available: false, reason: `model "${model}" not found in Ollama (ollama pull ${model})` };
  }
  return { available: true };
}

async function listModels(opts: ProviderRuntimeOptions): Promise<string[]> {
  return fetchModelNames(resolveBaseUrl(opts.ollamaUrl));
}

/**
 * `provider.status` for ollama — amendement 2026-09-25: `/api/tags` is local
 * and free, so this is the same 1.5s-bounded probe as isAvailable(), reported
 * through the closed reason-code set the spec defines: `ollama-unreachable`,
 * `model-missing` (a configured model isn't installed), `no-model-installed`
 * (no model configured AND the daemon has none installed either), else
 * `ready`.
 */
async function checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  let names: string[];
  try {
    names = await fetchModelNames(baseUrl);
  } catch {
    return { state: "ko", reason: "ollama-unreachable" };
  }
  const model = opts.model?.trim();
  if (model) {
    if (!names.some((name) => matchesModel(name, model))) {
      return { state: "ko", reason: "model-missing" };
    }
    return { state: "ok", reason: "ready" };
  }
  if (names.length === 0) {
    return { state: "ko", reason: "no-model-installed" };
  }
  return { state: "ok", reason: "ready" };
}

/** Parses one line of an Ollama /api/chat NDJSON stream into zero or more
 * AnswerEvents. Exported standalone (alongside parseNdjsonStream below) so
 * tests can feed it fixed line fixtures without going through a fake fetch. */
export function* parseNdjsonLine(line: string): Generator<AnswerEvent> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // malformed line — skip rather than crash mid-stream
  }
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  const message = obj.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string" && message.content.length > 0) {
    yield { kind: "delta", text: message.content };
  }
  if (obj.done === true) {
    const num = (key: string): number => (typeof obj[key] === "number" ? (obj[key] as number) : 0);
    yield {
      kind: "usage",
      usage: { inputTokens: num("prompt_eval_count"), outputTokens: num("eval_count") },
    };
  }
}

/** Reads a fetch Response body (newline-delimited JSON, one object per
 * `ollama serve` chunk) and yields AnswerEvents as lines complete. A final
 * partial line with no trailing newline (the last chunk of the stream) is
 * flushed once the body ends. */
export async function* parseNdjsonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AnswerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        yield* parseNdjsonLine(line);
      }
    }
    if (buffer.trim()) yield* parseNdjsonLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams the model's answer to `built.prompt` via Ollama's `/api/chat`
 * streaming endpoint. Requires `opts.model` — unlike claude-api, there is no
 * sane default to silently fall back to (whatever Ollama would pick is
 * unpredictable and may not be installed), so a missing model is reported as
 * ModelUnavailableError immediately rather than attempted. Likewise, a
 * configured model absent from `/api/tags` fails fast with the model named in
 * the message, rather than letting Ollama itself 404 deep into the request.
 */
export async function* streamAnswer(
  built: BuiltPrompt,
  opts: StreamAnswerOptions & ProviderRuntimeOptions = {},
): AsyncIterable<AnswerEvent> {
  const model = opts.model?.trim();
  if (!model) {
    throw new ModelUnavailableError("no Ollama model configured — pick one in Coati settings");
  }
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);

  let installedNames: string[];
  try {
    installedNames = await fetchModelNames(baseUrl);
  } catch (err) {
    throw new ModelUnavailableError(
      `cannot reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!installedNames.some((name) => matchesModel(name, model))) {
    throw new ModelUnavailableError(`model "${model}" not found in Ollama (ollama pull ${model})`);
  }

  const abortController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort();
    } else {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const timeoutMs = opts.timeoutMs ?? MODEL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: "system", content: buildSystemPrompt(built.nonce) },
            { role: "user", content: built.prompt },
          ],
        }),
        signal: abortController.signal,
      });
    } catch (err) {
      if (timedOut) throw new ModelTimeoutError(timeoutMs);
      throw new ModelUnavailableError(
        `cannot reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new ModelUnavailableError(`Ollama returned HTTP ${response.status} for model "${model}"`);
    }
    if (!response.body) {
      throw new Error("Ollama response has no body");
    }

    yield* parseNdjsonStream(response.body);
  } catch (err) {
    if (timedOut) throw new ModelTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) throw new ModelTimeoutError(timeoutMs);
}

export const ollamaProvider: ModelProvider = {
  id: "ollama",
  label: "Ollama (local)",
  isAvailable,
  listModels,
  checkStatus,
  streamAnswer,
};
