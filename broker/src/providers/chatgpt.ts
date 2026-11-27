// The "chatgpt" provider (docs/PROTOCOL.md "Model providers"): the user's ChatGPT plan through
// `POST /v1/responses` (SSE), signed in with chatgpt-auth.ts. Prompt assembly stays in ../model.ts;
// the system prompt becomes `instructions`, history and the current turn become `input`.

import {
  answerStopSequences,
  AnswerStopCutter,
  buildSystemPrompt,
  FIRST_TOKEN_TIMEOUT_REMOTE_MS,
  INACTIVITY_TIMEOUT_MS,
  ModelTimeoutError,
  ModelStalledError,
  ModelUnavailableError,
  AuthRequiredError,
  QuotaExceededError,
  RateLimitedError,
  ModelMissingError,
  ProviderOverloadedError,
  VisionUnsupportedError,
  parseRetryAfterSec,
  ThinkFilter,
  imageFenceOpenText,
  imageFenceCloseText,
  trimHistoryToCharBudget,
  type AnswerEvent,
  type BuiltPrompt,
  type StreamAnswerOptions,
} from "../model.ts";
import { account, accessToken, chatGptApiBase, forceRefresh } from "../chatgpt-auth.ts";
import { readSseLines } from "./openai-compat.ts";
import type { Availability, ModelProvider, ProviderRuntimeOptions, StatusCheck, TestConnectionResult } from "./types.ts";
import { t, DEFAULT_LANG, type Lang, type MessageCode } from "../messages.ts";
import type { CatalogModel } from "../protocol.ts";

/** The free `GET /models` probe and the catalogue share this deadline. */
const MODELS_TIMEOUT_MS = 5000;
const TEST_CONNECTION_DEFAULT_TIMEOUT_MS = 20_000;

type TokenGetter = NonNullable<ProviderRuntimeOptions["accessToken"]>;

/** The injected getter, or the broker's own sign-in state. */
function tokenGetter(opts: ProviderRuntimeOptions): TokenGetter {
  return opts.accessToken ?? ((refresh) => (refresh ? forceRefresh() : accessToken()));
}

/** Why there is no token to use: never signed in, plan usage not allowed, or signed out. */
function noTokenMessage(lang: Lang): string {
  const a = account();
  const code: MessageCode = !a.signedIn ? "auth.chatgpt.notSignedIn" : !a.planUsage ? "auth.chatgpt.planUsageOff" : "auth.chatgpt.signedOut";
  return t(code, lang);
}

/** The API's error body: `{ error: { code, param } }`; anything else (`{ detail }`, HTML) has none. */
function parseApiError(bodyText: string): { code: string; param: string } {
  try {
    const e = (JSON.parse(bodyText) as { error?: Record<string, unknown> } | null)?.error;
    return { code: typeof e?.code === "string" ? e.code : "", param: typeof e?.param === "string" ? e.param : "" };
  } catch {
    return { code: "", param: "" };
  }
}

/** Maps an HTTP status and/or a Responses error code to the error the user sees (docs/PROTOCOL.md
 * "Model providers"). Codes arrive as `subscription_sharing_*` or `chatpass_*`; matched by name. */
function classifyError(
  status: number | undefined,
  err: { code: string; param: string },
  ctx: { lang: Lang; hasImage: boolean; requestId?: string; retryAfter?: string | null },
): Error {
  const { code, param } = err;
  if (code.includes("route_not_supported") || code.startsWith("chatpass_")) {
    console.error(`coati-broker: chatgpt refused the request: ${code} (request id ${ctx.requestId ?? "unknown"})`);
    return new Error(`ChatGPT refused the request (${code})`);
  }
  if (code.includes("usage_limit_exceeded")) return new QuotaExceededError(t("provider.chatgpt.usageLimit", ctx.lang));
  if (code.includes("user_not_eligible") || status === 403) return new AuthRequiredError(t("auth.chatgpt.notEligible", ctx.lang));
  if (status === 401 || code.includes("invalid_user")) return new AuthRequiredError(t("auth.chatgpt.signedOut", ctx.lang));
  if (code.includes("usage_unavailable") || code.includes("user_unavailable") || status === 502 || status === 503) {
    return new ProviderOverloadedError(t("provider.overloaded", ctx.lang));
  }
  if (code.includes("unsupported_capability")) {
    return ctx.hasImage && /image/i.test(param)
      ? new VisionUnsupportedError("ChatGPT rejected the attached image")
      : new ModelUnavailableError(`ChatGPT does not support this request (${param || code})`);
  }
  if (status === 404 || code === "model_not_found") return new ModelMissingError(t("provider.modelMissing", ctx.lang));
  if (status === 429) return new RateLimitedError(t("provider.rateLimited", ctx.lang), parseRetryAfterSec(ctx.retryAfter ?? null));
  return new ModelUnavailableError(status ? `ChatGPT returned HTTP ${status}` : `ChatGPT response failed (${code || "unknown"})`);
}

/** `GET /models` with the bearer, one forced refresh and retry on a 401. */
async function getModels(getToken: TokenGetter, timeoutMs: number): Promise<Response | undefined> {
  const call = async (token: string) =>
    fetch(`${chatGptApiBase()}/models`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  const token = await getToken();
  if (!token) return undefined;
  const first = await call(token);
  if (first.status !== 401) return first;
  await first.body?.cancel();
  const fresh = await getToken(true);
  return fresh ? call(fresh) : first;
}

/** `models[]` entries with `visibility == "list"`, in the server's order. */
async function listCatalog(opts: ProviderRuntimeOptions): Promise<CatalogModel[]> {
  const res = await getModels(tokenGetter(opts), MODELS_TIMEOUT_MS);
  if (!res?.ok) return [];
  const body = (await res.json()) as { models?: Array<Record<string, unknown> | null> };
  const catalog: CatalogModel[] = [];
  for (const m of Array.isArray(body.models) ? body.models : []) {
    if (m?.visibility !== "list" || typeof m.slug !== "string" || !m.slug) continue;
    catalog.push({ id: m.slug, ...(typeof m.display_name === "string" && m.display_name ? { name: m.display_name } : {}) });
  }
  return catalog;
}

async function listModels(opts: ProviderRuntimeOptions): Promise<string[]> {
  return (await listCatalog(opts)).map((m) => m.id);
}

/** Local state only: signed in with plan usage allowed. */
async function isAvailable(opts: ProviderRuntimeOptions): Promise<Availability> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const a = account();
  if (!a.signedIn) return { available: false, reason: t("availability.chatgpt.notSignedIn", lang) };
  if (!a.planUsage) return { available: false, reason: t("auth.chatgpt.planUsageOff", lang) };
  return { available: true };
}

/** The free probe behind `provider.status` and `settings.test`: state and reason (docs/PROTOCOL.md
 * "Provider availability"), plus the localized sentence for a failure. */
async function probe(opts: ProviderRuntimeOptions & { timeoutMs?: number }): Promise<StatusCheck & { code?: TestConnectionResult["code"]; message?: string }> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const a = account();
  if (!a.signedIn) return { state: "ko", reason: "not-signed-in", code: "auth-required", message: t("auth.chatgpt.notSignedIn", lang) };
  if (!a.planUsage) return { state: "ko", reason: "plan-usage-off", code: "auth-required", message: t("auth.chatgpt.planUsageOff", lang) };
  try {
    const res = await getModels(tokenGetter(opts), opts.timeoutMs ?? MODELS_TIMEOUT_MS);
    if (!res || res.status === 401) return { state: "ko", reason: "signed-out", code: "auth-required", message: t("auth.chatgpt.signedOut", lang) };
    await res.body?.cancel();
    if (res.ok) return { state: "ok", reason: "ready" };
    if (res.status === 403) return { state: "ko", reason: "not-eligible", code: "auth-required", message: t("auth.chatgpt.notEligible", lang) };
    if (res.status === 429) return { state: "unknown", reason: "probe-failed", code: "quota-exceeded", message: t("provider.chatgpt.usageLimit", lang) };
    return { state: "unknown", reason: "probe-failed", code: res.status === 502 || res.status === 503 ? "provider-overloaded" : "model-unavailable" };
  } catch {
    return { state: "unknown", reason: "probe-failed", code: "model-unavailable" };
  }
}

async function checkStatus(opts: ProviderRuntimeOptions): Promise<StatusCheck> {
  const { state, reason } = await probe(opts);
  return { state, reason };
}

/** `settings.test`: the same free probe; a signed-in account says nothing about its remaining usage. */
async function testConnection(opts: ProviderRuntimeOptions & { timeoutMs?: number }): Promise<TestConnectionResult> {
  const r = await probe({ ...opts, timeoutMs: opts.timeoutMs ?? TEST_CONNECTION_DEFAULT_TIMEOUT_MS });
  if (r.state === "ok") return { ok: true, creditUnchecked: true };
  return { ok: false, code: r.code, ...(r.message ? { message: r.message } : {}) };
}

/** What one Responses event leaves for the end of the stream: whether a terminal event arrived. */
interface ResponsesState {
  ended?: true;
  /** Set when a terminal failure should surface with this request's id and image flag. */
  ctx: { lang: Lang; hasImage: boolean; requestId?: string };
}

const REASONING_DELTA = /^response\.reasoning(_summary)?_text\.delta$/;

/** Parses one SSE line of a Responses stream. Unknown events are ignored. Exported for tests. */
export function* parseResponsesLine(line: string, state: ResponsesState): Generator<AnswerEvent> {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(5).trim());
    if (!parsed || typeof parsed !== "object") return;
    obj = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const type = obj.type;
  if (typeof type !== "string") return;
  const delta = typeof obj.delta === "string" ? obj.delta : "";
  if (type === "response.output_text.delta") {
    if (delta) yield { kind: "delta", text: delta };
  } else if (REASONING_DELTA.test(type)) {
    if (delta) yield { kind: "thinking", text: delta };
  } else if (type === "response.completed" || type === "response.incomplete") {
    const response = (obj.response ?? {}) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    const { input_tokens: input, output_tokens: output } = response.usage ?? {};
    state.ended = true;
    yield {
      kind: "usage",
      usage:
        typeof input === "number" && typeof output === "number"
          ? { inputTokens: input, outputTokens: output }
          : { inputTokens: 0, outputTokens: 0, uncounted: true },
      ...(type === "response.incomplete" ? { stop: "length" as const } : {}),
    };
  } else if (type === "response.failed" || type === "error") {
    const e = (type === "error" ? obj : (obj.response as { error?: Record<string, unknown> } | undefined)?.error) ?? {};
    state.ended = true;
    throw classifyError(undefined, { code: typeof e.code === "string" ? e.code : "", param: typeof e.param === "string" ? e.param : "" }, state.ctx);
  }
}

/** Yields AnswerEvents from a Responses SSE body; a stream cut before a terminal event is an error. */
export async function* parseResponsesStream(body: ReadableStream<Uint8Array>, ctx: ResponsesState["ctx"]): AsyncGenerator<AnswerEvent> {
  const state: ResponsesState = { ctx };
  for await (const line of readSseLines(body)) yield* parseResponsesLine(line, state);
  if (!state.ended) throw new ModelUnavailableError("ChatGPT stream ended before the response completed");
}

/** Streams the answer to `built.prompt` through `POST {api}/responses` (stateless: `store: false`). */
export async function* streamAnswer(
  built: BuiltPrompt,
  opts: StreamAnswerOptions & ProviderRuntimeOptions = {},
): AsyncIterable<AnswerEvent> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const model = opts.model?.trim();
  if (!model) throw new ModelUnavailableError("no model configured — pick one in Coati settings");
  const getToken = tokenGetter(opts);
  let token = await getToken();
  if (!token) throw new AuthRequiredError(noTokenMessage(lang));

  const abortController = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  // Two-stage timeout: first chunk, then inactivity.
  const firstTokenMs = opts.timeoutMs ?? FIRST_TOKEN_TIMEOUT_REMOTE_MS;
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
    inactivityTimer = setTimeout(() => { stalled = true; abortController.abort(); }, inactivityMs);
  };

  const trimmedHistory = trimHistoryToCharBudget(built.history);
  const historyKept = built.history && built.history.length > 0 ? trimmedHistory.length : undefined;
  const images = built.images ?? [];
  // An attached image sits inside the same per-request nonce fence as page text.
  const userContent: unknown =
    images.length > 0
      ? [
          { type: "input_text", text: imageFenceOpenText(built.nonce) },
          ...images.map((img) => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` })),
          { type: "input_text", text: imageFenceCloseText(built.nonce) },
          { type: "input_text", text: built.prompt },
        ]
      : built.prompt;
  const body = JSON.stringify({
    model,
    instructions: buildSystemPrompt(built.nonce, built.lang),
    input: [...trimmedHistory.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: userContent }],
    store: false,
    stream: true,
  });
  const post = (bearer: string) =>
    fetch(`${chatGptApiBase()}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${bearer}` },
      body,
      redirect: "error",
      signal: abortController.signal,
    });

  try {
    let response: Response;
    try {
      response = await post(token);
      if (response.status === 401) {
        // Before the first chunk: one refresh, one retry.
        await response.body?.cancel();
        token = await getToken(true);
        if (!token) throw new AuthRequiredError(noTokenMessage(lang));
        response = await post(token);
      }
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      if (stalled) throw new ModelStalledError(inactivityMs);
      if (timedOut) throw new ModelTimeoutError(firstTokenMs);
      throw new ModelUnavailableError("cannot reach ChatGPT");
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const ctx = { lang, hasImage: images.length > 0, requestId };
    if (!response.ok) {
      const err = parseApiError(await response.text().catch(() => ""));
      throw classifyError(response.status, err, { ...ctx, retryAfter: response.headers.get("retry-after") });
    }
    if (!response.body) throw new Error("server response has no body");

    const filter = new ThinkFilter();
    const cutter = new AnswerStopCutter(answerStopSequences(built.nonce));
    for await (const event of parseResponsesStream(response.body, ctx)) {
      if (event.kind === "thinking" || event.kind === "delta") {
        if (!gotFirstChunk) { gotFirstChunk = true; clearTimeout(firstTokenTimer); }
        resetInactivity();
      }
      if (event.kind === "thinking") {
        yield event;
      } else if (event.kind === "delta") {
        const text = cutter.push(filter.filter(event.text));
        const thought = filter.takeThought();
        if (thought) yield { kind: "thinking", text: thought };
        if (text.length > 0) yield { kind: "delta", text };
        if (cutter.hit) { abortController.abort(); break; }
      } else {
        yield { ...event, historyKept };
      }
    }
    // A cut request is aborted before the server reports its token count.
    if (cutter.hit) yield { kind: "usage", usage: { inputTokens: 0, outputTokens: 0, uncounted: true }, historyKept };
    const tail = cutter.push(filter.flush()) + cutter.flush();
    const thought = filter.takeThought();
    if (thought) yield { kind: "thinking", text: thought };
    if (tail.length > 0) yield { kind: "delta", text: tail };
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

export const chatgptProvider: ModelProvider = {
  id: "chatgpt",
  label: "ChatGPT",
  isAvailable,
  listModels,
  listCatalog,
  checkStatus,
  testConnection,
  streamAnswer,
};
