// The ONE API-key entry component (goal U2), shared by the settings page's
// provider cards (options.js) and the "Connecter un modèle d'IA" guide
// (options-setup.js). Rules, decided by Romain (plan-utilisabilite U2):
//
// - masked field with a show/hide toggle; autocomplete/spellcheck/
//   autocapitalize/autocorrect all off (Chrome's enhanced spellcheck sends
//   typed text to Google);
// - never reads the clipboard (a user paste into the field is the browser's
//   own default behaviour, no paste listener here);
// - the key goes to the local program in ONE `settings.set` message
//   (docs/PROTOCOL.md, `apiKey` is write-only end to end) and is never kept
//   in the extension: no storage, no module/closure copy, the field is
//   cleared right after sending and never refilled — only « Clé enregistrée »;
// - right after a successful save, a free `settings.test` checks the key and
//   the result is shown in plain words (accepted / refused / no credit /
//   rate-limited), mapped from the result's optional `code`;
// - « Supprimer la clé » (two-step confirm, no native dialog) sends
//   `apiKey: ""`.
//
// `provider` is always sent with the key: the broker binds a key to
// `patch.provider ?? active provider` (broker/src/server.ts applySettings),
// so naming it explicitly guarantees the key reaches the service it was
// typed for.

import { t } from "./i18n-page.js";

const DELETE_CONFIRM_MS = 5000;

/** `settings.test-result.code` -> sentence(s). Reuses the U1 `common_error_*`
 * texts as the first sentence where they exist, plus a remedy that fits the
 * settings page (the panel's own texts say "go to the settings"). */
function describeTestFailure(code, brokerMessage) {
  switch (code) {
    case "auth-required":
      return t("keyInput_refused");
    case "quota-exceeded":
      return `${t("common_error_quota_exceeded")} ${t("keyInput_remedy_credit")}`;
    case "rate-limited":
      return `${t("common_error_rate_limited")} ${t("keyInput_remedy_wait")}`;
    case "model-unavailable":
      return brokerMessage ? `${t("common_error_model_unavailable")} ${brokerMessage}` : t("common_error_model_unavailable");
    default:
      // Absent or unknown code (an older broker, a module's own code): the
      // broker's own sentence is already localized and names the remedy.
      return brokerMessage || t("keyInput_test_failed");
  }
}

/**
 * @param {object} opts
 * @param {string} opts.provider        broker provider id ("claude-api", "openai-compat", …)
 * @param {(payload: object) => void} opts.send  sends one client message to the broker
 * @param {() => string} opts.newId     fresh request id
 * @param {string} [opts.placeholder]   placeholder when no key is stored yet
 * @param {string} [opts.limitsUrl]     paid provider: page where a monthly cap is set
 * @param {(ok: boolean) => void} [opts.onVerified]  called after each verification
 * @returns {{ element: HTMLElement, update(entry: object|null): void,
 *   handleBrokerMessage(message: object): void, setConnected(connected: boolean): void,
 *   verify(): void }}
 */
export function createKeyInput({ provider, send, newId, placeholder, limitsUrl, onVerified }) {
  let configured = false;
  let connected = true;
  // "idle" | "saving" | "verifying" | "accepted" | "failed" | "save-failed" | "deleting" | "deleted"
  let state = "idle";
  let failureText = "";
  let saveId = null;
  let testId = null;
  let deleteConfirmPending = false;
  let deleteConfirmTimer = null;

  const root = document.createElement("div");
  root.className = "key-input";

  const row = document.createElement("div");
  row.className = "key-input-row";

  const input = document.createElement("input");
  input.type = "password";
  input.className = "key-input-field";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("aria-label", t("keyInput_label"));

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "button-secondary key-input-reveal";
  reveal.setAttribute("aria-pressed", "false");
  reveal.textContent = t("keyInput_show");
  reveal.addEventListener("click", () => setRevealed(input.type === "password"));

  const save = document.createElement("button");
  save.type = "button";
  save.className = "key-input-save";
  save.textContent = t("keyInput_save");
  save.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  row.append(input, reveal, save);

  const statusRow = document.createElement("div");
  statusRow.className = "key-input-status-row";

  const status = document.createElement("p");
  status.className = "key-input-status";
  status.setAttribute("role", "status");
  const statusMark = document.createElement("span");
  statusMark.className = "key-input-mark";
  statusMark.setAttribute("aria-hidden", "true");
  const statusText = document.createElement("span");
  statusText.className = "key-input-status-text";
  status.append(statusMark, statusText);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button-secondary key-input-retry";
  retry.textContent = t("keyInput_retry");
  retry.addEventListener("click", () => verify());

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "apikey-clear key-input-delete";
  remove.textContent = t("keyInput_delete");
  remove.addEventListener("click", onDeleteClick);

  statusRow.append(status, retry, remove);

  const notes = document.createElement("ul");
  notes.className = "key-input-notes";
  addNote(t("keyInput_note_storage"));
  addNote(t("keyInput_note_never_share"));
  if (limitsUrl) {
    const li = addNote(t("keyInput_note_spending_cap"));
    li.append(" ");
    const link = document.createElement("a");
    link.className = "link";
    link.href = limitsUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("keyInput_spending_cap_link");
    li.appendChild(link);
  }

  root.append(row, statusRow, notes);
  render();

  function addNote(text) {
    const li = document.createElement("li");
    li.textContent = text;
    notes.appendChild(li);
    return li;
  }

  function setRevealed(revealed) {
    input.type = revealed ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(revealed));
    reveal.textContent = revealed ? t("keyInput_hide") : t("keyInput_show");
  }

  function submit() {
    const value = input.value.trim();
    // Field cleared and re-masked whatever happens next: the key must not
    // stay visible or selectable once it has left for the broker.
    input.value = "";
    setRevealed(false);
    if (!value || !connected) return;
    saveId = newId();
    state = "saving";
    render();
    send({ type: "settings.set", id: saveId, provider, apiKey: value });
  }

  function verify() {
    if (!connected) return;
    testId = newId();
    state = "verifying";
    render();
    send({ type: "settings.test", id: testId, provider });
  }

  function onDeleteClick() {
    if (!deleteConfirmPending) {
      deleteConfirmPending = true;
      remove.textContent = t("keyInput_delete_confirm");
      remove.classList.add("apikey-clear--confirm");
      deleteConfirmTimer = setTimeout(resetDeleteConfirm, DELETE_CONFIRM_MS);
      return;
    }
    resetDeleteConfirm();
    saveId = newId();
    state = "deleting";
    render();
    send({ type: "settings.set", id: saveId, provider, apiKey: "" });
  }

  function resetDeleteConfirm() {
    deleteConfirmPending = false;
    clearTimeout(deleteConfirmTimer);
    remove.textContent = t("keyInput_delete");
    remove.classList.remove("apikey-clear--confirm");
  }

  function entryFrom(settings) {
    return (settings?.available ?? []).find((p) => p.id === provider) ?? null;
  }

  function handleBrokerMessage(message) {
    if (!message) return;
    if (message.type === "settings" && saveId && (message.id === saveId || !message.id)) {
      saveId = null;
      configured = Boolean(entryFrom(message)?.configured);
      if (state === "saving") {
        if (configured) {
          verify();
          return;
        }
        // e.g. openai-compat with no address yet: nowhere to bind the key.
        state = "save-failed";
        failureText = t("keyInput_save_failed");
      } else if (state === "deleting") {
        state = configured ? "save-failed" : "deleted";
        failureText = t("keyInput_save_failed");
      }
      render();
      return;
    }
    if (message.type === "error" && saveId && message.id === saveId) {
      saveId = null;
      state = "save-failed";
      failureText = message.message ? `${t("keyInput_save_failed")} ${message.message}` : t("keyInput_save_failed");
      render();
      return;
    }
    if (message.type === "settings.test-result" && testId && message.id === testId) {
      testId = null;
      if (message.ok) {
        state = "accepted";
      } else {
        state = "failed";
        failureText = describeTestFailure(message.code, message.message);
      }
      render();
      onVerified?.(Boolean(message.ok));
    }
  }

  /** Latest `settings.available[]` entry for this provider (or null). Never
   * resets an in-flight save/verification — only the "configured" flag. */
  function update(entry) {
    configured = Boolean(entry?.configured);
    if (state === "deleted" && configured) state = "idle";
    render();
  }

  function setConnected(value) {
    connected = Boolean(value);
    render();
  }

  function render() {
    const busy = state === "saving" || state === "verifying" || state === "deleting";
    input.placeholder = configured ? t("keyInput_placeholder_replace") : (placeholder ?? t("keyInput_placeholder"));
    input.disabled = !connected;
    save.disabled = !connected || busy;
    reveal.disabled = !connected;

    let mark = "";
    let text = "";
    let tone = "neutral";
    switch (state) {
      case "saving":
        text = t("keyInput_saving");
        break;
      case "verifying":
        mark = "✓"; // i18n-allow: symbol, not a word
        text = t("keyInput_verifying");
        break;
      case "accepted":
        mark = "✓"; // i18n-allow: symbol, not a word
        text = `${t("keyInput_saved")} · ${t("keyInput_accepted")}`;
        tone = "ok";
        break;
      case "failed":
        mark = "!";
        text = failureText;
        tone = "error";
        break;
      case "save-failed":
        mark = "!";
        text = failureText;
        tone = "error";
        break;
      case "deleting":
        text = t("keyInput_saving");
        break;
      case "deleted":
        text = t("keyInput_deleted");
        break;
      default:
        if (configured) {
          mark = "✓"; // i18n-allow: symbol, not a word
          text = t("keyInput_saved");
          tone = "ok";
        } else if (!connected) {
          text = t("keyInput_not_connected");
        }
    }
    if (!connected && !busy && state !== "accepted") {
      text = configured ? `${t("keyInput_saved")} · ${t("keyInput_not_connected")}` : t("keyInput_not_connected");
      mark = configured ? "✓" : ""; // i18n-allow: symbol, not a word
      tone = "neutral";
    }
    status.dataset.tone = tone;
    root.dataset.state = state;
    statusMark.textContent = mark;
    statusText.textContent = text;
    status.hidden = !text;
    retry.hidden = !(connected && configured && state === "failed");
    remove.hidden = !(connected && configured && !busy);
    statusRow.hidden = status.hidden && retry.hidden && remove.hidden;
  }

  return { element: root, update, handleBrokerMessage, setConnected, verify };
}
