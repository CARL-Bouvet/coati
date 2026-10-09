// Coati side panel — shared mutable state (lot F3 split of panel.js).
//
// `panelState` groups every piece of state that is reassigned from MORE
// THAN ONE of the panel's feature modules (verified by grepping every
// reassignment site before the split — see
// coati-interne/design/notes-split-f3-09-10.md). Mutating a property of
// this exported `const` object works from any importer; reassigning a
// plain `export let` binding does not (ES modules give importers a
// read-only view of it). Everything else below is owned by exactly one
// module and stays a plain `let`/`const` there.
export const panelState = {
  /** @type {Array<{id: string, role: 'user'|'assistant'|'system', text: string}>} */
  conversation: [],
  activeRequestId: null,
  // "Coati reads this page" toggle (deliverable 3). null = no stored
  // preference yet, so default to true once a page type is known.
  attachPagePreference: null,
  // "See the screen" toggle (sticky). null/false = off by default.
  attachScreenPreference: false,
  // Set once any assistant answer completes this panel session
  // (handleBrokerMessage's "done" case) — read by model-status.js
  // (maybeRecheckProviderForFirstRun) and first-run-wiring.js (renderFirstRun).
  modelAnswered: false,
  // storage.local flag (MODEL_EVER_ANSWERED_KEY) mirrored in memory — true
  // once any assistant answer has ever completed, this session or a past
  // one. Written from handleBrokerMessage's "done" case AND from
  // first-run-wiring.js's loadAccessPrefs() (migration from FIRST_RUN_DONE_KEY).
  modelEverAnswered: false,
};

export function newId() {
  return crypto.randomUUID();
}

export const STORAGE_KEY = "coati:conversation";
export const ATTACH_PAGE_KEY = "coati:attachPage";
export const ATTACH_SCREEN_KEY = "coati:attachScreen";
export const PENDING_ACTION_KEY = "coati:pendingAction";
export const MAX_PERSISTED_MESSAGES = 200;
