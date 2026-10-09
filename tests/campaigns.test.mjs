// Plain-node test for src/lib/campaigns.mjs — the pure(ish) campaign-registry
// logic, exercised against an in-memory fake driver instead of a real SQLite
// database. Run with: node tests/campaigns.test.mjs

import assert from 'node:assert/strict';
import * as campaigns from '../src/lib/campaigns.mjs';

// ---------- tiny fake driver ----------
// Same shape as tests/store.test.mjs's fake, but campaigns.mjs always reads
// with `SELECT id, doc FROM <table>` (it needs the id — its rows don't carry
// their own _id inside the JSON the way store.mjs's documents do), so this
// one's select also has to answer that form.
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
    async select(sql) {
      let m;
      if ((m = sql.match(/^SELECT (?:id, )?doc FROM (\w+)/i))) {
        return Array.from(table(m[1]).entries()).map(([id, doc]) => ({ id, doc }));
      }
      throw new Error(`fake driver: unhandled select SQL: ${sql}`);
    }
  };
}

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

// ---------- listing / the implicit default ----------

await test('listCampaigns: an empty registry implicitly holds just the default campaign', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const list = await campaigns.listCampaigns(driver);
  assert.equal(list.length, 1);
  assert.equal(list[0]._id, campaigns.DEFAULT_CAMPAIGN_ID);
  assert.equal(list[0].name, campaigns.DEFAULT_CAMPAIGN_NAME);
  assert.equal(list[0].file, campaigns.DEFAULT_CAMPAIGN_FILE);
});

await test('getActiveCampaign: defaults to the default campaign when nothing was ever set', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const active = await campaigns.getActiveCampaign(driver);
  assert.equal(active._id, campaigns.DEFAULT_CAMPAIGN_ID);
});

// ---------- create ----------

await test('createCampaign: gets its own file name and appears in the list, default stays first', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const deps = makeClock();
  const created = await campaigns.createCampaign(driver, 'Curse of the Crimson Coast', deps);

  assert.equal(created.name, 'Curse of the Crimson Coast');
  assert.equal(created.file, `campaign-${created._id}.db`);
  assert.notEqual(created._id, campaigns.DEFAULT_CAMPAIGN_ID);

  const list = await campaigns.listCampaigns(driver);
  assert.equal(list.length, 2);
  assert.equal(list[0]._id, campaigns.DEFAULT_CAMPAIGN_ID, 'default always sorts first');
  assert.equal(list[1]._id, created._id);
});

await test('createCampaign: two campaigns get distinct, non-colliding file names', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const deps = makeClock();
  const a = await campaigns.createCampaign(driver, 'Campaign A', deps);
  const b = await campaigns.createCampaign(driver, 'Campaign B', deps);
  assert.notEqual(a.file, b.file);
});

await test('createCampaign: blank or whitespace-only names are rejected', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  await assert.rejects(() => campaigns.createCampaign(driver, '   '), /name/i);
  await assert.rejects(() => campaigns.createCampaign(driver, ''), /name/i);
});

await test('createCampaign: trims the name', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, '  Trimmed Name  ', makeClock());
  assert.equal(created.name, 'Trimmed Name');
});

// ---------- rename ----------

await test('renameCampaign: renames a real campaign without touching its file or id', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, 'Old Name', makeClock());
  const renamed = await campaigns.renameCampaign(driver, created._id, 'New Name');
  assert.equal(renamed.name, 'New Name');
  assert.equal(renamed.file, created.file);
  assert.equal(renamed._id, created._id);

  const fetched = await campaigns.getCampaign(driver, created._id);
  assert.equal(fetched.name, 'New Name');
});

await test('renameCampaign: can rename the implicit default campaign, which materializes its row', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const renamed = await campaigns.renameCampaign(driver, campaigns.DEFAULT_CAMPAIGN_ID, 'The Long Road Home');
  assert.equal(renamed.name, 'The Long Road Home');
  assert.equal(renamed.file, campaigns.DEFAULT_CAMPAIGN_FILE, 'renaming default must never change its file');

  const list = await campaigns.listCampaigns(driver);
  assert.equal(list[0]._id, campaigns.DEFAULT_CAMPAIGN_ID);
  assert.equal(list[0].name, 'The Long Road Home');
});

await test('renameCampaign: rejects a blank name and throws for an unknown id', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, 'Something', makeClock());
  await assert.rejects(() => campaigns.renameCampaign(driver, created._id, ''), /name/i);
  await assert.rejects(() => campaigns.renameCampaign(driver, 'nonexistent-id', 'Anything'), /no longer exists/i);
});

// ---------- switching / active id ----------

await test('setActiveCampaignId + getActiveCampaign: round-trips the active campaign', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, 'Second Campaign', makeClock());
  await campaigns.setActiveCampaignId(driver, created._id);
  const active = await campaigns.getActiveCampaign(driver);
  assert.equal(active._id, created._id);
});

await test('getActiveCampaign: falls back to default if the stored active id was deleted', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, 'Doomed Campaign', makeClock());
  await campaigns.setActiveCampaignId(driver, created._id);
  await campaigns.deleteCampaignRow(driver, created._id);

  const active = await campaigns.getActiveCampaign(driver);
  assert.equal(active._id, campaigns.DEFAULT_CAMPAIGN_ID, 'a dangling active id must not break loading');
});

// ---------- lastOpenedAt ----------

await test('touchLastOpened: sets lastOpenedAt without disturbing name/file/createdAt', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const deps = makeClock();
  const created = await campaigns.createCampaign(driver, 'Touchable', deps);
  assert.equal(created.lastOpenedAt, null);

  const touched = await campaigns.touchLastOpened(driver, created._id, deps);
  assert.ok(touched.lastOpenedAt, 'lastOpenedAt should now be set');
  assert.equal(touched.name, created.name);
  assert.equal(touched.file, created.file);
  assert.equal(touched.createdAt, created.createdAt);
});

// ---------- delete rules ----------

await test('assertCanDelete: refuses the default campaign, even when it is not active', async () => {
  assert.throws(() => campaigns.assertCanDelete(campaigns.DEFAULT_CAMPAIGN_ID, 'some-other-id'), /registry/i);
});

await test('assertCanDelete: refuses whichever campaign is currently active', async () => {
  assert.throws(() => campaigns.assertCanDelete('campaign-1', 'campaign-1'), /switch/i);
});

await test('assertCanDelete: allows a non-default, non-active campaign', async () => {
  assert.doesNotThrow(() => campaigns.assertCanDelete('campaign-1', 'campaign-2'));
});

await test('deleteCampaignRow: removes a real campaign from the list', async () => {
  const driver = makeFakeDriver();
  await campaigns.ensureRegistryTable(driver);
  const created = await campaigns.createCampaign(driver, 'Temporary', makeClock());
  await campaigns.deleteCampaignRow(driver, created._id);
  const list = await campaigns.listCampaigns(driver);
  assert.equal(list.length, 1);
  assert.equal(list[0]._id, campaigns.DEFAULT_CAMPAIGN_ID);
});

// ---------- name validation / file names ----------

await test('validateCampaignName: rejects names over 80 characters', () => {
  assert.throws(() => campaigns.validateCampaignName('x'.repeat(81)), /80/);
  assert.doesNotThrow(() => campaigns.validateCampaignName('x'.repeat(80)));
});

await test('campaignFileName: deterministic, prefixed form used by createCampaign', () => {
  assert.equal(campaigns.campaignFileName('abc123'), 'campaign-abc123.db');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
