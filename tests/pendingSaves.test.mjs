// Plain-node test for src/lib/pendingSaves.js: a campaign switch waits on
// these before reloading, so a save must never be missed. Run with:
// node tests/pendingSaves.test.mjs

import assert from 'node:assert/strict';
import { trackSave, waitForPendingSaves } from '../src/lib/pendingSaves.js';

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

const later = (ms, value, fail = false) =>
  new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error('x')) : resolve(value)), ms));

await test('waits for every tracked save, including slow ones', async () => {
  const landed = [];
  trackSave(later(30, 'a').then(() => landed.push('a')));
  trackSave(later(5, 'b').then(() => landed.push('b')));
  await waitForPendingSaves();
  assert.deepEqual(landed.sort(), ['a', 'b']);
});

await test('a failed save does not stop the wait, and is still rejected for its caller', async () => {
  const failing = trackSave(later(5, null, true));
  await assert.rejects(failing);
  await waitForPendingSaves();
});

await test('also waits for a save started while it was already waiting', async () => {
  let second = false;
  trackSave(later(10));
  // Joins the queue after the wait has begun, and finishes after the first.
  setTimeout(() => trackSave(later(30).then(() => (second = true))), 5);
  await waitForPendingSaves();
  assert.equal(second, true);
});

await test('returns straight away when nothing is pending', async () => {
  await waitForPendingSaves();
});

await test('trackSave hands back the same promise', async () => {
  const p = later(1, 42);
  assert.equal(trackSave(p), p);
  assert.equal(await p, 42);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
