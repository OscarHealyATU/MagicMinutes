// Plain-node test for src/lib/a11y.mjs: the font-style and colour-blind
// preferences, mirroring theme.test's coverage of theme.mjs. Run with:
// node tests/a11y.test.mjs

import assert from 'node:assert/strict';
import {
  applyColorBlind,
  applyFontStyle,
  COLOR_BLIND_KEY,
  DEFAULT_COLOR_BLIND,
  DEFAULT_FONT_STYLE,
  FONT_STYLE_KEY,
  FONT_STYLES,
  isFontStyle,
  readColorBlind,
  readFontStyle,
  writeColorBlind,
  writeFontStyle
} from '../src/lib/a11y.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// A tiny in-memory stand-in for localStorage, plus one that throws — the same
// shape theme.test uses to prove the guards actually guard.
function fakeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v))
  };
}
const throwingStorage = {
  getItem: () => { throw new Error('locked down'); },
  setItem: () => { throw new Error('locked down'); }
};
function fakeRoot() {
  const attrs = {};
  return { setAttribute: (k, v) => { attrs[k] = v; }, attrs };
}

// ---------- font style ----------

await test('FONT_STYLES lists fantasy, easy-read and opendyslexic, fantasy default', () => {
  const ids = FONT_STYLES.map((f) => f.id);
  assert.deepEqual(ids, ['fantasy', 'easy-read', 'opendyslexic']);
  assert.equal(DEFAULT_FONT_STYLE, 'fantasy');
});

await test('isFontStyle only accepts known ids', () => {
  assert.equal(isFontStyle('fantasy'), true);
  assert.equal(isFontStyle('easy-read'), true);
  assert.equal(isFontStyle('opendyslexic'), true);
  assert.equal(isFontStyle('comic-sans'), false);
  assert.equal(isFontStyle(undefined), false);
});

await test('readFontStyle: no storage, empty storage, or garbage all fall back to fantasy', () => {
  assert.equal(readFontStyle(null), DEFAULT_FONT_STYLE);
  assert.equal(readFontStyle(fakeStorage()), DEFAULT_FONT_STYLE);
  const s = fakeStorage();
  s.setItem(FONT_STYLE_KEY, 'nonsense');
  assert.equal(readFontStyle(s), DEFAULT_FONT_STYLE);
});

await test('readFontStyle: a broken localStorage never throws', () => {
  assert.equal(readFontStyle(throwingStorage), DEFAULT_FONT_STYLE);
});

await test('writeFontStyle + readFontStyle round-trip', () => {
  const s = fakeStorage();
  assert.equal(writeFontStyle('easy-read', s), true);
  assert.equal(readFontStyle(s), 'easy-read');
});

await test('writeFontStyle rejects an unknown style and never touches storage', () => {
  const s = fakeStorage();
  assert.equal(writeFontStyle('nonsense', s), false);
  assert.equal(readFontStyle(s), DEFAULT_FONT_STYLE);
});

await test('writeFontStyle on a broken localStorage never throws', () => {
  assert.equal(writeFontStyle('easy-read', throwingStorage), false);
});

await test('applyFontStyle sets data-font, falling back to fantasy for a bad value', () => {
  const root = fakeRoot();
  assert.equal(applyFontStyle('opendyslexic', root), 'opendyslexic');
  assert.equal(root.attrs['data-font'], 'opendyslexic');
  assert.equal(applyFontStyle('nonsense', root), DEFAULT_FONT_STYLE);
  assert.equal(root.attrs['data-font'], DEFAULT_FONT_STYLE);
});

await test('applyFontStyle tolerates a missing root', () => {
  assert.equal(applyFontStyle('easy-read', null), 'easy-read');
});

// ---------- colour-blind mode ----------

await test('DEFAULT_COLOR_BLIND is off', () => {
  assert.equal(DEFAULT_COLOR_BLIND, false);
});

await test('readColorBlind: no storage or empty storage default to off', () => {
  assert.equal(readColorBlind(null), false);
  assert.equal(readColorBlind(fakeStorage()), false);
});

await test('readColorBlind: only the literal "on" value turns it on', () => {
  const s = fakeStorage();
  s.setItem(COLOR_BLIND_KEY, 'on');
  assert.equal(readColorBlind(s), true);
  s.setItem(COLOR_BLIND_KEY, 'off');
  assert.equal(readColorBlind(s), false);
  s.setItem(COLOR_BLIND_KEY, 'yes');
  assert.equal(readColorBlind(s), false);
});

await test('readColorBlind on a broken localStorage never throws', () => {
  assert.equal(readColorBlind(throwingStorage), false);
});

await test('writeColorBlind + readColorBlind round-trip both ways', () => {
  const s = fakeStorage();
  writeColorBlind(true, s);
  assert.equal(readColorBlind(s), true);
  writeColorBlind(false, s);
  assert.equal(readColorBlind(s), false);
});

await test('writeColorBlind on a broken localStorage never throws', () => {
  assert.equal(writeColorBlind(true, throwingStorage), false);
});

await test('applyColorBlind sets data-cvd to on/off and returns a boolean', () => {
  const root = fakeRoot();
  assert.equal(applyColorBlind(true, root), true);
  assert.equal(root.attrs['data-cvd'], 'on');
  assert.equal(applyColorBlind(false, root), false);
  assert.equal(root.attrs['data-cvd'], 'off');
});

await test('applyColorBlind tolerates a missing root', () => {
  assert.equal(applyColorBlind(true, null), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
