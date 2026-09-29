// Generic two-step "arm, then confirm" reducer — no native dialog, same
// pattern as options.js's "Effacer la clé" and panel.js's own
// eraseConversation button. Used here for deleting a saved prompt from the
// in-panel library: first click on an item arms it ("Supprimer ?"), a second
// click on the SAME item within the timeout confirms; clicking a DIFFERENT
// item re-arms that one instead and disarms the first.
//
// Pure reducer only — the timer that auto-disarms after a few seconds lives
// in panel.js, which is what actually needs a real clock.

/**
 * @param {string|null} armedId - the id currently armed, or null.
 * @param {string} clickedId - the id just clicked.
 * @returns {{ armed: string|null, confirmed: boolean }}
 *   `confirmed: true` means the caller should perform the delete now, and
 *   the reducer already reports the new armed state as null.
 */
export function armOrConfirm(armedId, clickedId) {
  if (armedId === clickedId) return { armed: null, confirmed: true };
  return { armed: clickedId, confirmed: false };
}
