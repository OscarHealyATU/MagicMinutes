import React, { useEffect, useMemo, useState } from 'react';
import { copyText, openExternal, saveTextFile } from '../fileio.js';
import { mailtoFor, notesToText } from '../lib/noteText.mjs';
import { buildNotesExport, notesExportFilename } from '../lib/transfer.mjs';

// Pick some notes and send them: in an email, as copied text, or as a file.
// The email/text version is plain readable text (see src/lib/noteText.mjs), so
// it reads fine without the app and nothing gets flagged as an attachment.
export default function NoteShare({ notes, startWith, onClose }) {
  const [picked, setPicked] = useState(() => new Set(startWith ? [startWith] : []));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const chosen = useMemo(() => notes.filter((n) => picked.has(n._id)), [notes, picked]);
  const text = useMemo(() => (chosen.length ? notesToText(chosen) : ''), [chosen]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const q = search.trim().toLowerCase();
  const listed = q
    ? notes.filter((n) => (n.title || '').toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q)))
    : notes;

  function toggle(id) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function pickAll(on) {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const n of listed) {
        if (on) next.add(n._id);
        else next.delete(n._id);
      }
      return next;
    });
  }

  async function email() {
    try {
      const { url, fits } = mailtoFor(chosen, text);
      // Always copied too: if the email app trims the message, the full text
      // is still one paste away.
      const copied = await copyText(text);
      await openExternal(url);
      setStatus(
        fits
          ? 'Opening your email app with the notes in it (also copied). If nothing opens, paste them into an email.'
          : copied
            ? 'Too long to fit in an email link, so it\'s copied instead: paste it into the email (Ctrl+V).'
            : 'Too long to fit in an email link, and copying failed. Use Copy text instead.'
      );
    } catch (e) {
      setStatus(`Couldn't open your email app: ${e.message || e}. Use Copy text and paste it into an email.`);
    }
  }

  async function copy() {
    setStatus((await copyText(text)) ? 'Copied. Paste it into an email or message.' : 'Copying failed.');
  }

  async function saveFile() {
    try {
      const written = await saveTextFile(notesExportFilename(), JSON.stringify(buildNotesExport(chosen), null, 2));
      setStatus(written ? `Saved ${written}. Attach it to an email; it imports on the Notes page.` : 'Save cancelled.');
    } catch (e) {
      setStatus(e.message || String(e));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-notes-title">
        <div className="modal-head">
          <h3 id="share-notes-title">Share notes</h3>
          <button className="block-btn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body share-body">
          <div className="share-pick">
            <input
              className="search-input"
              placeholder="Find notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="share-pick-actions">
              <button className="text-btn" onClick={() => pickAll(true)}>Tick all</button>
              <button className="text-btn" onClick={() => pickAll(false)}>Untick all</button>
              <span className="share-count">{chosen.length} chosen</span>
            </div>
            <div className="share-list">
              {listed.length === 0 && <div className="empty-hint">No notes match.</div>}
              {listed.map((n) => (
                <label key={n._id} className={`share-row ${picked.has(n._id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={picked.has(n._id)} onChange={() => toggle(n._id)} />
                  <span className="share-row-title">{n.title || 'Untitled'}</span>
                  <span className="badge">{n.category}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="stack-label share-preview">
            What gets sent
            <textarea readOnly value={text || 'Tick the notes you want to send.'} />
          </label>
        </div>
        <div className="modal-foot">
          <span className="status-text">{status}</span>
          <button className="btn" disabled={!chosen.length} onClick={saveFile} title="A file to attach to an email">
            Save as file…
          </button>
          <button className="btn" disabled={!chosen.length} onClick={copy}>
            Copy text
          </button>
          <button className="btn primary" disabled={!chosen.length} onClick={email}>
            ✉ Email
          </button>
        </div>
      </div>
    </div>
  );
}
