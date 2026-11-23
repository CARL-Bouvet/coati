// Slow local model advice (4 and 6):
// the "Loading the model…" / "The model is reading the page…" line shown in
// the pending answer before its first word, the calm line shown when a
// "shared" model is picked, and the tip under a slow or cut answer.
//
// No i18n import on purpose (same as lib/model-list.js): the pure helpers
// are unit-tested under bun, and the builders receive `t` from panel.js.
// Security rule 3: every node is built with createElement/textContent —
// model names come from the local program, never inserted as markup.
import { isSlowLocalModel, shortModelName } from "../lib/model-list.js";

/** A first word later than this, on a model that doesn't fit the card,
 * earns the tip under the answer. */
export const SLOW_FIRST_WORD_MS = 30_000;

/** Options page anchor of the "Speed up Ollama" block (options.js). */
export const OLLAMA_SPEEDUP_PATH = "options.html#setup-ollama-speedup";

/** "loading" | "reading" | "thinking" | null — the only stages the panel
 * draws ("thinking": a thinking-only model reasoning before its first word). */
export function readProgressStage(stage) {
  return stage === "loading" || stage === "reading" || stage === "thinking" ? stage : null;
}

/** Locale key of the waiting line. `readsPage`: the request carries the
 * page (summarize, chat with the page attached) — else "your request". */
export function progressKey(stage, readsPage) {
  if (stage === "loading") return "panel_progress_loading";
  if (stage === "thinking") return "panel_progress_thinking";
  return readsPage ? "panel_progress_reading_page" : "panel_progress_reading_request";
}

/** true when a slow or cut answer earns the tip (only Ollama models get one). */
export function slowTipFor(entry) {
  return entry?.provider === "ollama";
}

/** true when the first word came late on a model that doesn't fit the card. */
export function isSlowFirstWord(elapsedMs, entry) {
  return elapsedMs > SLOW_FIRST_WORD_MS && isSlowLocalModel(entry);
}

/** "qwen3:8b doesn't fully fit in the graphics card: it will be slow." */
export function sharedModelNoticeText(entry, t) {
  return t("panel_shared_model_note", [shortModelName(entry.model)]);
}

/** Waiting line: what the model is doing, and why thinking takes longer. */
export function buildProgress(doc, { stage, readsPage, t }) {
  const wrap = doc.createElement("div");
  wrap.className = "message-progress";
  wrap.dataset.stage = stage;
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
  wrap.append(body);
  return wrap;
}

/** The tip under the answer: one sentence and a "Speed up Ollama" button. */
export function buildSlowTip(doc, { t, onSpeedup }) {
  const wrap = doc.createElement("div");
  wrap.className = "slow-tip";
  wrap.setAttribute("role", "note");
  const text = doc.createElement("p");
  text.className = "slow-tip-text";
  text.textContent = t("panel_slow_tip_speedup_text");
  const actions = doc.createElement("div");
  actions.className = "slow-tip-actions";
  const speedup = doc.createElement("button");
  speedup.type = "button";
  speedup.className = "slow-tip-action";
  speedup.textContent = t("panel_slow_tip_speedup_action");
  speedup.addEventListener("click", () => onSpeedup());
  actions.append(speedup);
  wrap.append(text, actions);
  return wrap;
}
