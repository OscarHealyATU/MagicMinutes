// Plain-node test for src/lib/noteText.mjs — notes as readable text for email.
// Run with: node tests/noteText.test.mjs

import assert from 'node:assert/strict';
import {
  MAILTO_MAX,
  cleanNote,
  NOTE_FORMAT_EXAMPLE,
  mailtoFor,
  markDuplicates,
  notesToText,
  parseNotesText
} from '../src/lib/noteText.mjs';

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

const bell = {
  _id: 'n1',
  title: 'The sunken bell tower',
  category: 'Location',
  place: 'Sunken Bell Tower',
  tags: ['mystery', 'marsh'],
  content: 'Half-sunk in Greywater Marsh.\n\nIt rings before a storm.',
  pinned: true
};
const plain = { _id: 'n2', title: 'Shopping', category: 'Misc', place: '', tags: [], content: 'Rope\nTorches', pinned: false };
const fields = ({ title, category, place, tags, content, pinned }) => ({ title, category, place, tags, content, pinned });

await test('round trip: notes written out read back exactly', () => {
  const text = notesToText([bell, plain]);
  const { notes, warnings } = parseNotesText(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(notes, [fields(bell), fields(plain)]);
});

await test('the written text is readable: no ids, no JSON', () => {
  const text = notesToText([bell]);
  assert.ok(!text.includes('n1') && !text.includes('{'));
  assert.ok(text.includes('Title: The sunken bell tower'));
  assert.ok(text.includes('It rings before a storm.'));
});

await test('hand-written notes: any capitals and spacing, only a title needed, no end line', () => {
  const text = `Hi! Here are my notes from Tuesday.

==== NOTE ====
title:   Met the duke
CATEGORY: roleplay
tags: politics ,  duke,
He wants the bridge fixed.

===note===
Title: Loose ends
`;
  const { notes, warnings } = parseNotesText(text);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes[0], {
    title: 'Met the duke', category: 'Roleplay', place: '', tags: ['politics', 'duke'],
    content: 'He wants the bridge fixed.', pinned: false
  });
  assert.equal(notes[1].title, 'Loose ends');
  assert.equal(notes[1].content, '');
  assert.deepEqual(warnings, []);
});

await test('the bundled example parses cleanly', () => {
  const { notes, warnings } = parseNotesText(NOTE_FORMAT_EXAMPLE);
  assert.equal(notes.length, 2);
  assert.deepEqual(warnings, []);
  assert.equal(notes[0].pinned, true);
  assert.equal(notes[0].content.split('\n').length, 2);
});

await test('an email reply with "> " quote marks and Windows line endings still imports', () => {
  const quoted = notesToText([bell])
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\r\n');
  const text = `Thanks, adding these!\r\n\r\nOn Tue someone wrote:\r\n${quoted}`;
  const { notes } = parseNotesText(text);
  assert.deepEqual(notes, [fields(bell)]);
});

await test('text lines that look like markers survive the trip', () => {
  const tricky = { ...plain, title: 'Tricky', content: '=== Note ===\n=== End note ===\n\\=== already slashed' };
  const { notes } = parseNotesText(notesToText([tricky]));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, tricky.content);
});

await test('an unknown category or missing title is fixed up with a warning', () => {
  const { notes, warnings } = parseNotesText('=== Note ===\nCategory: Gossip\n\nText\n=== End note ===');
  assert.equal(notes[0].category, 'Misc');
  assert.equal(notes[0].title, 'Untitled note');
  assert.equal(warnings.length, 2);
});

await test('a lone cut-off "=== Note ===" is left out with a warning', () => {
  const { notes, warnings } = parseNotesText(notesToText([plain]) + '\n=== Note ===\n');
  assert.equal(notes.length, 1);
  assert.equal(warnings.length, 1);
});

await test('text with no note blocks finds nothing', () => {
  assert.deepEqual(parseNotesText('Just an ordinary email.').notes, []);
  assert.deepEqual(parseNotesText('').notes, []);
});

await test('multi-line titles are flattened so they stay one field', () => {
  const { notes } = parseNotesText(notesToText([{ ...plain, title: 'Two\nlines' }]));
  assert.equal(notes[0].title, 'Two lines');
});

await test('markDuplicates: same title and text are skipped, ignoring spacing and capitals', () => {
  const parsed = parseNotesText(notesToText([bell, plain, plain])).notes;
  const existing = [{ ...bell, title: 'THE  sunken bell tower', content: bell.content.replace(/\n\n/, '\n') }];
  const marked = markDuplicates(parsed, existing);
  assert.deepEqual(marked.map((n) => n.duplicate), [true, false, true]);
});

await test('mailtoFor: short notes go in the body; long ones get a paste prompt', () => {
  const short = mailtoFor([bell], notesToText([bell]));
  assert.equal(short.fits, true);
  assert.ok(short.url.startsWith('mailto:?subject=MagicMinutes%20note%3A%20The%20sunken%20bell%20tower&body='));
  assert.ok(decodeURIComponent(short.url.split('&body=')[1]).includes('It rings before a storm.'));

  const many = Array.from({ length: 30 }, (_, k) => ({ ...bell, title: `Note ${k}` }));
  const long = mailtoFor(many, notesToText(many));
  assert.equal(long.fits, false);
  assert.ok(long.url.length <= MAILTO_MAX);
  assert.ok(long.subject.includes('30'));
});

await test('text pasted from a web page or word processor (Unicode line separators) parses, and never throws', () => {
  const text = `Intro line with a separator \n=== Note === Title: Web  Body === End note ===`;
  const { notes } = parseNotesText(text);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Web');
  assert.equal(notes[0].content, 'Body');
});

await test('indented or backslashed marker-looking lines in a note survive the trip', () => {
  const content = 'a\n  === End note ===\nb\n\\ === Note ===\n\\\\===\nc';
  const { notes } = parseNotesText(notesToText([{ ...plain, content }]));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, content);
});

await test('mixed reply marks: "> ", ">", "> > " and ">>" are all taken off', () => {
  const block = notesToText([bell], { intro: '' }).trimEnd().split('\n');
  const single = block.map((l, k) => (k % 2 ? `>${l}` : `> ${l}`)).join('\n');
  assert.deepEqual(parseNotesText(single).notes, [fields(bell)]);
  const double = block.map((l, k) => (k % 2 ? `>>${l}` : `> > ${l}`)).join('\n');
  assert.deepEqual(parseNotesText(double).notes, [fields(bell)]);
});

await test('warnings count notes by where they are in the text, even after a skipped one', () => {
  const { warnings } = parseNotesText('=== Note ===\n=== Note ===\nCategory: Gossip\nTitle: X\n');
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].startsWith('Note 2'));
});

await test('an untitled note matches its own "Untitled note" copy as a duplicate', () => {
  const untitled = { ...plain, title: '' };
  const parsed = parseNotesText(notesToText([untitled])).notes;
  assert.equal(markDuplicates(parsed, [untitled])[0].duplicate, true);
});

await test('cleanNote: keeps only note fields with the right types', () => {
  assert.deepEqual(cleanNote({ title: '  T ', tags: 'a,b', pinned: 1, category: 'QUEST', _id: 5, junk: true }), {
    title: 'T', category: 'Quest', place: '', tags: ['a', 'b'], content: '', pinned: false
  });
});

await test('mailtoFor: line breaks in the body are CRLF', () => {
  const { url } = mailtoFor([plain], 'one\ntwo');
  assert.ok(url.endsWith('&body=one%0D%0Atwo'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
