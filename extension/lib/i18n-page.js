// Page-side entry point of lib/i18n.js (panel, options, prompts, welcome and
// every module they import that calls t()).
//
// Several of those modules call t() at MODULE LOAD time to build constant
// tables (suggestions-data.js, read-button.js, first-run.js, labels.js, …).
// The top-level await below guarantees the chosen language's catalog is
// loaded before any module that imports this file runs its body, so those
// tables come out in the user's language, not the browser's.
//
// Never import this file from the service worker: Chrome refuses an MV3
// service worker whose module graph contains top-level await. The service
// worker imports lib/i18n.js directly and awaits i18nReady() where needed.
import { i18nReady } from "./i18n.js";

export * from "./i18n.js";

await i18nReady();
