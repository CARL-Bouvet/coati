// One-click sign-in, shared by the settings page's guide (options-setup.js) and the
// welcome tab (welcome/access-step.js): the button, the oauth.start request, the
// "waiting" / "failed" line, and ChatGPT's two moments (sign in, then allow the plan).
// The key never passes here: the local program keeps it and pushes fresh settings.
// Classes are the shared ones (components.css); no innerHTML.

import { api } from "./browser-compat.js";

// The address the local program may hand back to open, per sign-in service.
const OAUTH_URL_PREFIX = {
  openrouter: "https://openrouter.ai/auth?",
  chatgpt: "https://auth.openai.com/api/accounts/authorize?",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

/**
 * @param {object} opts
 * @param {{ oauth: string, name: string }} opts.service  an ONLINE_PROVIDERS entry with `oauth`
 * @param {boolean} [opts.consent]       ChatGPT: the "allow my plan" button instead of the sign-in
 * @param {(payload: object) => void} opts.send
 * @param {() => string} opts.newId
 * @param {(key: string, subs?: string[]) => string} opts.t
 * @param {() => boolean} opts.isConnected  the button is off while the local program is away
 * @param {() => void} [opts.onStarted]  the sign-in tab was opened
 * @param {() => void} [opts.onFailed]   the program could not start it
 * @returns {{ element: HTMLElement, button: HTMLButtonElement, handleBrokerMessage(message: object): void }}
 */
export function createOauthSignIn({ service, consent = false, send, newId, t, isConnected, onStarted, onFailed }) {
  const element = node("div", "c-oauth");
  const button = node("button", "c-button c-button--primary", consent ? t("setup_chatgpt_allow_button") : t("setup_oauth_signin", [service.name]));
  button.type = "button";
  button.disabled = !isConnected();
  const status = node("p", "c-note");
  status.setAttribute("aria-live", "polite");
  let requestId = null;
  button.addEventListener("click", () => {
    button.disabled = true;
    requestId = newId();
    const payload = { type: "oauth.start", id: requestId, service: service.oauth };
    if (consent) payload.consent = true;
    send(payload);
  });
  element.append(button, status);

  function handleBrokerMessage(message) {
    if (!requestId || message?.id !== requestId) return;
    requestId = null;
    button.disabled = !isConnected();
    if (message.type === "oauth.started" && typeof message.url === "string" && message.url.startsWith(OAUTH_URL_PREFIX[service.oauth])) {
      status.textContent = t("setup_oauth_waiting");
      api.tabs.create({ url: message.url });
      onStarted?.();
    } else {
      status.textContent = t("setup_oauth_failed");
      onFailed?.();
    }
  }
  return { element, button, handleBrokerMessage };
}

/**
 * ChatGPT, not yet usable: the sign-in, then the plan's consent. Empty once both are done.
 * @param {object|null} account  `settings.account` while ChatGPT is the active service
 * @param {(opts?: { consent?: boolean }) => { element: HTMLElement }} makeSignIn
 * @returns {HTMLElement[]}
 */
export function chatgptSignInNodes(account, makeSignIn, t) {
  if (!account?.signedIn) {
    const nodes = [makeSignIn().element];
    if (account?.revokeUnconfirmed) nodes.push(node("p", "c-note", t("setup_chatgpt_revoke_unconfirmed")));
    return nodes;
  }
  if (!account.planUsage) return [node("p", "c-note", t("setup_chatgpt_allow_plan")), makeSignIn({ consent: true }).element];
  return [];
}
