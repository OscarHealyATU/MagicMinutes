// Pure logic behind the Recap page's "📖 Export journal" dialog
// (src/components/JournalExport.jsx): which sessions go in, what order, and
// how a session's free-text summary turns into paragraphs/lines for print.
// No React/DOM in here, so tests/journal.test.mjs can exercise it with plain
// objects.

// `range` is either { mode: 'all' } or { mode: 'range', from, to } (session
// numbers, inclusive; either end may be omitted for an open range). A live
// session has no recap yet, so it's never included regardless of range.
function inRange(session, range) {
  if (!range || range.mode !== 'range') return true;
  const n = session.number;
  if (range.from != null && n < range.from) return false;
  if (range.to != null && n > range.to) return false;
  return true;
}

// The sessions a journal export includes, oldest first — a journal reads
// front-to-back in play order, regardless of how Recap's own list (or the
// order sessions happen to be stored in) is sorted.
export function selectSessions(sessions, range, { includeEmptySummary = false } = {}) {
  return (sessions || [])
    .filter((s) => !s.active)
    .filter((s) => inRange(s, range))
    .filter((s) => includeEmptySummary || (s.summary || '').trim())
    .sort((a, b) => (a.number || 0) - (b.number || 0));
}

// A session's heading falls back to "Session N" the same way Recap's own
// list does, for a session nobody ever titled.
export function sessionTitle(session) {
  return (session.title || '').trim() || `Session ${session.number}`;
}

// Free text -> paragraphs (separated by one or more blank lines) of lines
// (separated by a single newline) — the shape the print view renders as a
// <p> per paragraph with a <br/> between its lines, so a summary's own line
// breaks survive into the PDF instead of collapsing into one run-on block.
// A paragraph made of only blank lines is dropped; no text at all -> [].
export function splitParagraphs(text) {
  const trimmed = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n{2,}/)
    .map((para) => para.split('\n'))
    .filter((lines) => lines.some((line) => line.trim()));
}

// The full journal structure the print view (and the cover/contents pages)
// render from: the chosen sessions, oldest first, each reduced to just the
// fields a page needs.
export function buildJournal(
  sessions,
  {
    title = 'Campaign journal',
    range = { mode: 'all' },
    includeDates = true,
    includeActivity = false,
    includeEmptySummary = false,
    generatedAt = new Date().toISOString()
  } = {}
) {
  const picked = selectSessions(sessions, range, { includeEmptySummary });
  const first = picked[0];
  const last = picked[picked.length - 1];
  return {
    title: (title || '').trim() || 'Campaign journal',
    generatedAt,
    rangeLabel: picked.length
      ? first.number === last.number
        ? `Session ${first.number}`
        : `Sessions ${first.number}–${last.number}`
      : 'No sessions',
    sessions: picked.map((s) => ({
      number: s.number,
      title: sessionTitle(s),
      date: includeDates ? s.startedAt || null : null,
      paragraphs: splitParagraphs(s.summary),
      activity: includeActivity ? s.activity || [] : []
    }))
  };
}
