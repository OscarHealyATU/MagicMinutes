// Per-role text size multipliers (Settings → Appearance → Text size).
// Same guarded-localStorage pattern as theme.mjs/a11y.mjs, just with an
// object of five multipliers instead of a single string, one per role the
// stylesheet scales independently:
//   body     — note content, descriptions, list entries, form inputs,
//              recap summaries, the main reading text.
//   headings — page titles, card headings (h2/h3), the brand, title inputs.
//   ui       — nav labels/hints, buttons, chips, tabs, toolbar controls.
//   map      — SVG text on the Map and the Characters tree (station/zone
//              labels, note/NPC mini-lists, badges, node/group/edge labels).
//   small    — hints, dates, status lines, counts/badges, the map legend
//              and footer hint, settings help text.
// See styles.css's own comment (top of file) for exactly which selectors
// each role covers.

export const TEXT_SIZE_KEY = 'magicminutes.textSizes';
export const TEXT_SIZE_ROLES = ['body', 'headings', 'ui', 'map', 'small'];
export const TEXT_SIZE_MIN = 0.8;
export const TEXT_SIZE_MAX = 1.5;
export const TEXT_SIZE_STEP = 0.05;

export const DEFAULT_TEXT_SIZES = { body: 1, headings: 1, ui: 1, map: 1, small: 1 };

// Friendly copy for the Settings sliders — label plus a one-line description
// of what that role covers, kept short enough to sit under a slider.
export const TEXT_SIZE_LABELS = {
  body: { label: 'Body text', hint: 'Notes, descriptions, list entries and form inputs' },
  headings: { label: 'Headings', hint: 'Page titles, card headings, the brand' },
  ui: { label: 'Buttons & menus', hint: 'Nav, buttons, chips, tabs, toolbar controls' },
  map: { label: 'Map & tree labels', hint: 'Station, zone, node and group labels' },
  small: { label: 'Small print', hint: 'Hints, dates, status lines, counts and badges' }
};

// Snaps to the nearest 5% step and clamps to [80%, 150%] — guards against a
// stray value from a future version, a hand-edited localStorage entry, or
// float drift from repeated +/- clicks (0.1 + 0.05 isn't exactly 0.15 in
// floating point, so round to 2dp after snapping).
export function clampTextSize(value) {
  if (value == null) return 1; // Number(null) is 0, not "missing" — treat both as a broken value
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const snapped = Math.round(n / TEXT_SIZE_STEP) * TEXT_SIZE_STEP;
  const clamped = Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, snapped));
  return Math.round(clamped * 100) / 100;
}

// Clamps every role of a (possibly partial/garbage) object, falling back to
// the default for anything missing or unrecognisable — same "never let a
// broken preference stop the app" contract as theme.mjs/a11y.mjs.
export function clampTextSizes(sizes) {
  const out = { ...DEFAULT_TEXT_SIZES };
  if (sizes && typeof sizes === 'object') {
    for (const role of TEXT_SIZE_ROLES) {
      if (sizes[role] != null) out[role] = clampTextSize(sizes[role]);
    }
  }
  return out;
}

export function readTextSizes(storage) {
  try {
    const stored = storage && storage.getItem(TEXT_SIZE_KEY);
    if (!stored) return { ...DEFAULT_TEXT_SIZES };
    return clampTextSizes(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_TEXT_SIZES };
  }
}

export function writeTextSizes(sizes, storage) {
  try {
    storage && storage.setItem(TEXT_SIZE_KEY, JSON.stringify(clampTextSizes(sizes)));
    return true;
  } catch {
    return false;
  }
}

// Sets one --ts-<role> custom property per role on <html>, the same
// mechanism the stylesheet's `calc(<base>px * var(--ts-role, 1))` rules key
// off. Guards a missing root the same way applyTheme/applyFontStyle do.
export function applyTextSizes(sizes, root) {
  const value = clampTextSizes(sizes);
  if (root && root.style) {
    for (const role of TEXT_SIZE_ROLES) root.style.setProperty(`--ts-${role}`, value[role]);
  }
  return value;
}
