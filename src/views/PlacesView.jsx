import React, { useEffect, useState } from 'react';
import { confirmDialog } from '../fileio.js';
import { api } from '../api.js';
import BlockStack from '../components/BlockStack.jsx';
import { useAutosave } from '../lib/useAutosave.js';

export const PLACE_TYPES = [
  'City', 'Town', 'Village', 'Region', 'Wilderness', 'Dungeon',
  'Landmark', 'Shop / Inn', 'Other'
];

const PLACE_TYPE_COLORS = {
  City: '#70250a',
  Town: '#6d411c',
  Village: '#96602e',
  Region: '#485354',
  Wilderness: '#3f5e3a',
  Dungeon: '#2a3439',
  Landmark: '#1d4a52',
  'Shop / Inn': '#0f3a5c',
  Other: '#485354'
};

// `between`/`near`/`route`/`direction`/`note` are the ones drawn as map
// lines (see MapView) — the CVD review found between vs near hard to tell
// apart, so those five carry a CSS custom property (retuned under
// data-cvd="on") and a dash pattern applied only in that mode, mirrored in
// the map's legend. `inside`/`contains` become zones, not lines, and keep
// plain colours.
export const CONNECTION_TYPES = [
  {
    id: 'between',
    label: 'Between',
    color: 'var(--line-between, #0f3a5c)',
    dash: '9 4 2 4',
    hint: 'e.g. the city of Cairne and the town of Eberald'
  },
  {
    id: 'near',
    label: 'Near',
    color: 'var(--line-near, #1d4a52)',
    dash: '14 6',
    hint: 'e.g. the Whispering Falls'
  },
  { id: 'inside', label: 'Inside', color: '#485354', hint: 'e.g. the kingdom of Vall' },
  { id: 'contains', label: 'Contains', color: '#3f5e3a', hint: 'e.g. the Gilded Goose inn, the docks' },
  {
    id: 'route',
    label: 'On the route',
    color: 'var(--line-route, #6d411c)',
    dash: null,
    hint: 'e.g. the King’s Road, two days from Cairne'
  },
  {
    id: 'direction',
    label: 'Direction',
    color: 'var(--line-direction, #96602e)',
    dash: '5 5',
    hint: 'e.g. north of Eberald, across the ridge'
  },
  {
    id: 'note',
    label: 'Note',
    color: 'var(--line-note, #2a3439)',
    dash: '1.5 4',
    hint: 'anything else about getting there'
  }
];

export default function PlacesView({ focusId, onFocusUsed }) {
  const [places, setPlaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const selected = places.find((p) => p._id === selectedId) || null;

  useEffect(() => {
    api.list('places').then((docs) => {
      setPlaces(docs);
      if (focusId) {
        setSelectedId(focusId);
        onFocusUsed?.();
      }
    }).catch((e) => setStatus(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const autosave = useAutosave({
    id: selected?._id ?? null,
    snapshot: selected && {
      name: selected.name,
      type: selected.type,
      description: selected.description,
      notes: selected.notes,
      connections: (selected.connections || []).map(({ type, text }) => ({ type, text }))
    },
    onSave: (id, snap) => api.update('places', id, snap),
    onSaved: (id, updated) => patchLocal(id, { updatedAt: updated.updatedAt })
  });

  // A create/delete error auto-clears after a few seconds — otherwise it
  // permanently shadows the autosave status line below it (Saving…/Saved ✓),
  // which keeps working fine underneath even after an unrelated error here.
  function showError(message) {
    setStatus(message);
    setTimeout(() => setStatus((s) => (s === message ? '' : s)), 4000);
  }

  async function createPlace() {
    try {
      const place = await api.create('places', { name: 'Unnamed place' });
      setPlaces([place, ...places]);
      setSelectedId(place._id);
    } catch (e) {
      showError(e.message);
    }
  }

  function patchLocal(id, patch) {
    setPlaces((prev) => prev.map((p) => (p._id === id ? { ...p, ...patch } : p)));
  }

  // "Save" is now "save now" — autosave already keeps this persisted.
  async function savePlace() {
    if (!selected) return;
    await autosave.flush();
  }

  async function deletePlace() {
    if (!selected) return;
    if (!(await confirmDialog(`Delete "${selected.name}"?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    autosave.markDeleted(selected._id);
    try {
      await api.remove('places', selected._id);
      setPlaces((prev) => prev.filter((p) => p._id !== selected._id));
      setSelectedId(null);
    } catch (e) {
      // Delete didn't actually go through — restore autosave for this place.
      autosave.unmarkDeleted(selected._id);
      showError(e.message);
    }
  }

  const visible = places.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      ['name', 'type', 'description', 'notes'].some((f) => (p[f] || '').toLowerCase().includes(q)) ||
      (p.connections || []).some((c) => (c.text || '').toLowerCase().includes(q))
    );
  });

  return (
    <div className={`split-view ${selected ? 'detail-open' : ''}`}>
      <aside className="list-pane">
        <div className="list-header">
          <h2>Places</h2>
          <button className="btn primary" onClick={createPlace}>+ New</button>
        </div>
        <input
          className="search-input"
          placeholder="Search places…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="item-list">
          {visible.length === 0 && (
            <div className="empty-hint">
              No places yet. Add the cities, roads, and riverbanks of your campaign.
            </div>
          )}
          {visible.map((p) => (
            <button
              key={p._id}
              className={`item-card ${selectedId === p._id ? 'selected' : ''}`}
              onClick={() => setSelectedId(p._id)}
            >
              <div className="item-title">{p.name}</div>
              <div className="item-meta">
                <span
                  className="badge"
                  style={{ background: PLACE_TYPE_COLORS[p.type] || '#8a8fa3' }}
                >
                  {p.type}
                </span>
                <span className="item-date">
                  {(p.connections || [])[0]?.text || ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="editor-pane">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-icon">🗺️</div>
            <p>
              Select a place or add one. Describe what it's like, then snap together location
              blocks — e.g. <em>Between: the city of Cairne and the town of Eberald</em>.
            </p>
          </div>
        ) : (
          <>
            <button className="btn mobile-back" onClick={() => setSelectedId(null)}>← Back</button>
            <div className="editor-toolbar">
              <span className="status-text">{status || autosave.status}</span>
              <button className="btn primary" onClick={savePlace}>Save</button>
              <button className="btn danger" onClick={deletePlace}>Delete</button>
            </div>
            <input
              className="title-input"
              value={selected.name}
              placeholder="Place name, e.g. The Riverbank Camp"
              onChange={(e) => patchLocal(selected._id, { name: e.target.value })}
            />
            <div className="field-row">
              <label>
                Type
                <select
                  value={selected.type}
                  onChange={(e) => patchLocal(selected._id, { type: e.target.value })}
                >
                  {PLACE_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="section-label">Where is it?</div>
            <BlockStack
              blockTypes={CONNECTION_TYPES}
              blocks={selected.connections || []}
              onChange={(connections) => patchLocal(selected._id, { connections })}
              paletteLabel="Add location block:"
            />

            <div className="section-label">What is it like?</div>
            <textarea
              className="content-area"
              value={selected.description}
              placeholder="Sights, sounds, smells, mood… what would your character notice here?"
              onChange={(e) => patchLocal(selected._id, { description: e.target.value })}
            />
            <textarea
              className="content-area small"
              value={selected.notes}
              placeholder="Extra notes: who lives here, what happened here, rumors…"
              onChange={(e) => patchLocal(selected._id, { notes: e.target.value })}
            />
          </>
        )}
      </section>
    </div>
  );
}
