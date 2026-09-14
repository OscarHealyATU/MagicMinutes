// Pure(ish) document-store logic shared by the Tauri SQL binding (src/api.js) and
// the Node test script (tests/store.test.mjs).
//
// This layer knows nothing about @tauri-apps/plugin-sql directly. It talks to a
// "driver" seam shaped exactly like the plugin's Database object:
//   driver.select(sql, bindValues?) -> Promise<Array<{ id, doc }>>
//   driver.execute(sql, bindValues?) -> Promise<{ rowsAffected, lastInsertId? }>
// so a real Database instance can be passed straight through, and tests can pass
// a tiny in-memory fake with the same shape.
//
// Every document is stored as one row: `id TEXT PRIMARY KEY, doc TEXT NOT NULL`,
// where `doc` is the JSON-serialized document (including _id/createdAt/updatedAt).

export const COLLECTIONS = ['notes', 'npcs', 'combos', 'groups', 'places', 'players', 'rolls', 'sessions'];

export function defaultNow() {
  return new Date().toISOString();
}

export function defaultGenId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Mirrors server/models.js defaults exactly (one factory per collection).
// `ts` is only used by the `sessions` factory (startedAt defaults to the
// creation timestamp, same as Mongoose's `Date.now` default).
const DEFAULTS = {
  notes: () => ({
    title: 'Untitled note',
    category: 'Misc',
    place: '',
    tags: [],
    content: '',
    pinned: false
  }),
  // `name` may be blank for the nameless — a goblin from the gang, a half-orc
  // henchman — in which case `descriptor` is what the Characters tree labels
  // them with. `alignment` is -100 (enemy of the party) … +100 (ally), which
  // drives their left-to-right position on that page; `disposition` is kept in
  // step with it so the map's NPC dots keep their colours.
  npcs: () => ({
    name: '',
    descriptor: '',
    race: '',
    occupation: '',
    location: '',
    disposition: 'Unknown',
    alignment: 0,
    groupId: '',
    relations: [],
    firstMet: '',
    notes: '',
    mapX: null,
    mapY: null
  }),
  combos: () => ({
    name: 'New combo',
    description: '',
    blocks: []
  }),
  groups: () => ({
    name: 'New group',
    description: '',
    color: '#0f3a5c'
  }),
  places: () => ({
    name: 'Unnamed place',
    type: 'Town',
    description: '',
    notes: '',
    connections: [],
    mapX: null,
    mapY: null
  }),
  players: () => ({
    characterName: 'New character',
    playerName: '',
    race: '',
    className: '',
    level: '',
    description: '',
    notes: ''
  }),
  rolls: () => ({
    comboId: '',
    comboName: '',
    notation: '',
    die: 0,
    rolls: [],
    modifier: 0,
    total: 0,
    outcome: 'none',
    manual: false
  }),
  sessions: (ts) => ({
    number: 1,
    title: '',
    active: true,
    startedAt: ts,
    endedAt: null,
    summary: '',
    activity: []
  })
};

export function applyDefaults(resource, body = {}, ts = defaultNow()) {
  const factory = DEFAULTS[resource];
  const defaults = factory ? factory(ts) : {};
  return { ...defaults, ...body };
}

// Builds a brand-new document: defaults + caller-supplied fields, plus
// _id/createdAt/updatedAt.
export function buildCreateDoc(resource, body, { now = defaultNow, genId = defaultGenId } = {}) {
  const ts = now();
  return {
    ...applyDefaults(resource, body, ts),
    _id: genId(),
    createdAt: ts,
    updatedAt: ts
  };
}

// Shallow-merge patch semantics matching Mongoose's findByIdAndUpdate: patch
// fields overwrite, _id/createdAt are preserved, updatedAt is bumped.
export function applyPatch(doc, patch, { now = defaultNow } = {}) {
  return {
    ...doc,
    ...patch,
    _id: doc._id,
    createdAt: doc.createdAt,
    updatedAt: now()
  };
}

export function sortDocs(resource, docs) {
  const key = resource === 'sessions' ? 'startedAt' : 'updatedAt';
  return [...docs].sort((a, b) => new Date(b[key] || 0) - new Date(a[key] || 0));
}

function parseRows(rows) {
  return rows.map((r) => JSON.parse(r.doc));
}

// Table names are interpolated into SQL text, so refuse anything outside the
// known collection list before it gets near a query string.
function checkResource(resource) {
  if (!COLLECTIONS.includes(resource)) throw new Error(`Unknown resource: ${resource}`);
  return resource;
}

export async function ensureTables(driver) {
  for (const resource of COLLECTIONS) {
    await driver.execute(`CREATE TABLE IF NOT EXISTS ${resource} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  }
}

export async function listDocs(driver, resource) {
  const rows = await driver.select(`SELECT doc FROM ${checkResource(resource)}`);
  return sortDocs(resource, parseRows(rows));
}

export async function getDoc(driver, resource, id) {
  const rows = await driver.select(`SELECT doc FROM ${checkResource(resource)} WHERE id = $1`, [id]);
  if (!rows.length) return null;
  return JSON.parse(rows[0].doc);
}

export async function createDoc(driver, resource, body, deps) {
  const doc = buildCreateDoc(checkResource(resource), body, deps);
  await driver.execute(`INSERT INTO ${resource} (id, doc) VALUES ($1, $2)`, [doc._id, JSON.stringify(doc)]);
  return doc;
}

// Missing ids throw, matching the old api.js which turned the server's 404
// {error: 'Not found'} into a thrown Error the views .catch and display.
export async function updateDoc(driver, resource, id, patch, deps) {
  const existing = await getDoc(driver, resource, id);
  if (!existing) throw new Error('Not found');
  const updated = applyPatch(existing, patch, deps);
  await driver.execute(`UPDATE ${resource} SET doc = $1 WHERE id = $2`, [JSON.stringify(updated), id]);
  return updated;
}

// Writes a document verbatim under its own _id, inserting or overwriting as
// needed. Used by import, which has to preserve ids so that the links between
// documents (an NPC's relations, a place's connections) survive the trip.
export async function upsertDoc(driver, resource, doc, { now = defaultNow } = {}) {
  checkResource(resource);
  if (!doc || !doc._id) throw new Error('Cannot import a document without an _id');
  const ts = now();
  const stored = { ...doc, createdAt: doc.createdAt || ts, updatedAt: doc.updatedAt || ts };
  const json = JSON.stringify(stored);
  const existing = await getDoc(driver, resource, doc._id);
  if (existing) {
    await driver.execute(`UPDATE ${resource} SET doc = $1 WHERE id = $2`, [json, doc._id]);
  } else {
    await driver.execute(`INSERT INTO ${resource} (id, doc) VALUES ($1, $2)`, [doc._id, json]);
  }
  return stored;
}

export async function removeDoc(driver, resource, id) {
  const existing = await getDoc(driver, resource, id);
  if (!existing) throw new Error('Not found');
  await driver.execute(`DELETE FROM ${resource} WHERE id = $1`, [id]);
  return { ok: true };
}

// ---------- Sessions ----------

// [collection, singular kind, name-getter] — mirrors server/routes.js's `tracked` array.
const TRACKED = [
  ['notes', 'note', (d) => d.title],
  ['npcs', 'npc', (d) => d.name || d.descriptor],
  ['combos', 'combo', (d) => d.name],
  ['places', 'place', (d) => d.name],
  ['players', 'player', (d) => d.characterName || d.playerName]
];

export async function sessionsActive(driver) {
  const rows = await driver.select('SELECT doc FROM sessions');
  const docs = parseRows(rows);
  return docs.find((d) => d.active) || null;
}

export async function sessionsStart(driver, deps = {}) {
  const existing = await sessionsActive(driver);
  if (existing) return existing;
  const rows = await driver.select('SELECT doc FROM sessions');
  const count = rows.length;
  const doc = buildCreateDoc('sessions', { number: count + 1, active: true }, deps);
  await driver.execute('INSERT INTO sessions (id, doc) VALUES ($1, $2)', [doc._id, JSON.stringify(doc)]);
  return doc;
}

// Pure: given the session, the endedAt timestamp, and a { collection: docs[] }
// map, builds the recap activity list. Split out from sessionsEnd so it can be
// unit-tested without a driver.
export function buildActivity(session, endedAt, collectionsDocs) {
  const startedAt = new Date(session.startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  const activity = [];
  for (const [key, kind, getName] of TRACKED) {
    const docs = collectionsDocs[key] || [];
    for (const d of docs) {
      const updated = new Date(d.updatedAt).getTime();
      if (updated >= startedAt && updated <= endTime) {
        const created = new Date(d.createdAt).getTime();
        activity.push({
          kind,
          name: getName(d) || 'Untitled',
          action: created >= startedAt ? 'created' : 'updated'
        });
      }
    }
  }
  return activity;
}

export async function sessionsEnd(driver, id, deps = {}) {
  const now = deps.now || defaultNow;
  const session = await getDoc(driver, 'sessions', id);
  if (!session) return null;
  if (!session.active) return session;

  const endedAt = now();
  const collectionsDocs = {};
  for (const [key] of TRACKED) {
    const rows = await driver.select(`SELECT doc FROM ${key}`);
    collectionsDocs[key] = parseRows(rows);
  }
  const activity = buildActivity(session, endedAt, collectionsDocs);
  const updated = { ...session, active: false, endedAt, activity, updatedAt: now() };
  await driver.execute('UPDATE sessions SET doc = $1 WHERE id = $2', [JSON.stringify(updated), id]);
  return updated;
}

// Sessions list sorted by startedAt desc, patch limited to {title, summary}
// (mirrors the PUT /api/sessions/:id route, which only accepts those two
// fields) — but going through the generic updateDoc is fine since views only
// ever pass {title, summary} to api.update('sessions', ...).
