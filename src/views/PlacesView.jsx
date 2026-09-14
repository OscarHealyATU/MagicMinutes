import React, { useEffect, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { api } from '../api.js';
import BlockStack from '../components/BlockStack.jsx';

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

export const CONNECTION_TYPES = [
  { id: 'between', label: 'Between', color: '#0f3a5c', hint: 'e.g. the city of Cairne and the town of Eberald' },
  { id: 'near', label: 'Near', color: '#1d4a52', hint: 'e.g. the Whispering Falls' },
  { id: 'inside', label: 'Inside', color: '#485354', hint: 'e.g. the kingdom of Vall' },
  { id: 'contains', label: 'Contains', color: '#3f5e3a', hint: 'e.g. the Gilded Goose inn, the docks' },
  { id: 'route', label: 'On the route', color: '#6d411c', hint: 'e.g. the King’s Road, two days from Cairne' },
  { id: 'direction', label: 'Direction', color: '#96602e', hint: 'e.g. north of Eberald, across the ridge' },
  { id: 'note', label: 'Note', color: '#2a3439', hint: 'anything else about getting there' }
];

export default function PlacesView({ focusId }) {
  const [places, setPlaces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const selected = places.find((p) => p._id === selectedId) || null;

  useEffect(() => {
    api.list('places').then((docs) => {
      setPlaces(docs);
      if (focusId) setSelectedId(focusId);
    }).catch((e) => setStatus(e.message));
  }, [focusId]);

  async function createPlace() {
    const place = await api.create('places', { name: 'Unnamed place' });
    setPlaces([place, ...places]);
    setSelectedId(place._id);
  }

  function patchLocal(id, patch) {
    setPlaces((prev) => prev.map((p) => (p._id === id ? { ...p, ...patch } : p)));
  }

  async function savePlace() {
    if (!selected) return;
    setStatus('Saving…');
    const { _id, name, type, description, notes } = selected;
    const connections = selected.connections.map(({ type, text }) => ({ type, text }));
    const updated = await api.update('places', _id, { name, type, description, notes, connections });
    patchLocal(_id, updated);
    setStatus('Saved ✓');
    setTimeout(() => setStatus(''), 1500);
  }

  async function deletePlace() {
    if (!selected) return;
    if (!(await confirm(`Delete "${selected.name}"?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    await api.remove('places', selected._id);
    setPlaces((prev) => prev.filter((p) => p._id !== selected._id));
    setSelectedId(null);
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
              <span className="status-text">{status}</span>
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
