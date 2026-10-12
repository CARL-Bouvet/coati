// TypeScript types and parser for every message defined in docs/PROTOCOL.md.
// The 256 KB per-message cap is enforced here, at parse time.
//
// Lot F5 (split without behaviour change): the implementation now lives
// under protocol/ — shared.ts (wire limits, ErrorCode, validation
// primitives), context.ts (Context/Fact/Item/Element + parser),
// prompts-prefs.ts (PromptEntry/SitePrefs/PrefsData + validators), chat.ts
// (ChatImage/HistoryEntry + parsers), client-messages.ts /
// server-messages.ts (the wire message shapes) and parse.ts
// (parseClientMessage). This file re-exports all of it so every existing
// import of "./protocol.ts" / "../protocol.ts" keeps working unchanged.

export {
  MAX_MESSAGE_BYTES,
  MAX_IMAGE_MESSAGE_BYTES,
  type ErrorCode,
  isValidApiKeyFormat,
  isValidBaseUrl,
} from "./protocol/shared.ts";

export {
  type ContextKind,
  type PageKind,
  type Fact,
  type Item,
  type Element,
  type Context,
  FACTS_MAX,
  FACT_LABEL_MAX,
  FACT_VALUE_MAX,
  ITEMS_MAX,
  ITEM_TITLE_MAX,
  ITEM_PRICE_MAX,
  ITEM_LOCATION_MAX,
  ITEM_DETAIL_MAX,
  ELEMENTS_MAX,
  ELEMENT_LABEL_MAX,
  ELEMENT_REF_RE,
  ELEMENT_ROLES,
  type ElementRole,
  parseContext,
} from "./protocol/context.ts";

export {
  type PromptEntry,
  PROMPT_ID_PREFIX,
  PROMPT_ID_RE,
  POPULAR_SITE_KEY_RE,
  USER_SITE_KEY_RE,
  SUGGESTION_ID_RE,
  PROMPT_TITLE_MAX,
  PROMPT_BODY_MAX,
  PREFS_ORDER_MAX,
  PREFS_SITES_MAX,
  isValidSiteKey,
  isValidOrderItem,
  isValidPromptId,
  type SitePrefs,
  type PrefsData,
} from "./protocol/prompts-prefs.ts";

export {
  IMAGE_MEDIA_TYPES,
  type ImageMediaType,
  IMAGE_MAX_DECODED_BYTES,
  IMAGE_MAX_SIDE,
  type ChatImage,
  type HistoryRole,
  type HistoryEntry,
  HISTORY_MAX_ENTRIES,
  HISTORY_ENTRY_TEXT_MAX,
  type PageMeta,
  PAGE_META_TITLE_MAX,
  PAGE_META_URL_MAX,
  type ChatAbility,
  type SearchBody,
  type SearchResultEntry,
  type SearchPageEntry,
  type SearchDeclineReason,
  type OpenDeclineReason,
  OPEN_DECLINE_REASONS,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_MAX_PER_QUESTION,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_OPENED,
  OPEN_MAX_REFS,
  OPEN_PAGE_MAX_CHARS,
  SEARCH_BUDGET_LOCAL_CHARS,
  SEARCH_BUDGET_ONLINE_CHARS,
  CHAT_MAX_MODEL_TURNS,
  searchContentError,
  openContentError,
} from "./protocol/chat.ts";

export {
  type HelloMessage,
  type AuthMessage,
  type ChatMessage,
  type SummarizeMessage,
  type ActAction,
  type ActMessage,
  type PromptsListMessage,
  type PromptsSaveMessage,
  type PromptsDeleteMessage,
  type PromptsMoveMessage,
  type PrefsGetMessage,
  type PrefsSetMessage,
  type CancelMessage,
  type SettingsGetMessage,
  type SettingsSetMessage,
  type SettingsTestMessage,
  type ProviderStatusMessage,
  type ModelsListMessage,
  type ModelWarmupMessage,
  type PageContentMessage,
  type PageDeclineMessage,
  type SearchContentMessage,
  type SearchDeclineMessage,
  type OpenContentMessage,
  type OpenDeclineMessage,
  type ClientMessage,
} from "./protocol/client-messages.ts";

export {
  type ChunkMessage,
  type DoneMessage,
  type ErrorMessage,
  type PromptsMessage,
  type PrefsMessage,
  type HelloOkMessage,
  type ProviderStatus,
  type SettingsMessage,
  type SettingsTestResultMessage,
  type ProviderStatusState,
  type ProviderStatusResultMessage,
  type HostCapacity,
  type ModelFit,
  type ModelEntry,
  type ModelSource,
  type ModelsMessage,
  type ModelWarmupResultMessage,
  type ProgressMessage,
  type ChallengeMessage,
  type PageRequestMessage,
  type SearchRequestMessage,
  type OpenRequestMessage,
  type ServerMessage,
} from "./protocol/server-messages.ts";

export { type ParseError, type ParseResult, parseClientMessage } from "./protocol/parse.ts";
