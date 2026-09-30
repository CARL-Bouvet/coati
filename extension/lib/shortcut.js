// Keyboard-shortcut display helpers for the options page. DOM-free pure JS
// (tested in broker/test/ui-options-page.test.ts).

// French keyboards print "Maj" on the Shift key; the other modifier names
// are the same in French and English.
const KEY_LABELS = {
  Shift: "Maj",
  Command: "Cmd",
  MacCtrl: "Ctrl",
};

/**
 * Splits a `commands.getAll()` shortcut ("Alt+Shift+C", "Ctrl+Shift+Y") into
 * display labels, one per key. Chrome on macOS reports symbols with no
 * separator ("⌥⇧C") — kept as a single label rather than guessed apart.
 * @param {string | undefined | null} shortcut
 * @returns {string[]} empty when no shortcut is set.
 */
export function shortcutKeys(shortcut) {
  if (typeof shortcut !== "string") return [];
  const trimmed = shortcut.trim();
  if (!trimmed) return [];
  // "Ctrl++" style (the "+" key itself) is not a valid manifest shortcut,
  // so a plain split is safe; empty parts are dropped defensively.
  return trimmed
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => KEY_LABELS[part] ?? part);
}

/** The `_execute_action` entry's shortcut, or "" when absent/unset.
 * @param {Array<{ name?: string, shortcut?: string }> | undefined} commands */
export function actionShortcut(commands) {
  if (!Array.isArray(commands)) return "";
  const entry = commands.find((c) => c && c.name === "_execute_action");
  return entry && typeof entry.shortcut === "string" ? entry.shortcut : "";
}
