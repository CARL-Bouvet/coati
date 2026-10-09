// The "ollama" provider: talks to a local Ollama daemon (default
// http://127.0.0.1:11434, overridable via config's ollamaUrl) over plain HTTP
// + NDJSON streaming. This is the only provider that lets Coati honestly
// claim nothing leaves the machine — see the LOT brief. Prompt assembly
// (fencing, system prompt) lives in ../model.ts and is shared by every
// provider — see ../model.ts's header.

import { DEFAULT_OLLAMA_URL, isAllowedOllamaUrl } from "../config.ts";
import {
  buildSystemPrompt,
  FIRST_TOKEN_TIMEOUT_LOCAL_MS,
  INACTIVITY_TIMEOUT_MS,
  ModelTimeoutError,
  ModelStalledError,
  ModelUnavailableError,
  ThinkFilter,
  trimHistoryToCharBudget,
  type AnswerEvent,
  type BuiltPrompt,
  type StreamAnswerOptions,
} from "../model.ts";
import { readHostCapacity } from "../host.ts";
import type { HostCapacity } from "../protocol.ts";
import type { Availability, ModelProvider, ProviderRuntimeOptions, StatusCheck, TestConnectionResult } from "./types.ts";
import { t, DEFAULT_LANG } from "../messages.ts";

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
// Timeout for /api/show (capabilities lookup) — slightly more generous than
// /api/tags since it reads model metadata, but still short to avoid blocking
// the models.list response or a streaming call.
const SHOW_TIMEOUT_MS = 3000;

function resolveBaseUrl(url: string | undefined): string {
  const base = url && url.trim() ? url.trim() : DEFAULT_OLLAMA_URL;
  return base.replace(/\/+$/, "");
}

// --- /api/show cache (by digest) — amendment 2026-10-07 ------------------
//
// Keyed by model digest (from /api/tags). The cache is process-wide (one
// broker instance) and never evicted — model weights don't change without a
// restart.

interface ShowInfo {
  capabilities: string[] | null;
  /**
   * True when the model's Ollama template contains `not $.Think` — meaning
   * Ollama honours `think:false` to suppress reasoning tokens (hybrid models
   * like qwen3:8b). False for thinking-only models (qwen3:4b-Thinking-2507)
   * whose template always opens `<think>` regardless; for those we send
   * `think:true` so Ollama routes reasoning to `message.thinking` (not
   * `message.content`). See streamAnswer below.
   */
  canDisableThinking: boolean;
  // Amendment 2026-10-07 (bis): model_info fields for context size calculation.
  // All from /api/show's `model_info` key, keyed by "<arch>.<field>".
  /** Number of transformer layers (block_count). */
  blockCount?: number;
  /** Number of KV heads (attention.head_count_kv). */
  headCountKv?: number;
  /** Key vector dimension per head (attention.key_length). */
  keyLength?: number;
  /** Value vector dimension per head (attention.value_length). */
  valueLength?: number;
  /** Maximum context length the model was trained on. */
  contextLength?: number;
}
const showInfoCache = new Map<string, ShowInfo>();

// Amendment 2026-10-07 (bis): buckets for context size selection.
// 32768 added over the old [4096, 8192, 16384] — lets larger VRAM budgets use
// bigger windows without reloading the model on every request.
const CTX_BUCKETS_FIXED = [32768, 16384, 8192, 4096] as const; // largest-first for selection
// Amendment 2026-10-08 (lot B1): ascending order, to find the next tier UP.
const CTX_BUCKETS_FIXED_ASC = [4096, 8192, 16384, 32768] as const;

// Amendment 2026-10-07 (bis) follow-up: on a discrete GPU the display
// compositor (e.g. KDE/GNOME on a RX 5600 XT) already holds ~1.1 GB of VRAM,
// and Ollama adds compute buffers on top of the model weights. A 1.5 GB flat
// reserve covers both reliably: budget = vramGb×1e9 − DISCRETE_VRAM_RESERVE_BYTES.
// Analogue of HOST_FIT_CONSTANTS in host.ts.
const DISCRETE_VRAM_RESERVE_BYTES = 1.5e9;

/**
 * Computes the fixed context window size (num_ctx) for a model given its
 * KV-cache geometry and the host's memory budget. Called once per model
 * (result cached in showInfoCache via ShowInfo fields) and exposed as
 * `contextTokens` in the `models` reply.
 *
 * Algorithm (amendment 2026-10-07 bis, revised):
 *   kvBytesPerToken = blockCount × headCountKv × (keyLength + valueLength) × 2
 *   budget = vramGb×1e9 − 1.5e9 (discrete, for display+buffers)
 *          | 0.75×ramGb×1e9 (unified)
 *          | 8192 if unknown
 *   pick largest bucket in [32768,16384,8192,4096] ≤ contextLength such that
 *     sizeBytes + kvBytesPerToken×bucket + 0.5 GB ≤ budget
 *   minimum 8192.
 */
export function computeContextTokens(
  showInfo: ShowInfo,
  sizeBytes: number,
  host: HostCapacity,
): number {
  const { blockCount, headCountKv, keyLength, valueLength, contextLength } = showInfo;
  if (!blockCount || !headCountKv || !keyLength || !valueLength) return 8192;

  const kvBytesPerToken = blockCount * headCountKv * (keyLength + valueLength) * 2;

  let budgetBytes: number;
  if (host.unifiedMemory) {
    budgetBytes = 0.75 * host.ramGb * 1e9;
  } else if (host.vramGb !== null) {
    // Subtract the display+Ollama-buffers reserve (DISCRETE_VRAM_RESERVE_BYTES)
    // so the model doesn't spill onto the CPU when a compositor is running.
    budgetBytes = host.vramGb * 1e9 - DISCRETE_VRAM_RESERVE_BYTES;
  } else {
    return 8192; // vram unknown — safe minimum
  }

  const ctxCap = contextLength ?? 32768;

  for (const bucket of CTX_BUCKETS_FIXED) {
    if (bucket > ctxCap) continue; // respect model's trained context limit
    const kvBytes = kvBytesPerToken * bucket;
    if (sizeBytes + kvBytes + 0.5e9 <= budgetBytes) {
      return Math.max(bucket, 8192); // enforce minimum
    }
  }
  return 8192; // minimum even if 4096 would technically fit
}

/** Extended model info from /api/tags, including digest and size. */
interface OllamaModelTag {
  name: string;
  digest: string;
  sizeBytes: number;
}

/** Fetches /api/tags and returns the richer tag list (name + digest + size).
 * Used by listModelEntries() and (indirectly) by streamAnswer() for the
 * think-capability check. `redirect: "error"` per the task brief. */
async function fetchModelTags(baseUrl: string): Promise<OllamaModelTag[]> {
  // Security gate (notes/BUG_ollama_url_not_validated_and_redirects_followed_20261006.md):
  // checked here, the single choke point every other function in this file
  // routes through (fetchModelNames, isAvailable, checkStatus, testConnection,
  // streamAnswer, listModelEntries, supportsVision) — a baseUrl that already
  // passed config.ts's loadConfig check on disk still gets re-checked here in
  // case it ever reaches this provider some other way (a future caller, a
  // hand-edited runtime value). Throws like a network failure — every caller
  // already classifies a thrown error from this function as "unreachable".
  if (!isAllowedOllamaUrl(baseUrl)) {
    throw new Error(`ollama url "${baseUrl}" is not allowed (must be http on loopback, or https; no credentials)`);
  }
  const response = await fetchImpl(`${baseUrl}/api/tags`, {
    signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`ollama /api/tags returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    models?: Array<{ name?: unknown; digest?: unknown; size?: unknown }>;
  };
  if (!Array.isArray(body.models)) return [];
  return body.models
    .filter((m) => typeof m.name === "string" && m.name.length > 0)
    .map((m) => ({
      name: m.name as string,
      digest: typeof m.digest === "string" ? m.digest : "",
      sizeBytes: typeof m.size === "number" ? m.size : 0,
    }));
}

/** Fetches /api/show for a model, returns ShowInfo (capabilities + canDisableThinking
 * + model_info fields for context size). Result is cached by digest.
 * Never throws — a failure returns a safe default. */
async function fetchModelShowInfo(
  baseUrl: string,
  modelName: string,
  digest: string,
): Promise<ShowInfo> {
  if (digest && showInfoCache.has(digest)) {
    return showInfoCache.get(digest)!;
  }
  let info: ShowInfo = { capabilities: null, canDisableThinking: false };
  try {
    const response = await fetchImpl(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.ok) {
      const body = (await response.json()) as {
        capabilities?: unknown;
        template?: unknown;
        model_info?: Record<string, unknown>;
      };
      const capabilities = Array.isArray(body.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === "string")
        : null;
      const canDisableThinking =
        typeof body.template === "string" && body.template.includes("not $.Think");

      // Amendment 2026-10-07 (bis): extract KV-cache geometry from model_info.
      // Keys are "<arch>.<field>" where arch = model_info["general.architecture"].
      let blockCount: number | undefined;
      let headCountKv: number | undefined;
      let keyLength: number | undefined;
      let valueLength: number | undefined;
      let contextLength: number | undefined;
      const mi = body.model_info;
      if (mi && typeof mi === "object") {
        const arch = typeof mi["general.architecture"] === "string"
          ? (mi["general.architecture"] as string) : null;
        if (arch) {
          const n = (k: string): number | undefined => {
            const v = mi[`${arch}.${k}`];
            return typeof v === "number" ? v : undefined;
          };
          blockCount = n("block_count");
          headCountKv = n("attention.head_count_kv");
          keyLength = n("attention.key_length");
          valueLength = n("attention.value_length");
          contextLength = n("context_length");
        }
      }
      info = {
        capabilities,
        canDisableThinking,
        blockCount,
        headCountKv,
        keyLength,
        valueLength,
        contextLength,
      };
    }
  } catch {
    // Treat as unknown — safe default: keep the model, no think injection.
  }
  if (digest) showInfoCache.set(digest, info);
  return info;
}

// Testing seam for the show-info cache (reset between tests).
export function __resetShowCacheForTests(): void {
  showInfoCache.clear();
}

/** One entry returned by listModelEntries() — richer than listModels()'s
 * plain string, for the models.list response. */
export interface OllamaModelEntry {
  name: string;
  sizeBytes: number;
  capabilities: string[] | null;
  /**
   * Mirrors ShowInfo.canDisableThinking — forwarded to server.ts so it can
   * set `thinks:true` on thinking-only entries in the models response.
   */
  canDisableThinking: boolean;
  /**
   * Amendment 2026-10-07 (bis): fixed context window size (num_ctx) computed
   * from model_info and host VRAM. Absent when model_info is unavailable.
   */
  contextTokens?: number;
}

/** Lists all *chat* models from Ollama: fetches /api/tags (throws on network
 * error so callers can distinguish "unreachable" from "no models"), then calls
 * /api/show per model (cached by digest) and drops any model whose
 * `capabilities` array exists and lacks `"completion"` (embedding-only
 * models, etc.). Returned for the models.list response; the simpler
 * listModels() string array is kept for backward compat with settings.get.
 * Amendment 2026-10-07 (bis): also computes contextTokens from model_info. */
export async function listModelEntries(opts: ProviderRuntimeOptions): Promise<OllamaModelEntry[]> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  // Deliberately NOT catching here: callers (buildModelsPayload in server.ts)
  // need to distinguish a fetch failure (→ state:"unreachable") from an empty
  // list (→ state:"ok", zero entries).
  const tags = await fetchModelTags(baseUrl);
  // Read host capacity once for context size computation (cached by host.ts).
  const host = await readHostCapacity().catch(() => null as HostCapacity | null);
  // Fetch capabilities + model_info for every model in parallel.
  const entries: OllamaModelEntry[] = await Promise.all(
    tags.map(async (tag) => {
      const info = await fetchModelShowInfo(baseUrl, tag.name, tag.digest);
      const contextTokens = host ? computeContextTokens(info, tag.sizeBytes, host) : undefined;
      return {
        name: tag.name,
        sizeBytes: tag.sizeBytes,
        capabilities: info.capabilities,
        canDisableThinking: info.canDisableThinking,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      };
    }),
  );
  // Keep only chat models: drop if capabilities exists AND lacks "completion".
  return entries.filter((e) => e.capabilities === null || e.capabilities.includes("completion"));
}

// --- /api/ps (currently-loaded models) — lot 4 ----------------------------

/** One entry from Ollama /api/ps — the model is currently loaded in memory. */
export interface PsEntry {
  /** Model name, same format as /api/tags (e.g. "qwen3:8b"). */
  name: string;
  /** Total model size in bytes (same as sizeBytes from /api/tags). */
  size: number;
  /** Bytes currently in VRAM. Divide by size to get the GPU fraction. */
  size_vram: number;
}

/**
 * Fetches Ollama /api/ps to find currently-loaded models. Same timeout and
 * redirect rules as /api/tags. Returns [] on any error — a /api/ps failure
 * just means gpuPercent is absent from entries, not a hard error.
 * Amendment 2026-10-07 (bis): accepts an optional external `signal` so the
 * caller (e.g. server.ts's runStream, or streamAnswer itself) can abort the
 * /api/ps fetch when the main request is aborted, keeping test timeouts fast.
 */
export async function fetchPsEntries(opts: { ollamaUrl?: string; signal?: AbortSignal }): Promise<PsEntry[]> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  try {
    // Same security gate as fetchModelTags above — this function has its own
    // entry point (not downstream of fetchModelTags), so it is re-checked
    // here rather than assumed.
    if (!isAllowedOllamaUrl(baseUrl)) throw new Error(`ollama url "${baseUrl}" is not allowed`);
    const signal = opts.signal ?? AbortSignal.timeout(TAGS_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}/api/ps`, {
      signal,
      redirect: "error",
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: unknown[] };
    if (!Array.isArray(body.models)) return [];
    const result: PsEntry[] = [];
    for (const m of body.models) {
      if (typeof m === "object" && m !== null) {
        const e = m as Record<string, unknown>;
        if (typeof e.name === "string" && typeof e.size === "number" && typeof e.size_vram === "number") {
          result.push({ name: e.name, size: e.size, size_vram: e.size_vram });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** An installed model name from /api/tags (e.g. "llama3.2:latest") matches a
 * configured model name (e.g. "llama3.2") either exactly or by its tag-less
 * prefix — Ollama tags every pull with ":latest" unless the user asked for a
 * specific tag, and requiring the user to type that suffix would be a rough
 * edge for no safety benefit. Exported for server.ts progress detection. */
export function matchesModel(installedName: string, wanted: string): boolean {
  if (installedName === wanted) return true;
  return installedName.split(":")[0] === wanted;
}

async function fetchModelNames(baseUrl: string): Promise<string[]> {
  const tags = await fetchModelTags(baseUrl);
  return tags.map((t) => t.name);
}

async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  let names: string[];
  try {
    names = await fetchModelNames(baseUrl);
  } catch {
    return { available: false, reason: t("availability.ollama.unreachable", lang, { url: baseUrl }) };
  }
  const model = opts.model?.trim();
  if (model && !names.some((name) => matchesModel(name, model))) {
    return { available: false, reason: t("availability.ollama.modelNotFound", lang, { model }) };
  }
  return { available: true };
}

async function listModels(opts: ProviderRuntimeOptions): Promise<string[]> {
  return fetchModelNames(resolveBaseUrl(opts.ollamaUrl));
}

/**
 * `provider.status` for ollama — amendment 2026-09-25: `/api/tags` is local
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

/**
 * `settings.test` for ollama — goal U2 (docs/PROTOCOL.md, amendment
 * 2026-10-01): unchanged in substance, since `/api/tags` was already free
 * (local daemon) — this is the same probe as checkStatus() above, just
 * reshaped into TestConnectionResult and distinguishing `model-missing`
 * (daemon reachable, configured model not pulled) from `model-unavailable`
 * (daemon unreachable) per the task brief, same distinction provider.status
 * already makes via its `model-missing`/`ollama-unreachable` reasons.
 */
async function testConnection(
  opts: ProviderRuntimeOptions & { timeoutMs?: number },
): Promise<TestConnectionResult> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  let names: string[];
  try {
    names = await fetchModelNames(baseUrl);
  } catch {
    return { ok: false, code: "model-unavailable" };
  }
  const model = opts.model?.trim();
  if (!model) return { ok: false, code: "model-unavailable" };
  if (!names.some((name) => matchesModel(name, model))) {
    return { ok: false, code: "model-missing" };
  }
  return { ok: true };
}

/**
 * Per-request context fallback: picks the SMALLEST bucket that fits the
 * estimated token count for the given character count.
 *
 * Amendment 2026-10-07 (bis): the primary context size is now `contextTokens`
 * (computed from model_info + VRAM by computeContextTokens). This function is
 * the per-request fallback used when the prompt is too large for the fixed
 * size, and for providers/callers that don't have model_info yet.
 *
 * Buckets extended to 32 768 (from the old cap of 16 384) since the new
 * fixed-size logic already selects up to 32 768 and the per-request path
 * should cover the same range.
 *
 * estimatedTokens = ⌈totalChars / 3⌉ + 1024  (1 024 = answer headroom)
 */
const CTX_BUCKETS = [4096, 8192, 16384, 32768] as const;

export function ollamaContextSize(totalChars: number): number {
  const estimatedTokens = Math.ceil(totalChars / 3) + 1024;
  for (const bucket of CTX_BUCKETS) {
    if (bucket >= estimatedTokens) return bucket;
  }
  return 32768;
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
  // Amendment 2026-10-07 (bis): emit a thinking event when message.thinking
  // is present and non-empty. Callers use it for activity-tracking only — it
  // is never forwarded as text. Emitted BEFORE content so streamAnswer can
  // satisfy the first-token deadline from thinking alone.
  if (message && typeof message.thinking === "string" && message.thinking.length > 0) {
    yield { kind: "thinking" };
  }
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

  let installedTags: OllamaModelTag[];
  try {
    installedTags = await fetchModelTags(baseUrl);
  } catch (err) {
    throw new ModelUnavailableError(
      `cannot reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const matchedTag = installedTags.find((t) => matchesModel(t.name, model));
  if (!matchedTag) {
    throw new ModelUnavailableError(`model "${model}" not found in Ollama (ollama pull ${model})`);
  }

  // Amendment 2026-10-07: check capabilities + canDisableThinking.
  // Uses the show-info cache (warmed by listModelEntries / models.list).
  // Never throws — a failure falls back to the safe default (no think injection).
  const showInfo = await fetchModelShowInfo(baseUrl, matchedTag.name, matchedTag.digest).catch(
    () => ({ capabilities: null, canDisableThinking: false } satisfies ShowInfo),
  );
  const hasThinking =
    Array.isArray(showInfo.capabilities) && showInfo.capabilities.includes("thinking");

  const abortController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortController.abort();
    } else {
      opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  // Amendment 2026-10-07 (bis): two-stage timeout.
  // firstTokenMs: deadline from start to first chunk (hung before generating).
  // inactivityMs: reset on every chunk; fires when silent mid-answer.
  // Ollama is always loopback → use FIRST_TOKEN_TIMEOUT_LOCAL_MS (300 s).
  // timeoutMs override (test knob) applies to the first-token deadline.
  const firstTokenMs = opts.timeoutMs ?? FIRST_TOKEN_TIMEOUT_LOCAL_MS;
  const inactivityMs = opts.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
  let timedOut = false;
  let stalled = false;
  let gotFirstChunk = false;

  const firstTokenTimer = setTimeout(() => {
    if (!gotFirstChunk) { timedOut = true; abortController.abort(); }
  }, firstTokenMs);

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      stalled = true;
      abortController.abort();
    }, inactivityMs);
  };

  // Compute fixed context size for this model (from /api/show model_info).
  // readHostCapacity() is process-cached; fetchModelShowInfo is digest-cached.
  const host = await readHostCapacity().catch(() => null as HostCapacity | null);
  const contextTokens = host ? computeContextTokens(showInfo, matchedTag.sizeBytes, host) : undefined;

  const systemPrompt = buildSystemPrompt(built.nonce, built.lang);
  const totalChars = systemPrompt.length + built.prompt.length;
  const promptEstimate = Math.ceil(totalChars / 3) + 1024;
  // Use the fixed context size; if the prompt is too large, fall back to the
  // smallest per-request bucket that fits, capped by the model's context_length.
  const ctxCap = showInfo.contextLength ?? 32768;
  let num_ctx: number;
  if (contextTokens !== undefined && promptEstimate <= contextTokens) {
    num_ctx = contextTokens;
  } else {
    // Per-request fallback (prompt larger than fixed size, or no model_info).
    num_ctx = ollamaContextSize(totalChars);
    if (num_ctx > ctxCap) num_ctx = ctxCap;
  }
  // Amendment 2026-10-08 (lot B1, docs/PROTOCOL.md item 6): a screenshot
  // costs the vision encoder its own tokens, on top of the text estimate
  // above — without headroom, Ollama silently truncates the prompt from the
  // START when num_ctx is exceeded (hallucination risk, not an error). One
  // tier up, capped by the model's own context_length.
  const hasImage = (built.images?.length ?? 0) > 0;
  if (hasImage) {
    for (const bucket of CTX_BUCKETS_FIXED_ASC) {
      if (bucket > num_ctx && bucket <= ctxCap) {
        num_ctx = bucket;
        break;
      }
    }
  }

  // Amendment 2026-10-08 (bis, "historique"): fit WITHIN the tier already
  // chosen above, rather than growing it for history — "fewer when the
  // model has little room" (docs/PROTOCOL.md). `promptEstimate` already
  // reserves the answer's own headroom (+1024 tokens); whatever is left of
  // `num_ctx` is the history budget, converted back to a char count with the
  // same /3 ratio ollamaContextSize uses the other way. A model whose own
  // prompt already fills its tier gets 0 chars of room — every history
  // entry is dropped, not the request.
  const remainingChars = Math.max(0, (num_ctx - promptEstimate) * 3);
  const trimmedHistory = trimHistoryToCharBudget(built.history, remainingChars);
  const historyMessages = trimmedHistory.map((h) => ({ role: h.role, content: h.text }));
  const historyKept = built.history && built.history.length > 0 ? trimmedHistory.length : undefined;

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          keep_alive: "15m",
          // Amendment 2026-10-07: for thinking-capable models:
          //   - hybrid (canDisableThinking): think:false → reasoning suppressed
          //     at source; ThinkFilter still strips any residual <think> blocks.
          //   - thinking-only (!canDisableThinking): think:true → Ollama routes
          //     reasoning to message.thinking (ignored by parseNdjsonLine);
          //     message.content stays clean; ThinkFilter is a safety net.
          ...(hasThinking ? { think: showInfo.canDisableThinking ? false : true } : {}),
          // Amendment 2026-10-08 (bis, "historique"): past turns rendered
          // as real alternating messages, between the system turn and the
          // current one, already trimmed to fit `num_ctx` above.
          messages: [
            { role: "system", content: systemPrompt },
            ...historyMessages,
            {
              role: "user",
              content: built.prompt,
              // Amendment 2026-10-08 (lot B1, docs/PROTOCOL.md): Ollama's
              // /api/chat takes base64 strings (no data: URI prefix) on the
              // message, not a separate content-block array. Security review
              // (L8): unlike claude-api.ts/openai-compat.ts, there is no
              // ordered content array here to interleave a fence-wrapped
              // image into — `images` is a flat sibling field on the whole
              // message, with no notion of "where" relative to `content`'s
              // text it belongs. Left as-is; the system prompt's own
              // sentence ("A message may also include an attached image...")
              // remains the only framing for this one provider.
              ...(hasImage ? { images: built.images!.map((img) => img.data) } : {}),
            },
          ],
          options: { num_ctx },
        }),
        // Same reasoning as /api/tags/show/ps/generate above: never follow a
        // redirect that could carry page content off-machine
        // (notes/BUG_ollama_url_not_validated_and_redirects_followed_20261006.md).
        redirect: "error",
        signal: abortController.signal,
      });
    } catch (err) {
      if (stalled) throw new ModelStalledError(inactivityMs);
      if (timedOut) throw new ModelTimeoutError(firstTokenMs);
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

    // Amendment 2026-10-07: strip <think>…</think> blocks from the output
    // for thinking-capable models. Even with think:false, Ollama 0.35.1 still
    // emits the thinking tokens inside the content stream — filter them out.
    // Amendment 2026-10-07 (bis): message.thinking deltas count as activity:
    // they satisfy the first-token deadline and reset the 60 s inactivity
    // timer. They are yielded upstream (as { kind: "thinking" }) so server.ts
    // can emit the "thinking" progress stage once, but never forwarded as text.
    if (hasThinking) {
      const filter = new ThinkFilter();
      for await (const event of parseNdjsonStream(response.body)) {
        if (event.kind === "thinking") {
          // Counts as activity — satisfies first-token deadline if still pending.
          if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); resetInactivity(); }
          else { resetInactivity(); }
          yield { kind: "thinking" }; // forwarded so server.ts can send progress:thinking once
        } else if (event.kind === "delta") {
          if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); resetInactivity(); }
          else { resetInactivity(); }
          const filtered = filter.filter(event.text);
          if (filtered.length > 0) yield { kind: "delta", text: filtered };
        } else {
          yield event.kind === "usage" ? { ...event, historyKept } : event;
        }
      }
      const tail = filter.flush();
      if (tail.length > 0) yield { kind: "delta", text: tail };
    } else {
      for await (const event of parseNdjsonStream(response.body)) {
        if (event.kind === "delta") {
          if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); resetInactivity(); }
          else { resetInactivity(); }
        }
        yield event.kind === "usage" ? { ...event, historyKept } : event;
      }
    }
  } catch (err) {
    if (stalled) throw new ModelStalledError(inactivityMs);
    if (timedOut) throw new ModelTimeoutError(firstTokenMs);
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(inactivityTimer);
  }

  if (stalled) throw new ModelStalledError(inactivityMs);
  if (timedOut) throw new ModelTimeoutError(firstTokenMs);
}

/**
 * Pre-loads an Ollama model into memory (amendment 2026-10-07 bis).
 *
 * Checks /api/ps first — if the model is already loaded, returns "already"
 * immediately. Otherwise POSTs to /api/generate with an empty prompt and
 * `keep_alive:"15m"` (Ollama loads the model and returns without generating).
 * The `options.num_ctx` matches what streamAnswer would use for this model,
 * preventing a reload on the first real request.
 *
 * Returns:
 *   - `{ state: "already" }` — model was already in memory.
 *   - `{ state: "loaded", ms }` — successfully loaded, ms = wall time.
 *   - `{ state: "failed" }` — Ollama unreachable or error.
 */
export async function warmupModel(
  model: string,
  contextTokens: number,
  opts: { ollamaUrl?: string },
): Promise<{ state: "already" | "loaded" | "failed"; ms?: number }> {
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  // Check if already loaded
  try {
    const ps = await fetchPsEntries({ ollamaUrl: baseUrl });
    if (ps.some((e) => matchesModel(e.name, model))) {
      return { state: "already" };
    }
  } catch {
    // /api/ps failure is non-fatal — proceed to load
  }

  const startedAt = Date.now();
  try {
    // Same security gate as fetchModelTags/fetchPsEntries above.
    if (!isAllowedOllamaUrl(baseUrl)) throw new Error(`ollama url "${baseUrl}" is not allowed`);
    const response = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: "15m",
        options: { num_ctx: contextTokens },
      }),
      signal: AbortSignal.timeout(300_000), // up to 5 min for cold load
      redirect: "error",
    });
    if (!response.ok) return { state: "failed" };
    // Drain the response body (Ollama streams a single done:true JSON object)
    await response.text().catch(() => "");
    return { state: "loaded", ms: Date.now() - startedAt };
  } catch {
    return { state: "failed" };
  }
}

/**
 * Amendment 2026-10-08 (lot B1, docs/PROTOCOL.md): the live, per-model
 * vision gate — `true`/`false` from /api/show's `capabilities` for THIS
 * model (digest-cached, same lookup streamAnswer already makes), `undefined`
 * if the model isn't found or the daemon is unreachable.
 */
async function supportsVision(opts: ProviderRuntimeOptions): Promise<boolean | undefined> {
  const model = opts.model?.trim();
  if (!model) return undefined;
  const baseUrl = resolveBaseUrl(opts.ollamaUrl);
  let installedTags: OllamaModelTag[];
  try {
    installedTags = await fetchModelTags(baseUrl);
  } catch {
    return undefined;
  }
  const matchedTag = installedTags.find((t) => matchesModel(t.name, model));
  if (!matchedTag) return undefined;
  const showInfo = await fetchModelShowInfo(baseUrl, matchedTag.name, matchedTag.digest).catch(
    () => ({ capabilities: null, canDisableThinking: false }) as ShowInfo,
  );
  if (!Array.isArray(showInfo.capabilities)) return undefined;
  return showInfo.capabilities.includes("vision");
}

export const ollamaProvider: ModelProvider = {
  id: "ollama",
  label: "Ollama (local)",
  isAvailable,
  listModels,
  checkStatus,
  testConnection,
  streamAnswer,
  supportsVision,
};
