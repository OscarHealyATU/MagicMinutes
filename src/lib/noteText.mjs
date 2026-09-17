// Notes as plain, readable text — for pasting into an email and back.
//
// Each note is a block anyone can read, and anyone can write by hand:
//
//   === Note ===
//   Title: The sunken bell tower
//   Category: Location
//   Place: Sunken Bell Tower
//   Tags: mystery, marsh
//   Pinned: yes
//
//   Half-sunk in Greywater Marsh. It rings before a storm.
//   === End note ===
//
// Reading it back is deliberately forgiving, because the text has usually been
// through an email client (or someone's typing) on the way: capitals and
// spacing don't matter, every field except the text is optional, the end line
// is optional, and ">" reply marks are stripped. Pure logic only, tested in
// tests/noteText.test.mjs.

export const NOTE_CATEGORIES = [
  'Session Log',
  'Roleplay',
  'Character',
  'Quest',
  'Location',
  'Item',
  'Lore',
  'Misc'
];

const START = /^={3,}\s*note\s*={3,}\s*$/i;
const END = /^={3,}\s*end\s*(?:of\s*)?note\s*={3,}\s*$/i;
// A line of the note's text that would read as a marker is written with a
// leading backslash, and the backslash is dropped again when read back.
// Written: any backslashes, then spaces, then "===". Read: the same with one
// extra backslash in front, which is taken off again.
const LOOKS_LIKE_MARKER = /^\\*\s*={3,}/;
const ESCAPED = /^\\\\*\s*={3,}/;
const FIELD = /^\s*(title|category|place|tags|pinned)\s*:\s*(.*)$/i;
const YES = /^(yes|y|true|1|pinned)$/i;

export const EMAIL_INTRO =
  'These notes were sent from MagicMinutes. To add them to your own campaign, open ' +
  'MagicMinutes, go to Notes, click Import, and paste this whole email in.';

function noteBlock(note) {
  const lines = ['=== Note ===', `Title: ${oneLine(note.title) || 'Untitled note'}`];
  if (note.category) lines.push(`Category: ${oneLine(note.category)}`);
  if (note.place) lines.push(`Place: ${oneLine(note.place)}`);
  if (note.tags && note.tags.length) lines.push(`Tags: ${note.tags.map(oneLine).join(', ')}`);
  if (note.pinned) lines.push('Pinned: yes');
  lines.push('');
  const content = (note.content || '').replace(/\r\n?/g, '\n');
  for (const line of content.split('\n')) {
    lines.push(LOOKS_LIKE_MARKER.test(line) ? `\\${line}` : line);
  }
  lines.push('=== End note ===');
  return lines.join('\n');
}

function oneLine(s) {
  return String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function notesToText(notes, { intro = EMAIL_INTRO } = {}) {
  const blocks = notes.map(noteBlock);
  return [intro, ...blocks].filter(Boolean).join('\n\n') + '\n';
}

function matchCategory(raw, categories) {
  const want = raw.trim().toLowerCase();
  return categories.find((c) => c.toLowerCase() === want) || null;
}

// Returns { notes, warnings }. Each note is { title, category, place, tags,
// content, pinned }; warnings are strings a person can act on.
export function parseNotesText(text, { categories = NOTE_CATEGORIES } = {}) {
  // Unicode line and paragraph separators turn up in text copied from web
  // pages and word processors; treat them as the line breaks they are.
  const lines = String(text ?? '').split(/\r\n|\r|\n|\u2028|\u2029/);
  const notes = [];
  const warnings = [];
  let block = 0;

  let i = 0;
  while (i < lines.length) {
    // A quoted or forwarded email puts ">" marks in front of every line
    // ("> ", ">", "> > ", ">>" all happen). The start line sets how deep the
    // quoting is, and that many marks come off each line of the block.
    const depth = quoteDepth(lines[i]);
    if (!START.test(unquote(lines[i], depth).trim())) {
      i++;
      continue;
    }
    block++;

    const body = [];
    i++;
    let ended = false;
    while (i < lines.length) {
      const line = unquote(lines[i], depth);
      if (END.test(line.trim())) {
        ended = true;
        i++;
        break;
      }
      if (START.test(line.trim())) break; // next note starts; this one had no end line
      body.push(line);
      i++;
    }

    const note = { title: '', category: 'Misc', place: '', tags: [], content: '', pinned: false };
    let j = 0;
    while (j < body.length && body[j].trim() === '') j++;
    for (; j < body.length; j++) {
      const m = body[j].match(FIELD);
      if (!m) break;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'title') note.title = value;
      else if (key === 'place') note.place = value;
      else if (key === 'pinned') note.pinned = YES.test(value);
      else if (key === 'tags') note.tags = splitTags(value);
      else if (key === 'category') {
        const cat = matchCategory(value, categories);
        if (cat) note.category = cat;
        else if (value) warnings.push(`Note ${block}: "${value}" isn't a category, so it was filed under Misc.`);
      }
    }
    // One blank line separates the fields from the text.
    if (j < body.length && body[j].trim() === '') j++;
    const content = body.slice(j).map((line) => (ESCAPED.test(line) ? line.slice(1) : line));
    while (content.length && content[content.length - 1].trim() === '') content.pop();
    note.content = content.join('\n');

    const empty = !note.title && note.content === '' && !note.place && !note.tags.length;
    if (empty && !ended) {
      // A lone "=== Note ===" with nothing after it: probably a cut-off paste.
      warnings.push(`Note ${block} looks cut off — there's nothing after its "=== Note ===" line, so it was left out.`);
      continue;
    }
    if (!note.title) {
      note.title = 'Untitled note';
      warnings.push(`Note ${block} has no "Title:" line, so it's called "Untitled note".`);
    }
    notes.push(note);
  }

  return { notes, warnings };
}

function quoteDepth(line) {
  const m = line.match(/^(?:[ \t]*>)+/);
  return m ? (m[0].match(/>/g) || []).length : 0;
}

function unquote(line, depth) {
  let out = line;
  for (let k = 0; k < depth; k++) {
    const m = out.match(/^[ \t]*>/);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return depth && out.startsWith(' ') ? out.slice(1) : out;
}

function splitTags(value) {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

// A note that came from a file rather than text: keep only the fields a note
// has, with the types the app expects, so an odd or hand-edited file can't
// store something that breaks the notes page later.
export function cleanNote(doc, { categories = NOTE_CATEGORIES } = {}) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const tags = Array.isArray(doc.tags)
    ? doc.tags.map((t) => str(t).trim()).filter(Boolean)
    : typeof doc.tags === 'string'
      ? splitTags(doc.tags)
      : [];
  const note = {
    title: str(doc.title).trim() || 'Untitled note',
    category: matchCategory(str(doc.category), categories) || 'Misc',
    place: str(doc.place).trim(),
    tags,
    content: str(doc.content),
    pinned: doc.pinned === true
  };
  if (typeof doc._id === 'string' && doc._id) note._id = doc._id;
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof doc[key] === 'string' && !Number.isNaN(Date.parse(doc[key]))) note[key] = doc[key];
  }
  return note;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
// A note with no title is written out as "Untitled note", so the two match.
const normTitle = (s) => (norm(s) === 'untitled note' ? '' : norm(s));

// Which parsed notes you already have: same title and same text (ignoring
// spacing and capitals, which email clients like to fiddle with).
export function markDuplicates(parsed, existing) {
  const have = new Set(existing.map((n) => JSON.stringify([normTitle(n.title), norm(n.content)])));
  const seen = new Set();
  return parsed.map((note) => {
    const key = JSON.stringify([normTitle(note.title), norm(note.content)]);
    const duplicate = have.has(key) || seen.has(key);
    seen.add(key);
    return { ...note, duplicate };
  });
}

// A mailto: link long enough to break in some email apps (older Outlook cuts
// links off around 2,000 characters) gets a short body instead, and the notes
// travel by the clipboard.
export const MAILTO_MAX = 1800;

export function mailtoFor(notes, body) {
  const subject =
    notes.length === 1 ? `MagicMinutes note: ${oneLine(notes[0].title) || 'Untitled note'}` : `MagicMinutes notes (${notes.length})`;
  const enc = encodeURIComponent;
  // RFC 6068: line breaks in a mailto body are CRLF.
  const full = `mailto:?subject=${enc(subject)}&body=${enc(body.replace(/\r?\n/g, '\r\n'))}`;
  if (full.length <= MAILTO_MAX) return { url: full, fits: true, subject };
  const short =
    'Paste your notes here (MagicMinutes has copied them to your clipboard: press Ctrl+V).';
  return { url: `mailto:?subject=${enc(subject)}&body=${enc(short)}`, fits: false, subject };
}

export const NOTE_FORMAT_EXAMPLE = `=== Note ===
Title: Deal with the ferryman
Category: Quest
Place: Whispering Falls
Tags: ferryman, favour
Pinned: yes

He'll take us across for free if we find his lost lantern.
Blank lines and as many paragraphs as you like are fine.
=== End note ===

=== Note ===
Title: Only a title is really needed

Everything else is optional.
=== End note ===
`;
