// Export / import of the whole campaign as one JSON file.
//
// Pure logic only — building the export payload, validating a file someone
// hands back, and working out what an import would change. The actual file
// picking and database writes live in src/fileio.js and the Settings view, so
// everything here is testable with plain objects.

import { cleanNote } from './noteText.mjs';
import { COLLECTIONS } from './store.mjs';

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
  for (const [name, docs] of Object.entries(data.collections)) {
    if (!COLLECTIONS.includes(name)) {
      skipped.push(name);
      continue;
    }
    if (!Array.isArray(docs)) {
      throw new Error(`The "${name}" section of that export is not a list.`);
    }
    const clean = docs.filter((d) => d && typeof d === 'object' && typeof d._id === 'string' && d._id);
    if (clean.length !== docs.length) {
      throw new Error(`Some "${name}" entries in that export have no id and can't be imported.`);
    }
    collections[name] = clean;
  }
  return { ...data, collections, skipped };
}

// Works out what an import does before doing any of it, so the UI can show
// "12 added, 3 replaced" and so a replace can be confirmed properly.
//
//  merge   — incoming documents win on matching ids; anything not mentioned in
//            the file is left alone.
//  replace — the file becomes the whole database; existing documents that
//            aren't in it are deleted.
export function planImport(existing, incoming, mode = 'merge') {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`Unknown import mode: ${mode}`);
  }
  const plan = {};
  const totals = { create: 0, update: 0, remove: 0 };

  for (const name of COLLECTIONS) {
    const have = existing[name] || [];
    const want = incoming[name] || [];
    // `replace` wipes a collection the file doesn't mention at all.
    if (mode === 'merge' && !incoming[name]) {
      plan[name] = { create: [], update: [], remove: [] };
      continue;
    }

    const haveIds = new Set(have.map((d) => d._id));
    const wantIds = new Set(want.map((d) => d._id));
    const create = want.filter((d) => !haveIds.has(d._id));
    const update = want.filter((d) => haveIds.has(d._id));
    const remove = mode === 'replace' ? have.filter((d) => !wantIds.has(d._id)).map((d) => d._id) : [];

    plan[name] = { create, update, remove };
    totals.create += create.length;
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
