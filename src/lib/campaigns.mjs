// Pure(ish) logic for the multi-campaign registry that src/api.js sits on
// top of. Each campaign is its own SQLite file under Tauri (or, in a plain
// browser, its own in-memory driver — see browserDriver.mjs); this module
// only knows about the *registry* of them: one `campaigns` table living in
// the home database (ttrpgmap.db), shaped exactly like every collection in
// store.mjs — `id TEXT PRIMARY KEY, doc TEXT` — so it reuses the same driver
// seam (driver.select/driver.execute) and is testable the same way
// (tests/campaigns.test.mjs, a fake driver, no real database).
//
// The pre-existing `default` campaign (today's ttrpgmap.db, holding the
// owner's real notes) is never written to this table until something about
// it changes (a rename, or the active campaign switching away from it) — an
// empty table implicitly means "just the default campaign", so installs that
// predate this feature keep working with zero migration.
//
// Reads always pull the whole (tiny) table rather than filtering in SQL —
// that keeps this module working unchanged against the in-memory fake
// drivers used here and in the browser, which only understand the same
// handful of SQL shapes store.mjs issues.

import { defaultGenId, defaultNow } from './store.mjs';

export const REGISTRY_TABLE = 'campaigns';
export const DEFAULT_CAMPAIGN_ID = 'default';
export const DEFAULT_CAMPAIGN_NAME = 'My campaign';
export const DEFAULT_CAMPAIGN_FILE = 'ttrpgmap.db';

// Not a real campaign — a row in the same table holding {activeId}, so the
// active campaign travels with the registry itself instead of needing a
// second table or a separate storage mechanism per environment.
const META_ID = '__meta__';

// `campaign-<id>.db` — flat files next to ttrpgmap.db (plugin-sql resolves
// `sqlite:<name>` relative to the app's own data dir; see api.js), not a
// subfolder, so nothing beyond this file name has to change if that ever
// needs listing or backing up directly.
export function campaignFileName(id) {
  return `campaign-${id}.db`;
}

// Shared by "new campaign" and "rename" — both are free-text names typed
// into an on-page input (never window.prompt, which is a no-op in the
// Tauri webview).
export function validateCampaignName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('Give the campaign a name.');
  if (trimmed.length > 80) throw new Error('That name is too long (80 characters max).');
  return trimmed;
}

export async function ensureRegistryTable(driver) {
  await driver.execute(`CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLE} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
}

async function allRows(driver) {
  const rows = await driver.select(`SELECT id, doc FROM ${REGISTRY_TABLE}`);
  return rows.map((r) => ({ id: r.id, doc: JSON.parse(r.doc) }));
}

async function realCampaignRows(driver) {
  return (await allRows(driver)).filter((r) => r.id !== META_ID);
}

// Insert-or-update a row without needing the caller to know which one it
// is — the registry is small enough that a full scan first is simplest, and
// keeps this module using only the INSERT/UPDATE/DELETE shapes the fake
// drivers (here and in browserDriver.mjs) already understand.
async function writeRow(driver, id, doc) {
  const rows = await driver.select(`SELECT id, doc FROM ${REGISTRY_TABLE}`);
  const json = JSON.stringify(doc);
  if (rows.some((r) => r.id === id)) {
    await driver.execute(`UPDATE ${REGISTRY_TABLE} SET doc = $1 WHERE id = $2`, [json, id]);
  } else {
    await driver.execute(`INSERT INTO ${REGISTRY_TABLE} (id, doc) VALUES ($1, $2)`, [id, json]);
  }
}

// The full campaign list, synthesizing the implicit default entry when the
// table doesn't (yet) hold a real row for it — see the module comment.
// Default always sorts first; the rest oldest-created first.
export async function listCampaigns(driver) {
  const rows = await realCampaignRows(driver);
  const hasDefaultRow = rows.some((r) => r.id === DEFAULT_CAMPAIGN_ID);
  const list = rows.map((r) => ({ _id: r.id, ...r.doc }));
  if (!hasDefaultRow) {
    list.push({
      _id: DEFAULT_CAMPAIGN_ID,
      name: DEFAULT_CAMPAIGN_NAME,
      file: DEFAULT_CAMPAIGN_FILE,
      createdAt: null,
      lastOpenedAt: null
    });
  }
  return list.sort((a, b) => {
    if (a._id === DEFAULT_CAMPAIGN_ID) return -1;
    if (b._id === DEFAULT_CAMPAIGN_ID) return 1;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
}

export async function getCampaign(driver, id) {
  const found = (await listCampaigns(driver)).find((c) => c._id === id);
  if (!found) throw new Error('That campaign no longer exists.');
  return found;
}

export async function createCampaign(driver, name, { now = defaultNow, genId = defaultGenId } = {}) {
  const cleanName = validateCampaignName(name);
  const id = genId();
  const doc = { name: cleanName, file: campaignFileName(id), createdAt: now(), lastOpenedAt: null };
  await driver.execute(`INSERT INTO ${REGISTRY_TABLE} (id, doc) VALUES ($1, $2)`, [id, JSON.stringify(doc)]);
  return { _id: id, ...doc };
}

export async function renameCampaign(driver, id, name) {
  const cleanName = validateCampaignName(name);
  const existing = await getCampaign(driver, id);
  const doc = { name: cleanName, file: existing.file, createdAt: existing.createdAt, lastOpenedAt: existing.lastOpenedAt };
  await writeRow(driver, id, doc);
  return { _id: id, ...doc };
}

// Records that a campaign was just opened. Best-effort from the caller's
// point of view (api.js calls this without letting a failure block loading
// the campaign's own data) — losing a lastOpenedAt update isn't worth
// failing a launch over.
export async function touchLastOpened(driver, id, { now = defaultNow } = {}) {
  const existing = await getCampaign(driver, id);
  const doc = { name: existing.name, file: existing.file, createdAt: existing.createdAt, lastOpenedAt: now() };
  await writeRow(driver, id, doc);
  return { _id: id, ...doc };
}

export async function deleteCampaignRow(driver, id) {
  await driver.execute(`DELETE FROM ${REGISTRY_TABLE} WHERE id = $1`, [id]);
}

export async function readActiveCampaignId(driver) {
  const meta = (await allRows(driver)).find((r) => r.id === META_ID);
  return (meta && meta.doc && meta.doc.activeId) || DEFAULT_CAMPAIGN_ID;
}

export async function setActiveCampaignId(driver, id) {
  await writeRow(driver, META_ID, { activeId: id });
}

// Resolves whichever campaign is actually active, falling back to default if
// the stored id points at something that's gone (e.g. deleted from another
// window) rather than failing to load at all.
export async function getActiveCampaign(driver) {
  const list = await listCampaigns(driver);
  const activeId = await readActiveCampaignId(driver);
  return list.find((c) => c._id === activeId) || list.find((c) => c._id === DEFAULT_CAMPAIGN_ID) || list[0];
}

// The two rules the UI and api.js both need before deleting a campaign:
// never the default (it holds this very registry) and never the one
// currently active (switch away first, so nothing is deleted out from
// under itself).
export function assertCanDelete(id, activeId) {
  if (id === DEFAULT_CAMPAIGN_ID) {
    throw new Error("The default campaign holds the registry and can't be deleted.");
  }
  if (id === activeId) {
    throw new Error('Switch to a different campaign before deleting this one.');
  }
}
