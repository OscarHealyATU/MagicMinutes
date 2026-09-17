// Plain-node test for src/lib/transfer.mjs and the theme helpers — export
// payload shape, validation of files handed back to us, and what an import
// would change. Run with: node tests/transfer.test.mjs

import assert from 'node:assert/strict';
import { COLLECTIONS } from '../src/lib/store.mjs';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExport,
  buildNotesExport,
  NOTES_FORMAT,
  notesExportFilename,
  parseNotesFile,
  countDocs,
  describePlan,
  exportFilename,
  parseExport,
  planImport
} from '../src/lib/transfer.mjs';
import { DEFAULT_THEME, applyTheme, isTheme, readTheme, writeTheme } from '../src/lib/theme.mjs';

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

const doc = (id, extra = {}) => ({ _id: id, name: id, ...extra });
const wrap = (collections) => ({
  format: EXPORT_FORMAT,
  version: EXPORT_VERSION,
  exportedAt: '2026-08-02T00:00:00.000Z',
  collections
});

// ---------- export ----------

await test('buildExport: stamps format/version and includes every collection', () => {
  const out = buildExport({ notes: [doc('n1')] }, { now: () => 'TS' });
  assert.equal(out.format, EXPORT_FORMAT);
  assert.equal(out.version, EXPORT_VERSION);
  assert.equal(out.exportedAt, 'TS');
  for (const name of COLLECTIONS) {
    assert.ok(Array.isArray(out.collections[name]), `${name} missing from export`);
  }
  assert.equal(out.collections.notes.length, 1);
  assert.equal(out.collections.places.length, 0);
});

await test('countDocs and exportFilename', () => {
  assert.equal(countDocs({ notes: [doc('a'), doc('b')], npcs: [doc('c')] }), 3);
  assert.equal(countDocs({}), 0);
  assert.equal(exportFilename(new Date('2026-08-02T13:00:00Z')), 'magicminutes-backup-2026-08-02.json');
});

await test('export survives a JSON round-trip back through parseExport', () => {
  const built = buildExport({ notes: [doc('n1', { title: 'Bell tower' })] });
  const parsed = parseExport(JSON.stringify(built));
  assert.equal(parsed.collections.notes[0].title, 'Bell tower');
  assert.deepEqual(parsed.skipped, []);
});

// ---------- import validation ----------

await test('parseExport: rejects junk with a message a human can act on', () => {
  assert.throws(() => parseExport('not json at all'), /valid JSON/);
  assert.throws(() => parseExport('[]'), /does not contain/);
  assert.throws(() => parseExport(JSON.stringify({ format: 'something-else' })), /not a MagicMinutes export/);
  assert.throws(
    () => parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, collections: {} })),
    /newer version/
  );
  assert.throws(
    () => parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 1 })),
    /no collections/
  );
});

await test('parseExport: a collection that is not a list, or docs with no id, is an error', () => {
  assert.throws(() => parseExport(JSON.stringify(wrap({ notes: 'nope' }))), /not a list/);
  assert.throws(
    () => parseExport(JSON.stringify(wrap({ notes: [{ title: 'no id here' }] }))),
    /have no id/
  );
});

await test('parseExport: unknown sections are reported, not fatal', () => {
  const parsed = parseExport(JSON.stringify(wrap({ notes: [doc('n1')], spaceships: [doc('s1')] })));
  assert.deepEqual(parsed.skipped, ['spaceships']);
  assert.equal(parsed.collections.spaceships, undefined);
  assert.equal(parsed.collections.notes.length, 1);
});

// ---------- import planning ----------

await test('merge: adds missing, overwrites matching ids, never deletes', () => {
  const existing = { notes: [doc('keep'), doc('shared', { title: 'mine' })] };
  const incoming = { notes: [doc('shared', { title: 'theirs' }), doc('new')] };
  const { plan, totals } = planImport(existing, incoming, 'merge');

  assert.deepEqual(plan.notes.create.map((d) => d._id), ['new']);
  assert.deepEqual(plan.notes.update.map((d) => d._id), ['shared']);
  assert.deepEqual(plan.notes.remove, []);
  assert.equal(plan.notes.update[0].title, 'theirs', 'incoming wins on a clash');
  assert.deepEqual(totals, { create: 1, update: 1, remove: 0 });
});

await test('merge: a collection the file omits is left completely alone', () => {
  const existing = { notes: [doc('n1')], places: [doc('p1')] };
  const { plan, totals } = planImport(existing, { notes: [doc('n1')] }, 'merge');
  assert.deepEqual(plan.places, { create: [], update: [], remove: [] });
  assert.equal(totals.remove, 0);
});

await test('replace: deletes whatever the file does not mention, including whole collections', () => {
  const existing = { notes: [doc('gone'), doc('shared')], places: [doc('p1')] };
  const incoming = { notes: [doc('shared'), doc('new')] };
  const { plan, totals } = planImport(existing, incoming, 'replace');

  assert.deepEqual(plan.notes.remove, ['gone']);
  assert.deepEqual(plan.notes.create.map((d) => d._id), ['new']);
  // places isn't in the file at all, so replace clears it
  assert.deepEqual(plan.places.remove, ['p1']);
  assert.deepEqual(totals, { create: 1, update: 1, remove: 2 });
});

await test('planImport: importing an export of the current state is a no-op', () => {
  const existing = { notes: [doc('a')], places: [doc('b')] };
  const roundTrip = parseExport(JSON.stringify(buildExport(existing)));
  const { totals } = planImport(existing, roundTrip.collections, 'replace');
  assert.deepEqual(totals, { create: 0, update: 2, remove: 0 });
});

await test('planImport: rejects an unknown mode rather than guessing', () => {
  assert.throws(() => planImport({}, {}, 'obliterate'), /Unknown import mode/);
});

await test('describePlan: readable summaries', () => {
  assert.match(describePlan({ mode: 'merge', totals: { create: 2, update: 1, remove: 0 } }), /2 added, 1 replaced/);
  assert.match(describePlan({ mode: 'merge', totals: { create: 0, update: 0, remove: 0 } }), /Nothing to change/);
});

// ---------- theme ----------

await test('theme: reads, validates and stores, and survives a hostile localStorage', () => {
  const store = new Map();
  const ok = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

  assert.equal(readTheme(ok), DEFAULT_THEME);
  assert.equal(writeTheme('light', ok), true);
  assert.equal(readTheme(ok), 'light');

  // Garbage in storage falls back rather than breaking the stylesheet.
  store.set('ttrpgmap.theme', 'chartreuse');
  assert.equal(readTheme(ok), DEFAULT_THEME);
  assert.equal(writeTheme('chartreuse', ok), false);

  const throws = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };
  assert.equal(readTheme(throws), DEFAULT_THEME);
  assert.equal(writeTheme('light', throws), false);
  assert.equal(readTheme(null), DEFAULT_THEME);

  assert.equal(isTheme('dark'), true);
  assert.equal(isTheme('neon'), false);
});

await test('applyTheme: writes the attribute the stylesheet keys off', () => {
  const attrs = {};
  const root = { setAttribute: (k, v) => (attrs[k] = v) };
  assert.equal(applyTheme('light', root), 'light');
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(applyTheme('nonsense', root), DEFAULT_THEME);
  assert.equal(attrs['data-theme'], DEFAULT_THEME);
});

await test('shared notes file: its own format, refused as a campaign backup, read by parseNotesFile', () => {
  const notes = [
    { _id: 'a', title: 'One', category: 'Quest', place: '', tags: ['x'], content: 'Hi', pinned: false, createdAt: '2026-09-16T00:00:00.000Z' }
  ];
  const file = buildNotesExport(notes, { now: () => '2026-09-16T00:00:00.000Z' });
  assert.equal(file.format, NOTES_FORMAT);
  assert.notEqual(file.format, EXPORT_FORMAT, 'older builds must not take it for a backup');
  assert.throws(() => parseExport(JSON.stringify(file)), /Notes page/);
  assert.equal(notesExportFilename(new Date('2026-09-16T10:00:00Z')), 'magicminutes-notes-2026-09-16.json');
  const back = parseNotesFile(JSON.stringify(file));
  assert.deepEqual(back.notes, notes);
  assert.deepEqual(back.warnings, []);
});

await test('parseNotesFile: takes just the notes from a full backup, and cleans odd or repeated entries', () => {
  const backup = buildExport({
    notes: [
      { _id: 'a', title: 'Good', tags: ['t'], content: 'c', category: 'lore', pinned: true },
      { _id: 'a', title: 'Same id again' },
      { _id: 'b', tags: 'one, two', title: 42, pinned: 'yes', category: 'Nonsense', extra: { evil: 1 } },
      null
    ],
    places: [{ _id: 'p' }]
  });
  const { notes, warnings } = parseNotesFile(JSON.stringify(backup));
  assert.equal(notes.length, 2);
  assert.deepEqual(notes[0], { _id: 'a', title: 'Good', category: 'Lore', place: '', tags: ['t'], content: 'c', pinned: true });
  assert.deepEqual(notes[1], { _id: 'b', title: '42', category: 'Misc', place: '', tags: ['one', 'two'], content: '', pinned: false });
  assert.equal(warnings.length, 2, 'left-out entries, and the places it did not import');
  assert.throws(() => parseNotesFile('not json'), /valid JSON/);
  assert.throws(() => parseNotesFile('{"format":"something-else","version":1}'), /not a MagicMinutes/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
