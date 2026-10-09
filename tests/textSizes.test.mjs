// Plain-node test for src/lib/textSizes.mjs — the per-role text size
// multipliers, mirroring theme.test/a11y.test's coverage of the guarded
// localStorage + apply pattern. Run with: node tests/textSizes.test.mjs

import assert from 'node:assert/strict';
import {
  applyTextSizes,
  clampTextSize,
  clampTextSizes,
  DEFAULT_TEXT_SIZES,
  readTextSizes,
  TEXT_SIZE_KEY,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_SIZE_ROLES,
  TEXT_SIZE_STEP,
  writeTextSizes
} from '../src/lib/textSizes.mjs';

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
  const props = {};
  return { style: { setProperty: (k, v) => { props[k] = v; } }, props };
}

// ---------- clampTextSize ----------

await test('clampTextSize passes through an already-valid step', () => {
  assert.equal(clampTextSize(1), 1);
  assert.equal(clampTextSize(1.2), 1.2);
  assert.equal(clampTextSize(0.8), 0.8);
  assert.equal(clampTextSize(1.5), 1.5);
});

await test('clampTextSize snaps to the nearest 5% step', () => {
  assert.equal(clampTextSize(1.03), 1.05);
  assert.equal(clampTextSize(1.11), 1.1);
  assert.equal(clampTextSize(0.97), 0.95);
});

await test('clampTextSize clamps below the minimum and above the maximum', () => {
  assert.equal(clampTextSize(0.1), TEXT_SIZE_MIN);
  assert.equal(clampTextSize(-5), TEXT_SIZE_MIN);
  assert.equal(clampTextSize(3), TEXT_SIZE_MAX);
});

await test('clampTextSize falls back to 1 for garbage', () => {
  assert.equal(clampTextSize('nonsense'), 1);
  assert.equal(clampTextSize(undefined), 1);
  assert.equal(clampTextSize(NaN), 1);
  assert.equal(clampTextSize(null), 1);
});

await test('clampTextSize avoids float drift from repeated step arithmetic', () => {
  // 0.1 + 0.05 isn't exactly 0.15 in floating point — make sure the
  // rounding step actually lands on a clean two-decimal value.
  const stepped = 1 + TEXT_SIZE_STEP_SUM(3);
  assert.equal(clampTextSize(stepped), 1.15);
});
function TEXT_SIZE_STEP_SUM(times) {
  let v = 0;
  for (let i = 0; i < times; i++) v += TEXT_SIZE_STEP;
  return v;
}

// ---------- clampTextSizes ----------

await test('clampTextSizes fills in every role, defaulting missing ones to 1', () => {
  const out = clampTextSizes({ body: 1.2 });
  assert.deepEqual(Object.keys(out).sort(), [...TEXT_SIZE_ROLES].sort());
  assert.equal(out.body, 1.2);
  assert.equal(out.headings, 1);
  assert.equal(out.ui, 1);
  assert.equal(out.map, 1);
  assert.equal(out.small, 1);
});

await test('clampTextSizes tolerates null/undefined/non-object input', () => {
  assert.deepEqual(clampTextSizes(null), DEFAULT_TEXT_SIZES);
  assert.deepEqual(clampTextSizes(undefined), DEFAULT_TEXT_SIZES);
  assert.deepEqual(clampTextSizes('nonsense'), DEFAULT_TEXT_SIZES);
  assert.deepEqual(clampTextSizes(42), DEFAULT_TEXT_SIZES);
});

await test('clampTextSizes clamps every role independently, out of range or not', () => {
  const out = clampTextSizes({ body: 5, headings: -1, ui: 1.23, map: 'nonsense', small: 0.8 });
  assert.equal(out.body, TEXT_SIZE_MAX);
  assert.equal(out.headings, TEXT_SIZE_MIN);
  assert.equal(out.ui, 1.25);
  assert.equal(out.map, 1); // garbage falls back to 1, not the default object's copy
  assert.equal(out.small, 0.8);
});

// ---------- read/write round trip ----------

await test('readTextSizes: no storage, empty storage, or garbage JSON all fall back to defaults', () => {
  assert.deepEqual(readTextSizes(null), DEFAULT_TEXT_SIZES);
  assert.deepEqual(readTextSizes(fakeStorage()), DEFAULT_TEXT_SIZES);
  const s = fakeStorage();
  s.setItem(TEXT_SIZE_KEY, '{not json');
  assert.deepEqual(readTextSizes(s), DEFAULT_TEXT_SIZES);
});

await test('readTextSizes on a broken localStorage never throws', () => {
  assert.deepEqual(readTextSizes(throwingStorage), DEFAULT_TEXT_SIZES);
});

await test('writeTextSizes + readTextSizes round-trip, clamped on the way in', () => {
  const s = fakeStorage();
  writeTextSizes({ body: 1.3, headings: 1, ui: 1, map: 1, small: 5 }, s);
  const back = readTextSizes(s);
  assert.equal(back.body, 1.3);
  assert.equal(back.small, TEXT_SIZE_MAX);
});

await test('writeTextSizes on a broken localStorage never throws, returns false', () => {
  assert.equal(writeTextSizes(DEFAULT_TEXT_SIZES, throwingStorage), false);
});

// ---------- applyTextSizes ----------

await test('applyTextSizes sets one --ts-<role> custom property per role', () => {
  const root = fakeRoot();
  const applied = applyTextSizes({ body: 1.2, headings: 1, ui: 1, map: 1, small: 1 }, root);
  assert.equal(root.props['--ts-body'], 1.2);
  assert.equal(root.props['--ts-headings'], 1);
  assert.equal(root.props['--ts-ui'], 1);
  assert.equal(root.props['--ts-map'], 1);
  assert.equal(root.props['--ts-small'], 1);
  assert.equal(applied.body, 1.2);
});

await test('applyTextSizes tolerates a missing root', () => {
  const applied = applyTextSizes({ body: 1.1 }, null);
  assert.equal(applied.body, 1.1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
