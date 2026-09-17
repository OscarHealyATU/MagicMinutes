import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { NOTES_FILTER, copyText, openTextFile } from '../fileio.js';
import { NOTE_FORMAT_EXAMPLE, markDuplicates, parseNotesText } from '../lib/noteText.mjs';
import { parseNotesFile } from '../lib/transfer.mjs';

// Bring notes in from a pasted email (or any text written in the note format),
// or from a notes file someone attached. Shows what it found before adding
// anything, and skips notes you already have.
export default function NoteImport({ existing, onImported, onClose }) {
  const [text, setText] = useState('');
  // Notes read from a .json file keep their ids, so re-importing the same
  // file doesn't double up; `fileNotes` replaces the pasted text while set.
  const [fileNotes, setFileNotes] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const found = useMemo(() => {
    if (fileNotes) {
      const haveIds = new Set(existing.map((n) => n._id));
      const byContent = markDuplicates(fileNotes.notes, existing);
      return {
        notes: byContent.map((n) => ({ ...n, duplicate: n.duplicate || haveIds.has(n._id) })),
        warnings: fileNotes.warnings
      };
    }
    const { notes, warnings } = parseNotesText(text);
    return { notes: markDuplicates(notes, existing), warnings };
  }, [text, fileNotes, existing]);

  const fresh = found.notes.filter((n) => !n.duplicate);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function openFile() {
    setStatus('');
    try {
      const file = await openTextFile(NOTES_FILTER);
      if (!file) return;
      const trimmed = file.text.trim();
      if (trimmed.startsWith('{')) {
        const { notes, warnings } = parseNotesFile(trimmed);
        setFileNotes({ name: file.name, notes, warnings });
      } else {
        setFileNotes(null);
        setText(file.text);
      }
    } catch (e) {
      setStatus(e.message || String(e));
    }
  }

  async function importNotes() {
    setBusy(true);
    setStatus('Importing…');
    try {
      const added = [];
      for (const n of fresh) {
        const { duplicate, ...doc } = n;
        added.push(doc._id ? await api.upsert('notes', doc) : await api.create('notes', doc));
      }
      const skipped = found.notes.length - fresh.length;
      onImported(added, `Imported ${added.length} note${added.length === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} you already had` : ''}.`);
    } catch (e) {
      setStatus(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-notes-title">
        <div className="modal-head">
          <h3 id="import-notes-title">Import notes</h3>
          <button className="block-btn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {fileNotes ? (
            <div className="import-file">
              From file <strong>{fileNotes.name}</strong>
              <button className="text-btn" onClick={() => setFileNotes(null)}>Paste text instead</button>
            </div>
          ) : (
            <label className="stack-label">
              Paste an email with notes in it, or notes you've written in the format below
              <textarea
                className="import-paste"
                value={text}
                placeholder={'=== Note ===\nTitle: …\n\nWhat happened…\n=== End note ==='}
                onChange={(e) => setText(e.target.value)}
                autoFocus
              />
            </label>
          )}

          <button className="text-btn import-help-toggle" onClick={() => setShowHelp((s) => !s)}>
            {showHelp ? '▾' : '▸'} How to write notes so they import
          </button>
          {showHelp && (
            <div className="import-help">
              <p>
                Start each note with a line saying <code>=== Note ===</code>. Then add a{' '}
                <code>Title:</code> line, and optionally <code>Category:</code>, <code>Place:</code>,{' '}
                <code>Tags:</code> (separated by commas) and <code>Pinned: yes</code>. Leave a blank
                line, write the note, and finish with <code>=== End note ===</code>. Capitals and
                spacing don't matter, and anything outside those lines, like the rest of an email, is
                ignored.
              </p>
              <p>
                Categories: Session Log, Roleplay, Character, Quest, Location, Item, Lore, Misc.
              </p>
              <pre className="import-example">{NOTE_FORMAT_EXAMPLE}</pre>
              <button
                className="text-btn"
                onClick={async () => setStatus((await copyText(NOTE_FORMAT_EXAMPLE)) ? 'Example copied.' : 'Copying failed.')}
              >
                Copy example
              </button>
            </div>
          )}

          {(text.trim() || fileNotes) && (
            <div className="import-found">
              <div className="section-label">
                Found {found.notes.length} note{found.notes.length === 1 ? '' : 's'}
              </div>
              {found.notes.length === 0 && !fileNotes && (
                <div className="empty-hint">
                  No notes found. Each one needs to start with a line saying <code>=== Note ===</code>.
                </div>
              )}
              {found.notes.map((n, i) => (
                <div key={i} className={`import-row ${n.duplicate ? 'dup' : ''}`}>
                  <span className="import-row-title">{n.title}</span>
                  <span className="badge">{n.category}</span>
                  {n.place && <span className="import-row-meta">📍 {n.place}</span>}
                  {n.duplicate && <span className="import-row-meta">already have it, skipped</span>}
                </div>
              ))}
              {found.warnings.map((w, i) => (
                <div key={i} className="settings-error">⚠ {w}</div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="status-text">{status}</span>
          <button className="btn" onClick={openFile}>Open a file…</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!fresh.length || busy} onClick={importNotes}>
            {fresh.length ? `Import ${fresh.length} note${fresh.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
