// Plain-node test for src/lib/recap.mjs (session-material collection and
// summary drafting) and pickModel from src/lib/ollama.mjs. No network calls —
// detectOllama/generate are exercised manually, not here. Run with:
// node tests/recap.test.mjs

import assert from 'node:assert/strict';
import { buildPrompt, collectSessionMaterial, draftSummary } from '../src/lib/recap.mjs';
import { pickModel } from '../src/lib/ollama.mjs';

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

const note = (over = {}) => ({
  title: 'Untitled note',
  category: 'Misc',
  place: '',
  tags: [],
  content: '',
  createdAt: '2026-08-02T19:00:00.000Z',
  updatedAt: '2026-08-02T19:00:00.000Z',
  ...over
});
const place = (over = {}) => ({
  name: 'Unnamed place',
  type: 'Town',
  description: '',
  createdAt: '2026-08-02T19:00:00.000Z',
  updatedAt: '2026-08-02T19:00:00.000Z',
  ...over
});
const npc = (over = {}) => ({
  name: '',
  descriptor: '',
  disposition: 'Unknown',
  notes: '',
  createdAt: '2026-08-02T19:00:00.000Z',
  updatedAt: '2026-08-02T19:00:00.000Z',
  ...over
});
const session = (over = {}) => ({
  startedAt: '2026-08-02T18:00:00.000Z',
  endedAt: '2026-08-02T21:00:00.000Z',
  activity: [],
  ...over
});

// ---------- collectSessionMaterial ----------

await test('collectSessionMaterial: matches docs referenced by the activity log', () => {
  const s = session({
    activity: [
      { kind: 'place', name: 'Eberald', action: 'created' },
      { kind: 'npc', name: 'Bram the Smith', action: 'updated' },
      { kind: 'note', name: 'The heist plan', action: 'created' },
      { kind: 'combo', name: 'Nova Round', action: 'created' } // not a material kind
    ]
  });
  const material = collectSessionMaterial(s, {
    notes: [note({ title: 'The heist plan', content: 'We planned the job.' }), note({ title: 'Unrelated' })],
    places: [place({ name: 'Eberald' }), place({ name: 'Somewhere else' })],
    npcs: [npc({ name: 'Bram the Smith', descriptor: 'the blacksmith' })]
  });

  assert.equal(material.notes.length, 1);
  assert.equal(material.notes[0].title, 'The heist plan');
  assert.equal(material.places.length, 1);
  assert.equal(material.places[0].name, 'Eberald');
  assert.equal(material.npcs.length, 1);
  assert.equal(material.npcs[0].name, 'Bram the Smith');
  assert.equal(material.durationMinutes, 180);
});

await test('collectSessionMaterial: falls back to a time window when activity is empty', () => {
  const s = session({ startedAt: '2026-08-02T18:00:00.000Z', endedAt: '2026-08-02T20:00:00.000Z', activity: [] });
  const inside = note({ title: 'In window', updatedAt: '2026-08-02T19:00:00.000Z', createdAt: '2026-08-02T19:00:00.000Z' });
  const before = note({ title: 'Too early', updatedAt: '2026-08-02T10:00:00.000Z', createdAt: '2026-08-02T10:00:00.000Z' });
  const after = note({ title: 'Too late', updatedAt: '2026-08-03T10:00:00.000Z', createdAt: '2026-08-03T10:00:00.000Z' });

  const material = collectSessionMaterial(s, { notes: [inside, before, after], places: [], npcs: [] });
  assert.deepEqual(material.notes.map((n) => n.title), ['In window']);
});

await test('collectSessionMaterial: missing endedAt (live session) does not throw and durationMinutes is null', () => {
  const s = session({ endedAt: null, activity: [] });
  const material = collectSessionMaterial(s, { notes: [], places: [], npcs: [] });
  assert.equal(material.durationMinutes, null);
  assert.deepEqual(material.notes, []);
});

// ---------- draftSummary ----------

await test('draftSummary: mentions every place and npc name, and note titles', () => {
  const material = collectSessionMaterial(
    session({ activity: [
      { kind: 'place', name: 'Eberald' },
      { kind: 'place', name: 'The Sunken Quay' },
      { kind: 'npc', name: 'Bram the Smith' },
      { kind: 'note', name: 'A dark bargain' }
    ] }),
    {
      notes: [note({ title: 'A dark bargain', content: 'The party met a stranger in the alley. More followed.' })],
      places: [place({ name: 'Eberald' }), place({ name: 'The Sunken Quay' })],
      npcs: [npc({ name: 'Bram the Smith', descriptor: 'the blacksmith' })]
    }
  );
  const summary = draftSummary(material);
  assert.match(summary, /Eberald/);
  assert.match(summary, /The Sunken Quay/);
  assert.match(summary, /Bram the Smith/);
  assert.match(summary, /A dark bargain/);
  assert.doesNotMatch(summary, /undefined/);
});

await test('draftSummary: handles completely empty material gracefully', () => {
  const material = collectSessionMaterial(session({ activity: [] }), { notes: [], places: [], npcs: [] });
  const summary = draftSummary(material);
  assert.match(summary, /No notes were written this session\./);
  assert.doesNotMatch(summary, /undefined/);
  assert.ok(summary.length > 0);
});

await test('draftSummary: never leaks "undefined" for docs missing optional fields', () => {
  const material = {
    notes: [{ title: 'Bare note', content: '' }],
    places: [{ name: 'Bare place' }],
    npcs: [{ name: '', descriptor: '' }],
    durationMinutes: null
  };
  const summary = draftSummary(material);
  assert.doesNotMatch(summary, /undefined/);
});

// ---------- buildPrompt ----------

await test('buildPrompt: contains the summarising instruction and every note title', () => {
  const material = collectSessionMaterial(
    session({ activity: [
      { kind: 'note', name: 'First note' },
      { kind: 'note', name: 'Second note' }
    ] }),
    {
      notes: [note({ title: 'First note', content: 'Stuff happened.' }), note({ title: 'Second note', content: 'More stuff.' })],
      places: [],
      npcs: []
    }
  );
  const prompt = buildPrompt(material);
  assert.match(prompt, /summarising one session of a tabletop RPG/);
  assert.match(prompt, /do not invent events/);
  assert.match(prompt, /First note/);
  assert.match(prompt, /Second note/);
});

await test('buildPrompt: says "none recorded" for empty sections rather than omitting them', () => {
  const material = collectSessionMaterial(session({ activity: [] }), { notes: [], places: [], npcs: [] });
  const prompt = buildPrompt(material);
  assert.match(prompt, /Places visited:\n- none recorded/);
  assert.match(prompt, /People met:\n- none recorded/);
  assert.match(prompt, /Notes from the session:\n- none recorded/);
});

// ---------- pickModel ----------

await test('pickModel: prefers models in the documented order', () => {
  const models = [
    { name: 'llama3.2:3b', sizeBytes: 2_000_000_000 },
    { name: 'qwen2.5:1.5b', sizeBytes: 900_000_000 },
    { name: 'gemma3:1b', sizeBytes: 800_000_000 }
  ];
  assert.equal(pickModel(models), 'gemma3:1b');
  assert.equal(pickModel(models.filter((m) => m.name !== 'gemma3:1b')), 'qwen2.5:1.5b');
});

await test('pickModel: falls back to the smallest installed model by size', () => {
  const models = [
    { name: 'mystery-model:70b', sizeBytes: 40_000_000_000 },
    { name: 'another-one:8b', sizeBytes: 5_000_000_000 },
    { name: 'tiny-one:2b', sizeBytes: 1_500_000_000 }
  ];
  assert.equal(pickModel(models), 'tiny-one:2b');
});

await test('pickModel: an empty or missing model list returns null', () => {
  assert.equal(pickModel([]), null);
  assert.equal(pickModel(undefined), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
