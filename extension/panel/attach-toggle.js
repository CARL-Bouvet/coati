// Coati side panel — main button label ("Summarize"/"Read the page" is
// gone, see panel/dev-mode.js) — split of panel.js, trimmed when the
// "Read the page"/"See the screen" switches were replaced by the single
// "Dev mode" switch (docs/PROTOCOL.md "Page on demand"): the two switches
// and their wiring used to live in this file; only the unrelated main-button
// label logic below survives.
import { t } from "../lib/i18n-page.js";
import { pageKind, pageType } from "./page-detect.js";

export const MAIN_BUTTON_LABELS = {
  video: t("panel_summarize_video"),
  article: t("panel_summarize_article"),
  page: t("panel_summarize_page"),
};

// (page types), docs/PROTOCOL.md "Page types,
// facts and entries". `context.pageKind` — set by extract.js only for
// kind === "page" — refines the generic "page" label above. `other` keeps
// today's wording so an unrecognized/absent pageKind (an older client, or
// the protocol's "uncertain → other") reads exactly as before.
export const PAGE_KIND_BUTTON_LABELS = {
  list: t("panel_summarize_results"),
  listing: t("panel_summarize_listing"),
  article: t("panel_summarize_article"),
  other: t("panel_summarize_page"),
};

/** `pageKind` (DOM-derived, kind === "page" only) wins over the legacy
 * `pageType` label when known; falls back to it otherwise — an older broker
 * exchange, a video, or a page read before the DOM classifier ran. */
export function mainButtonLabel() {
  if (pageKind && PAGE_KIND_BUTTON_LABELS[pageKind]) return PAGE_KIND_BUTTON_LABELS[pageKind];
  return MAIN_BUTTON_LABELS[pageType] ?? t("panel_summarize_default");
}
