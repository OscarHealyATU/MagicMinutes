// Accessibility preferences: font style and colour-blind mode. Same shape as
// theme.mjs — a pure module with guarded localStorage read/write, and an
// `apply*` that sets a `data-*` attribute on <html> for the stylesheet (and,
// for colour-blind mode, a couple of view components) to key off.

export const FONT_STYLES = [
  {
    id: 'fantasy',
    label: 'Fantasy',
    hint: "Today's look — Jim Nightshade & Quintessential"
  },
  {
    id: 'easy-read',
    label: 'Easy-read',
    hint: 'Comic Sans text, Lexend headings — easier for dyslexia'
  },
  {
    id: 'opendyslexic',
    label: 'OpenDyslexic',
    hint: 'A typeface designed for dyslexia, Lexend headings'
  }
];

export const FONT_STYLE_KEY = 'magicminutes.fontStyle';
export const DEFAULT_FONT_STYLE = 'fantasy';

export function isFontStyle(value) {
  return FONT_STYLES.some((f) => f.id === value);
}

export function readFontStyle(storage) {
  try {
    const stored = storage && storage.getItem(FONT_STYLE_KEY);
    return isFontStyle(stored) ? stored : DEFAULT_FONT_STYLE;
  } catch {
    return DEFAULT_FONT_STYLE;
  }
}

export function writeFontStyle(style, storage) {
  if (!isFontStyle(style)) return false;
  try {
    storage && storage.setItem(FONT_STYLE_KEY, style);
    return true;
  } catch {
    return false;
  }
}

// `data-font="fantasy"` is written explicitly (rather than left absent) so a
// stylesheet rule can target it if it ever needs to, but every CSS rule for
// the default look keys off its *absence* of data-font="easy-read"/"opendyslexic",
// so this never changes anything by itself.
export function applyFontStyle(style, root) {
  const value = isFontStyle(style) ? style : DEFAULT_FONT_STYLE;
  if (root) root.setAttribute('data-font', value);
  return value;
}

// ---------- Colour-blind mode ----------

export const COLOR_BLIND_KEY = 'magicminutes.colorBlind';
export const DEFAULT_COLOR_BLIND = false;

export function readColorBlind(storage) {
  try {
    const stored = storage && storage.getItem(COLOR_BLIND_KEY);
    return stored === 'on';
  } catch {
    return DEFAULT_COLOR_BLIND;
  }
}

export function writeColorBlind(on, storage) {
  try {
    storage && storage.setItem(COLOR_BLIND_KEY, on ? 'on' : 'off');
    return true;
  } catch {
    return false;
  }
}

export function applyColorBlind(on, root) {
  if (root) root.setAttribute('data-cvd', on ? 'on' : 'off');
  return !!on;
}
