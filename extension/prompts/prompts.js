// "Mes prompts" page — plan-mes-prompts-28-09.md, lot 4. Full-page grid, one
// case per site, talking to the broker through the service worker exactly
// like options.js (coati:client-message / coati:broker-message / coati:get-
// status / coati:status — see extension/options.js:84-99). textContent only,
// never innerHTML (CLAUDE.md security rule #3): all prompt text ultimately
// comes from a stored value the user or a page extraction produced.

import { api } from "../lib/browser-compat.js";
import { SITES, permissionPatternsFor } from "../lib/suggestions-data.js";
import { armOrConfirm } from "../panel/confirm-arm.js";
import { ALL_SITES_ORIGINS } from "../panel/read-button.js";
import Sortable from "../vendor/sortable/sortable.esm.js";
import { coatiItemsForSite, computeCaseItems as computeCaseItemsPure, buildCaseDescriptors as buildCaseDescriptorsPure, replaceInOrder } from "./prompts-cases.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n(document);

// How long a delete stays "armed" (confirm-arm.js) before disarming itself —
// no value is specified anywhere else in the plan; picked to match a
// comfortable double-click-ish window without becoming a trap. Assumption,
// recorded in the mission report.
const ARM_TIMEOUT_MS = 4000;

// --- "Tous les sites" (docs/DECISIONS.md T42, amendement 2026-09-30 bis) ---
// User-facing strings grouped here, from _locales/<lang>/messages.json.
const ALL_SITES_TEXT = {
  line: t("prompts_all_sites_line"),
  revoke: t("prompts_all_sites_revoke"),
};

const els = {
  connectionBanner: document.getElementById("connectionBanner"),
  connectionBannerText: document.getElementById("connectionBannerText"),
  board: document.getElementById("board"),
  allSitesNotice: document.getElementById("allSitesNotice"),
  allSitesText: document.getElementById("allSitesText"),
  allSitesRevoke: document.getElementById("allSitesRevoke"),
};

// True while the optional "all sites" host permission is held (granted from
// the panel's "Lire cette page" button, T50). A per-site pattern can't be
// removed from under that broader grant, so the per-site switches then show
// "on", locked, and the one way back is the notice's own button.
let allSitesGranted = false;

// --- State -------------------------------------------------------------
// `prompts`/`prefsSites` mirror the broker exactly (docs/PROTOCOL.md
// "Bibliothèque de prompts et préférences par site") — every reducer below
// reads from these two and writes through a coati:client-message; the actual
// mutation only lands once the corresponding broadcast comes back in
// onRuntimeMessage(), which is also what every OTHER open Coati page
// (including this one) reacts to, so two open tabs of "Mes prompts" stay in
// sync for free.
let prompts = [];
let prefsSites = {};
let connectionState = "unknown";

// The single row currently expanded for editing, or null. `isCoati` tracks
// whether saving must go through the "convert a suggestion into a prompt"
// path (docs/PROTOCOL.md prompts.save + prefs.set) instead of a plain
// prompts.save on an existing id.
let editing = null;

let armedDeleteKey = null;
let armedDeleteTimer = null;

// One SortableJS instance per rendered case `<ul>`, torn down and rebuilt on
// every render() — simplest way to keep the DOM, the list contents and the
// drag targets consistent with each other.
const caseSortables = new Map();

// Requests awaiting a specific reply id, alongside the "apply whatever
// broadcast arrives" behaviour every prompts/prefs message already gets
// (FACTS: "Apply EVERY prompts/prefs broadcast you see, so the page stays in
// sync with the panel's disquette").
const pendingResolvers = new Map();

function nextId() {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendClientMessage(payload) {
  return new Promise((resolve) => {
    pendingResolvers.set(payload.id, resolve);
    api.runtime.sendMessage({ type: "coati:client-message", payload }).catch(() => {
      pendingResolvers.delete(payload.id);
      resolve(null);
    });
  });
}

function resolvePending(id) {
  const resolve = pendingResolvers.get(id);
  if (resolve) {
    pendingResolvers.delete(id);
    resolve(true);
  }
}

function prefsSet(site, prefs) {
  return sendClientMessage({ type: "prefs.set", id: nextId(), site, prefs });
}

init();

async function init() {
  api.runtime.onMessage.addListener(onRuntimeMessage);
  els.allSitesText.textContent = ALL_SITES_TEXT.line;
  els.allSitesRevoke.textContent = ALL_SITES_TEXT.revoke;
  els.allSitesRevoke.addEventListener("click", revokeAllSites);
  api.permissions.onAdded.addListener(refreshAllActiveSwitches);
  api.permissions.onRemoved.addListener(refreshAllActiveSwitches);
  await refreshAllActiveSwitches();
  const status = await api.runtime.sendMessage({ type: "coati:get-status" }).catch(() => null);
  applyStatus(status?.state ?? "unknown");
  requestAll();
}

function requestAll() {
  sendClientMessage({ type: "prompts.list", id: nextId() });
  sendClientMessage({ type: "prefs.get", id: nextId() });
}

function onRuntimeMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "coati:status") {
    applyStatus(message.state);
    if (message.state === "connected") requestAll();
    return;
  }

  if (message.type !== "coati:broker-message") return;
  const msg = message.message;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "prompts") {
    prompts = Array.isArray(msg.items) ? msg.items : [];
    // prompts.move's reply also carries the full prefs (docs/PROTOCOL.md) —
    // folded in here too, same as the panel does.
    if (msg.prefs && typeof msg.prefs === "object" && msg.prefs.sites) {
      prefsSites = msg.prefs.sites;
    }
    resolvePending(msg.id);
    render();
  } else if (msg.type === "prefs") {
    prefsSites = msg.sites && typeof msg.sites === "object" ? msg.sites : {};
    resolvePending(msg.id);
    render();
  }
}

function applyStatus(state) {
  connectionState = state;
  applyConnectionBanner(state);
}

// Same two states, same wording style as options.js's disconnected model
// section ("Broker non connecté — impossible d'afficher ou de changer le
// fournisseur de modèle.") — this page has nothing to show or edit without
// the broker either.
function applyConnectionBanner(state) {
  if (state === "no-token") {
    els.connectionBannerText.textContent = t("prompts_banner_no_token");
    els.connectionBanner.hidden = false;
    return;
  }
  if (state === "disconnected") {
    els.connectionBannerText.textContent = t("prompts_banner_disconnected");
    els.connectionBanner.hidden = false;
    return;
  }
  els.connectionBanner.hidden = true;
}

// --- Derived data --------------------------------------------------------
// Thin wrappers over prompts-cases.js's pure functions, closing over this
// module's current `prompts`/`prefsSites`/SITES — the pure functions
// themselves take everything as arguments so they're unit-testable without
// any DOM (see broker/test/ui-prompts-page.test.ts).

function computeCaseItems(siteKey) {
  return computeCaseItemsPure({ siteKey, prompts, prefsSites, sites: SITES });
}

function buildCaseDescriptors() {
  return buildCaseDescriptorsPure({ prompts, sites: SITES });
}

function isDirty(entry) {
  return entry.title !== entry.originalTitle || entry.body !== entry.originalBody;
}

// --- Rendering -------------------------------------------------------------

function render() {
  // A stale editor (its item deleted from elsewhere) never lingers.
  if (editing && !computeCaseItems(editing.site).some((item) => item.key === editing.key)) {
    editing = null;
  }

  destroySortables();
  els.board.textContent = "";

  for (const descriptor of buildCaseDescriptors()) {
    if (descriptor.kind === "head") {
      els.board.appendChild(buildHeadCaseElement());
      continue;
    }
    const items = computeCaseItems(descriptor.key);
    if (!descriptor.alwaysShow && items.length === 0) continue;
    els.board.appendChild(buildCaseElement(descriptor, items));
  }

  initSortables();
  refreshAllActiveSwitches();

  if (editing) {
    const textarea = document.getElementById("promptEditorBody");
    if (textarea) textarea.focus();
  }
}

// The `<ul>` a SortableJS instance attaches to — one per site key, whether
// it lives inside a plain site case or inside one of the head case's two
// parts (initSortables() below finds every `.prompt-case-list` on the
// board regardless of which case wraps it).
function buildRowsList(siteKey, items) {
  const list = document.createElement("ul");
  list.className = "prompt-case-list";
  list.dataset.site = siteKey;
  items.forEach((item, index) => {
    list.appendChild(buildRowElement(siteKey, item, index, items.length));
  });
  return list;
}

// Head case (plan-activation-28-09.md, "Points tranchés" 1, Romain's
// correction at goal launch): full board width, coloured background, NO
// case title of its own — two parts instead:
//   - "*" ("Sur tous les sites"): the only heading in the case, always
//     shown (heading + muted empty line when empty, same as any other
//     always-shown case);
//   - "@unsorted" (prompts saved on a page whose address Coati couldn't
//     see): no heading, no label at all, and no zone rendered when empty —
//     not even the thin rule that otherwise separates it from the first
//     part. The literal string "@unsorted" never reaches the DOM.
function buildHeadCaseElement() {
  const section = document.createElement("section");
  section.className = "prompt-case prompt-case--head";

  const parts = document.createElement("div");
  parts.className = "prompt-case-head-parts";

  const part1 = document.createElement("div");
  part1.className = "prompt-case-head-part";
  const heading = document.createElement("h2");
  heading.className = "prompt-case-title";
  heading.textContent = t("prompts_all_sites_heading");
  part1.appendChild(heading);

  const part1Items = computeCaseItems("*");
  if (part1Items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "prompt-case-empty";
    empty.textContent = t("prompts_empty");
    part1.appendChild(empty);
  }
  part1.appendChild(buildRowsList("*", part1Items));
  parts.appendChild(part1);

  const part2Items = computeCaseItems("@unsorted");
  if (part2Items.length > 0) {
    const rule = document.createElement("div");
    rule.className = "prompt-case-head-rule";
    rule.setAttribute("aria-hidden", "true");
    parts.appendChild(rule);

    const part2 = document.createElement("div");
    part2.className = "prompt-case-head-part";
    part2.appendChild(buildRowsList("@unsorted", part2Items));
    parts.appendChild(part2);
  }

  section.appendChild(parts);
  return section;
}

function buildCaseElement(descriptor, items) {
  const section = document.createElement("section");
  section.className = "prompt-case";
  section.dataset.site = descriptor.key;

  const headRow = document.createElement("div");
  headRow.className = "prompt-case-head-row";
  const heading = document.createElement("h2");
  heading.className = "prompt-case-title";
  heading.textContent = descriptor.title;
  headRow.appendChild(heading);
  headRow.appendChild(buildActiveSwitch(descriptor.key));
  section.appendChild(headRow);

  const list = buildRowsList(descriptor.key, items);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "prompt-case-empty";
    empty.textContent = t("prompts_empty");
    section.appendChild(empty);
  }
  section.appendChild(list);

  const removedCount = (prefsSites[descriptor.key]?.removed ?? []).length;
  if (coatiItemsForSite(SITES, descriptor.key).length > 0 && removedCount > 0) {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "prompt-case-restore";
    restore.textContent = t("prompts_restore_suggestions");
    restore.addEventListener("click", () => prefsSet(descriptor.key, { removed: [] }));
    section.appendChild(restore);
  }

  return section;
}

// --- "Actif" switch (plan-activation-28-09.md, "Points tranchés" 2) -------
// One per SITE case (popular or user's own) — never in the head case, which
// has no single site key to activate. Same `role="switch"` button shape as
// the panel's "Lire la page" (extension/panel/panel.html:36-39), duplicated
// rather than imported: this page has no build step to share a partial
// (same rationale as prompts.css's .connection-banner comment).

function buildActiveSwitch(siteKey) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "switch prompt-case-switch";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", "false");
  btn.dataset.site = siteKey;

  const track = document.createElement("span");
  track.className = "switch-track";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  thumb.className = "switch-thumb";
  track.appendChild(thumb);

  const text = document.createElement("span");
  text.className = "switch-text";
  text.textContent = t("prompts_active_switch");

  btn.appendChild(track);
  btn.appendChild(text);
  btn.addEventListener("click", () => handleActiveSwitchClick(btn));
  return btn;
}

// Click is the user gesture chrome.permissions.request needs — the request
// (or remove) call below happens synchronously off this handler, before any
// await, exactly like panel.js's onReadPageClick().
function handleActiveSwitchClick(btn) {
  if (btn.getAttribute("aria-disabled") === "true") return; // locked under "all sites"
  const siteKey = btn.dataset.site;
  const patterns = permissionPatternsFor(siteKey);
  if (patterns.length === 0) return;
  if (btn.getAttribute("aria-checked") === "true") {
    api.permissions
      .remove({ origins: patterns })
      .catch(() => {})
      .then(() => refreshActiveSwitch(btn));
  } else {
    api.permissions
      .request({ origins: patterns })
      .catch(() => false) // refused -> stays off, no error UI (plan-activation-28-09.md)
      .then(() => refreshActiveSwitch(btn));
  }
}

async function refreshActiveSwitch(btn) {
  // aria-disabled, not `disabled`: the switch stays focusable, so its
  // accessible description (the notice line) is still announced.
  if (allSitesGranted) {
    btn.setAttribute("aria-checked", "true");
    btn.classList.add("switch--on");
    btn.setAttribute("aria-disabled", "true");
    btn.setAttribute("aria-describedby", "allSitesText");
    return;
  }
  btn.removeAttribute("aria-disabled");
  btn.removeAttribute("aria-describedby");
  const patterns = permissionPatternsFor(btn.dataset.site);
  const granted = patterns.length > 0 && (await api.permissions.contains({ origins: patterns }).catch(() => false));
  if (allSitesGranted) return; // granted meanwhile — the branch above already ran
  btn.setAttribute("aria-checked", String(granted));
  btn.classList.toggle("switch--on", granted);
}

// Re-read the "all sites" grant and every switch, on load and on
// permissions.onAdded/onRemoved (the panel's read button grants too, and
// this page must reflect that).
async function refreshAllActiveSwitches() {
  allSitesGranted = await api.permissions.contains({ origins: ALL_SITES_ORIGINS }).catch(() => false);
  els.allSitesNotice.hidden = !allSitesGranted;
  els.board.querySelectorAll(".prompt-case-switch").forEach((btn) => refreshActiveSwitch(btn));
}

// "Revenir au site par site": drops only the two "all sites" patterns —
// per-site grants made earlier stay exactly as they were.
function revokeAllSites() {
  api.permissions
    .remove({ origins: ALL_SITES_ORIGINS })
    .catch(() => false)
    .then(() => refreshAllActiveSwitches());
}

function buildRowElement(caseKey, item, index, total) {
  const row = document.createElement("li");
  row.className = "prompt-row";
  row.dataset.key = item.key;
  row.dataset.kind = item.kind;
  const isEditingThis = editing && editing.key === item.key;
  if (isEditingThis) row.classList.add("is-editing");

  const main = document.createElement("div");
  main.className = "prompt-row-main";

  const handle = document.createElement("span");
  handle.className = "prompt-handle";
  handle.setAttribute("aria-hidden", "true");
  handle.textContent = "⠿";
  main.appendChild(handle);

  const isAction = item.kind === "coati" && Boolean(item.action);
  let label;
  if (isAction) {
    // YouTube's "Résumer cette vidéo" — not a stored prompt, nothing to
    // expand (FACTS: "not editable (no expand)"), but still movable/deletable.
    label = document.createElement("span");
    label.className = "prompt-row-label prompt-row-label--static";
    label.title = t("prompts_action_title");
  } else {
    label = document.createElement("button");
    label.type = "button";
    label.className = "prompt-row-label";
    label.addEventListener("click", () => openEditor(caseKey, item));
  }
  label.textContent = item.label;
  main.appendChild(label);

  const controls = document.createElement("div");
  controls.className = "prompt-row-controls";

  const up = document.createElement("button");
  up.type = "button";
  up.className = "prompt-row-up";
  up.textContent = "▲";
  up.setAttribute("aria-label", t("prompts_move_up_aria", [item.label]));
  up.disabled = index === 0;
  up.addEventListener("click", () => moveWithinCase(caseKey, item.key, -1));
  controls.appendChild(up);

  const down = document.createElement("button");
  down.type = "button";
  down.className = "prompt-row-down";
  down.textContent = "▼";
  down.setAttribute("aria-label", t("prompts_move_down_aria", [item.label]));
  down.disabled = index === total - 1;
  down.addEventListener("click", () => moveWithinCase(caseKey, item.key, 1));
  controls.appendChild(down);

  const del = document.createElement("button");
  del.type = "button";
  const armed = armedDeleteKey === item.key;
  del.className = armed ? "prompt-row-delete is-armed" : "prompt-row-delete";
  del.textContent = armed ? t("prompts_delete_confirm") : "🗑";
  del.setAttribute(
    "aria-label",
    armed ? t("prompts_delete_confirm_aria", [item.label]) : t("prompts_delete_aria", [item.label]),
  );
  del.addEventListener("click", () => handleDeleteClick(caseKey, item));
  controls.appendChild(del);

  main.appendChild(controls);
  row.appendChild(main);

  if (isEditingThis) row.appendChild(buildEditorElement());

  return row;
}

function buildEditorElement() {
  const wrap = document.createElement("div");
  wrap.className = "prompt-editor";

  const titleLabel = document.createElement("label");
  titleLabel.textContent = t("prompts_editor_title_label");
  titleLabel.htmlFor = "promptEditorTitle";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.id = "promptEditorTitle";
  titleInput.value = editing.title;
  titleInput.addEventListener("input", () => {
    editing.title = titleInput.value;
  });
  titleInput.addEventListener("keydown", handleEditorKeydown);

  const bodyLabel = document.createElement("label");
  bodyLabel.textContent = t("prompts_editor_body_label");
  bodyLabel.htmlFor = "promptEditorBody";
  const bodyInput = document.createElement("textarea");
  bodyInput.id = "promptEditorBody";
  bodyInput.value = editing.body;

  const actions = document.createElement("div");
  actions.className = "prompt-editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "is-secondary";
  cancel.textContent = t("panel_cancel");
  cancel.addEventListener("click", () => closeEditor());
  const save = document.createElement("button");
  save.type = "button";
  save.className = "is-primary";
  save.textContent = t("options_save");
  save.addEventListener("click", () => commitEditor());
  const updateSaveDisabled = () => {
    save.disabled = bodyInput.value.trim().length === 0;
  };
  updateSaveDisabled();
  bodyInput.addEventListener("input", () => {
    editing.body = bodyInput.value;
    updateSaveDisabled();
  });
  bodyInput.addEventListener("keydown", handleEditorKeydown);

  actions.appendChild(cancel);
  actions.appendChild(save);

  wrap.appendChild(titleLabel);
  wrap.appendChild(titleInput);
  wrap.appendChild(bodyLabel);
  wrap.appendChild(bodyInput);
  wrap.appendChild(actions);
  return wrap;
}

function handleEditorKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    commitEditor();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeEditor();
  }
}

// --- Editor lifecycle --------------------------------------------------

function openEditor(caseKey, item) {
  if (editing) {
    if (editing.key === item.key) return; // already open
    // "unsaved text is never lost silently — opening another row while
    // dirty keeps the first open" (plan-mes-prompts-28-09.md).
    if (isDirty(editing)) return;
  }
  editing = {
    key: item.key,
    site: caseKey,
    isCoati: item.kind === "coati",
    // A Coati suggestion opens with its label as the title: saving it
    // unchanged must keep the button's name (« Points clés minutés »), not
    // fall back to the start of the text (admin fix, 28/09).
    title: item.kind === "user" ? item.title ?? "" : item.label ?? "",
    body: item.body ?? "",
    originalTitle: item.kind === "user" ? item.title ?? "" : item.label ?? "",
    originalBody: item.body ?? "",
  };
  render();
}

function closeEditor() {
  editing = null;
  render();
}

function commitEditor() {
  if (!editing) return;
  if (editing.body.trim().length === 0) return; // prompts.save requires a non-empty body
  if (editing.isCoati) saveEditingCoatiPrompt();
  else saveEditingUserPrompt();
}

async function saveEditingUserPrompt() {
  const { key, site, title, body } = editing;
  await sendClientMessage({
    type: "prompts.save",
    id: nextId(),
    prompt: { id: key, site, title: title.trim(), body: body.trim() },
  });
  closeEditor();
}

// Converting a Coati suggestion into a user prompt (docs/PROTOCOL.md,
// plan-mes-prompts-28-09.md lot 4, point 5): create the prompt, then replace
// the suggestion's id with the new prompt's id at the very same spot in the
// case's order, and mark the suggestion removed — two awaited round trips,
// in that order, so prefs.json only ever describes a state that already
// matches prompts-v2.json.
async function saveEditingCoatiPrompt() {
  const { site, title, body, key: coatiId } = editing;
  const beforeIds = new Set(prompts.map((p) => p.id));
  await sendClientMessage({
    type: "prompts.save",
    id: nextId(),
    prompt: { site, title: title.trim(), body: body.trim() },
  });
  const created = prompts.find((p) => !beforeIds.has(p.id));
  if (!created) {
    closeEditor();
    return;
  }
  const order = replaceInOrder(
    computeCaseItems(site).map((entry) => entry.key),
    coatiId,
    created.id,
  );
  const removed = [...(prefsSites[site]?.removed ?? [])];
  if (!removed.includes(coatiId)) removed.push(coatiId);
  await prefsSet(site, { order, removed });
  closeEditor();
}

// --- Reorder / delete ----------------------------------------------------

function moveWithinCase(siteKey, key, direction) {
  const keys = computeCaseItems(siteKey).map((entry) => entry.key);
  const index = keys.indexOf(key);
  const swapIndex = index + direction;
  if (index < 0 || swapIndex < 0 || swapIndex >= keys.length) return;
  [keys[index], keys[swapIndex]] = [keys[swapIndex], keys[index]];
  prefsSet(siteKey, { order: keys });
}

function handleDeleteClick(caseKey, item) {
  const result = armOrConfirm(armedDeleteKey, item.key);
  if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
  armedDeleteKey = result.armed;
  if (result.armed) {
    armedDeleteTimer = setTimeout(() => {
      armedDeleteKey = null;
      render();
    }, ARM_TIMEOUT_MS);
  }
  if (result.confirmed) performDelete(caseKey, item);
  render();
}

function performDelete(caseKey, item) {
  if (item.kind === "user") {
    sendClientMessage({ type: "prompts.delete", id: nextId(), promptId: item.key });
    return;
  }
  const removed = [...(prefsSites[caseKey]?.removed ?? [])];
  if (!removed.includes(item.key)) removed.push(item.key);
  prefsSet(caseKey, { removed });
}

// --- Drag and drop (SortableJS, extension/vendor/sortable/) ---------------

function initSortables() {
  els.board.querySelectorAll(".prompt-case-list").forEach((list) => {
    const instance = new Sortable(list, {
      group: {
        name: "prompts",
        // A Coati suggestion may reorder within its own case but never leave
        // it — only the case's user prompts can move to another site.
        pull: (to, from, dragEl) => dragEl.dataset.kind !== "coati",
        put: true,
      },
      handle: ".prompt-handle",
      animation: 150,
      onEnd: handleDragEnd,
    });
    caseSortables.set(list.dataset.site, instance);
  });
}

function destroySortables() {
  caseSortables.forEach((instance) => instance.destroy());
  caseSortables.clear();
}

function handleDragEnd(evt) {
  const fromSite = evt.from.dataset.site;
  const toSite = evt.to.dataset.site;
  const itemKey = evt.item.dataset.key;
  const order = [...evt.to.children].map((li) => li.dataset.key);

  if (fromSite === toSite) {
    prefsSet(toSite, { order });
    return;
  }
  // Cross-case: only reachable by a user prompt (Coati items refuse to be
  // pulled out, see the `pull` function above). prompts.move updates the
  // source case's order server-side — no separate call needed for it.
  sendClientMessage({ type: "prompts.move", id: nextId(), promptId: itemKey, site: toSite, order });
}
