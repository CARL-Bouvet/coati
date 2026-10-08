// Slow local model advice (plan-ollama-rapide-07-10.md, points 3, 4 and 6):
// the « Chargement du modèle… » / « Le modèle lit la page… » line shown in
// the pending answer before its first word, the calm line shown when a
// « partagé » model is picked, and the tip under a slow or cut answer.
//
// No i18n import on purpose (same as lib/model-list.js): the pure helpers
// are unit-tested under bun, and the builders receive `t` from panel.js.
// Security rule 3: every node is built with createElement/textContent —
// model names come from the local program, never inserted as markup.
import { bestGpuModel, isSlowLocalModel, sameModel, shortModelName } from "../lib/model-list.js";

/** A first word later than this, on a model that doesn't fit the card,
 * earns the tip under the answer. */
export const SLOW_FIRST_WORD_MS = 30_000;

/** Options page anchor of the « Accélérer Ollama » block (options.js). */
export const OLLAMA_SPEEDUP_PATH = "options.html#setup-ollama-speedup";

/** The sniffing coati (WebP/still PNG) shows for at most this long per
 * request, counted once from the first progress stage — not replayed when
 * the stage changes (loading -> reading -> thinking). */
export const COATI_VISIBLE_MS = 2000;

/** `startedAt`: ms timestamp of the first progress stage of this message, or
 * null/undefined before any stage fired. `now`: injected clock (tests pass a
 * fixed value; panel.js passes Date.now()). */
export function coatiVisible(startedAt, now) {
  return typeof startedAt === "number" && now - startedAt < COATI_VISIBLE_MS;
}

/** "loading" | "reading" | "thinking" | null — the only stages the panel
 * draws ("thinking": a thinking-only model reasoning before its first word). */
export function readProgressStage(stage) {
  return stage === "loading" || stage === "reading" || stage === "thinking" ? stage : null;
}

/** Locale key of the waiting line. `readsPage`: the request carries the
 * page (summarize, chat with the page attached) — else « votre demande ». */
export function progressKey(stage, readsPage) {
  if (stage === "loading") return "panel_progress_loading";
  if (stage === "thinking") return "panel_progress_thinking";
  return readsPage ? "panel_progress_reading_page" : "panel_progress_reading_request";
}

/** The best model that fits the card, never `entry` itself, or null. */
function alternativeTo(entry, grouped) {
  const best = bestGpuModel(grouped);
  return best && !sameModel(best.model, entry?.model) ? best : null;
}

/**
 * Tip under a slow or cut answer, or null when none applies (only Ollama
 * models get one). `suggest`: model id to offer instead (largest one that
 * fits the card), null when `entry` isn't slow or nothing fits.
 * @returns {{suggest: string|null}|null}
 */
export function slowTipFor(entry, grouped) {
  if (entry?.provider !== "ollama") return null;
  const alt = isSlowLocalModel(entry) ? alternativeTo(entry, grouped) : null;
  return { suggest: alt ? alt.model : null };
}

/** true when the first word came late on a model that doesn't fit the card. */
export function isSlowFirstWord(elapsedMs, entry) {
  return elapsedMs > SLOW_FIRST_WORD_MS && isSlowLocalModel(entry);
}

/** « qwen3:8b ne tient pas entièrement dans la carte graphique : il sera
 * lent. qwen3:4b y tient. » — second sentence only when a model fits. */
export function sharedModelNoticeText(entry, grouped, t) {
  const first = t("panel_shared_model_note", [shortModelName(entry.model)]);
  const alt = alternativeTo(entry, grouped);
  return alt ? `${first} ${t("panel_shared_model_alt", [shortModelName(alt.model)])}` : first;
}

/** Waiting line with the sniffing coati head: an animated WebP (still PNG
 * under prefers-reduced-motion), shown for at most COATI_VISIBLE_MS and then
 * removed — the slot it sat in stays reserved so the row doesn't jump.
 * `startedAt`/`now`: see coatiVisible(). */
export function buildProgress(doc, { stage, readsPage, t, iconSrc, iconStillSrc, reducedMotion, startedAt, now }) {
  const wrap = doc.createElement("div");
  wrap.className = "message-progress";
  wrap.dataset.stage = stage;
  const slot = doc.createElement("span");
  slot.className = "message-progress-icon-slot";
  if (coatiVisible(startedAt, now)) {
    const icon = doc.createElement("img");
    icon.className = "message-progress-coati";
    icon.src = reducedMotion ? iconStillSrc : iconSrc;
    icon.alt = "";
    icon.width = 32;
    icon.height = 32;
    slot.append(icon);
  }
  const body = doc.createElement("span");
  body.className = "message-progress-body";
  const label = doc.createElement("span");
  label.className = "message-progress-text";
  label.textContent = t(progressKey(stage, readsPage));
  body.append(label);
  // Thinking-only models reason for minutes: say why it takes longer.
  if (stage === "thinking") {
    const hint = doc.createElement("span");
    hint.className = "message-progress-hint";
    hint.textContent = t("panel_progress_thinking_hint");
    body.append(hint);
  }
  wrap.append(slot, body);
  return wrap;
}

/**
 * The tip under the answer: one sentence, then « Passer à … » (when a model
 * fits) and « Accélérer Ollama ».
 * @param {{suggest: string|null}} tip
 * @param {{t: Function, onSwitch: (model: string) => void, onSpeedup: () => void, canSwitch: boolean}} opts
 */
export function buildSlowTip(doc, tip, { t, onSwitch, onSpeedup, canSwitch }) {
  const wrap = doc.createElement("div");
  wrap.className = "slow-tip";
  wrap.setAttribute("role", "note");
  const text = doc.createElement("p");
  text.className = "slow-tip-text";
  const name = tip.suggest ? shortModelName(tip.suggest) : "";
  text.textContent = tip.suggest ? t("panel_slow_tip_switch_text", [name]) : t("panel_slow_tip_speedup_text");
  const actions = doc.createElement("div");
  actions.className = "slow-tip-actions";
  if (tip.suggest && canSwitch) {
    const switchButton = doc.createElement("button");
    switchButton.type = "button";
    switchButton.className = "slow-tip-action";
    switchButton.textContent = t("panel_slow_tip_switch_action", [name]);
    switchButton.title = tip.suggest;
    switchButton.addEventListener("click", () => onSwitch(tip.suggest));
    actions.append(switchButton);
  }
  const speedup = doc.createElement("button");
  speedup.type = "button";
  speedup.className = "slow-tip-action";
  speedup.textContent = t("panel_slow_tip_speedup_action");
  speedup.addEventListener("click", () => onSpeedup());
  actions.append(speedup);
  wrap.append(text, actions);
  return wrap;
}
