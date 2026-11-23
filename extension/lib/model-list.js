// Shared "available models" list (goal "model visible", lots 2 + 3).
// One source — the local program's `models` reply to `models.list`
// (docs/PROTOCOL.md) — rendered the same way in three
// places: the panel's model menu (next to "Connected"), the tutorial step
// "Download a model" and the "Model" section of the settings page.
//
// No i18n import on purpose: the pure helpers below are unit-tested under
// bun without a browser, and the renderer receives `t` / `providerLabel`
// from its caller (each page already imports lib/i18n-page.js and
// lib/labels.js). setup-data.js is pure data, safe to import here.
import { getProviderLinks, LM_STUDIO } from "./setup-data.js";
//
// Security rule 3: every node is built with createElement/textContent —
// model names come from the local program, never inserted as markup.

/** Same model, tolerating Ollama's implicit ":latest" tag. */
export function sameModel(a, b) {
  if (!a || !b) return false;
  const norm = (name) => (name.includes(":") ? name : `${name}:latest`);
  return norm(a) === norm(b);
}

/** Name shown to a human: no ":latest", no "vendor/" prefix (OpenRouter-style
 * ids), Claude ids as family and version ("claude-sonnet-5-5" -> "Sonnet 5.5").
 * The full id stays available as a tooltip. */
export function shortModelName(model) {
  if (typeof model !== "string" || !model) return "";
  let name = model.endsWith(":latest") ? model.slice(0, -":latest".length) : model;
  const slash = name.lastIndexOf("/");
  if (slash !== -1 && slash < name.length - 1) name = name.slice(slash + 1);
  const claude = name.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return name;
}

/** Decimal gigabytes (what Ollama and ollama.com print), one decimal, or
 * null when the size is unknown. */
export function sizeInGb(bytes) {
  if (typeof bytes !== "number" || !(bytes > 0)) return null;
  return Math.round(bytes / 1e8) / 10;
}

// --- Machine capacity -------------------------------------------------
//
// COPY of the local program's rule, docs/PROTOCOL.md,
// "Machine capacity and `fit` classification" (broker/src/host.ts,
// FIT_CONSTANTS / computeFit). The local program classifies INSTALLED
// models; the extension needs the same verdict for models not downloaded
// yet (tutorial suggestions). Change both together.
export const FIT_CONSTANTS = {
  OVERHEAD_BYTES: 1.5 * 1e9,
  UNIFIED_RAM_FRACTION: 0.75,
  RAM_SUPPLEMENT_FRACTION: 0.5,
  CPU_RAM_FRACTION: 0.5,
};

/** A usable `host` from a `models` reply, or null (older local program). */
export function readHost(host) {
  if (!host || typeof host !== "object" || typeof host.ramGb !== "number" || !(host.ramGb > 0)) return null;
  return {
    ramGb: host.ramGb,
    vramGb: typeof host.vramGb === "number" && host.vramGb > 0 ? host.vramGb : null,
    unifiedMemory: host.unifiedMemory === true,
  };
}

/** Largest model file (bytes) that fits the graphics card (`gpu`) and that
 * still runs, partly in memory (`shared`). 0 = nothing of that kind fits. */
function fitLimitsBytes(host) {
  const ram = host.ramGb * 1e9;
  const overhead = FIT_CONSTANTS.OVERHEAD_BYTES;
  if (host.unifiedMemory) {
    const gpu = Math.max(0, FIT_CONSTANTS.UNIFIED_RAM_FRACTION * ram - overhead);
    return { gpu, shared: gpu };
  }
  if (host.vramGb !== null) {
    const vram = host.vramGb * 1e9;
    return {
      gpu: Math.max(0, vram - overhead),
      shared: Math.max(0, vram + FIT_CONSTANTS.RAM_SUPPLEMENT_FRACTION * ram - overhead),
    };
  }
  return { gpu: 0, shared: Math.max(0, FIT_CONSTANTS.CPU_RAM_FRACTION * ram - overhead) };
}

/** "gpu" | "shared" | "too-big" — same rule as the local program. */
export function classifyFit(sizeBytes, host) {
  const limits = fitLimitsBytes(host);
  if (sizeBytes <= limits.gpu) return "gpu";
  return sizeBytes <= limits.shared ? "shared" : "too-big";
}

/** The same limits in decimal GB, rounded down to 0.1, for the settings
 * page ("a model up to about N GB"). */
export function fitLimitsGb(host) {
  const { gpu, shared } = fitLimitsBytes(host);
  const floorGb = (bytes) => Math.floor(bytes / 1e8) / 10;
  return { gpu: floorGb(gpu), shared: floorGb(shared) };
}

/** Locale key of the plain-words fit note, or null. A measured GPU share
 * (`gpuPercent`, loaded model only) wins over the estimate. */
export function fitNoteKey(entry) {
  if (typeof entry?.gpuPercent === "number") return "model_fit_loaded_percent";
  if (entry?.fit === "gpu") return "model_fit_gpu";
  if (entry?.fit === "shared") return "model_fit_shared";
  if (entry?.fit === "too-big") return "model_fit_too_big";
  return null;
}

/** true when `entry` is a local Ollama model that doesn't fully fit the
 * graphics card — slow. A
 * measured GPU share (loaded model) wins over the estimate. */
export function isSlowLocalModel(entry) {
  if (entry?.provider !== "ollama" || entry.local !== true) return false;
  if (typeof entry.gpuPercent === "number") return entry.gpuPercent < 100;
  return entry.fit === "shared" || entry.fit === "too-big";
}

/** `{id: label}` from a `settings` message's `available` list — the only
 * place a module (an id lib/labels.js doesn't know, e.g. claude-cli) gets
 * its human name. */
export function moduleLabelsFrom(settings) {
  const labels = {};
  for (const provider of Array.isArray(settings?.available) ? settings.available : []) {
    if (typeof provider?.id === "string" && typeof provider.label === "string" && provider.label) {
      labels[provider.id] = provider.label;
    }
  }
  return labels;
}

/**
 * Human name of an entry's provider, never the raw id: the service name
 * from openai-compat's address when it is known (OpenRouter, Mistral…, as
 * the panel's status line does; LM Studio for its local preset), the
 * built-in label (lib/labels.js), the module's own label from `settings`,
 * else `fallback`.
 * @param {(id: string, fallback?: string) => string} providerLabel
 */
export function providerDisplayName(providerId, { providerLabel, moduleLabels, baseUrl, fallback }) {
  if (providerId === "openai-compat" && baseUrl) {
    if (baseUrl === LM_STUDIO.baseUrl) return "LM Studio";
    const service = getProviderLinks(providerId, baseUrl);
    if (service) return service.name;
  }
  const label = providerLabel(providerId, moduleLabels?.[providerId]);
  return label && label !== providerId ? label : fallback;
}

function isEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    value.model !== ""
  );
}

/**
 * Normalises a `models` reply into what every view needs.
 * @returns {{
 *   current: {provider: string|null, model: string|null},
 *   currentEntry: object|null,
 *   local: object[], online: object[],
 *   ollamaUnreachable: boolean,
 * }}
 */
export function groupModels(reply) {
  const current = {
    provider: typeof reply?.current?.provider === "string" ? reply.current.provider : null,
    model: typeof reply?.current?.model === "string" && reply.current.model ? reply.current.model : null,
  };
  const entries = Array.isArray(reply?.entries) ? reply.entries.filter(isEntry) : [];
  const marked = entries.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    local: entry.local === true,
    sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : undefined,
    thinks: entry.thinks === true,
    fit: ["gpu", "shared", "too-big"].includes(entry.fit) ? entry.fit : undefined,
    gpuPercent:
      typeof entry.gpuPercent === "number" && entry.gpuPercent >= 0 && entry.gpuPercent <= 100
        ? Math.round(entry.gpuPercent)
        : undefined,
    contextTokens:
      Number.isInteger(entry.contextTokens) && entry.contextTokens > 0 ? entry.contextTokens : undefined,
    // true/false/undefined
    // (unknown) — see ModelEntry.vision's own comment in protocol.ts. Kept
    // as a real tri-state, never coerced to boolean: "unknown" and "false"
    // get different UI treatment (checkbox active vs. greyed).
    vision: entry.vision === true ? true : entry.vision === false ? false : undefined,
    current: entry.provider === current.provider && sameModel(entry.model, current.model),
  }));
  const sources = Array.isArray(reply?.sources) ? reply.sources : [];
  const ollama = sources.find((source) => source?.provider === "ollama");
  return {
    current,
    currentEntry: marked.find((entry) => entry.current) ?? null,
    local: marked.filter((entry) => entry.local),
    online: marked.filter((entry) => !entry.local),
    ollamaUnreachable: ollama?.state === "unreachable",
    host: readHost(reply?.host),
  };
}

// Claude families, in display order (Haiku sits under Sonnet). Matched as a
// word of the model id; no model identifier is held here.
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

function claudeFamily(model) {
  const lower = model.toLowerCase();
  return CLAUDE_FAMILIES.find((family) => lower.includes(family)) ?? null;
}

/** Version numbers of an id ("claude-3-5-sonnet-20241022" -> [3, 5]); dates skipped. */
function versionOf(model) {
  return (model.match(/\d+/g) ?? []).filter((digits) => digits.length < 8).map(Number);
}

function newestFirst(a, b) {
  const va = versionOf(a.model);
  const vb = versionOf(b.model);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] ?? -1) - (va[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.model.localeCompare(b.model);
}

/**
 * Entries -> provider groups for the panel menu. A Claude provider is split
 * in families (Fable, Opus, Sonnet, Haiku; others last), newest version
 * first; every other provider is alphabetical. Groups are alphabetical.
 * @param {object[]} entries
 * @param {(entry: object) => string} labelOf provider group label of an entry
 * @returns {{key: string, label: string, entries: object[],
 *   families: {family: string|null, entries: object[]}[]|null}[]}
 */
export function groupByProvider(entries, labelOf) {
  const byProvider = new Map();
  for (const entry of entries) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry);
  }
  const groups = [];
  for (const [key, list] of byProvider) {
    const label = labelOf(list[0]);
    if (/claude|anthropic/i.test(key)) {
      const order = [...CLAUDE_FAMILIES, null];
      const families = order
        .map((family) => ({
          family,
          entries: list.filter((entry) => claudeFamily(entry.model) === family).sort(newestFirst),
        }))
        .filter((part) => part.entries.length > 0);
      groups.push({ key, label, entries: list, families });
    } else {
      const sorted = [...list].sort((a, b) =>
        shortModelName(a.model).localeCompare(shortModelName(b.model), undefined, { numeric: true }),
      );
      groups.push({ key, label, entries: sorted, families: null });
    }
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

/** true = runs on this computer, false = online. Read from the matching
 * entry when there is one; else from the provider id (Ollama is always
 * local; anything unknown is presumed online, the cautious claim). */
export function isCurrentLocal(grouped) {
  if (grouped.currentEntry) return grouped.currentEntry.local;
  return grouped.current.provider === "ollama";
}

/** true/false/undefined (unknown) for the CURRENT model. No entry
 * at all (older local program, no `models.list`) is also "unknown": the
 * checkbox stays active rather than guessing it's unsupported. */
export function currentModelVision(grouped) {
  return grouped?.currentEntry ? grouped.currentEntry.vision : undefined;
}

function uiLocale() {
  return (globalThis.document?.documentElement?.lang || "fr").replace("_", "-");
}

function formatGb(value) {
  try {
    return new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Appends the model list to `container` (emptied first).
 *
 * @param {HTMLElement} container
 * @param {object|null} reply           the `models` message
 * @param {object} opts
 * @param {(key: string, subs?: string[]) => string} opts.t
 * @param {(id: string, fallback?: string) => string} opts.providerLabel
 * @param {Record<string, string>} [opts.moduleLabels] moduleLabelsFrom(settings)
 * @param {string} [opts.baseUrl]       openai-compat's address, when known
 * @param {(entry: object) => void} opts.onPick
 * @param {"menu"|"list"} [opts.mode]   "menu" = ARIA menu items (panel),
 *                                      "list" = plain toggle buttons (options)
 * @param {boolean} [opts.localOnly]    only "On this computer" (tutorial)
 * @param {(() => void)} [opts.onAdd]   adds "Add a model…" last (menu)
 * @param {string} [opts.idPrefix]      unique prefix for heading ids
 * @param {Map<string, boolean>} [opts.groupState] menu: user-chosen open/closed
 *                                      per provider group (default: open = holds the current model)
 * @param {() => void} [opts.onToggleGroup] menu: called after a group toggled
 * @returns {HTMLElement[]} the focusable items, in order
 */
export function renderModelList(container, reply, opts) {
  const { t, providerLabel, onPick, mode = "list", localOnly = false, onAdd, idPrefix = "models", groupState, onToggleGroup } = opts;
  // From the latest `settings` message (module labels, openai-compat's
  // address) — both optional, see providerDisplayName().
  const { moduleLabels, baseUrl } = opts;
  const menu = mode === "menu";
  const grouped = groupModels(reply);
  const focusables = [];
  container.replaceChildren();

  function itemButton(className, role) {
    const button = el("button", className);
    button.type = "button";
    if (menu) {
      button.setAttribute("role", role);
      button.tabIndex = -1;
    }
    return button;
  }

  function entryButton(entry) {
    let className = entry.current ? "c-row model-item model-item--current" : "c-row model-item";
    // Still selectable, only muted — the words below say why.
    if (entry.fit === "too-big" && typeof entry.gpuPercent !== "number") className += " model-item--too-big";
    const button = itemButton(className, "menuitemradio");
    if (menu) button.setAttribute("aria-checked", String(entry.current));
    else button.setAttribute("aria-pressed", String(entry.current));
    button.dataset.provider = entry.provider;
    button.dataset.model = entry.model;
    button.title = entry.model;

    const check = el("span", "model-item-check", entry.current ? "✓" : ""); // i18n-allow: symbol
    check.setAttribute("aria-hidden", "true");
    const text = el("span", "model-item-text");
    text.append(el("span", "model-item-name", shortModelName(entry.model)));

    const details = [];
    if (!menu && (entry.provider !== "ollama" || !entry.local)) {
      details.push(
        providerDisplayName(entry.provider, {
          providerLabel,
          moduleLabels,
          baseUrl,
          fallback: t(entry.local ? "model_list_provider_local" : "model_list_provider_online"),
        }),
      );
    }
    const gb = sizeInGb(entry.sizeBytes);
    if (gb !== null) details.push(t("model_list_size_gb", [formatGb(gb)]));
    if (details.length > 0) text.append(el("span", "model-item-detail", details.join(" · ")));
    const fitKey = entry.local ? fitNoteKey(entry) : null;
    if (fitKey) {
      const fitText = fitKey === "model_fit_loaded_percent" ? t(fitKey, [String(entry.gpuPercent)]) : t(fitKey);
      const fitNote = el("span", "model-item-note model-item-fit", fitText);
      fitNote.dataset.fit = fitKey === "model_fit_loaded_percent" ? "loaded" : entry.fit;
      text.append(fitNote);
    }
    if (entry.thinks) text.append(el("span", "model-item-note", t("model_list_thinks")));

    button.append(check, text);
    button.addEventListener("click", () => onPick(entry));
    focusables.push(button);
    return button;
  }

  function note(text) {
    if (menu) {
      // A menu only announces its items: the calm "Ollama isn't responding"
      // line is an inert item so arrow keys reach it and read it.
      const item = itemButton("model-list-note", "menuitem");
      item.setAttribute("aria-disabled", "true");
      item.textContent = text;
      focusables.push(item);
      return item;
    }
    return el("p", "model-list-note", text);
  }

  function section(key, headingKey, entries, noteText) {
    const group = el("div", "model-list-section");
    const headingId = `${idPrefix}-${key}`;
    const heading = el("div", "model-list-heading", t(headingKey));
    heading.id = headingId;
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", headingId);
    group.append(heading);
    for (const entry of entries) group.append(entryButton(entry));
    if (noteText) group.append(note(noteText));
    container.append(group);
  }

  // Menu: one collapsible group per provider; folded groups render no rows.
  function menuGroups(grouped, localNote) {
    const labelOf = (entry) =>
      providerDisplayName(entry.provider, {
        providerLabel,
        moduleLabels,
        baseUrl,
        fallback: t(entry.local ? "model_list_provider_local" : "model_list_provider_online"),
      });
    const entries = [...grouped.local, ...grouped.online];
    const groups = groupByProvider(entries, labelOf);
    // Ollama unreachable: its group still shows, holding the calm line.
    if (grouped.ollamaUnreachable && !groups.some((group) => group.key === "ollama")) {
      groups.unshift({ key: "ollama", label: providerLabel("ollama"), entries: [], families: null });
    }
    if (localNote && !groups.some((group) => group.key === "ollama")) container.append(note(localNote));
    for (const group of groups) {
      const open = groupState?.get(group.key) ?? group.entries.some((entry) => entry.current);
      const wrap = el("div", "model-list-section");
      wrap.setAttribute("role", "group");
      const toggle = itemButton("model-group-toggle", "menuitem");
      toggle.dataset.group = group.key;
      toggle.setAttribute("aria-expanded", String(open));
      const arrow = el("span", "model-group-arrow", open ? "▾" : "▸"); // i18n-allow: symbol
      arrow.setAttribute("aria-hidden", "true");
      const local = group.entries.length === 0 ? group.key === "ollama" : group.entries[0].local;
      toggle.append(
        arrow,
        el("span", "model-group-name", group.label),
        el("span", "model-group-where", t(local ? "model_list_local" : "model_list_online")),
        el("span", "model-group-count", String(group.entries.length)),
      );
      toggle.addEventListener("click", () => {
        groupState?.set(group.key, !open);
        onToggleGroup?.();
      });
      focusables.push(toggle);
      wrap.append(toggle);
      if (open) {
        if (group.families) {
          for (const part of group.families) {
            // i18n-allow: model family names are proper nouns
            if (part.family) wrap.append(el("div", "model-list-heading", part.family[0].toUpperCase() + part.family.slice(1)));
            for (const entry of part.entries) wrap.append(entryButton(entry));
          }
        } else {
          for (const entry of group.entries) wrap.append(entryButton(entry));
        }
        if (group.key === "ollama" && localNote) {
          wrap.append(note(localNote));
        }
      }
      container.append(wrap);
    }
  }

  const localNote = grouped.ollamaUnreachable
    ? t("model_list_ollama_unreachable")
    : grouped.local.length === 0
      ? t("model_list_no_local")
      : null;
  if (menu) {
    menuGroups(grouped, localNote);
  } else {
    // Ollama down: one calm line where its models would be.
    section("local", "model_list_local", grouped.local, localNote);
    if (!localOnly && grouped.online.length > 0) section("online", "model_list_online", grouped.online, null);
  }

  if (onAdd) {
    const separator = el("div", "model-list-separator");
    separator.setAttribute("role", "separator");
    const add = itemButton("c-row model-item model-item--add", "menuitem");
    add.textContent = t("model_list_add");
    add.addEventListener("click", () => onAdd());
    focusables.push(add);
    container.append(separator, add);
  }
  return focusables;
}

/**
 * Older local program, no `models.list` support (docs/PROTOCOL.md): instead of the usual grouped
 * list, one calm explanatory line plus a button to the settings page. Same
 * "menu" item shape as renderModelList() (focusable `<button>`s, roving
 * tabindex handled by the caller) so it drops into the same container and
 * keyboard wiring.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {(key: string, subs?: string[]) => string} opts.t
 * @param {() => void} opts.onOpenSettings
 * @returns {HTMLElement[]} the focusable items, in order
 */
export function renderStaleBrokerMenu(container, { t, onOpenSettings }) {
  container.replaceChildren();

  const note = el("button", "model-list-note", t("model_menu_stale_broker_line"));
  note.type = "button";
  note.setAttribute("role", "menuitem");
  note.setAttribute("aria-disabled", "true");
  note.tabIndex = -1;

  const settingsButton = el("button", "c-row model-item model-item--add", t("panel_open_settings"));
  settingsButton.type = "button";
  settingsButton.setAttribute("role", "menuitem");
  settingsButton.tabIndex = -1;
  settingsButton.addEventListener("click", () => onOpenSettings());

  container.append(note, settingsButton);
  return [note, settingsButton];
}
