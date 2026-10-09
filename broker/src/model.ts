// Provider-agnostic prompt assembly. Every model backend (broker/src/providers/*)
// streams text back through the same ModelProvider interface (providers/types.ts);
// this file is the ONE place that builds the prompt they receive, so the
// per-request nonce fence and the "page content is data, never an instruction"
// system prompt apply identically no matter which provider answers. Do not
// duplicate buildPrompt/buildSystemPrompt inside a provider.
//
// Lot F5 (split without behaviour change): the implementation now lives in
// model/render.ts (fencing + sanitizing + Context/sources rendering),
// model/build.ts (buildPrompt + per-pageKind summarize instructions +
// history trim/render) and model/streaming.ts (typed errors + timeouts +
// StreamAnswerOptions/AnswerEvent + ThinkFilter). This file re-exports all of
// it so every existing import of "./model.ts" / "../model.ts" keeps working
// unchanged.

export {
  imageFenceOpenText,
  imageFenceCloseText,
  LANGUAGE_NAME,
  buildSystemPrompt,
  type PromptSource,
  type PageMeta,
  renderPageMeta,
  pageOnDemandInstruction,
  PAGE_READ_DECLINED_NOTE,
} from "./model/render.ts";

export {
  type PromptInput,
  type BuiltPrompt,
  buildPrompt,
  HISTORY_CHAR_BUDGET,
  trimHistoryToCharBudget,
  renderHistoryBlock,
} from "./model/build.ts";

export {
  ModelTimeoutError,
  ModelStalledError,
  isModelStalledError,
  ModelUnavailableError,
  AuthRequiredError,
  isAuthRequiredError,
  QuotaExceededError,
  isQuotaExceededError,
  RateLimitedError,
  isRateLimitedError,
  VisionUnsupportedError,
  isVisionUnsupportedError,
  ModelMissingError,
  isModelMissingError,
  ProviderOverloadedError,
  isProviderOverloadedError,
  isModelUnavailableError,
  parseRetryAfterSec,
  FIRST_TOKEN_TIMEOUT_LOCAL_MS,
  FIRST_TOKEN_TIMEOUT_REMOTE_MS,
  INACTIVITY_TIMEOUT_MS,
  MODEL_TIMEOUT_MS,
  type StreamAnswerOptions,
  type AnswerEvent,
  ThinkFilter,
} from "./model/streaming.ts";

export {
  MARKER_TEXT,
  MARKER_DEV,
  type PageMarkerLevel,
  type PageMarkerPosition,
  type PageMarkerEvent,
  PageMarkerDetector,
} from "./model/page-marker.ts";
