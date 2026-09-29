// What the broker hands to every model provider, built-in or loaded from an
// external module (docs/MODULES.md, amendement 2026-09-29 de docs/PROTOCOL.md
// "Fournisseur de modèle"). A module must never import broker internals by a
// relative path outside its own file — everything it legitimately needs
// (system-prompt builder, timeout constant, typed errors, a logger) comes
// through this `host` object, passed as `createProvider(host, options)`'s
// first argument. Built-in providers (ollama.ts, claude-api.ts) still import
// ../model.ts directly — only modules go through `host`, since they cannot
// import a relative path into this repository at all.

import {
  buildSystemPrompt,
  MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  AuthRequiredError,
} from "../model.ts";

export interface ProviderLogger {
  /** One line. Prefixed "coati-broker: " automatically if not already present
   * — matches every other log line the broker writes (see docs/PROTOCOL.md
   * "Journalisation"). Goes to stdout. */
  info(message: string): void;
  /** Same as info(), but stderr — for a condition the maintainer should
   * notice without necessarily failing anything. */
  warn(message: string): void;
}

export interface ProviderHost {
  buildSystemPrompt: typeof buildSystemPrompt;
  MODEL_TIMEOUT_MS: number;
  ModelTimeoutError: typeof ModelTimeoutError;
  ModelUnavailableError: typeof ModelUnavailableError;
  AuthRequiredError: typeof AuthRequiredError;
  logger: ProviderLogger;
}

function prefixed(message: string): string {
  return message.startsWith("coati-broker:") ? message : `coati-broker: ${message}`;
}

export const defaultProviderLogger: ProviderLogger = {
  info(message) {
    console.log(prefixed(message));
  },
  warn(message) {
    console.warn(prefixed(message));
  },
};

/** Builds the host object passed to every loaded module. A fresh call per
 * process is enough — nothing here is per-provider or per-request state. */
export function buildProviderHost(logger: ProviderLogger = defaultProviderLogger): ProviderHost {
  return {
    buildSystemPrompt,
    MODEL_TIMEOUT_MS,
    ModelTimeoutError,
    ModelUnavailableError,
    AuthRequiredError,
    logger,
  };
}
