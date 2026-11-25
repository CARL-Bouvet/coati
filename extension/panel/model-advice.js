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

/** "40 s" / "2 min 05 s" — how long the current stage has lasted. */
export function elapsedText(ms, t) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return t("panel_limits_elapsed_sec", [String(total)]);
  return t("panel_limits_elapsed_min", [String(Math.floor(total / 60)), String(total % 60).padStart(2, "0")]);
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

/** The ticking time span, refreshed in place by message-render.js. */
export function buildElapsed(doc, text) {
  const el = doc.createElement("span");
  el.className = "message-elapsed";
  el.textContent = text;
  return el;
}

/** `s` without its trailing ellipsis ("Loading the model…" -> "Loading the model"). */
export const withoutEllipsis = (s) => s.replace(/…$/, "");

/** Waiting line before the first word: the current activity with its elapsed
 * time on the right, the reading/search/open `status` (already without
 * ellipsis) and, for a thinking-only model, why it takes longer. The model
 * `stage` leads when known, else `status` does. */
export function buildProgress(doc, { stage, status, readsPage, t, elapsed }) {
  const wrap = doc.createElement("div");
  wrap.className = "message-progress";
  if (stage) wrap.dataset.stage = stage;
  const body = doc.createElement("div");
  body.className = "message-progress-body";
  const main = doc.createElement("p");
  main.className = "message-progress-text";
  main.textContent = stage ? withoutEllipsis(t(progressKey(stage, readsPage))) : (status ?? "");
  // Cut at two lines: a long search query stays whole on hover.
  main.title = main.textContent;
  body.append(main);
  const addNote = (text) => {
    const note = doc.createElement("p");
    note.className = "message-progress-note";
    note.textContent = text;
    body.append(note);
  };
  if (stage && status) addNote(status);
  if (stage === "thinking") addNote(t("panel_progress_thinking_hint"));
  wrap.append(body);
  if (elapsed !== undefined) wrap.append(buildElapsed(doc, elapsed));
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
