// Coati side panel — main button label, "Coati is reading this page" and
// "See the screen" toggles (lot F3 split of panel.js).
import { t } from "../lib/i18n-page.js";
import { els } from "./dom-refs.js";
import { panelState } from "./panel-state.js";
import { providerLabel } from "../lib/labels.js";
import { isCurrentLocal, currentModelVision } from "../lib/model-list.js";
import { hasFeature, currentGroupedModels } from "./model-status.js";
import { currentTabId } from "./panel.js";
import { pageKind, pageType } from "./page-detect.js";

export const MAIN_BUTTON_LABELS = {
  video: t("panel_summarize_video"),
  article: t("panel_summarize_article"),
  page: t("panel_summarize_page"),
};

// Amendment 2026-09-25 (page types), docs/PROTOCOL.md "Page types,
// facts and entries". `context.pageKind` — set by extract.js only for
// kind === "page" — refines the generic "page" label above. `other` keeps
// today's wording so an unrecognized/absent pageKind (an older client, or
// the amendment's own "uncertain → other") reads exactly as before.
export const PAGE_KIND_BUTTON_LABELS = {
  list: t("panel_summarize_results"),
  listing: t("panel_summarize_listing"),
  article: t("panel_summarize_article"),
  other: t("panel_summarize_page"),
};

// --- Page detection (deliverable 1) --------------------------------------

/** `pageKind` (DOM-derived, kind === "page" only) wins over the legacy
 * `pageType` label when known; falls back to it otherwise — an older broker
 * exchange, a video, or a page read before the DOM classifier ran. */
export function mainButtonLabel() {
  if (pageKind && PAGE_KIND_BUTTON_LABELS[pageKind]) return PAGE_KIND_BUTTON_LABELS[pageKind];
  return MAIN_BUTTON_LABELS[pageType] ?? t("panel_summarize_default");
}

export function updateAttachToggle() {
  // Gated on "do we have a tab to read", not on whether its type is already
  // known — real extraction always happens at send time (a gesture), even
  // when redetectTabFromMetadata() left the type unknown.
  const available = currentTabId != null;
  els.attachPage.disabled = !available;
  setAttachPageChecked(available && (panelState.attachPagePreference ?? true));
}

/** `#attachPage` is a `role="switch"` button (Lot 2), not a checkbox: its
 * state lives in `aria-checked`/the `.switch--on` class, not `.checked`. */
export function setAttachPageChecked(checked) {
  els.attachPage.setAttribute("aria-checked", String(checked));
  els.attachPage.classList.toggle("switch--on", checked);
}

export function isAttachPageChecked() {
  return els.attachPage.getAttribute("aria-checked") === "true";
}

// --- "See the screen" -------------------------------------------------------

export function setAttachScreenChecked(checked) {
  els.attachScreen.setAttribute("aria-checked", String(checked));
  els.attachScreen.classList.toggle("switch--on", checked);
}

export function isAttachScreenChecked() {
  return els.attachScreen.getAttribute("aria-checked") === "true";
}

/** Shows/hides the row, greys the switch out with a reason when the
 * current model is KNOWN not to see images, and sets the destination line.
 * Called whenever what it depends on changes: `brokerFeatures` (coati:status)
 * and the current model (renderModelPicker(), already called on every
 * models/status update). Unknown vision (older local program, or a source
 * that can't tell) leaves the switch active — plan §3B: "inconnu : case
 * active". */
export function updateAttachScreenUi() {
  const show = hasFeature("vision");
  els.attachScreenRow.hidden = !show;
  if (!show) return;

  const grouped = currentGroupedModels();
  const vision = currentModelVision(grouped);
  const noVision = vision === false;
  els.attachScreen.disabled = noVision;
  // Sticky preference (ATTACH_SCREEN_KEY) is the source of truth, same as
  // attachPage's — re-applied every time this row becomes usable again
  // (e.g. the model regains vision after this very function greyed it out).
  setAttachScreenChecked(!noVision && panelState.attachScreenPreference);

  if (noVision) {
    els.attachScreenDestination.textContent = t("panel_screen_no_vision");
    return;
  }
  // No current model known yet (models.list hasn't answered this session) —
  // leave the line blank rather than guessing a provider from a null id.
  els.attachScreenDestination.textContent = !grouped.current.provider
    ? ""
    : isCurrentLocal(grouped)
      ? t("panel_attach_screen_local")
      : t("panel_attach_screen_online", [providerLabel(grouped.current.provider, grouped.current.provider)]);
}
