// Plain-node test for src/lib/journal.mjs — the Recap page's journal-export
// logic (which sessions, what order, paragraph splitting). Run with:
// node tests/journal.test.mjs

import assert from 'node:assert/strict';
import { buildJournal, selectSessions, sessionTitle, splitParagraphs } from '../src/lib/journal.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const session = (over = {}) => ({
  _id: `s${over.number ?? 1}`,
  number: 1,
  title: '',
  active: false,
  startedAt: '2026-08-02T18:00:00.000Z',
  endedAt: '2026-08-02T21:00:00.000Z',
  summary: 'Something happened.',
  activity: [],
  ...over
});

await test('selectSessions sorts oldest first regardless of input order', () => {
  const sessions = [session({ number: 3 }), session({ number: 1 }), session({ number: 2 })];
  const picked = selectSessions(sessions, { mode: 'all' });
  assert.deepEqual(picked.map((s) => s.number), [1, 2, 3]);
});

await test('selectSessions drops the live session', () => {
  const sessions = [session({ number: 1 }), session({ number: 2, active: true })];
  const picked = selectSessions(sessions, { mode: 'all' });
  assert.deepEqual(picked.map((s) => s.number), [1]);
});

await test('selectSessions filters to a from/to range, inclusive', () => {
  const sessions = [1, 2, 3, 4, 5].map((n) => session({ number: n }));
  const picked = selectSessions(sessions, { mode: 'range', from: 2, to: 4 });
  assert.deepEqual(picked.map((s) => s.number), [2, 3, 4]);
});

await test('selectSessions range with only `from` is open-ended upward', () => {
  const sessions = [1, 2, 3].map((n) => session({ number: n }));
  const picked = selectSessions(sessions, { mode: 'range', from: 2 });
  assert.deepEqual(picked.map((s) => s.number), [2, 3]);
});

await test('selectSessions drops empty summaries unless asked to keep them', () => {
  const sessions = [session({ number: 1, summary: '' }), session({ number: 2, summary: 'wrote something' })];
  assert.deepEqual(selectSessions(sessions, { mode: 'all' }).map((s) => s.number), [2]);
  const kept = selectSessions(sessions, { mode: 'all' }, { includeEmptySummary: true });
  assert.deepEqual(kept.map((s) => s.number), [1, 2]);
});

await test('selectSessions treats a whitespace-only summary as empty', () => {
  const sessions = [session({ number: 1, summary: '   \n  ' })];
  assert.equal(selectSessions(sessions, { mode: 'all' }).length, 0);
});

await test('sessionTitle falls back to "Session N" when untitled', () => {
  assert.equal(sessionTitle(session({ number: 7, title: '' })), 'Session 7');
  assert.equal(sessionTitle(session({ number: 7, title: '  ' })), 'Session 7');
  assert.equal(sessionTitle(session({ number: 7, title: 'The Heist' })), 'The Heist');
});

await test('splitParagraphs splits on blank lines and keeps line breaks within a paragraph', () => {
  const text = 'First line\nSecond line\n\nSecond paragraph\n\n\nThird paragraph';
  const paras = splitParagraphs(text);
  assert.deepEqual(paras, [
    ['First line', 'Second line'],
    ['Second paragraph'],
    ['Third paragraph']
  ]);
});

await test('splitParagraphs handles Windows line endings the same way', () => {
  const text = 'a\r\nb\r\n\r\nc';
  assert.deepEqual(splitParagraphs(text), [['a', 'b'], ['c']]);
});

await test('splitParagraphs returns [] for empty or whitespace-only text', () => {
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs(undefined), []);
  assert.deepEqual(splitParagraphs('   \n\n  '), []);
});

await test('buildJournal reduces sessions and labels the range', () => {
  const sessions = [
    session({ number: 1, title: 'The Start', summary: 'Line one\n\nLine two', startedAt: '2026-08-01T18:00:00.000Z' }),
    session({ number: 2, title: '', summary: 'More stuff' })
  ];
  const journal = buildJournal(sessions, { title: 'My Campaign' });
  assert.equal(journal.title, 'My Campaign');
  assert.equal(journal.rangeLabel, 'Sessions 1–2');
  assert.equal(journal.sessions.length, 2);
  assert.equal(journal.sessions[0].title, 'The Start');
  assert.equal(journal.sessions[1].title, 'Session 2');
  assert.deepEqual(journal.sessions[0].paragraphs, [['Line one'], ['Line two']]);
});

await test('buildJournal with a single session reports it as one session, not a range', () => {
  const journal = buildJournal([session({ number: 5 })]);
  assert.equal(journal.rangeLabel, 'Session 5');
});

await test('buildJournal falls back to a default title when given a blank one', () => {
  const journal = buildJournal([session()], { title: '   ' });
  assert.equal(journal.title, 'Campaign journal');
});

await test('buildJournal reports "No sessions" when nothing matches', () => {
  const journal = buildJournal([session({ number: 1, summary: '' })]);
  assert.equal(journal.rangeLabel, 'No sessions');
  assert.deepEqual(journal.sessions, []);
});

await test('buildJournal omits dates when includeDates is off', () => {
  const journal = buildJournal([session({ number: 1 })], { includeDates: false });
  assert.equal(journal.sessions[0].date, null);
});

await test('buildJournal includes activity only when includeActivity is on', () => {
  const activity = [{ kind: 'note', name: 'A note', action: 'created' }];
  const sessions = [session({ number: 1, activity })];
  assert.deepEqual(buildJournal(sessions).sessions[0].activity, []);
  assert.deepEqual(buildJournal(sessions, { includeActivity: true }).sessions[0].activity, activity);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
