// Coati options page — small cross-cutting utilities shared by every
// options/*.js module (split of options.js): DOM node builders (no
// innerHTML, per the extension's CSP), an id generator for outgoing
// broker requests, and the broker message sender.

import { api } from "../lib/browser-compat.js";

export function newId() {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tiny DOM helper (this file): no innerHTML, text via textContent. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function buttonEl(text, className) {
  const button = el("button", className, text);
  button.type = "button";
  return button;
}
export const sendClientMessage = (payload) => api.runtime.sendMessage({ type: "coati:client-message", payload });
export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
