// Coati options page — "Test" (settings.test), lot F3 split of
// options.js.
//
// "settings.test" is fire-and-forget per provider; its reply does not itself
// re-render anything. Two places can start one: the current-model line
// ("current") and a service row ("row"). The result shows where the click
// was, and is repainted after a re-render.

import { t } from "../lib/i18n-page.js";
import { status } from "./model-core.js";
import { newId, el, buttonEl, clearChildren, sendClientMessage } from "./dom-helpers.js";

// claude-cli's own reconnect command (modules/claude-cli/index.ts,
// AUTH_REQUIRED_MESSAGE — amendement 2026-10-02, goal-j2FJ-kI7): kept as one
// constant here so the copy button and the displayed text can never drift
// apart from each other.
const CLAUDE_CLI_LOGIN_COMMAND = "claude auth login --claudeai";

export const testTargets = new Map(); // `${kind}:${provider}` -> { button, result }
const testsInFlight = new Map(); // provider -> kind that started the test
const lastTestResults = new Map(); // `${kind}:${provider}` -> settings.test-result
// Ids of the settings.test requests sent by the "Test" buttons — a key
// component's own verification (lib/key-input.js) also sends settings.test,
// and shows its result itself.
const testRequestIds = new Set();

export function registerTestTarget(kind, providerId, button, result) {
  testTargets.set(`${kind}:${providerId}`, { button, result });
  paintTestTarget(kind, providerId);
}

function paintTestTarget(kind, providerId) {
  const target = testTargets.get(`${kind}:${providerId}`);
  if (!target) return;
  const runningKind = testsInFlight.get(providerId);
  target.button.disabled = Boolean(runningKind) || status !== "connected";
  target.button.textContent = runningKind === kind ? t("options_test_in_progress") : t("options_test_short");
  const last = lastTestResults.get(`${kind}:${providerId}`);
  if (last) renderTestResult(target.result, last);
  else {
    clearChildren(target.result);
    target.result.classList.remove("test-result--ok", "test-result--error");
  }
}

export function testProvider(providerId, kind) {
  if (testsInFlight.has(providerId) || status !== "connected") return;
  testsInFlight.set(providerId, kind);
  lastTestResults.delete(`${kind}:${providerId}`);
  paintTestTarget("current", providerId);
  paintTestTarget("row", providerId);
  const id = newId();
  testRequestIds.add(id);
  sendClientMessage({ type: "settings.test", id, provider: providerId });
}

export function applyTestResult(message) {
  // A key component's own verification: it shows its result itself.
  if (message.id && !testRequestIds.has(message.id)) return;
  testRequestIds.delete(message.id);
  const kind = testsInFlight.get(message.provider) ?? "row";
  testsInFlight.delete(message.provider);
  lastTestResults.set(`${kind}:${message.provider}`, message);
  paintTestTarget("current", message.provider);
  paintTestTarget("row", message.provider);
}

/**
 * Fills `result` (a "Test" result <span>) with the outcome of a
 * settings.test — amendment 2026-10-02 (goal-j2FJ-kI7, "model failure flow"):
 * a successful check says "connected" up front (not just the
 * broker's own full sentence) and, when the broker couldn't see the
 * account's remaining credit (`creditUnchecked`), adds a dedicated second
 * line rather than leaving that limit implicit. A claude-cli session failure
 * additionally gets a copyable `claude auth login --claudeai` line — the
 * actual remedy, which no ordinary "check your settings" link can offer for
 * a CLI subscription. No innerHTML: every node built with
 * createElement/textContent, per the extension's CSP.
 */
function renderTestResult(result, message) {
  clearChildren(result);
  result.classList.remove("test-result--ok", "test-result--error");
  result.classList.add(message.ok ? "test-result--ok" : "test-result--error");

  const headline = el("span", "test-result-headline");
  // `message.message` is the broker's own sentence (docs/PROTOCOL.md,
  // settings.test-result, in the language sent with hello.lang), a plain
  // fallback if it is ever missing.
  const sentence = message.message || (message.ok ? t("options_test_ok") : t("options_test_failed"));
  headline.textContent = message.ok ? `${t("options_test_connected")} — ${sentence}` : sentence;
  result.appendChild(headline);

  if (message.ok && message.creditUnchecked) {
    result.appendChild(el("span", "test-result-detail", t("options_credit_unchecked")));
  }

  // claude-cli (external module, docs/MODULES.md) reports a session failure
  // the same way claude-api reports a key failure (code "auth-required") —
  // but (a) the broker's generic sentence for auth-required says "API key
  // rejected" which is wrong for a CLI subscription, and (b) the remedy is a
  // terminal command, not a settings field.  Both are special-cased here.
  if (!message.ok && message.provider === "claude-cli" && message.code === "auth-required") {
    headline.textContent = t("options_claude_cli_auth_required");
    result.appendChild(el("span", "test-result-detail", t("options_claude_cli_paste_hint")));

    const command = el("code", "test-result-command", CLAUDE_CLI_LOGIN_COMMAND);
    command.tabIndex = 0;
    result.appendChild(command);

    const copyBtn = buttonEl(t("options_copy_command"), "button-secondary button-small test-result-copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard?.writeText(CLAUDE_CLI_LOGIN_COMMAND).catch(() => {});
    });
    result.appendChild(copyBtn);
  }
}
