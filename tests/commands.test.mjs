// Plain-node test for src/lib/commands.mjs, the command line's logic. Runs the
// commands against an in-memory fake of the outside world (campaigns, files,
// backups), so nothing here touches a real database or disk.
// Run with: node tests/commands.test.mjs

import assert from 'node:assert/strict';
import * as store from '../src/lib/store.mjs';
import { campaignFileName } from '../src/lib/campaigns.mjs';
import { notesToText } from '../src/lib/noteText.mjs';
import { buildExport } from '../src/lib/transfer.mjs';
import { HELP, helpFor, parseArgs, runCommand, searchNotes, tokenize } from '../src/lib/commands.mjs';

// ---------- fake driver (same SQL shapes as tests/store.test.mjs) ----------
function makeFakeDriver() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  return {
    async execute(sql, params = []) {
      let m;
      if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i))) return table(m[1]) && { rowsAffected: 0 };
      if ((m = sql.match(/^INSERT INTO (\w+) \(id, doc\) VALUES/i))) {
        table(m[1]).set(params[0], params[1]);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^UPDATE (\w+) SET doc = \$1 WHERE id = \$2/i))) {
        table(m[1]).set(params[1], params[0]);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^DELETE FROM (\w+) WHERE id = \$1/i))) {
        table(m[1]).delete(params[0]);
        return { rowsAffected: 1 };
      }
      throw new Error(`fake driver: unhandled execute SQL: ${sql}`);
    },
    async select(sql, params = []) {
      let m;
      if ((m = sql.match(/^SELECT doc FROM (\w+) WHERE id = \$1/i))) {
        const row = table(m[1]).get(params[0]);
        return row ? [{ id: params[0], doc: row }] : [];
      }
      if ((m = sql.match(/^SELECT doc FROM (\w+)/i))) {
        return Array.from(table(m[1]).entries()).map(([id, doc]) => ({ id, doc }));
      }
      throw new Error(`fake driver: unhandled select SQL: ${sql}`);
    }
  };
}

// ---------- the fake outside world ----------
// Two campaigns, "My campaign" (default, active) and "Marsh". Records which
// campaigns were opened and every file written, and has no way to switch the
// active campaign at all, so a command can't do it by accident.
async function makeWorld({ failBackup = false } = {}) {
  const campaigns = [
    { _id: 'default', name: 'My campaign' },
    { _id: 'a1b2c3d4e5f6', name: 'Marsh' }
  ];
  const drivers = { default: makeFakeDriver(), a1b2c3d4e5f6: makeFakeDriver() };
  for (const d of Object.values(drivers)) await store.ensureTables(d);
  const world = {
    activeId: 'default',
    campaigns,
    drivers,
    files: new Map(),
    backups: [],
    opened: [],
    clock: 0
  };
  world.ctx = {
    now: () => new Date(Date.UTC(2026, 0, 1) + ++world.clock * 60000).toISOString(),
    async listCampaigns() {
      return { campaigns: world.campaigns.map((c) => ({ ...c })), activeId: world.activeId };
    },
    async openCampaign(id) {
      const use = id || world.activeId;
      world.opened.push(id);
      return { campaign: world.campaigns.find((c) => c._id === use), driver: world.drivers[use] };
    },
    async createCampaign(name) {
      const made = { _id: `new${world.campaigns.length}0000000`, name, file: campaignFileName('x') };
      world.campaigns.push(made);
      world.drivers[made._id] = makeFakeDriver();
      await store.ensureTables(world.drivers[made._id]);
      return made;
    },
    async readFile(path) {
      if (!world.files.has(path)) throw new Error('The system cannot find the file specified. (os error 2)');
      return world.files.get(path);
    },
    async writeFile(path, text) {
      world.files.set(path, text);
    },
    async backup(name, text) {
      if (failBackup) throw new Error('disk full');
      world.backups.push({ name, text });
      return `C:\\appdata\\${name}`;
    }
  };
  return world;
}

async function seedNote(world, id, fields, campaign = 'default') {
  return store.upsertDoc(
    world.drivers[campaign],
    'notes',
    {
      _id: id,
      title: 'Untitled note',
      category: 'Misc',
      place: '',
      tags: [],
      content: '',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...fields
    },
    { now: world.ctx.now }
  );
}

const notesOf = (world, campaign = 'default') => store.listDocs(world.drivers[campaign], 'notes');
const run = (world, argv) => runCommand(argv, world.ctx);

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

// ---------- reading the command line ----------

await test('tokenize: shell-style quotes, Windows paths and apostrophes', () => {
  assert.deepEqual(tokenize('notes add --title "Bob\'s boat" --text \'two words\''), [
    'notes', 'add', '--title', "Bob's boat", '--text', 'two words'
  ]);
  assert.deepEqual(tokenize('import C:\\Users\\me\\backup.json --yes'), ['import', 'C:\\Users\\me\\backup.json', '--yes']);
  assert.deepEqual(tokenize('x --text "say \\"hi\\""'), ['x', '--text', 'say "hi"']);
  assert.deepEqual(tokenize('x --title=\'a b\' ""'), ['x', '--title=a b', '']);
  assert.deepEqual(tokenize("x --title Bob's boat"), ['x', '--title', "Bob's", 'boat']);
  assert.deepEqual(tokenize("x --title 'Bob's boat'"), ['x', '--title', "Bob's boat"]);
  assert.deepEqual(tokenize('   '), []);
  assert.throws(() => tokenize('x "never closed'), /never closed/);
});

await test('parseArgs: words, flags, aliases, =value, booleans', () => {
  const a = parseArgs(['notes', 'list', '-n', '5', '--cat=Quest', '--JSON', '-y', '--tag', 'a,b']);
  assert.deepEqual(a.words, ['notes', 'list']);
  assert.deepEqual(a.flags, { limit: '5', category: 'Quest', json: true, yes: true, tags: 'a,b' });
  assert.deepEqual(parseArgs(['x', '--yes=false']).flags, { yes: false });
  assert.deepEqual(parseArgs(['x', '--text', '--- rule']).flags, { text: '--- rule' });
  assert.deepEqual(parseArgs(['--', '--not-a-flag']).words, ['--not-a-flag']);
  assert.deepEqual(parseArgs(['x', '-5']).words, ['x', '-5']);
  assert.equal(parseArgs(['notes', 'add', '--title']).errors.length, 1);
  assert.equal(parseArgs(['--confirm']).flags.yes, true);
});

// ---------- help ----------

await test('help stays small, and help <command> gives usage plus an example', async () => {
  assert.ok(HELP.length < 1400, `help is ${HELP.length} characters`);
  assert.match(HELP, /notes add/);
  const world = await makeWorld();
  assert.equal((await run(world, [])).output, HELP);
  assert.equal((await run(world, ['help'])).output, HELP);
  assert.equal((await run(world, ['--help'])).output, HELP);
  const h = await run(world, ['help', 'notes', 'add']);
  assert.equal(h.code, 0);
  assert.match(h.output, /^Usage: magicminutes notes add --title/);
  assert.match(h.output, /Example: magicminutes notes add/);
  assert.equal((await run(world, ['note', 'new', '-h'])).output, helpFor('notes add'));
  assert.match(helpFor('nonsense'), /No command called "nonsense"/);
  // Every command has help.
  for (const c of ['campaigns', 'campaigns add', 'notes list', 'notes search', 'notes show', 'notes add', 'notes import', 'notes export', 'export', 'import', 'run', 'help']) {
    assert.match(helpFor(c), /^Usage: /, c);
  }
});

// ---------- campaigns ----------

await test('campaigns: lists with * on the current one, and --json', async () => {
  const world = await makeWorld();
  const r = await run(world, ['campaigns']);
  assert.equal(r.code, 0);
  assert.equal(r.output, '* My campaign (id default)\n  Marsh (id a1b2c3d4)');
  const j = JSON.parse((await run(world, ['campaign', 'ls', '--json'])).output);
  assert.equal(j.current, 'default');
  assert.deepEqual(j.campaigns.map((c) => c.current), [true, false]);
});

await test('campaigns add: creates, does not switch, skips a repeat, rejects a blank name', async () => {
  const world = await makeWorld();
  const r = await run(world, ['campaigns', 'add', 'Curse of the Marsh']);
  assert.equal(r.code, 0);
  assert.match(r.output, /Created campaign "Curse of the Marsh"/);
  assert.match(r.output, /still on "My campaign"/);
  assert.equal(world.activeId, 'default');
  assert.equal(world.campaigns.length, 3);

  const again = await run(world, ['campaigns', 'new', 'curse of the marsh']);
  assert.equal(again.code, 0);
  assert.match(again.output, /already exists/);
  assert.equal(world.campaigns.length, 3);

  const blank = await run(world, ['campaigns', 'add', '  ']);
  assert.equal(blank.code, 1);
  assert.match(blank.output, /Give the campaign a name/);
  const none = await run(world, ['campaigns', 'add']);
  assert.equal(none.code, 1);
  assert.match(none.output, /^Error: missing the campaign name\nUsage: magicminutes campaigns add "Name"$/);
});

await test('--campaign: by name, by id prefix, ambiguous and unknown; never changes the active one', async () => {
  const world = await makeWorld();
  await seedNote(world, 'aaaa1111aaaa', { title: 'Marsh only' }, 'a1b2c3d4e5f6');
  await seedNote(world, 'bbbb2222bbbb', { title: 'Default only' });

  assert.match((await run(world, ['notes', 'list', '--campaign', 'marsh'])).output, /Marsh only/);
  assert.match((await run(world, ['notes', 'list', '-c', 'a1b2'])).output, /Marsh only/);
  assert.match((await run(world, ['notes', 'list'])).output, /Default only/);
  assert.doesNotMatch((await run(world, ['notes', 'list'])).output, /Marsh only/);

  const none = await run(world, ['notes', 'list', '--campaign', 'nope']);
  assert.equal(none.code, 1);
  assert.match(none.output, /no campaign called "nope". Campaigns: "My campaign", "Marsh"/);

  world.campaigns.push({ _id: 'mmmm', name: 'Mist' });
  world.drivers.mmmm = makeFakeDriver();
  const amb = await run(world, ['notes', 'list', '--campaign', 'm']);
  assert.equal(amb.code, 1);
  assert.match(amb.output, /matches several campaigns/);

  assert.equal(world.activeId, 'default');
  assert.ok(world.opened.includes(null), 'no --campaign asks for the active one');
});

// ---------- notes list / search / show ----------

await test('notes list: one short line each, limit, "more" line, category, json', async () => {
  const world = await makeWorld();
  for (let i = 0; i < 25; i++) {
    await seedNote(world, `id${String(i).padStart(2, '0')}abcdef12`, {
      title: `Note number ${i}`,
      category: i % 5 === 0 ? 'Quest' : 'Lore',
      updatedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString()
    });
  }
  const r = await run(world, ['notes', 'list']);
  const lines = r.output.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], 'id24abcd | 2026-06-25 | Lore | Note number 24');
  assert.equal(lines[20], '... 5 more (use --limit)');

  const all = await run(world, ['ls', '--limit', 'all']);
  assert.equal(all.output.split('\n').length, 25);
  assert.doesNotMatch(all.output, /more \(use/);

  const q = await run(world, ['notes', 'list', '--category', 'quest', '--limit', '3']);
  assert.equal(q.output.split('\n').length, 4);
  assert.match(q.output, /\| Quest \|/);
  assert.match(q.output, /\.\.\. 2 more/);

  const j = JSON.parse((await run(world, ['notes', 'list', '--json', '--limit', '2'])).output);
  assert.equal(j.total, 25);
  assert.equal(j.shown, 2);
  assert.deepEqual(Object.keys(j.notes[0]), ['id', 'date', 'category', 'title']);

  const bad = await run(world, ['notes', 'list', '--category', 'Spaceships']);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /Use one of: Session Log, Roleplay/);
  const lim = await run(world, ['notes', 'list', '--limit', 'lots']);
  assert.equal(lim.code, 1);
  assert.match(lim.output, /--limit must be a whole number/);
});

await test('notes list: truncates long titles and says when empty', async () => {
  const world = await makeWorld();
  assert.equal((await run(world, ['notes', 'list'])).output, 'No notes yet.');
  await seedNote(world, 'longlong0000', { title: 'x'.repeat(100), category: 'Session Log' });
  const line = (await run(world, ['notes', 'list'])).output;
  assert.ok(line.endsWith(`${'x'.repeat(57)}...`));
});

await test('notes search: title matches rank first, all words needed, falls back to some', async () => {
  const world = await makeWorld();
  await seedNote(world, 'content00001', { title: 'Market day', content: 'We spoke to the ferryman about a lantern.' });
  await seedNote(world, 'title0000002', { title: 'The ferryman', content: 'Old Marsh.', updatedAt: '2025-01-01T00:00:00.000Z' });
  await seedNote(world, 'tag000000003', { title: 'Debts', tags: ['ferryman'] });
  await seedNote(world, 'place0000004', { title: 'Falls', place: 'Ferryman Landing' });
  await seedNote(world, 'none00000005', { title: 'Unrelated' });

  const r = await run(world, ['notes', 'search', 'ferryman']);
  assert.deepEqual(
    r.output.split('\n').map((l) => l.slice(0, 8)),
    ['title000', 'tag00000', 'place000', 'content0']
  );

  const both = await run(world, ['find', 'ferryman', 'lantern']);
  assert.equal(both.output.split('\n').length, 1);
  assert.match(both.output, /Market day/);

  const some = await run(world, ['notes', 'search', 'lantern', 'dragon']);
  assert.match(some.output.split('\n')[0], /^\(no note has all those words/);
  assert.match(some.output, /Market day/);

  const none = await run(world, ['notes', 'search', 'dragon']);
  assert.equal(none.output, 'No notes match "dragon".');
  assert.equal((await run(world, ['notes', 'search'])).code, 1);

  // Case-insensitive, and the exported helper agrees.
  assert.equal(searchNotes(await notesOf(world), 'FERRYMAN').all.length, 4);
});

await test('notes show: whole note by id prefix; ambiguous, unknown, and title fallback', async () => {
  const world = await makeWorld();
  await seedNote(world, 'abc12345aaaa', { title: 'First', category: 'Quest', tags: ['a', 'b'], content: 'Line one\nLine two' });
  await seedNote(world, 'abc12345bbbb', { title: 'Second' });
  await seedNote(world, 'zzz99999cccc', { title: 'Third one' });

  const r = await run(world, ['notes', 'show', 'abc12345a']);
  assert.equal(r.code, 0);
  assert.match(r.output, /^ID: abc12345aaaa\nUpdated: 2026-01-01\n=== Note ===\nTitle: First\nCategory: Quest/);
  assert.match(r.output, /Tags: a, b\n\nLine one\nLine two\n=== End note ===$/);
  assert.equal((await run(world, ['cat', 'zzz'])).code, 0);

  const amb = await run(world, ['notes', 'show', 'abc']);
  assert.equal(amb.code, 1);
  assert.match(amb.output, /matches 2 notes; type more of the id:\nabc12345 \|/);
  assert.match(amb.output, /Usage: magicminutes notes show <id>$/);

  const unknown = await run(world, ['notes', 'show', 'qqq']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /no note with id starting "qqq"/);

  assert.match((await run(world, ['notes', 'show', 'third one'])).output, /Title: Third one/);
  assert.equal((await run(world, ['notes', 'show'])).code, 1);
  assert.equal(JSON.parse((await run(world, ['notes', 'show', 'zzz', '--json'])).output)._id, 'zzz99999cccc');
});

// ---------- notes add ----------

await test('notes add: saves a clean note straight away', async () => {
  const world = await makeWorld();
  const r = await run(world, [
    'notes', 'add', '--title', 'Deal with the ferryman', '--text', 'Free crossing.\\nBring a lantern.',
    '--place', 'Whispering Falls', '--tags', 'ferryman, favour', '--category', 'quest'
  ]);
  assert.equal(r.code, 0);
  assert.match(r.output, /^Added note [0-9a-f]{8} "Deal with the ferryman" to "My campaign"\.$/);
  const [n] = await notesOf(world);
  assert.equal(n.category, 'Quest');
  assert.equal(n.place, 'Whispering Falls');
  assert.deepEqual(n.tags, ['ferryman', 'favour']);
  assert.equal(n.content, 'Free crossing.\nBring a lantern.');
  assert.equal(n.pinned, false);
});

await test('notes add: other campaign, derived title, errors, and duplicates', async () => {
  const world = await makeWorld();
  const r = await run(world, ['new', '--text', 'Only some text here.\\nMore.', '--campaign', 'Marsh', '--json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.output);
  assert.equal(out.added, true);
  assert.equal(out.campaign, 'Marsh');
  assert.equal((await notesOf(world)).length, 0);
  assert.equal((await notesOf(world, 'a1b2c3d4e5f6'))[0].title, 'Only some text here.');

  const noTitle = await run(world, ['notes', 'add']);
  assert.equal(noTitle.code, 1);
  assert.match(noTitle.output, /^Error: a note needs --title \(or at least --text\)\nUsage: magicminutes notes add/);
  const badCat = await run(world, ['notes', 'add', '--title', 'x', '--category', 'Dragons']);
  assert.equal(badCat.code, 1);
  assert.match(badCat.output, /"Dragons" is not a category/);
  assert.equal((await run(world, ['notes', 'add', '--title'])).code, 1);
  const extra = await run(world, ['notes', 'add', '--title', 'x', 'stray', 'words']);
  assert.match(extra.output, /unexpected extra word "stray"/);
  const flag = await run(world, ['notes', 'add', '--title', 'x', '--colour', 'red']);
  assert.match(flag.output, /unknown option --colour/);

  await run(world, ['notes', 'add', '--title', 'Twice', '--text', 'Same']);
  const dup = await run(world, ['notes', 'add', '--title', 'twice', '--text', 'same']);
  assert.equal(dup.code, 0);
  assert.match(dup.output, /Not added: .* already has a note with that title and text/);
  assert.equal((await notesOf(world)).length, 1);
  await run(world, ['notes', 'add', '--title', 'Twice', '--text', 'Same', '--yes']);
  assert.equal((await notesOf(world)).length, 2);
});

// ---------- notes import / export ----------

const TEXT_NOTES = `=== Note ===
Title: The sunken bell tower
Category: Location
Tags: mystery, marsh

Half-sunk in Greywater Marsh.
=== End note ===

=== Note ===
Title: Deal with the ferryman
Category: Quest

Free crossing for a lantern.
=== End note ===
`;

await test('notes import: plan without --yes changes nothing; --yes adds; repeat skips', async () => {
  const world = await makeWorld();
  world.files.set('notes.txt', TEXT_NOTES);
  await seedNote(world, 'have00000001', { title: 'Deal with the ferryman', content: 'Free crossing for a lantern.' });

  const plan = await run(world, ['notes', 'import', 'notes.txt']);
  assert.equal(plan.code, 0);
  assert.match(plan.output, /notes\.txt: 2 notes found, 1 new, 1 already in "My campaign"\./);
  assert.match(plan.output, /The sunken bell tower \(Location\)/);
  assert.match(plan.output, /Nothing changed yet\. Add --yes to add the 1 new note\.$/);
  assert.equal((await notesOf(world)).length, 1);

  const done = await run(world, ['notes', 'import', 'notes.txt', '--yes']);
  assert.match(done.output, /^Imported 1 note into "My campaign", skipped 1 already there\.$/);
  const all = await notesOf(world);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((n) => n.title === 'The sunken bell tower').tags, ['mystery', 'marsh']);

  const again = await run(world, ['notes', 'import', 'notes.txt', '--yes']);
  assert.match(again.output, /^Imported 0 notes/);
  assert.equal((await notesOf(world)).length, 2);
  assert.equal((await run(world, ['notes', 'import', 'notes.txt', '--json'])).output.includes('"applied":false'), true);
});

await test('notes import: JSON files keep ids, bare lists work, bad input explains itself', async () => {
  const world = await makeWorld();
  const doc = { _id: 'fromfile0001', title: 'From JSON', content: 'x', category: 'Lore' };
  world.files.set('n.json', JSON.stringify({ format: 'magicminutes-notes', version: 1, collections: { notes: [doc] } }));
  world.files.set('list.json', JSON.stringify([{ title: 'Bare', content: 'y' }]));
  world.files.set('empty.txt', 'nothing useful here');
  world.files.set('broken.json', '{ nope');

  await run(world, ['notes', 'import', 'n.json', '--yes']);
  assert.equal((await notesOf(world))[0]._id, 'fromfile0001');
  await run(world, ['notes', 'import', 'list.json', '--yes']);
  assert.equal((await notesOf(world)).length, 2);

  const none = await run(world, ['notes', 'import', 'empty.txt']);
  assert.equal(none.code, 1);
  assert.match(none.output, /no notes found in "empty\.txt"\. Each note should look like:\n=== Note ===/);
  const broken = await run(world, ['notes', 'import', 'broken.json']);
  assert.equal(broken.code, 1);
  assert.match(broken.output, /isn't valid JSON/);
  const missing = await run(world, ['notes', 'import', 'nope.txt']);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /can't read "nope\.txt": .*os error 2/);
  assert.equal((await run(world, ['notes', 'import'])).code, 1);
});

await test('notes export: text or JSON by extension, --search, and no silent overwrite', async () => {
  const world = await makeWorld();
  await seedNote(world, 'e00000000001', { title: 'Marsh trip', content: 'Boggy.', category: 'Location' });
  await seedNote(world, 'e00000000002', { title: 'Tavern', content: 'Loud.' });

  const r = await run(world, ['notes', 'export', 'out.txt', '--search', 'marsh']);
  assert.equal(r.code, 0);
  assert.match(r.output, /^Wrote 1 note from "My campaign" to out\.txt \(text\)\.$/);
  assert.equal(world.files.get('out.txt'), notesToText([(await notesOf(world)).find((n) => n.title === 'Marsh trip')], { intro: '' }));

  await run(world, ['notes', 'export', 'all.json']);
  const parsed = JSON.parse(world.files.get('all.json'));
  assert.equal(parsed.format, 'magicminutes-notes');
  assert.equal(parsed.collections.notes.length, 2);

  const clash = await run(world, ['notes', 'export', 'out.txt']);
  assert.equal(clash.code, 1);
  assert.match(clash.output, /already exists\. Add --yes to overwrite it/);
  assert.match(world.files.get('out.txt'), /Marsh trip/);
  assert.equal((await run(world, ['notes', 'export', 'out.txt', '--yes'])).code, 0);
  assert.match(world.files.get('out.txt'), /Tavern/);

  // A text export can be imported back into another campaign.
  const back = await run(world, ['notes', 'import', 'out.txt', '--campaign', 'Marsh', '--yes']);
  assert.match(back.output, /Imported 2 notes into "Marsh"/);
});

// ---------- whole-campaign export / import ----------

async function backupFile(world) {
  const other = await makeWorld();
  await seedNote(other, 'n0000000001', { title: 'Kept note', content: 'k' });
  await seedNote(other, 'n0000000002', { title: 'Changed note', content: 'new text' });
  await store.upsertDoc(other.drivers.default, 'places', { _id: 'p0000000001', name: 'Cairne', type: 'City', description: '', notes: '', connections: [], mapX: null, mapY: null }, { now: other.ctx.now });
  const all = {};
  for (const name of store.COLLECTIONS) all[name] = await store.listDocs(other.drivers.default, name);
  world.files.set('backup.json', JSON.stringify(buildExport(all)));
}

await test('export then import: round trips, shows a plan first', async () => {
  const world = await makeWorld();
  await seedNote(world, 'n0000000001', { title: 'Kept note', content: 'k' });
  const exp = await run(world, ['export', 'full.json']);
  assert.match(exp.output, /^Exported 1 entry from "My campaign" to full\.json\.$/);
  assert.equal(JSON.parse(world.files.get('full.json')).format, 'ttrpgmap-export');

  const same = await run(world, ['import', 'full.json']);
  assert.match(same.output, /^Nothing to change/);

  await backupFile(world);
  const plan = await run(world, ['import', 'backup.json']);
  assert.equal(plan.code, 0);
  assert.match(plan.output, /^Plan for "My campaign" from backup\.json: 2 added \(merge\)\./);
  assert.match(plan.output, /notes: 1 added/);
  assert.match(plan.output, /places: 1 added/);
  assert.match(plan.output, /Nothing changed yet\. Add --yes to apply\.$/);
  assert.equal((await notesOf(world)).length, 1);
  assert.equal(world.backups.length, 0);

  const done = await run(world, ['import', 'backup.json', '--yes']);
  assert.match(done.output, /^Imported into "My campaign": /);
  assert.equal((await notesOf(world)).length, 2);
  assert.equal((await store.listDocs(world.drivers.default, 'places')).length, 1);
  assert.equal(world.backups.length, 0, 'a merge makes no safety backup');

  const json = JSON.parse((await run(world, ['import', 'backup.json', '--json'])).output);
  assert.equal(json.applied, false);
  assert.equal(json.totals.create + json.totals.update + json.totals.remove, 0);
});

await test('import --replace: plan warns, --yes backs up first, then deletes what is not in the file', async () => {
  const world = await makeWorld();
  await seedNote(world, 'old00000001', { title: 'Will be deleted', content: 'bye' });
  await backupFile(world);

  const plan = await run(world, ['import', 'backup.json', '--replace']);
  assert.match(plan.output, /notes: 2 added, 1 deleted/);
  assert.match(plan.output, /Replace deletes the 1 entry that is not in the file\. A safety backup is saved first\./);
  assert.equal((await notesOf(world)).length, 1);
  assert.equal(world.backups.length, 0);

  const done = await run(world, ['import', 'backup.json', '--replace', '--yes']);
  assert.equal(done.code, 0);
  assert.match(done.output, /Safety backup: C:\\appdata\\magicminutes-safety-backup-My_campaign-/);
  assert.equal(world.backups.length, 1);
  const saved = JSON.parse(world.backups[0].text);
  assert.equal(saved.collections.notes[0].title, 'Will be deleted');
  assert.deepEqual((await notesOf(world)).map((n) => n.title).sort(), ['Changed note', 'Kept note']);
});

await test('import --replace --yes aborts, changing nothing, when the backup fails', async () => {
  const world = await makeWorld({ failBackup: true });
  await seedNote(world, 'old00000001', { title: 'Must survive', content: 'safe' });
  await backupFile(world);
  const r = await run(world, ['import', 'backup.json', '--replace', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.output, /couldn't write a safety backup, so nothing was changed: disk full/);
  assert.deepEqual((await notesOf(world)).map((n) => n.title), ['Must survive']);
});

await test('import: bad files and a notes-only file are refused clearly', async () => {
  const world = await makeWorld();
  world.files.set('notes.json', JSON.stringify({ format: 'magicminutes-notes', version: 1, collections: { notes: [] } }));
  world.files.set('junk.json', 'not json');
  const a = await run(world, ['import', 'notes.json', '--replace', '--yes']);
  assert.equal(a.code, 1);
  assert.match(a.output, /shared notes, not a whole campaign/);
  assert.equal((await run(world, ['import', 'junk.json'])).code, 1);
  assert.equal((await run(world, ['import', 'missing.json'])).code, 1);
  assert.equal((await run(world, ['import', 'a.json', '--wipe'])).code, 1);
  assert.equal(world.backups.length, 0);
});

// ---------- run ----------

await test('run: several commands, comments, quotes, program name, shared options', async () => {
  const world = await makeWorld();
  world.files.set(
    'steps.txt',
    [
      '# adding notes',
      '',
      'notes add --title "First note" --text "Hello there" --tags "a,b"',
      "magicminutes.exe notes add --title 'Bob\\'s?' --text 'x'",
      'notes add --title Second --text "Quote: \\"hi\\""',
      'notes list'
    ].join('\r\n')
  );
  const r = await run(world, ['run', 'steps.txt', '--campaign', 'Marsh']);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /^> notes add --title "First note"/m);
  assert.match(r.output, /Ran 4 commands from steps\.txt\.$/);
  const notes = await notesOf(world, 'a1b2c3d4e5f6');
  assert.equal(notes.length, 3);
  assert.equal(notes.find((n) => n.title === 'Second').content, 'Quote: "hi"');
  assert.equal((await notesOf(world)).length, 0, '--campaign on run applies to every line');
});

await test('run: stops at the first failing line with its exit code; no nested run', async () => {
  const world = await makeWorld();
  world.files.set('bad.txt', 'notes add --title One\nnotes show nosuchid\nnotes add --title Never');
  const r = await run(world, ['run', 'bad.txt']);
  assert.equal(r.code, 1);
  assert.match(r.output, /Stopped at line 2 of bad\.txt; 1 earlier command ran\./);
  assert.equal((await notesOf(world)).length, 1);

  world.files.set('nest.txt', 'run bad.txt');
  const nested = await run(world, ['run', 'nest.txt']);
  assert.equal(nested.code, 1);
  assert.match(nested.output, /can not contain another "run"/);

  world.files.set('quote.txt', 'notes add --title "open');
  assert.match((await run(world, ['run', 'quote.txt'])).output, /never closed/);
  assert.equal((await run(world, ['run', 'nope.txt'])).code, 1);
});

await test('run: --json prints one JSON result per line and --yes is passed on', async () => {
  const world = await makeWorld();
  world.files.set('n.txt', TEXT_NOTES);
  world.files.set('j.txt', 'notes import n.txt\nnotes list');
  const r = await run(world, ['run', 'j.txt', '--json', '--yes']);
  assert.equal(r.code, 0);
  const lines = r.output.split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].added, 2);
  assert.equal(lines[1].total, 2);
});

// ---------- mistakes and exit codes ----------

await test('unknown commands get a nearest-name suggestion and a usage line to type', async () => {
  const world = await makeWorld();
  const a = await run(world, ['notez', 'list']);
  assert.equal(a.code, 1);
  assert.equal(a.output, 'Error: unknown command "notez" (did you mean "notes"?)\nUsage: magicminutes notes list [--limit 20] [--category Quest]');
  const b = await run(world, ['notes', 'serach', 'x']);
  assert.match(b.output, /unknown command "serach" \(did you mean "search"\?\)\nUsage: magicminutes notes search/);
  const c = await run(world, ['xyzzy']);
  assert.equal(c.output, 'Error: unknown command "xyzzy"\nUsage: magicminutes help');
  const d = await run(world, ['campaigns', 'delete', 'x']);
  assert.equal(d.code, 1);
  assert.match(d.output, /unknown command "delete"/);
  assert.match((await run(world, ['notes', 'delete', 'abc'])).output, /^Error: unknown command "delete"/);
});

await test('aliases: note/notes, ls, find, cat, new, bare verbs, program name typed again', async () => {
  const world = await makeWorld();
  await run(world, ['note', 'new', '--title', 'Hello', '--text', 'world']);
  assert.equal((await notesOf(world)).length, 1);
  assert.match((await run(world, ['note', 'ls'])).output, /Hello/);
  assert.match((await run(world, ['list'])).output, /Hello/);
  assert.match((await run(world, ['search', 'world'])).output, /Hello/);
  assert.match((await run(world, ['notes'])).output, /Hello/);
  assert.match((await run(world, ['magicminutes', 'notes', 'find', 'hello'])).output, /Hello/);
  const id = (await notesOf(world))[0]._id.slice(0, 6);
  assert.match((await run(world, ['notes', 'view', id])).output, /Title: Hello/);
  assert.equal((await run(world, ['notes', 'list', '--bogus'])).code, 1);
});

await test('exit codes: 0 fine, 1 caller mistake, 2 internal failure', async () => {
  const world = await makeWorld();
  assert.equal((await run(world, ['campaigns'])).code, 0);
  assert.equal((await run(world, ['notes', 'show', 'x'])).code, 1);
  const broken = await makeWorld();
  broken.ctx.listCampaigns = async () => {
    throw new Error('database is locked');
  };
  const r = await run(broken, ['campaigns']);
  assert.equal(r.code, 2);
  assert.equal(r.output, 'Internal error: database is locked');
  broken.ctx.openCampaign = async () => {
    throw new Error('disk on fire');
  };
  assert.equal((await run(broken, ['notes', 'list'])).code, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
