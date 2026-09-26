// Export / import of the whole campaign as one JSON file.
//
// Pure logic only — building the export payload, validating a file someone
// hands back, and working out what an import would change. The actual file
// picking and database writes live in src/fileio.js and the Settings view, so
// everything here is testable with plain objects.

import { cleanNote } from './noteText.mjs';
import { COLLECTIONS } from './store.mjs';

// ---------- Coercing an imported document to the shape its view expects ----------
//
// A hand-edited or older/foreign export can hold a document with a field of
// the wrong type — a session with no `activity`, a note with `tags` as a
// string, a place whose `connections` isn't an array. Nothing here validates
// that on the way in, so it reaches the view untouched, and something like
// `selected.activity.length` or `connections.map(...)` throws — which (React
// 19) unmounts the whole app over one bad document. Each collection gets its
// own cleaner, modelled on `cleanNote` in noteText.mjs, that coerces every
// field to the type/shape its view relies on.

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const bool = (v) => v === true;
function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// _id/createdAt/updatedAt are carried over verbatim (like cleanNote does) —
// they aren't display fields, so there's nothing to coerce, just to keep.
function withMeta(doc, cleaned) {
  if (typeof doc._id === 'string' && doc._id) cleaned._id = doc._id;
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof doc[key] === 'string' && !Number.isNaN(Date.parse(doc[key]))) cleaned[key] = doc[key];
  }
  return cleaned;
}

function cleanPlace(doc) {
  const connections = arr(doc.connections)
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ type: str(c.type), text: str(c.text) }));
  return withMeta(doc, {
    name: str(doc.name).trim() || 'Unnamed place',
    type: str(doc.type) || 'Town',
    description: str(doc.description),
    notes: str(doc.notes),
    connections,
    mapX: numOrNull(doc.mapX),
    mapY: numOrNull(doc.mapY)
  });
}

function cleanNpc(doc) {
  const relations = arr(doc.relations)
    .filter((r) => r && typeof r === 'object' && typeof r.targetId === 'string' && r.targetId)
    .map((r) => ({ targetId: r.targetId, type: str(r.type) || 'knows', text: str(r.text) }));
  return withMeta(doc, {
    name: str(doc.name),
    descriptor: str(doc.descriptor),
    race: str(doc.race),
    occupation: str(doc.occupation),
    location: str(doc.location),
    disposition: str(doc.disposition) || 'Unknown',
    alignment: numOr(doc.alignment, 0),
    groupId: str(doc.groupId),
    relations,
    firstMet: str(doc.firstMet),
    notes: str(doc.notes),
    mapX: numOrNull(doc.mapX),
    mapY: numOrNull(doc.mapY)
  });
}

function cleanPlayer(doc) {
  return withMeta(doc, {
    characterName: str(doc.characterName).trim() || 'New character',
    playerName: str(doc.playerName),
    race: str(doc.race),
    className: str(doc.className),
    level: str(doc.level),
    description: str(doc.description),
    notes: str(doc.notes)
  });
}

function cleanGroup(doc) {
  return withMeta(doc, {
    name: str(doc.name).trim() || 'New group',
    description: str(doc.description),
    color: str(doc.color) || '#0f3a5c'
  });
}

function cleanCombo(doc) {
  // Each block is {type, text, condition, roll} — CombosView reads
  // `b.type`/`b.text` directly off every entry, so a non-object slipping
  // through (a bare string, null) would throw there, not just render oddly.
  const blocks = arr(doc.blocks)
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({ type: str(b.type), text: str(b.text), condition: str(b.condition), roll: str(b.roll) }));
  return withMeta(doc, {
    name: str(doc.name).trim() || 'New combo',
    description: str(doc.description),
    blocks
  });
}

function cleanRoll(doc) {
  return withMeta(doc, {
    comboId: str(doc.comboId),
    comboName: str(doc.comboName),
    notation: str(doc.notation),
    die: numOr(doc.die, 0),
    // Individual die faces are numbers; a stray object here would reach a
    // view as a React child and throw ("Objects are not valid as a React
    // child"), so each entry is coerced rather than just the array shape.
    rolls: arr(doc.rolls).map((r) => numOr(r, 0)),
    modifier: numOr(doc.modifier, 0),
    total: numOr(doc.total, 0),
    outcome: str(doc.outcome) || 'none',
    manual: bool(doc.manual)
  });
}

function cleanSession(doc) {
  const activity = arr(doc.activity)
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      kind: str(a.kind),
      name: str(a.name) || 'Untitled',
      action: a.action === 'created' ? 'created' : 'updated'
    }));
  return withMeta(doc, {
    number: numOr(doc.number, 1),
    title: str(doc.title),
    active: bool(doc.active),
    startedAt: typeof doc.startedAt === 'string' ? doc.startedAt : new Date().toISOString(),
    endedAt: typeof doc.endedAt === 'string' ? doc.endedAt : null,
    summary: str(doc.summary),
    activity
  });
}

const CLEANERS = {
  notes: cleanNote,
  places: cleanPlace,
  npcs: cleanNpc,
  players: cleanPlayer,
  groups: cleanGroup,
  combos: cleanCombo,
  rolls: cleanRoll,
  sessions: cleanSession
};

// The one place that knows how to coerce a document of a given collection to
// the shape its view expects. `collection` is assumed already checked against
// COLLECTIONS — an unknown name is passed through untouched.
export function cleanDoc(collection, doc) {
  const cleaner = CLEANERS[collection];
  return cleaner ? cleaner(doc) : doc;
}

export const EXPORT_FORMAT = 'ttrpgmap-export';
export const EXPORT_VERSION = 1;

export function exportFilename(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return `magicminutes-backup-${stamp}.json`;
}

// `collections` is { notes: [...], places: [...], … }.
export function buildExport(collections, { now = () => new Date().toISOString() } = {}) {
  const payload = {};
  for (const name of COLLECTIONS) payload[name] = collections[name] || [];
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now(),
    collections: payload
  };
}

// A few notes to send someone. It gets its own format name, not the backup's,
// so no version of the app will take it as a whole campaign: a Replace import
// of a notes-only file would delete everything else.
export const NOTES_FORMAT = 'magicminutes-notes';

export function notesExportFilename(now = new Date()) {
  return `magicminutes-notes-${now.toISOString().slice(0, 10)}.json`;
}

export function buildNotesExport(notes, { now = () => new Date().toISOString() } = {}) {
  return {
    format: NOTES_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now(),
    collections: { notes }
  };
}

// Notes from a file for the Notes page's Import: a shared-notes file, or the
// notes out of a full backup. Each note is cleaned to the fields a note has,
// and an id that appears twice is only kept once.
export function parseNotesFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON, so it isn't a MagicMinutes notes file.");
  }
  if (!data || typeof data !== 'object' || (data.format !== NOTES_FORMAT && data.format !== EXPORT_FORMAT)) {
    throw new Error('That file is not a MagicMinutes notes file or backup.');
  }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
    throw new Error(`That file was written by a newer version of the app (v${data.version}).`);
  }
  const collections = data.collections && typeof data.collections === 'object' ? data.collections : {};
  const raw = Array.isArray(collections.notes) ? collections.notes : [];
  const warnings = [];
  const seen = new Set();
  const notes = [];
  for (const doc of raw) {
    if (!doc || typeof doc !== 'object') continue;
    const note = cleanNote(doc);
    if (note._id && seen.has(note._id)) continue;
    if (note._id) seen.add(note._id);
    notes.push(note);
  }
  if (raw.length !== notes.length) {
    warnings.push(`${raw.length - notes.length} entries in that file were broken or repeated and were left out.`);
  }
  const others = Object.entries(collections).filter(
    ([name, docs]) => name !== 'notes' && Array.isArray(docs) && docs.length
  );
  if (others.length) {
    warnings.push(
      `This file also holds ${others.map(([name, docs]) => `${docs.length} ${name}`).join(', ')}. Only its notes are imported here; use Settings → Import for the rest.`
    );
  }
  return { notes, warnings };
}

export function countDocs(collections) {
  return Object.values(collections).reduce((sum, docs) => sum + (docs ? docs.length : 0), 0);
}

// Throws with something a human can act on, rather than letting a bad file
// turn into a confusing failure halfway through writing to the database.
export function parseExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON — is it definitely a MagicMinutes export?");
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('That file does not contain a MagicMinutes export.');
  }
  if (data.format === NOTES_FORMAT) {
    throw new Error('That file holds some shared notes, not a whole campaign. Import it on the Notes page instead.');
  }
  if (data.format !== EXPORT_FORMAT) {
    throw new Error(
      `That file says it is "${data.format || 'unknown'}", not a MagicMinutes export.`
    );
  }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
    throw new Error(
      `That export was written by a newer version of the app (v${data.version}); this one understands up to v${EXPORT_VERSION}.`
    );
  }
  if (!data.collections || typeof data.collections !== 'object') {
    throw new Error('That export has no collections in it.');
  }

  // Keep only known collections of well-formed documents; an export carrying a
  // table this build has never heard of is skipped rather than fatal.
  const collections = {};
  const skipped = [];
  const duplicates = [];
  for (const [name, docs] of Object.entries(data.collections)) {
    if (!COLLECTIONS.includes(name)) {
      skipped.push(name);
      continue;
    }
    if (!Array.isArray(docs)) {
      throw new Error(`The "${name}" section of that export is not a list.`);
    }
    const withIds = docs.filter((d) => d && typeof d === 'object' && typeof d._id === 'string' && d._id);
    if (withIds.length !== docs.length) {
      throw new Error(`Some "${name}" entries in that export have no id and can't be imported.`);
    }
    // A later document wins over an earlier one sharing an _id (the file is
    // presumably corrupt or hand-merged either way); it's reported as one
    // warning rather than two documents silently colliding on write.
    const byId = new Map();
    for (const d of withIds) byId.set(d._id, cleanDoc(name, d));
    if (byId.size !== withIds.length) duplicates.push(name);
    collections[name] = [...byId.values()];
  }
  return { ...data, collections, skipped, duplicates };
}

// Deep, key-order-independent equality — re-importing the very file you just
// exported should show "0 changed" for a collection, not "12 replaced" just
// because every id happens to already exist.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameDoc(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// A merge (or a replace) can leave a collection holding 2+ sessions marked
// `active: true` at once — e.g. importing someone else's in-progress session
// while your own is still running. Only the most recently started one stays
// active; the rest are turned into ordinary (non-live) sessions so the UI
// never has two "LIVE" badges. `have` is existing, unfiltered by remove yet.
function fixupActiveSessions(have, create, update, remove) {
  const removedIds = new Set(remove);
  const projected = new Map();
  for (const d of have) if (!removedIds.has(d._id)) projected.set(d._id, d);
  for (const d of update) projected.set(d._id, d);
  for (const d of create) projected.set(d._id, d);

  const activeOnes = [...projected.values()]
    .filter((d) => d && d.active)
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  if (activeOnes.length <= 1) return { create, update };

  const nextCreate = [...create];
  const nextUpdate = [...update];
  for (const doc of activeOnes.slice(1)) {
    const patched = { ...doc, active: false };
    const ci = nextCreate.findIndex((d) => d._id === doc._id);
    const ui = nextUpdate.findIndex((d) => d._id === doc._id);
    if (ci >= 0) nextCreate[ci] = patched;
    else if (ui >= 0) nextUpdate[ui] = patched;
    // An existing session this import otherwise wouldn't touch still needs
    // deactivating, so it's added to `update` even though it isn't in `want`.
    else nextUpdate.push(patched);
  }
  return { create: nextCreate, update: nextUpdate };
}

// Works out what an import does before doing any of it, so the UI can show
// "12 added, 3 replaced" and so a replace can be confirmed properly.
//
//  merge   — incoming documents win on matching ids; anything not mentioned in
//            the file is left alone.
//  replace — the file becomes the whole database; existing documents that
//            aren't in it are deleted.
//
// Either way, a collection the file doesn't mention *at all* is left alone —
// a notes-only file must not touch NPCs, places, groups or anything else,
// even in replace mode. That used to only hold for merge; `replace` used
// `incoming[name] || []` for a missing collection, which read as "the file
// wants zero of these", so a notes-only backup "replaced" every place, NPC,
// group and session in the campaign with nothing.
export function planImport(existing, incoming, mode = 'merge') {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`Unknown import mode: ${mode}`);
  }
  const plan = {};
  const totals = { create: 0, update: 0, remove: 0 };

  for (const name of COLLECTIONS) {
    const have = existing[name] || [];
    if (!Object.prototype.hasOwnProperty.call(incoming, name)) {
      plan[name] = { create: [], update: [], remove: [] };
      continue;
    }
    const want = incoming[name] || [];

    const haveById = new Map(have.map((d) => [d._id, d]));
    const wantIds = new Set(want.map((d) => d._id));
    const create = want.filter((d) => !haveById.has(d._id));
    let update = want.filter((d) => haveById.has(d._id) && !sameDoc(haveById.get(d._id), d));
    const remove = mode === 'replace' ? have.filter((d) => !wantIds.has(d._id)).map((d) => d._id) : [];
    let finalCreate = create;

    if (name === 'sessions') {
      const fixed = fixupActiveSessions(have, create, update, remove);
      finalCreate = fixed.create;
      update = fixed.update;
    }

    plan[name] = { create: finalCreate, update, remove };
    totals.create += finalCreate.length;
    totals.update += update.length;
    totals.remove += remove.length;
  }
  return { mode, plan, totals };
}

export function describePlan({ mode, totals }) {
  const bits = [];
  if (totals.create) bits.push(`${totals.create} added`);
  if (totals.update) bits.push(`${totals.update} replaced`);
  if (totals.remove) bits.push(`${totals.remove} deleted`);
  if (!bits.length) return 'Nothing to change — that file matches what you already have.';
  return `${bits.join(', ')} (${mode}).`;
}

// Friendly names, in COLLECTIONS order, kept here (rather than only in
// SettingsView) so a test can check the per-collection breakdown a Replace
// confirm dialog needs without a whole DOM. `labelOf` lets the caller swap in
// its own display names; the collection key is used unchanged if it doesn't.
export function describePlanByCollection({ plan }, labelOf = (n) => n) {
  const lines = [];
  for (const name of COLLECTIONS) {
    const p = plan[name];
    if (!p) continue;
    const bits = [];
    if (p.create.length) bits.push(`${p.create.length} added`);
    if (p.update.length) bits.push(`${p.update.length} replaced`);
    if (p.remove.length) bits.push(`${p.remove.length} deleted`);
    if (bits.length) lines.push(`${labelOf(name)}: ${bits.join(', ')}`);
  }
  return lines;
}
