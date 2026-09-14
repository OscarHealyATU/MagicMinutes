// Plain-node test for src/lib/store.mjs — the pure(ish) document-store logic
// layer, exercised against an in-memory fake driver instead of a real SQLite
// database. Run with: node tests/store.test.mjs

import assert from 'node:assert/strict';
import * as store from '../src/lib/store.mjs';

// ---------- tiny fake driver: Map-backed, understands only the exact SQL
// shapes store.mjs issues (see the queries in src/lib/store.mjs). ----------
function makeFakeDriver() {
  const tables = new Map(); // table name -> Map(id -> doc JSON string)

  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }

  return {
    async execute(sql, params = []) {
      let m;
      if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i))) {
        table(m[1]);
        return { rowsAffected: 0 };
      }
      if ((m = sql.match(/^INSERT INTO (\w+) \(id, doc\) VALUES/i))) {
        const [id, doc] = params;
        table(m[1]).set(id, doc);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^UPDATE (\w+) SET doc = \$1 WHERE id = \$2/i))) {
        const [doc, id] = params;
        table(m[1]).set(id, doc);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^DELETE FROM (\w+) WHERE id = \$1/i))) {
        const [id] = params;
        table(m[1]).delete(id);
        return { rowsAffected: 1 };
      }
      throw new Error(`fake driver: unhandled execute SQL: ${sql}`);
    },
    async select(sql, params = []) {
      let m;
      if ((m = sql.match(/^SELECT doc FROM (\w+) WHERE id = \$1/i))) {
        const [id] = params;
        const row = table(m[1]).get(id);
        return row ? [{ id, doc: row }] : [];
      }
      if ((m = sql.match(/^SELECT doc FROM (\w+)/i))) {
        return Array.from(table(m[1]).entries()).map(([id, doc]) => ({ id, doc }));
      }
      throw new Error(`fake driver: unhandled select SQL: ${sql}`);
    }
  };
}

// Deterministic, monotonically increasing clock + id generator so tests can
// reason exactly about createdAt/updatedAt ordering and session boundaries.
function makeClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000) {
  let t = new Date(startIso).getTime();
  let idCounter = 0;
  return {
    now: () => new Date((t += stepMs)).toISOString(),
    genId: () => `id${(idCounter++).toString().padStart(4, '0')}`
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}

// ---------- defaults on create ----------

await test('notes: defaults applied on create, overrides respected', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const note = await store.createDoc(driver, 'notes', {}, deps);
  assert.equal(note.title, 'Untitled note');
  assert.equal(note.category, 'Misc');
  assert.equal(note.place, '');
  assert.deepEqual(note.tags, []);
  assert.equal(note.content, '');
  assert.equal(note.pinned, false);
  assert.ok(note._id);
  assert.equal(note.createdAt, note.updatedAt);

  const custom = await store.createDoc(driver, 'notes', { title: 'Custom', pinned: true }, deps);
  assert.equal(custom.title, 'Custom');
  assert.equal(custom.pinned, true);
  assert.equal(custom.category, 'Misc'); // untouched fields still default
});

await test('combos: defaults applied on create (blocks: [])', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const combo = await store.createDoc(driver, 'combos', {}, deps);
  assert.equal(combo.name, 'New combo');
  assert.equal(combo.description, '');
  assert.deepEqual(combo.blocks, []);
});

await test('places: defaults applied on create (connections: [], mapX/mapY: null)', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const place = await store.createDoc(driver, 'places', {}, deps);
  assert.equal(place.name, 'Unnamed place');
  assert.equal(place.type, 'Town');
  assert.deepEqual(place.connections, []);
  assert.equal(place.mapX, null);
  assert.equal(place.mapY, null);
});

await test('rolls: defaults applied on create (manual: false, outcome: none)', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const roll = await store.createDoc(driver, 'rolls', {}, deps);
  assert.equal(roll.comboId, '');
  assert.equal(roll.die, 0);
  assert.deepEqual(roll.rolls, []);
  assert.equal(roll.modifier, 0);
  assert.equal(roll.total, 0);
  assert.equal(roll.outcome, 'none');
  assert.equal(roll.manual, false);
});

await test('npcs, players and groups: defaults applied on create', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  // NPCs start nameless on purpose — the Characters page falls back to
  // `descriptor` ("half-orc henchman") for the ones the party never named.
  const npc = await store.createDoc(driver, 'npcs', {}, deps);
  assert.equal(npc.name, '');
  assert.equal(npc.descriptor, '');
  assert.equal(npc.disposition, 'Unknown');
  assert.equal(npc.alignment, 0);
  assert.equal(npc.groupId, '');
  assert.deepEqual(npc.relations, []);

  const player = await store.createDoc(driver, 'players', {}, deps);
  assert.equal(player.characterName, 'New character');
  assert.equal(player.playerName, '');

  const group = await store.createDoc(driver, 'groups', {}, deps);
  assert.equal(group.name, 'New group');
});

// ---------- update: merge + bump updatedAt ----------

await test('updateDoc: shallow-merges patch and bumps updatedAt, preserves _id/createdAt', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const note = await store.createDoc(driver, 'notes', { title: 'Original' }, deps);
  const updated = await store.updateDoc(driver, 'notes', note._id, { title: 'Changed' }, deps);

  assert.equal(updated.title, 'Changed');
  assert.equal(updated.category, 'Misc'); // untouched field survives the merge
  assert.equal(updated._id, note._id);
  assert.equal(updated.createdAt, note.createdAt);
  assert.notEqual(updated.updatedAt, note.updatedAt);
  assert.ok(new Date(updated.updatedAt) > new Date(note.updatedAt));

  // persisted, not just returned
  const reloaded = await store.getDoc(driver, 'notes', note._id);
  assert.equal(reloaded.title, 'Changed');
});

await test('updateDoc: throws Not found for missing id (matches old api.js 404 behavior)', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();
  await assert.rejects(
    () => store.updateDoc(driver, 'notes', 'nonexistent', { title: 'x' }, deps),
    /Not found/
  );
});

await test('unknown resource name is rejected before reaching SQL', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  await assert.rejects(() => store.listDocs(driver, 'notes; DROP TABLE notes'), /Unknown resource/);
});

// ---------- list sort order ----------

await test('listDocs: sorted by updatedAt descending', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const a = await store.createDoc(driver, 'notes', { title: 'A' }, deps);
  const b = await store.createDoc(driver, 'notes', { title: 'B' }, deps);
  const c = await store.createDoc(driver, 'notes', { title: 'C' }, deps);

  let list = await store.listDocs(driver, 'notes');
  assert.deepEqual(list.map((d) => d.title), ['C', 'B', 'A']);

  // touching the oldest one should move it to the front
  await store.updateDoc(driver, 'notes', a._id, { title: 'A (touched)' }, deps);
  list = await store.listDocs(driver, 'notes');
  assert.deepEqual(list.map((d) => d.title), ['A (touched)', 'C', 'B']);
});

await test('listDocs: sessions sorted by startedAt descending', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const s1 = await store.sessionsStart(driver, deps);
  await store.sessionsEnd(driver, s1._id, deps);
  const s2 = await store.sessionsStart(driver, deps);

  const list = await store.listDocs(driver, 'sessions');
  assert.deepEqual(list.map((d) => d._id), [s2._id, s1._id]);
});

// ---------- sessions: start/active/end + recap ----------

await test('sessions: start creates number 1 when none exist, active() finds it', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  assert.equal(await store.sessionsActive(driver), null);

  const s1 = await store.sessionsStart(driver, deps);
  assert.equal(s1.number, 1);
  assert.equal(s1.active, true);
  assert.ok(s1.startedAt);

  const active = await store.sessionsActive(driver);
  assert.equal(active._id, s1._id);
});

await test('sessions: start returns the existing active session instead of creating a new one', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const s1 = await store.sessionsStart(driver, deps);
  const s1again = await store.sessionsStart(driver, deps);
  assert.equal(s1again._id, s1._id);

  const list = await store.listDocs(driver, 'sessions');
  assert.equal(list.length, 1);
});

await test('sessions: number increments after a prior session ended', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const s1 = await store.sessionsStart(driver, deps);
  await store.sessionsEnd(driver, s1._id, deps);
  const s2 = await store.sessionsStart(driver, deps);
  assert.equal(s2.number, 2);
});

await test('sessions: end() recap classifies created vs updated and extracts names per collection', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  // Pre-existing notes, created and last touched before the session starts.
  const oldNote = await store.createDoc(driver, 'notes', { title: 'Pre-existing note' }, deps);
  const untouchedNote = await store.createDoc(driver, 'notes', { title: 'Untouched note' }, deps);

  const session = await store.sessionsStart(driver, deps);

  // Created during the session -> 'created'
  const newNpc = await store.createDoc(driver, 'npcs', { name: 'Grak the Guard' }, deps);
  const newCombo = await store.createDoc(driver, 'combos', { name: 'Sneak Attack' }, deps);
  const newPlace = await store.createDoc(driver, 'places', { name: 'The Rusty Tankard' }, deps);
  // Player with empty characterName should fall back to playerName.
  const newPlayer = await store.createDoc(
    driver,
    'players',
    { characterName: '', playerName: 'Oscar' },
    deps
  );

  // Pre-existing note touched during the session -> 'updated'
  await store.updateDoc(driver, 'notes', oldNote._id, { title: 'Pre-existing note (edited)' }, deps);

  // untouchedNote is never touched during the session -> should NOT appear in the recap.
  void untouchedNote;

  const ended = await store.sessionsEnd(driver, session._id, deps);

  assert.equal(ended.active, false);
  assert.ok(ended.endedAt);

  const byKind = Object.fromEntries(ended.activity.map((a) => [a.kind, a]));

  assert.equal(byKind.note.name, 'Pre-existing note (edited)');
  assert.equal(byKind.note.action, 'updated');

  assert.equal(byKind.npc.name, 'Grak the Guard');
  assert.equal(byKind.npc.action, 'created');

  assert.equal(byKind.combo.name, 'Sneak Attack');
  assert.equal(byKind.combo.action, 'created');

  assert.equal(byKind.place.name, 'The Rusty Tankard');
  assert.equal(byKind.place.action, 'created');

  assert.equal(byKind.player.name, 'Oscar'); // fallback to playerName
  assert.equal(byKind.player.action, 'created');

  // Exactly one 'note' entry — the untouched note must not show up.
  const noteEntries = ended.activity.filter((a) => a.kind === 'note');
  assert.equal(noteEntries.length, 1);

  // Ending again is a no-op that returns the already-ended session unchanged.
  const endedAgain = await store.sessionsEnd(driver, session._id, deps);
  assert.deepEqual(endedAgain, ended);
});

// ---------- upsert (used by import) ----------

await test('upsertDoc: keeps the incoming _id, inserting or overwriting as needed', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  // Insert: the id from the file is preserved, not regenerated — links between
  // documents depend on it.
  const inserted = await store.upsertDoc(
    driver,
    'notes',
    { _id: 'from-a-backup', title: 'Imported', createdAt: 'C', updatedAt: 'U' },
    deps
  );
  assert.equal(inserted._id, 'from-a-backup');
  assert.equal(inserted.createdAt, 'C');
  assert.equal(inserted.updatedAt, 'U');
  assert.equal((await store.listDocs(driver, 'notes')).length, 1);

  // Overwrite: same id updates in place rather than duplicating.
  await store.upsertDoc(driver, 'notes', { _id: 'from-a-backup', title: 'Second pass' }, deps);
  const notes = await store.listDocs(driver, 'notes');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Second pass');

  // Timestamps are filled in when the file didn't carry them.
  const bare = await store.upsertDoc(driver, 'notes', { _id: 'bare' }, deps);
  assert.ok(bare.createdAt && bare.updatedAt);

  await assert.rejects(() => store.upsertDoc(driver, 'notes', { title: 'no id' }, deps), /_id/);
  await assert.rejects(
    () => store.upsertDoc(driver, 'not_a_table', { _id: 'x' }, deps),
    /Unknown resource/
  );
});

// ---------- remove ----------

await test('removeDoc: deletes existing doc, throws Not found for missing id', async () => {
  const driver = makeFakeDriver();
  await store.ensureTables(driver);
  const deps = makeClock();

  const note = await store.createDoc(driver, 'notes', {}, deps);
  assert.deepEqual(await store.removeDoc(driver, 'notes', note._id), { ok: true });
  assert.equal(await store.getDoc(driver, 'notes', note._id), null);
  await assert.rejects(() => store.removeDoc(driver, 'notes', note._id), /Not found/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
