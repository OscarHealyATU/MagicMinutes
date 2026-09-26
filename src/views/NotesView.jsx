import React, { useEffect, useRef, useState } from 'react';
import { confirmDialog } from '../fileio.js';
import { api } from '../api.js';
import NoteImport from '../components/NoteImport.jsx';
import NoteShare from '../components/NoteShare.jsx';
import PlaceReconcile from '../components/PlaceReconcile.jsx';
import { NOTE_CATEGORIES } from '../lib/noteText.mjs';
import { isKnown, similarNames } from '../lib/similar.js';
import { useAutosave } from '../lib/useAutosave.js';

function parseTags(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

// Lives with the note text format, which has to agree on the list.
export { NOTE_CATEGORIES };

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

export default function NotesView({ focusId, onFocusUsed }) {
  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [places, setPlaces] = useState([]);
  const [reconcile, setReconcile] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [importing, setImporting] = useState(false);
  // The Tags field's own raw text — kept separate from `selected.tags` so
  // typing a comma doesn't immediately re-split into an empty trailing tag
  // (see parseTags/onBlur below). Reset whenever a different note is opened.
  const [tagsDraft, setTagsDraft] = useState('');
  // Places the user chose to "skip for now" — don't nag again this session
  const dismissed = useRef(new Set());

  const selected = notes.find((n) => n._id === selectedId) || null;

  useEffect(() => {
    setTagsDraft((selected?.tags || []).join(', '));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.list('notes').then((docs) => {
      setNotes(docs);
      if (focusId) {
        setSelectedId(focusId);
        onFocusUsed?.();
      }
    }).catch((e) => setStatus(e.message));
    api.list('places').then(setPlaces).catch(() => {});
    // Selecting another note from the Map reloads this list — refetching
    // here must not blow away whatever's mid-edit in the currently open one;
    // it doesn't, since the autosave hook below flushes off its own refs,
    // not off `notes`/`selected`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const autosave = useAutosave({
    id: selected?._id ?? null,
    snapshot: selected && {
      title: selected.title,
      category: selected.category,
      place: selected.place,
      tags: parseTags(tagsDraft),
      content: selected.content,
      pinned: selected.pinned
    },
    onSave: (id, snap) => api.update('notes', id, snap),
    onSaved: (id, updated) => patchLocal(id, { updatedAt: updated.updatedAt })
  });

  // A create/delete error auto-clears after a few seconds — otherwise it
  // permanently shadows the autosave status line below it (Saving…/Saved ✓),
  // which keeps working fine underneath even after an unrelated error here.
  function showError(message) {
    setStatus(message);
    setTimeout(() => setStatus((s) => (s === message ? '' : s)), 4000);
  }

  async function createNote() {
    try {
      const note = await api.create('notes', {
        title: 'Untitled note',
        category: filter === 'All' ? 'Session Log' : filter
      });
      setNotes([note, ...notes]);
      setSelectedId(note._id);
    } catch (e) {
      showError(e.message);
    }
  }

  function patchLocal(id, patch) {
    setNotes((prev) => prev.map((n) => (n._id === id ? { ...n, ...patch } : n)));
  }

  function checkPlaceReconcile(place) {
    const p = (place || '').trim();
    if (p && !isKnown(places, p) && !dismissed.current.has(p.toLowerCase())) {
      setReconcile({
        noteId: selected._id,
        items: [{ tag: p, similar: similarNames(places, p) }]
      });
    }
  }

  // "Save" is now "save now" — autosave already keeps this persisted, this
  // just flushes immediately and runs the place-reconcile check afterwards.
  async function saveNote() {
    if (!selected) return;
    await autosave.flush();
    checkPlaceReconcile(selected.place);
  }

  async function applyReconcile(resolutions) {
    try {
      for (const r of resolutions) {
        if (r.action === 'new') {
          await api.create('places', { name: r.tag, type: r.type || 'Town' });
        } else if (r.action === 'existing' && r.canonical) {
          // It was a typo — rewrite the note to the canonical place name
          patchLocal(reconcile.noteId, { place: r.canonical });
          await api.update('notes', reconcile.noteId, { place: r.canonical });
        } else {
          dismissed.current.add(r.tag.trim().toLowerCase());
        }
      }
      const fresh = await api.list('places').catch(() => places);
      setPlaces(fresh);
    } catch (e) {
      showError(e.message);
    } finally {
      setReconcile(null);
    }
  }

  async function deleteNote() {
    if (!selected) return;
    if (!(await confirmDialog(`Delete "${selected.title}"? This cannot be undone.`, { title: 'Confirm delete', kind: 'warning' }))) return;
    // Mark deleted before the request lands: a debounced or in-flight
    // autosave for this note must not recreate it via an update afterwards.
    autosave.markDeleted(selected._id);
    try {
      await api.remove('notes', selected._id);
      setNotes((prev) => prev.filter((n) => n._id !== selected._id));
      setSelectedId(null);
    } catch (e) {
      // The delete didn't actually go through (transient SQLite/IPC error,
      // not "already gone") — undo markDeleted, or autosave would stay
      // disabled for this note for the rest of the session even though it's
      // still sitting right here, still selected.
      autosave.unmarkDeleted(selected._id);
      showError(e.message);
    }
  }

  function togglePinned() {
    if (!selected) return;
    patchLocal(selected._id, { pinned: !selected.pinned });
    // A discrete click, not typing — persist right away instead of waiting
    // out the debounce.
    setTimeout(() => autosave.flush(), 0);
  }

  const visible = notes
    .filter((n) => filter === 'All' || n.category === filter)
    .filter((n) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        (n.title || '').toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q) ||
        (n.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => (b.pinned === true) - (a.pinned === true));

  return (
    <div className={`split-view ${selected ? 'detail-open' : ''}`}>
      <aside className="list-pane">
        <div className="list-header">
          <h2>Notes</h2>
          <button className="btn primary" onClick={createNote}>+ New</button>
        </div>
        <div className="list-header-actions">
          <button className="btn" title="Email or copy notes to someone" disabled={!notes.length} onClick={() => setSharing(true)}>
            ✉ Share
          </button>
          <button className="btn" title="Bring in notes from an email or a file" onClick={() => setImporting(true)}>
            ⬇ Import
          </button>
        </div>
        <input
          className="search-input"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="chip-row">
          {['All', ...NOTE_CATEGORIES].map((c) => (
            <button
              key={c}
              className={`chip ${filter === c ? 'chip-active' : ''}`}
              onClick={() => setFilter(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="item-list">
          {visible.length === 0 && (
            <div className="empty-hint">No notes yet. Click “+ New” to write your first one.</div>
          )}
          {visible.map((n) => (
            <button
              key={n._id}
              className={`item-card ${selectedId === n._id ? 'selected' : ''}`}
              onClick={() => setSelectedId(n._id)}
            >
              <div className="item-title">
                {n.pinned && <span title="Pinned">📌 </span>}
                {n.title || 'Untitled'}
              </div>
              <div className="item-meta">
                <span className="badge">{n.category}</span>
                <span className="item-date">{fmtDate(n.updatedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="editor-pane">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-icon">📜</div>
            <p>Select a note, or create a new one to record what happened this session.</p>
          </div>
        ) : (
          <>
            <button className="btn mobile-back" onClick={() => setSelectedId(null)}>← Back</button>
            <div className="editor-toolbar">
              <span className="status-text">{status || autosave.status}</span>
              <button className="btn" onClick={togglePinned}>
                {selected.pinned ? 'Unpin' : 'Pin'} 📌
              </button>
              <button className="btn primary" onClick={saveNote}>Save</button>
              <button className="btn danger" onClick={deleteNote}>Delete</button>
            </div>
            <input
              className="title-input"
              value={selected.title}
              placeholder="Note title"
              onChange={(e) => patchLocal(selected._id, { title: e.target.value })}
            />
            <div className="field-row">
              <label>
                Category
                <select
                  value={selected.category}
                  onChange={(e) => patchLocal(selected._id, { category: e.target.value })}
                >
                  {NOTE_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Place
                <input
                  value={selected.place || ''}
                  placeholder="Where, e.g. Cairne"
                  list="known-places"
                  onChange={(e) => patchLocal(selected._id, { place: e.target.value })}
                />
                <datalist id="known-places">
                  {places.map((p) => (
                    <option key={p._id} value={p.name} />
                  ))}
                </datalist>
              </label>
              <label className="grow">
                Tags (comma separated)
                <input
                  value={tagsDraft}
                  placeholder="e.g. tavern, chapter 3, mystery"
                  onChange={(e) => setTagsDraft(e.target.value)}
                  onBlur={() => patchLocal(selected._id, { tags: parseTags(tagsDraft) })}
                />
              </label>
            </div>
            <textarea
              className="content-area"
              value={selected.content}
              placeholder="What happened? Who said what? What do you want to remember next session?"
              onChange={(e) => patchLocal(selected._id, { content: e.target.value })}
            />
          </>
        )}
      </section>

      {sharing && <NoteShare notes={notes} startWith={selectedId} onClose={() => setSharing(false)} />}
      {importing && (
        <NoteImport
          existing={notes}
          onClose={() => setImporting(false)}
          onImported={(added, message) => {
            setNotes((prev) => [...added, ...prev.filter((n) => !added.some((a) => a._id === n._id))]);
            setImporting(false);
            if (added.length) setSelectedId(added[0]._id);
            setStatus(message);
            setTimeout(() => setStatus(''), 4000);
          }}
        />
      )}
      {reconcile && (
        <PlaceReconcile
          items={reconcile.items}
          onApply={applyReconcile}
          onClose={() => setReconcile(null)}
        />
      )}
    </div>
  );
}
