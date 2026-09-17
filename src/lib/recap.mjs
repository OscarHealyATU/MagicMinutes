// Session-recap helpers: turning a session's tracked activity (or, failing
// that, a time window) into the material for a summary, and turning that
// material into either a deterministic prose draft or a prompt for a local
// LLM. Pure module — no React/DOM, node-testable (see tests/recap.test.mjs).

function inWindow(doc, startMs, endMs) {
  const created = new Date(doc.createdAt).getTime();
  const updated = new Date(doc.updatedAt).getTime();
  return (created >= startMs && created <= endMs) || (updated >= startMs && updated <= endMs);
}

// Picks the docs a session's activity log points at (matched by kind + name,
// since buildActivity in store.mjs only records the name, not the id). When a
// session has no activity at all — e.g. it predates activity tracking, or the
// player only wrote notes without anything getting logged — falls back to any
// note/place/npc created or updated between startedAt and endedAt.
export function collectSessionMaterial(session, { notes = [], places = [], npcs = [] } = {}) {
  const activity = session.activity || [];
  let pickedNotes = [];
  let pickedPlaces = [];
  let pickedNpcs = [];

  if (activity.length) {
    const notesByName = new Map(notes.map((n) => [n.title || 'Untitled', n]));
    const placesByName = new Map(places.map((p) => [p.name || 'Untitled', p]));
    const npcsByName = new Map(npcs.map((n) => [n.name || n.descriptor || 'Untitled', n]));
    const seen = new Set();
    for (const a of activity) {
      const key = `${a.kind}:${a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.kind === 'note' && notesByName.has(a.name)) pickedNotes.push(notesByName.get(a.name));
      else if (a.kind === 'place' && placesByName.has(a.name)) pickedPlaces.push(placesByName.get(a.name));
      else if (a.kind === 'npc' && npcsByName.has(a.name)) pickedNpcs.push(npcsByName.get(a.name));
    }
  } else {
    const startMs = new Date(session.startedAt).getTime();
    const endMs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
    pickedNotes = notes.filter((n) => inWindow(n, startMs, endMs));
    pickedPlaces = places.filter((p) => inWindow(p, startMs, endMs));
    pickedNpcs = npcs.filter((n) => inWindow(n, startMs, endMs));
  }

  const startedAt = session.startedAt || null;
  const endedAt = session.endedAt || null;
  const durationMinutes =
    startedAt && endedAt ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000)) : null;

  return {
    notes: pickedNotes.map((n) => ({
      title: n.title || 'Untitled note',
      category: n.category || '',
      content: n.content || '',
      place: n.place || '',
      tags: n.tags || []
    })),
    places: pickedPlaces.map((p) => ({
      name: p.name || 'Unnamed place',
      type: p.type || '',
      description: p.description || ''
    })),
    npcs: pickedNpcs.map((n) => ({
      name: n.name || '',
      descriptor: n.descriptor || '',
      disposition: n.disposition || '',
      notes: n.notes || ''
    })),
    durationMinutes,
    startedAt,
    endedAt
  };
}

function fmtDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function joinList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// First sentence of free text, trimmed — good enough for a one-line taste of
// a note's content without dumping the whole thing into the summary.
function firstSentence(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^[^.!?\n]*[.!?]?/);
  return (match ? match[0] : trimmed).trim();
}

function npcLabel(npc) {
  const name = npc.name || npc.descriptor || 'someone unnamed';
  if (npc.name && npc.descriptor) return `${npc.name} (${npc.descriptor})`;
  return name;
}

// Deterministic, no-LLM summary: a short journal-style paragraph built purely
// from the material's field values, in a fixed order (places, then people,
// then notes). This is the fallback that always works, Android included.
export function draftSummary(material) {
  const { notes = [], places = [], npcs = [], durationMinutes } = material || {};
  const sentences = [];

  if (durationMinutes != null && durationMinutes > 0) {
    sentences.push(`The session ran for about ${fmtDuration(durationMinutes)}.`);
  }

  if (places.length) {
    sentences.push(`You made your way through ${joinList(places.map((p) => p.name))}.`);
  }

  if (npcs.length) {
    sentences.push(`Along the way you crossed paths with ${joinList(npcs.map(npcLabel))}.`);
  }

  if (notes.length) {
    const shown = notes.slice(0, 6);
    for (const n of shown) {
      const gist = firstSentence(n.content);
      sentences.push(gist ? `${n.title} — ${gist}` : `You jotted down "${n.title}" without further detail.`);
    }
    if (notes.length > shown.length) {
      sentences.push(`${notes.length - shown.length} more note(s) were written besides.`);
    }
  } else {
    sentences.push('No notes were written this session.');
  }

  if (sentences.length < 3) {
    sentences.push('Not much else was recorded for this session — fill in the rest from memory.');
  }

  return sentences.join(' ');
}

const PROMPT_INSTRUCTION =
  "You are summarising one session of a tabletop RPG for the player's journal. Use only the " +
  'material below; do not invent events. Write 120–200 words, past tense, second person plural ' +
  "('you').";

// The prompt sent to a local model: the instruction, then the material laid
// out as labelled sections so the model has something concrete to work from.
export function buildPrompt(material) {
  const { notes = [], places = [], npcs = [], durationMinutes } = material || {};
  const lines = [PROMPT_INSTRUCTION, ''];

  lines.push(`Session length: ${durationMinutes != null ? fmtDuration(durationMinutes) : 'unknown'}`, '');

  lines.push('Places visited:');
  if (places.length) {
    for (const p of places) {
      lines.push(`- ${p.name}${p.type ? ` (${p.type})` : ''}${p.description ? `: ${p.description}` : ''}`);
    }
  } else {
    lines.push('- none recorded');
  }

  lines.push('', 'People met:');
  if (npcs.length) {
    for (const n of npcs) {
      const label = `${n.name || 'Unnamed'}${n.descriptor ? ` — ${n.descriptor}` : ''}`;
      const extra = [n.disposition, n.notes].filter(Boolean).join('; ');
      lines.push(`- ${label}${extra ? `: ${extra}` : ''}`);
    }
  } else {
    lines.push('- none recorded');
  }

  lines.push('', 'Notes from the session:');
  if (notes.length) {
    for (const n of notes) {
      lines.push(`- ${n.title}${n.category ? ` [${n.category}]` : ''}: ${n.content || '(no content)'}`);
    }
  } else {
    lines.push('- none recorded');
  }

  return lines.join('\n');
}

// The small model copies the style of the notes it's given, so notes typed in
// lowercase come back as a summary in lowercase (telling it not to only makes
// it worse). This puts the capitals back afterwards: the start of each
// sentence, "I", and the names of the session's places and people.
const MINOR_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

function titleCase(name) {
  return name
    .split(/(\s+)/)
    .map((word, i) =>
      /^\s+$/.test(word) || (i > 0 && MINOR_WORDS.has(word.toLowerCase()))
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join('');
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function tidyCapitals(text, material = {}) {
  let out = String(text || '');
  const names = [...(material.places || []), ...(material.npcs || [])]
    .map((d) => (d && d.name ? d.name.trim() : ''))
    .filter((n) => n.length >= 3)
    // Longest first, so "High Esterly Market" is fixed before "High Esterly".
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    // A name already written with capitals keeps them; an all-lowercase one
    // gets title case.
    const proper = name === name.toLowerCase() ? titleCase(name) : name;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), proper);
  }
  out = out.replace(/(^|[.!?]["')\]]?\s+|\n\s*)([\p{Ll}])/gu, (m, lead, ch) => lead + ch.toUpperCase());
  out = out.replace(/(?<![\p{L}\p{N}'])i(?=['\s,.!?]|$)/gu, 'I');
  return out;
}
