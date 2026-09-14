// Light / dark colour scheme. The stylesheet holds two sets of custom
// properties and switches on `data-theme` on <html>; this module is just the
// small amount of logic around choosing and remembering which one.

export const THEMES = [
  { id: 'dark', label: 'Dark', hint: 'Candlelit, easy on the eyes at the table' },
  { id: 'light', label: 'Light', hint: 'Paper, better in a bright room' }
];

export const THEME_KEY = 'ttrpgmap.theme';
export const DEFAULT_THEME = 'dark';

export function isTheme(value) {
  return THEMES.some((t) => t.id === value);
}

// localStorage throws in some locked-down webviews, so every access is guarded
// — a broken preference must never stop the app rendering.
export function readTheme(storage) {
  try {
    const stored = storage && storage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeTheme(theme, storage) {
  if (!isTheme(theme)) return false;
  try {
    storage && storage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function applyTheme(theme, root) {
  const value = isTheme(theme) ? theme : DEFAULT_THEME;
  if (root) root.setAttribute('data-theme', value);
  return value;
}
