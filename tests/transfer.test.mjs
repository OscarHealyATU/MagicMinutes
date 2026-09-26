// Plain-node test for src/lib/transfer.mjs and the theme helpers — export
// payload shape, validation of files handed back to us, and what an import
// would change. Run with: node tests/transfer.test.mjs

import assert from 'node:assert/strict';
import { COLLECTIONS, applyDefaults, buildCreateDoc } from '../src/lib/store.mjs';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExport,
  buildNotesExport,
  NOTES_FORMAT,
  notesExportFilename,
  parseNotesFile,
  cleanDoc,
  countDocs,
  describePlan,
  describePlanByCollection,
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
  assert.deepEqual(parsed.duplicates, []);
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

await test('parseExport: a duplicate _id within one collection is collapsed, last one wins, reported once', () => {
  const parsed = parseExport(
    JSON.stringify(wrap({ notes: [doc('a', { title: 'first' }), doc('a', { title: 'second' })] }))
  );
  assert.equal(parsed.collections.notes.length, 1);
  assert.equal(parsed.collections.notes[0].title, 'second');
  assert.deepEqual(parsed.duplicates, ['notes']);
});

await test('parseExport: cleans document shapes per collection so a bad field cannot crash a view', () => {
  const parsed = parseExport(
    JSON.stringify(
      wrap({
        sessions: [{ _id: 's1', number: 1, active: 'nope' }], // no `activity` at all
        places: [{ _id: 'p1', connections: 'not an array' }],
        npcs: [{ _id: 'n1', relations: [{ targetId: 'missing text' }, 'garbage', null] }]
      })
    )
  );
  assert.deepEqual(parsed.collections.sessions[0].activity, []);
  assert.equal(parsed.collections.sessions[0].active, false);
  assert.deepEqual(parsed.collections.places[0].connections, []);
  assert.deepEqual(parsed.collections.npcs[0].relations, [{ targetId: 'missing text', type: 'knows', text: '' }]);
});

await test('cleanDoc: coerces each collection to the shape its view expects', () => {
  assert.deepEqual(cleanDoc('sessions', { _id: 's', activity: 'nope', number: 'three' }).activity, []);
  assert.equal(cleanDoc('sessions', { _id: 's', number: 'three' }).number, 1, 'bad number falls back rather than becoming NaN');
  assert.deepEqual(cleanDoc('places', { _id: 'p', connections: null }).connections, []);
  assert.equal(cleanDoc('places', { _id: 'p', name: 42 }).name, '42');
  assert.deepEqual(cleanDoc('npcs', { _id: 'n', relations: 'nope' }).relations, []);
  assert.equal(cleanDoc('npcs', { _id: 'n', alignment: 'lots' }).alignment, 0);
  assert.equal(cleanDoc('unknown-collection', { _id: 'x', anything: 1 }).anything, 1, 'unknown collection passes through');
});

await test('cleanDoc: combos and rolls coerce each array entry too, not just the array itself', () => {
  // A bare string/null block would throw when CombosView reads `b.type` off
  // it; a non-number roll would throw as an invalid React child.
  const combo = cleanDoc('combos', { _id: 'c', blocks: [{ type: 'action', text: 'Hit' }, 'garbage', null, 42] });
  assert.deepEqual(combo.blocks, [
    { type: 'action', text: 'Hit', condition: '', roll: '' }
  ]);
  const roll = cleanDoc('rolls', { _id: 'r', rolls: [4, '5', null, { bad: 1 }, 'six'] });
  assert.deepEqual(roll.rolls, [4, 5, 0, 0, 0]);
});

await test('cleanDoc: matches store.mjs\'s own document shape exactly, for every collection — the no-op re-import guarantee holds on real app data, not just hand-built fixtures', () => {
  const now = () => '2026-09-01T00:00:00.000Z';
  const genId = (() => {
    let n = 0;
    return () => `id${n++}`;
  })();
  for (const name of COLLECTIONS) {
    const real = buildCreateDoc(name, {}, { now, genId });
    const cleaned = cleanDoc(name, real);
    assert.deepEqual(cleaned, real, `cleanDoc(${name}, ...) should be a no-op on a document store.mjs itself just created`);
  }
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

await test('replace: deletes whatever a collection it DOES cover does not mention', () => {
  const existing = { notes: [doc('gone'), doc('shared')], places: [doc('p1')] };
  // `places: []` — present in the file, just empty — is different from the
  // file never mentioning places at all (see the next test).
  const incoming = { notes: [doc('shared'), doc('new')], places: [] };
  const { plan, totals } = planImport(existing, incoming, 'replace');

  assert.deepEqual(plan.notes.remove, ['gone']);
  assert.deepEqual(plan.notes.create.map((d) => d._id), ['new']);
  assert.deepEqual(plan.notes.update, [], 'the unchanged "shared" doc is not counted as replaced');
  assert.deepEqual(plan.places.remove, ['p1']);
  assert.deepEqual(totals, { create: 1, update: 0, remove: 2 });
});

await test('replace: a collection the file never mentions is left alone, not wiped', () => {
  // The bug this guards: a backup holding only `notes` used to plan
  // "1 replaced, 4 deleted" — removing every NPC, group and session — because
  // a missing key read as "the file wants zero of these".
  const existing = { notes: [doc('n1')], places: [doc('p1')], npcs: [doc('x1')], groups: [doc('g1')] };
  const incoming = { notes: [doc('n1')] }; // no `places`/`npcs`/`groups` key at all
  const { plan, totals } = planImport(existing, incoming, 'replace');
  assert.deepEqual(plan.places, { create: [], update: [], remove: [] });
  assert.deepEqual(plan.npcs, { create: [], update: [], remove: [] });
  assert.deepEqual(plan.groups, { create: [], update: [], remove: [] });
  assert.deepEqual(totals, { create: 0, update: 0, remove: 0 });
});

await test('planImport: importing an export of the current state is a true no-op', () => {
  // Realistic, already-clean shapes: cleanDoc is idempotent on a document
  // that already has every field a view expects, so the round trip really
  // changes nothing (the plain `doc()` fixture above is deliberately bare —
  // running it through cleanDoc would fill in note/place fields it never
  // had, which is a real difference, not a false one).
  const existing = {
    notes: [{ _id: 'a', title: 'A', category: 'Misc', place: '', tags: [], content: '', pinned: false }],
    places: [{ _id: 'b', name: 'B', type: 'Town', description: '', notes: '', connections: [], mapX: null, mapY: null }]
  };
  const roundTrip = parseExport(JSON.stringify(buildExport(existing)));
  const { totals } = planImport(existing, roundTrip.collections, 'replace');
  assert.deepEqual(totals, { create: 0, update: 0, remove: 0 });
  assert.match(describePlan({ mode: 'replace', totals }), /Nothing to change/);
});

await test('planImport: only documents that actually changed count as an update', () => {
  const existing = { notes: [doc('a', { title: 'same' }), doc('b', { title: 'old' })] };
  const incoming = { notes: [doc('a', { title: 'same' }), doc('b', { title: 'new' })] };
  const { plan, totals } = planImport(existing, incoming, 'merge');
  assert.deepEqual(plan.notes.update.map((d) => d._id), ['b']);
  assert.deepEqual(totals, { create: 0, update: 1, remove: 0 });
});

await test('planImport: sessions — a merge that would leave 2+ active sessions keeps only the newest', () => {
  const existing = {
    sessions: [doc('old', { active: true, startedAt: '2026-01-01T00:00:00.000Z' })]
  };
  const incoming = {
    sessions: [doc('new', { active: true, startedAt: '2026-06-01T00:00:00.000Z' })]
  };
  const { plan } = planImport(existing, incoming, 'merge');
  // The incoming session is a create, unaffected; the existing one wasn't
  // otherwise touched by this import, but still needs deactivating.
  const created = plan.sessions.create.find((d) => d._id === 'new');
  const deactivated = plan.sessions.update.find((d) => d._id === 'old');
  assert.ok(created && created.active === true);
  assert.ok(deactivated && deactivated.active === false);
});

await test('describePlanByCollection: a per-collection breakdown for the confirm dialog', () => {
  const existing = { notes: [doc('gone')], places: [doc('p1')] };
  const incoming = { notes: [doc('new')], places: [] };
  const { plan } = planImport(existing, incoming, 'replace');
  const lines = describePlanByCollection({ plan }, (n) => ({ notes: 'Notes', places: 'Places' })[n] || n);
  assert.deepEqual(lines, ['Notes: 1 added, 1 deleted', 'Places: 1 deleted']);
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
