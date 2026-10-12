// The command-line commands, as pure logic: no Tauri, no files, no database of
// its own. `runCommand(argv, ctx)` takes the arguments and a `ctx` that supplies
// the outside world, and returns { output, code }. src/cli.js wires `ctx` to the
// real app; tests/commands.test.mjs wires it to a fake. Everything that decides
// what a note or an import means is reused from store.mjs, transfer.mjs and
// noteText.mjs, so the command line and the app can't disagree.
//
// `ctx` is:
//   listCampaigns()        -> { campaigns: [{ _id, name }], activeId }
//   openCampaign(id|null)  -> { campaign, driver }   (null = the active one; must
//                             never change which campaign the app has open)
//   createCampaign(name)   -> the new campaign (does not switch to it)
//   readFile(path) / writeFile(path, text)
//   backup(name, text)     -> where the safety backup went (throws if it can't)
//   now()                  -> ISO timestamp
//
// This is aimed at AI agents, some of them weak, so it is forgiving: it accepts
// the aliases and flag spellings a model is likely to guess, and every mistake
// gets one line saying what is wrong and the exact usage line to type instead.
// Exit codes: 0 fine, 1 the caller got something wrong, 2 something broke inside.

import { validateCampaignName } from './campaigns.mjs';
import { NOTE_CATEGORIES, cleanNote, markDuplicates, notesToText, parseNotesText } from './noteText.mjs';
import * as store from './store.mjs';
import {
  buildExport,
  buildNotesExport,
  describePlan,
  describePlanByCollection,
  parseExport,
  parseNotesFile,
  planImport
} from './transfer.mjs';

const PROGRAM = 'magicminutes';
const DEFAULT_LIMIT = 20;

// A mistake by whoever typed the command. Anything else that gets thrown is
// reported as an internal error (exit code 2).
export class CliError extends Error {
  constructor(message, { usage = '', code = 1 } = {}) {
    super(message);
    this.usage = usage;
    this.code = code;
  }
}

// ---------- Help ----------

// Kept short on purpose: an agent reads this on every session, so every line
// costs tokens. tests/commands.test.mjs holds it to a character budget.
export const HELP = `MagicMinutes CLI - run: ${PROGRAM} <command> [options]
  campaigns                         list campaigns (* = current)
  campaigns add "Name"              new empty campaign
  notes list [--limit 20] [--category Quest]
  notes search "words" [--limit 20]
  notes show <id>                   full note (id = first 8 chars)
  notes add --title "T" --text "Body" [--place P] [--tags a,b] [--category Quest]
  notes import <file> [--yes]       text (=== Note ===) or JSON
  notes export <file> [--search "words"]
  export <file>                     whole-campaign backup (JSON)
  import <file> [--replace] [--yes] restore or merge a backup
  run <file>                        commands from a file, one per line
  help <command>
Options: --campaign "Name" (default: current)  --json  --yes
Imports only show a plan until you add --yes. Nothing is deleted except by
import --replace --yes, which saves a backup first.
Categories: ${NOTE_CATEGORIES.join(', ')}`;

// One entry per command: the usage line to type, a line saying what it does,
// an example, and the options it understands (besides --campaign/--json/--yes).
const COMMANDS = {
  help: {
    usage: `${PROGRAM} help [command]`,
    about: 'Shows the command list, or details for one command.',
    example: `${PROGRAM} help notes add`,
    flags: []
  },
  campaigns: {
    usage: `${PROGRAM} campaigns`,
    about: 'Lists campaigns. * marks the one the app has open.',
    example: `${PROGRAM} campaigns`,
    flags: []
  },
  'campaigns add': {
    usage: `${PROGRAM} campaigns add "Name"`,
    about: 'Creates an empty campaign. The app stays on its current campaign; use --campaign to work in the new one.',
    example: `${PROGRAM} campaigns add "Curse of the Marsh"`,
    flags: []
  },
  'notes list': {
    usage: `${PROGRAM} notes list [--limit 20] [--category Quest]`,
    about: 'One line per note, newest first: id, date, category, title. --limit all shows everything.',
    example: `${PROGRAM} notes list --category Lore --limit 5`,
    flags: ['limit', 'category']
  },
  'notes search': {
    usage: `${PROGRAM} notes search "words" [--limit 20]`,
    about: 'Finds notes with all the words in title, text, tags or place, title matches first. Falls back to notes with some of them.',
    example: `${PROGRAM} notes search "bell tower"`,
    flags: ['limit']
  },
  'notes show': {
    usage: `${PROGRAM} notes show <id>`,
    about: 'Prints one whole note. The id is the first 8 characters shown in lists, or any unique start of it.',
    example: `${PROGRAM} notes show 1a2b3c4d`,
    flags: []
  },
  'notes add': {
    usage: `${PROGRAM} notes add --title "..." --text "..." [--place "..."] [--tags a,b] [--category Quest]`,
    about: 'Adds one note at once. In --text, \\n is a new line. A note with the same title and text is skipped unless --yes.',
    example: `${PROGRAM} notes add --title "Ferryman's deal" --text "Free crossing for a lantern." --category Quest --tags ferryman`,
    flags: ['title', 'text', 'place', 'tags', 'category', 'pinned']
  },
  'notes import': {
    usage: `${PROGRAM} notes import <file> [--yes]`,
    about: 'Reads notes from a text file (=== Note === blocks) or a notes JSON file. Shows what it found; adds them only with --yes. Notes you already have are skipped.',
    example: `${PROGRAM} notes import session5.txt --yes`,
    flags: []
  },
  'notes export': {
    usage: `${PROGRAM} notes export <file> [--search "words"]`,
    about: 'Writes notes to a file: JSON if the name ends in .json, otherwise readable text. Will not overwrite a file without --yes.',
    example: `${PROGRAM} notes export marsh.txt --search marsh`,
    flags: ['search', 'category']
  },
  export: {
    usage: `${PROGRAM} export <file>`,
    about: 'Writes the whole campaign (notes, places, NPCs, everything) as a JSON backup. Will not overwrite a file without --yes.',
    example: `${PROGRAM} export backup.json`,
    flags: []
  },
  import: {
    usage: `${PROGRAM} import <file> [--replace] [--yes]`,
    about: 'Reads a backup. Shows a plan; applies it only with --yes. Merge (default) adds and overwrites by id. --replace makes the file the whole campaign and deletes the rest, after saving a safety backup.',
    example: `${PROGRAM} import backup.json --yes`,
    flags: ['replace']
  },
  run: {
    usage: `${PROGRAM} run <file>`,
    about: 'Runs the commands in a file, one per line, in order (same syntax, without "magicminutes"). Lines starting with # are skipped. Stops at the first error.',
    example: `${PROGRAM} run steps.txt`,
    flags: []
  }
};

export function helpFor(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return HELP;
  let key;
  try {
    key = route(words).key;
  } catch {
    key = null;
  }
  const info = key && COMMANDS[key];
  if (!info) return `No command called "${words.join(' ')}".\n${HELP}`;
  return `Usage: ${info.usage}\n${info.about}\nExample: ${info.example}`;
}

// ---------- Reading the command line ----------

// Splits one line the way a shell would: spaces separate words, double or single
// quotes keep several words together, \" is a quote inside double quotes. A
// backslash anywhere else is left alone, because Windows paths are full of them.
// An apostrophe inside a word (Bob's) is just an apostrophe.
export function tokenize(line) {
  const out = [];
  let cur = '';
  let started = false; // true for "" too, which is a real (empty) word
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"') {
      if (c === '\\' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quote = null;
      else cur += c;
    } else if (quote === "'") {
      // Closes at a quote that ends the word, so 'Bob's boat' keeps its apostrophe.
      if (c === "'" && (i + 1 === line.length || /\s/.test(line[i + 1]))) quote = null;
      else cur += c;
    } else if (c === '"') {
      quote = '"';
      started = true;
    } else if (c === "'" && (!cur || cur.endsWith('='))) {
      quote = "'";
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) throw new CliError(`A ${quote} quote is never closed in: ${line}`);
  if (started) out.push(cur);
  return out;
}

const BOOLEAN_FLAGS = new Set(['yes', 'json', 'replace', 'help', 'pinned']);
// Spellings a model is likely to try, mapped to the real option.
const FLAG_ALIASES = {
  y: 'yes',
  confirm: 'yes',
  apply: 'yes',
  force: 'yes',
  h: 'help',
  c: 'campaign',
  n: 'limit',
  max: 'limit',
  count: 'limit',
  t: 'title',
  s: 'search',
  q: 'search',
  query: 'search',
  tag: 'tags',
  cat: 'category',
  content: 'text',
  body: 'text',
  location: 'place'
};

// argv is already split into words (by the OS, or by `tokenize`). Returns
// { words, flags, errors }: the plain words in order, the options by their real
// name, and any option that was missing its value.
export function parseArgs(argv) {
  const words = [];
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (token === '--') {
      words.push(...argv.slice(i + 1).map(String));
      break;
    }
    // --name, --name=value, or a single-letter -n. Anything else (including
    // "-5" and "- a bullet") is just a word.
    const m = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(token) || /^-([A-Za-z])()$/.exec(token);
    if (!m) {
      words.push(token);
      continue;
    }
    const raw = m[1].toLowerCase();
    const name = FLAG_ALIASES[raw] || raw;
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = m[2] === undefined || m[2] === '' ? true : !/^(false|no|0)$/i.test(m[2]);
    } else if (m[2]) {
      flags[name] = m[2];
    } else if (i + 1 < argv.length) {
      flags[name] = String(argv[++i]);
    } else {
      errors.push(`--${raw} needs a value`);
    }
  }
  return { words, flags, errors };
}

// ---------- Finding the right command ----------

const GROUPS = {
  help: 'help',
  campaigns: 'campaigns',
  campaign: 'campaigns',
  camp: 'campaigns',
  notes: 'notes',
  note: 'notes',
  export: 'export',
  import: 'import',
  run: 'run'
};
const NOTE_VERBS = {
  list: 'list',
  ls: 'list',
  search: 'search',
  find: 'search',
  show: 'show',
  cat: 'show',
  view: 'show',
  get: 'show',
  read: 'show',
  add: 'add',
  new: 'add',
  create: 'add',
  import: 'import',
  export: 'export'
};
const CAMPAIGN_VERBS = { list: 'list', ls: 'list', add: 'add', new: 'add', create: 'add' };

// What to suggest, as a command key, for each word someone might mistype.
const SUGGESTIONS = {
  ...Object.fromEntries(Object.keys(GROUPS).map((w) => [w, GROUPS[w] === 'notes' ? 'notes list' : GROUPS[w]])),
  list: 'notes list',
  search: 'notes search',
  show: 'notes show',
  add: 'notes add'
};

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

function nearestCommand(word, names) {
  const w = word.toLowerCase();
  let best = null;
  let bestScore = 3; // farther than 2 typos is a guess, not a suggestion
  for (const name of names) {
    const score = name.startsWith(w) || w.startsWith(name) ? 1 : editDistance(w, name);
    if (score < bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

function unknown(word, names, suggestions) {
  const near = nearestCommand(word, names);
  const key = near && suggestions[near];
  if (key) {
    return new CliError(`unknown command "${word}" (did you mean "${near}"?)`, { usage: COMMANDS[key].usage });
  }
  return new CliError(`unknown command "${word}"`, { usage: `${PROGRAM} help` });
}

// words -> { key, rest }: which command, and the words left over for it.
function route(words) {
  const first = words[0].toLowerCase();
  const group = GROUPS[first];

  if (!group) {
    // A bare verb ("list", "search", "add") means the same on notes.
    const verb = NOTE_VERBS[first];
    if (verb && verb !== 'import' && verb !== 'export') return { key: `notes ${verb}`, rest: words.slice(1) };
    throw unknown(first, Object.keys(SUGGESTIONS), SUGGESTIONS);
  }

  if (group === 'notes') {
    if (words.length === 1) return { key: 'notes list', rest: [] };
    const sub = words[1].toLowerCase();
    const verb = NOTE_VERBS[sub];
    if (!verb) throw unknown(sub, Object.keys(NOTE_VERBS), Object.fromEntries(Object.keys(NOTE_VERBS).map((w) => [w, `notes ${NOTE_VERBS[w]}`])));
    return { key: `notes ${verb}`, rest: words.slice(2) };
  }

  if (group === 'campaigns') {
    if (words.length === 1) return { key: 'campaigns', rest: [] };
    const sub = words[1].toLowerCase();
    const verb = CAMPAIGN_VERBS[sub];
    const keyOf = (v) => (v === 'add' ? 'campaigns add' : 'campaigns');
    if (!verb) throw unknown(sub, Object.keys(CAMPAIGN_VERBS), Object.fromEntries(Object.entries(CAMPAIGN_VERBS).map(([w, v]) => [w, keyOf(v)])));
    return { key: keyOf(verb), rest: words.slice(2) };
  }

  return { key: group, rest: words.slice(1) };
}

// ---------- Small helpers ----------

const shortId = (id) => String(id).slice(0, 8);
const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : '----------');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function truncate(s, max) {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const errText = (e) => (e && e.message ? e.message : String(e));
// "1 note", "3 notes", "1 entry", "3 entries".
const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const json = (data) => JSON.stringify(data);

function listCategories() {
  return NOTE_CATEGORIES.join(', ');
}

// "quest", "Session_Log" and "sess" all find a category; anything else is an
// error that lists the real ones.
export function matchCategory(raw, usage) {
  const want = oneLine(String(raw).replace(/[_-]+/g, ' ')).toLowerCase();
  const exact = NOTE_CATEGORIES.find((c) => c.toLowerCase() === want);
  if (exact) return exact;
  const starts = want ? NOTE_CATEGORIES.filter((c) => c.toLowerCase().startsWith(want)) : [];
  if (starts.length === 1) return starts[0];
  throw new CliError(`"${raw}" is not a category. Use one of: ${listCategories()}`, { usage });
}

function parseLimit(flags, usage) {
  if (flags.limit === undefined) return DEFAULT_LIMIT;
  const v = String(flags.limit).trim();
  if (/^(all|0)$/i.test(v)) return Infinity;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`--limit must be a whole number such as 20, or "all" (got "${flags.limit}")`, { usage });
  }
  return n;
}

function need(words, count, what, usage) {
  if (words.length < count) throw new CliError(`missing ${what}`, { usage });
}

function noExtra(words, count, usage) {
  if (words.length > count) {
    throw new CliError(`unexpected extra word "${words[count]}" (put text with spaces in quotes)`, { usage });
  }
}

// ---------- Campaigns ----------

// Name, exact id, then a unique start of the id or of the name. Never guesses
// between several.
export function resolveCampaign(campaigns, query) {
  const q = oneLine(query).toLowerCase();
  const name = (c) => oneLine(c.name).toLowerCase();
  const id = (c) => String(c._id).toLowerCase();
  const tries = [
    campaigns.filter((c) => name(c) === q),
    campaigns.filter((c) => id(c) === q),
    // The start of the id or of the name, whichever the caller meant.
    campaigns.filter((c) => id(c).startsWith(q) || name(c).startsWith(q))
  ];
  for (const matches of tries) if (matches.length === 1) return matches[0];
  const several = tries.find((matches) => matches.length > 1);
  const pool = several || campaigns;
  throw new CliError(
    `${several ? `"${query}" matches several campaigns` : `no campaign called "${query}"`}. Campaigns: ${pool
      .map((c) => `"${c.name}"`)
      .join(', ')}`,
    { usage: `${PROGRAM} campaigns` }
  );
}

async function openCampaign(g, ctx) {
  if (!g.campaign) return ctx.openCampaign(null);
  const { campaigns } = await ctx.listCampaigns();
  return ctx.openCampaign(resolveCampaign(campaigns, g.campaign)._id);
}

async function cmdCampaigns(a, g, ctx) {
  const { campaigns, activeId } = await ctx.listCampaigns();
  if (g.json) {
    return json({
      current: activeId,
      campaigns: campaigns.map((c) => ({ id: c._id, name: c.name, current: c._id === activeId }))
    });
  }
  return campaigns.map((c) => `${c._id === activeId ? '*' : ' '} ${c.name} (id ${shortId(c._id)})`).join('\n');
}

async function cmdCampaignsAdd(a, g, ctx) {
  const usage = COMMANDS['campaigns add'].usage;
  need(a.words, 1, 'the campaign name', usage);
  noExtra(a.words, 1, usage);
  let name;
  try {
    name = validateCampaignName(a.words[0]);
  } catch (e) {
    throw new CliError(errText(e), { usage });
  }
  const { campaigns, activeId } = await ctx.listCampaigns();
  const same = campaigns.find((c) => oneLine(c.name).toLowerCase() === name.toLowerCase());
  if (same) {
    return g.json
      ? json({ ok: true, created: false, id: same._id, name: same.name })
      : `A campaign called "${same.name}" already exists (id ${shortId(same._id)}). Nothing created.`;
  }
  const made = await ctx.createCampaign(name);
  const current = campaigns.find((c) => c._id === activeId);
  if (g.json) return json({ ok: true, created: true, id: made._id, name: made.name });
  return `Created campaign "${made.name}" (id ${shortId(made._id)}). The app is still on "${current ? current.name : 'its current campaign'}"; add --campaign "${made.name}" to work in the new one.`;
}

// ---------- Notes: finding them ----------

function noteLine(n) {
  return `${shortId(n._id)} | ${dateOf(n.updatedAt || n.createdAt)} | ${truncate(n.category, 12)} | ${truncate(n.title, 60)}`;
}

function noteSummary(n) {
  return { id: shortId(n._id), date: dateOf(n.updatedAt || n.createdAt), category: n.category, title: oneLine(n.title) };
}

// A list of notes as lines, cut off at `limit`, with a last line saying how
// many were left out.
function renderNotes(notes, limit, g, { header = '', empty }) {
  const shown = notes.slice(0, limit);
  const more = notes.length - shown.length;
  if (g.json) return json({ total: notes.length, shown: shown.length, notes: shown.map(noteSummary) });
  if (!notes.length) return empty;
  const lines = shown.map(noteLine);
  if (header) lines.unshift(header);
  if (more > 0) lines.push(`... ${more} more (use --limit)`);
  return lines.join('\n');
}

// Splits the words, finds which notes contain them, and ranks: a word in the
// title counts most, then tags, place, and last the text. Returns
//   all  - notes containing every word, best first
//   some - notes containing at least one but not all, best first
export function searchNotes(notes, query) {
  const words = oneLine(query).toLowerCase().split(' ').filter(Boolean);
  const phrase = words.join(' ');
  const all = [];
  const some = [];
  for (const n of notes) {
    const title = oneLine(n.title).toLowerCase();
    const text = String(n.content ?? '').toLowerCase();
    const tags = (n.tags || []).join(' ').toLowerCase();
    const place = oneLine(n.place).toLowerCase();
    let score = words.length > 1 && title.includes(phrase) ? 200 : 0;
    let hits = 0;
    for (const w of words) {
      const here = (title.includes(w) ? 100 : 0) + (tags.includes(w) ? 40 : 0) + (place.includes(w) ? 30 : 0) + (text.includes(w) ? 10 : 0);
      if (here) hits++;
      score += here;
    }
    if (!hits) continue;
    (hits === words.length ? all : some).push({ n, score });
  }
  // Same score: the more recently edited note first.
  const byScore = (x, y) => y.score - x.score || new Date(y.n.updatedAt || 0) - new Date(x.n.updatedAt || 0);
  return { all: all.sort(byScore).map((x) => x.n), some: some.sort(byScore).map((x) => x.n) };
}

// A note by id or by the start of its id. Falls back to an exact title, since a
// model will sometimes pass that instead. Never guesses between several.
export function findNote(notes, query) {
  const q = oneLine(query).toLowerCase();
  const exact = notes.filter((n) => String(n._id).toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const starts = notes.filter((n) => String(n._id).toLowerCase().startsWith(q));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) {
    const list = starts.slice(0, 10).map(noteLine).join('\n');
    throw new CliError(
      `"${query}" matches ${starts.length} notes; type more of the id:\n${list}${starts.length > 10 ? '\n...' : ''}`,
      { usage: COMMANDS['notes show'].usage }
    );
  }
  const titled = notes.filter((n) => oneLine(n.title).toLowerCase() === q);
  if (titled.length === 1) return titled[0];
  throw new CliError(`no note with id starting "${query}". To find one by words, use: ${PROGRAM} notes search "${query}"`, {
    usage: COMMANDS['notes show'].usage
  });
}

async function cmdNotesList(a, g, ctx) {
  const usage = COMMANDS['notes list'].usage;
  noExtra(a.words, 0, usage);
  const limit = parseLimit(a.flags, usage);
  const category = a.flags.category !== undefined ? matchCategory(a.flags.category, usage) : null;
  const { driver } = await openCampaign(g, ctx);
  const notes = (await store.listDocs(driver, 'notes')).filter((n) => !category || n.category === category);
  return renderNotes(notes, limit, g, { empty: category ? `No ${category} notes.` : 'No notes yet.' });
}

async function cmdNotesSearch(a, g, ctx) {
  const usage = COMMANDS['notes search'].usage;
  const query = oneLine(a.words.join(' '));
  if (!query) throw new CliError('missing the words to search for', { usage });
  const limit = parseLimit(a.flags, usage);
  const { driver } = await openCampaign(g, ctx);
  const { all, some } = searchNotes(await store.listDocs(driver, 'notes'), query);
  const notes = all.length ? all : some;
  const header = !all.length && some.length ? '(no note has all those words; these have some of them)' : '';
  return renderNotes(notes, limit, g, { header, empty: `No notes match "${query}".` });
}

async function cmdNotesShow(a, g, ctx) {
  const usage = COMMANDS['notes show'].usage;
  need(a.words, 1, 'the note id', usage);
  const { driver } = await openCampaign(g, ctx);
  const note = findNote(await store.listDocs(driver, 'notes'), a.words.join(' '));
  if (g.json) return json(note);
  return `ID: ${note._id}\nUpdated: ${dateOf(note.updatedAt)}\n${notesToText([note], { intro: '' }).trimEnd()}`;
}

// ---------- Notes: adding ----------

async function cmdNotesAdd(a, g, ctx) {
  const usage = COMMANDS['notes add'].usage;
  noExtra(a.words, 0, usage);
  const f = a.flags;
  // "\n" typed into a shell argument is two characters; make it a line break.
  const content = f.text === undefined ? '' : String(f.text).replace(/\\n/g, '\n');
  let title = oneLine(f.title);
  if (!title && content.trim()) title = truncate(content.trim().split('\n')[0], 60);
  if (!title) throw new CliError('a note needs --title (or at least --text)', { usage });

  const note = cleanNote({
    title,
    category: f.category !== undefined ? matchCategory(f.category, usage) : 'Misc',
    place: f.place,
    tags: f.tags === undefined ? [] : String(f.tags).split(','),
    content,
    pinned: f.pinned === true
  });

  const { campaign, driver } = await openCampaign(g, ctx);
  const have = await store.listDocs(driver, 'notes');
  // A model that isn't sure its first try worked will often run it again.
  const existing = have.find((n) => markDuplicates([note], [n])[0].duplicate);
  if (existing && !g.yes) {
    return g.json
      ? json({ ok: true, added: false, duplicateOf: existing && existing._id })
      : `Not added: "${campaign.name}" already has a note with that title and text (id ${existing ? shortId(existing._id) : '?'}). Add --yes to add it anyway.`;
  }
  const doc = await store.createDoc(driver, 'notes', note, { now: ctx.now });
  return g.json
    ? json({ ok: true, added: true, id: doc._id, title: doc.title, campaign: campaign.name })
    : `Added note ${shortId(doc._id)} "${truncate(doc.title, 60)}" to "${campaign.name}".`;
}

// ---------- Files ----------

async function readInput(ctx, path, usage) {
  try {
    return String(await ctx.readFile(path)).replace(/^﻿/, '');
  } catch (e) {
    throw new CliError(`can't read "${path}": ${errText(e)}`, { usage });
  }
}

// "File not found", as the OS says it however its language is set. Windows and
// Rust both end these messages with "(os error 2)" or "(os error 3)".
const NOT_FOUND = /not found|no such file|cannot find|os error [23]\b/i;

// Writing a file silently over another is the one way these commands could
// destroy something that isn't in MagicMinutes, so it needs --yes.
async function writeOutput(ctx, path, text, g, usage) {
  let exists = false;
  try {
    await ctx.readFile(path);
    exists = true;
  } catch (e) {
    // Anything but "isn't there" means we can't tell, so don't risk it.
    if (!NOT_FOUND.test(errText(e))) {
      throw new CliError(`can't check "${path}" before writing to it: ${errText(e)}`, { usage });
    }
  }
  if (exists && !g.yes) {
    throw new CliError(`"${path}" already exists. Add --yes to overwrite it, or choose another file name.`, { usage });
  }
  try {
    await ctx.writeFile(path, text);
  } catch (e) {
    throw new CliError(`can't write "${path}": ${errText(e)}`, { usage });
  }
}

// A notes file in any of the shapes the app accepts: a shared-notes or backup
// JSON file, a bare JSON list of notes, or the readable === Note === text.
function parseNotesInput(text, path, usage) {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('{')) return parseNotesFile(trimmed);
    if (trimmed.startsWith('[')) {
      const list = JSON.parse(trimmed);
      return { notes: list.filter((d) => d && typeof d === 'object').map((d) => cleanNote(d)), warnings: [] };
    }
  } catch (e) {
    throw new CliError(errText(e), { usage });
  }
  const parsed = parseNotesText(text);
  if (!parsed.notes.length) {
    throw new CliError(
      `no notes found in "${path}". Each note should look like:\n=== Note ===\nTitle: Name\nCategory: Quest\n\nText of the note.\n=== End note ===`,
      { usage }
    );
  }
  return parsed;
}

async function cmdNotesImport(a, g, ctx) {
  const usage = COMMANDS['notes import'].usage;
  need(a.words, 1, 'the file to import', usage);
  noExtra(a.words, 1, usage);
  const path = a.words[0];
  const { notes: parsed, warnings } = parseNotesInput(await readInput(ctx, path, usage), path, usage);

  const { campaign, driver } = await openCampaign(g, ctx);
  const existing = await store.listDocs(driver, 'notes');
  const haveIds = new Set(existing.map((n) => n._id));
  // Same test as the app's Import dialog: the same title and text, or the same id.
  const checked = markDuplicates(parsed, existing).map((n) => ({ ...n, duplicate: n.duplicate || haveIds.has(n._id) }));
  const fresh = checked.filter((n) => !n.duplicate);
  const skipped = checked.length - fresh.length;

  const added = [];
  if (g.yes) {
    for (const n of fresh) {
      const { duplicate, ...doc } = n;
      added.push(doc._id ? await store.upsertDoc(driver, 'notes', doc, { now: ctx.now }) : await store.createDoc(driver, 'notes', doc, { now: ctx.now }));
    }
  }

  if (g.json) {
    return json({ applied: !!g.yes, found: checked.length, new: fresh.length, skipped, added: added.length, warnings });
  }
  const lines = [];
  if (g.yes) {
    lines.push(`Imported ${plural(added.length, 'note')} into "${campaign.name}"${skipped ? `, skipped ${skipped} already there` : ''}.`);
  } else {
    lines.push(`${path}: ${plural(checked.length, 'note')} found, ${fresh.length} new, ${skipped} already in "${campaign.name}".`);
    for (const n of fresh.slice(0, 20)) lines.push(`  ${truncate(n.title, 60)} (${n.category})`);
    if (fresh.length > 20) lines.push(`  ... ${fresh.length - 20} more`);
  }
  for (const w of warnings.slice(0, 5)) lines.push(`Warning: ${w}`);
  if (!g.yes) {
    lines.push(fresh.length ? `Nothing changed yet. Add --yes to add the ${fresh.length} new ${fresh.length === 1 ? 'note' : 'notes'}.` : 'Nothing to add.');
  }
  return lines.join('\n');
}

async function cmdNotesExport(a, g, ctx) {
  const usage = COMMANDS['notes export'].usage;
  need(a.words, 1, 'the file to write', usage);
  noExtra(a.words, 1, usage);
  const path = a.words[0];
  const category = a.flags.category !== undefined ? matchCategory(a.flags.category, usage) : null;
  const { campaign, driver } = await openCampaign(g, ctx);
  let notes = await store.listDocs(driver, 'notes');
  if (a.flags.search) notes = searchNotes(notes, a.flags.search).all;
  if (category) notes = notes.filter((n) => n.category === category);
  const asJson = /\.json$/i.test(path);
  const text = asJson
    ? JSON.stringify(buildNotesExport(notes, { now: ctx.now }), null, 2)
    : notesToText(notes, { intro: '' });
  await writeOutput(ctx, path, text, g, usage);
  return g.json
    ? json({ ok: true, file: path, notes: notes.length })
    : `Wrote ${plural(notes.length, 'note')} from "${campaign.name}" to ${path} (${asJson ? 'JSON' : 'text'}).`;
}

// ---------- Whole-campaign export and import ----------

async function readAll(driver) {
  const all = {};
  for (const name of store.COLLECTIONS) all[name] = await store.listDocs(driver, name);
  return all;
}

async function cmdExport(a, g, ctx) {
  const usage = COMMANDS.export.usage;
  need(a.words, 1, 'the file to write', usage);
  noExtra(a.words, 1, usage);
  const { campaign, driver } = await openCampaign(g, ctx);
  const all = await readAll(driver);
  await writeOutput(ctx, a.words[0], JSON.stringify(buildExport(all, { now: ctx.now }), null, 2), g, usage);
  const entries = Object.values(all).reduce((sum, docs) => sum + docs.length, 0);
  return g.json
    ? json({ ok: true, file: a.words[0], entries })
    : `Exported ${plural(entries, 'entry')} from "${campaign.name}" to ${a.words[0]}.`;
}

async function cmdImport(a, g, ctx) {
  const usage = COMMANDS.import.usage;
  need(a.words, 1, 'the backup file to import', usage);
  noExtra(a.words, 1, usage);
  const path = a.words[0];
  const mode = a.flags.replace ? 'replace' : 'merge';

  let data;
  try {
    data = parseExport(await readInput(ctx, path, usage));
  } catch (e) {
    throw e instanceof CliError ? e : new CliError(errText(e), { usage });
  }

  const { campaign, driver } = await openCampaign(g, ctx);
  const existing = await readAll(driver);
  const { plan, totals } = planImport(existing, data.collections, mode);
  const changes = totals.create + totals.update + totals.remove;
  const notices = [
    data.skipped.length ? `Skipped unknown sections: ${data.skipped.join(', ')}.` : '',
    data.duplicates.length ? `Duplicate ids were collapsed in: ${data.duplicates.join(', ')}.` : ''
  ].filter(Boolean);
  const breakdown = describePlanByCollection({ plan });
  const summary = describePlan({ mode, totals });

  const planJson = () => ({
    mode,
    campaign: campaign.name,
    totals,
    collections: Object.fromEntries(
      Object.entries(plan)
        .filter(([, p]) => p.create.length || p.update.length || p.remove.length)
        .map(([name, p]) => [name, { added: p.create.length, replaced: p.update.length, deleted: p.remove.length }])
    )
  });

  if (!changes) {
    return g.json ? json({ ...planJson(), applied: false }) : [`Nothing to change: ${path} matches what "${campaign.name}" already has.`, ...notices].join('\n');
  }

  if (!g.yes) {
    if (g.json) return json({ ...planJson(), applied: false });
    const lines = [`Plan for "${campaign.name}" from ${path}: ${summary}`, ...breakdown.map((l) => `  ${l}`), ...notices];
    if (mode === 'replace') {
      lines.push(`Replace deletes the ${plural(totals.remove, 'entry')} that ${totals.remove === 1 ? 'is' : 'are'} not in the file. A safety backup is saved first.`);
    }
    lines.push('Nothing changed yet. Add --yes to apply.');
    return lines.join('\n');
  }

  // Replace deletes things, so a copy of what's there goes to the app's data
  // folder first, and if that can't be written nothing is touched.
  let backupPath = '';
  if (mode === 'replace') {
    const stamp = ctx.now().replace(/[:.]/g, '-');
    const safe = String(campaign.name).replace(/[^\w-]+/g, '_').slice(0, 40) || 'campaign';
    try {
      backupPath = await ctx.backup(
        `magicminutes-safety-backup-${safe}-${stamp}.json`,
        JSON.stringify(buildExport(existing, { now: ctx.now }), null, 2)
      );
    } catch (e) {
      throw new CliError(`couldn't write a safety backup, so nothing was changed: ${errText(e)}`, { usage });
    }
  }

  // Writes before deletes: if this dies partway, the campaign is left holding
  // too much rather than too little.
  for (const name of store.COLLECTIONS) {
    const step = plan[name];
    for (const doc of [...step.create, ...step.update]) await store.upsertDoc(driver, name, doc, { now: ctx.now });
    for (const id of step.remove) await store.removeDoc(driver, name, id);
  }

  if (g.json) return json({ ...planJson(), applied: true, backup: backupPath || null });
  return [`Imported into "${campaign.name}": ${summary}`, ...notices, backupPath ? `Safety backup: ${backupPath}` : ''].filter(Boolean).join('\n');
}

// ---------- run ----------

async function cmdRun(a, g, ctx, depth) {
  const usage = COMMANDS.run.usage;
  need(a.words, 1, 'the file of commands', usage);
  noExtra(a.words, 1, usage);
  if (depth > 0) throw new CliError('a commands file can not contain another "run"', { usage });
  const path = a.words[0];
  const lines = (await readInput(ctx, path, usage)).split(/\r\n|\r|\n/);

  const parts = [];
  let ran = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let result;
    try {
      let argv = tokenize(line);
      // Lines may be written the way they'd be typed, with the program name.
      if (argv.length && /^magicminutes(\.exe)?$/i.test(argv[0])) argv = argv.slice(1);
      const parsed = parseArgs(argv);
      // Options given to `run` (--campaign, --json, --yes) apply to every line
      // unless the line sets its own.
      parsed.flags = { ...(g.campaign ? { campaign: g.campaign } : {}), ...(g.json ? { json: true } : {}), ...(g.yes ? { yes: true } : {}), ...parsed.flags };
      result = await execute(parsed, ctx, depth + 1);
    } catch (e) {
      result = failure(e);
    }
    ran++;
    parts.push(g.json ? result.output : `> ${truncate(line, 80)}\n${result.output}`);
    if (result.code !== 0) {
      parts.push(`Stopped at line ${i + 1} of ${path}; ${ran - 1} earlier ${ran - 1 === 1 ? 'command' : 'commands'} ran.`);
      return { output: parts.join('\n'), code: result.code };
    }
  }
  if (!g.json) parts.push(`Ran ${plural(ran, 'command')} from ${path}.`);
  return parts.join('\n');
}

// ---------- Putting it together ----------

const HANDLERS = {
  campaigns: cmdCampaigns,
  'campaigns add': cmdCampaignsAdd,
  'notes list': cmdNotesList,
  'notes search': cmdNotesSearch,
  'notes show': cmdNotesShow,
  'notes add': cmdNotesAdd,
  'notes import': cmdNotesImport,
  'notes export': cmdNotesExport,
  export: cmdExport,
  import: cmdImport,
  run: cmdRun
};

const GLOBAL_FLAGS = ['campaign', 'json', 'yes', 'help'];

async function execute(parsed, ctx, depth = 0) {
  const { words, flags, errors } = parsed;
  const g = { campaign: flags.campaign, json: !!flags.json, yes: !!flags.yes };
  // Someone who types the program name again inside the arguments.
  while (words.length && /^magicminutes(\.exe)?$/i.test(words[0])) words.shift();

  if (!words.length) return { output: HELP, code: 0 };
  if (words[0].toLowerCase() === 'help') return { output: helpFor(words.slice(1).join(' ')), code: 0 };

  const { key, rest } = route(words);
  if (flags.help) return { output: helpFor(key), code: 0 };

  const info = COMMANDS[key];
  if (errors.length) throw new CliError(errors[0], { usage: info.usage });
  const allowed = new Set([...GLOBAL_FLAGS, ...info.flags]);
  const bad = Object.keys(flags).find((f) => !allowed.has(f));
  if (bad) {
    const known = info.flags.map((f) => `--${f}`).concat('--campaign', '--json', '--yes').join(' ');
    throw new CliError(`unknown option --${bad} (this command takes: ${known})`, { usage: info.usage });
  }
  if (flags.campaign !== undefined && !String(flags.campaign).trim()) {
    throw new CliError('--campaign needs a campaign name', { usage: info.usage });
  }

  const result = await HANDLERS[key]({ words: rest, flags }, g, ctx, depth);
  return typeof result === 'string' ? { output: result, code: 0 } : result;
}

// Turns whatever was thrown into the text and exit code the caller sees.
function failure(e) {
  if (e instanceof CliError) {
    const message = `Error: ${e.message}`;
    return { output: e.usage ? `${message}\nUsage: ${e.usage}` : message, code: e.code };
  }
  return { output: `Internal error: ${errText(e)}`, code: 2 };
}

/**
 * Runs one command. `argv` is the list of words after the program name.
 * Never throws: problems come back as { output, code } with code 1 (the caller
 * got something wrong) or 2 (something broke inside).
 */
export async function runCommand(argv, ctx) {
  try {
    return await execute(parseArgs(argv), ctx);
  } catch (e) {
    return failure(e);
  }
}
