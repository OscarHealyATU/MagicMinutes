// Central list of every keyboard shortcut in the app — written for the
// Settings → "Keyboard shortcuts" window (a later task), but kept here so
// this list and the handlers below can't quietly drift apart. Pure data, no
// React/DOM, so it's cheap to import from a component or a settings screen
// alike.
export const SHORTCUTS = [
  { keys: ['Ctrl', '+'], action: 'Zoom in', where: 'Map / Characters' },
  { keys: ['Ctrl', '-'], action: 'Zoom out', where: 'Map / Characters' },
  { keys: ['Ctrl', '0'], action: 'Reset zoom', where: 'Map / Characters' },
  { keys: ['Ctrl', 'F'], action: 'Find a place or zone', where: 'Map' },
  { keys: ['↑', '↓'], action: 'Move the highlighted find suggestion', where: 'Map (find box)' },
  { keys: ['Enter'], action: 'Go to the highlighted find suggestion', where: 'Map (find box)' },
  { keys: ['Esc'], action: 'Close the find box', where: 'Map (find box)' },
  // Every Esc-closes-this modal in the app shares one row — Share notes,
  // Import notes, Export journal and this Keyboard shortcuts window itself
  // all wire up the same "Escape closes the open dialog" handler.
  { keys: ['Esc'], action: 'Close the dialog', where: 'Dialogs (Share, Import, Export journal, Shortcuts)' }
];

// Whether a keydown event matches a shortcut's `keys` — one optional Ctrl
// (Cmd on Mac counts too, same as the zoom/find handlers) plus exactly one
// other key. Handlers that hard-code a combo (Ctrl+F's own listener, say)
// can check it against this list instead, so the two never disagree about
// what the shortcut actually is.
export function matchesShortcut(e, shortcut) {
  const keys = shortcut.keys.map((k) => k.toLowerCase());
  const wantCtrl = keys.includes('ctrl');
  const mainKey = keys.find((k) => k !== 'ctrl' && k !== 'shift' && k !== 'alt');
  if (wantCtrl !== !!(e.ctrlKey || e.metaKey)) return false;
  return mainKey != null && e.key.toLowerCase() === mainKey;
}
