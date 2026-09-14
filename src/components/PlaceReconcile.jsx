import React, { useState } from 'react';
import { PLACE_TYPES } from '../views/PlacesView.jsx';

// Resolve an unknown place on a note: add it as a new place, merge it into a
// similar existing one (typo catch), or skip it for now. Ported from notemap.
export default function PlaceReconcile({ items, onApply, onClose }) {
  const [res, setRes] = useState(() => {
    const init = {};
    for (const it of items) {
      init[it.tag] = { action: 'new', type: 'Town', canonical: it.similar[0] || null };
    }
    return init;
  });

  function setItem(tag, patch) {
    setRes((prev) => ({ ...prev, [tag]: { ...prev[tag], ...patch } }));
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="reconcile-modal">
        <div className="reconcile-head">
          <span className="reconcile-title">New place found</span>
          <span className="reconcile-sub">
            This place isn’t documented yet. Add it to your Places (and the map), or merge a
            likely typo into an existing place.
          </span>
        </div>

        <div className="reconcile-list">
          {items.map((it) => {
            const r = res[it.tag];
            return (
              <div key={it.tag} className="reconcile-row">
                <div className="reconcile-tag">📍 {it.tag}</div>

                {it.similar.length > 0 && (
                  <div className="reconcile-hint">
                    Looks similar to an existing place — same spot, or genuinely different?
                  </div>
                )}

                <div className="reconcile-opts">
                  {it.similar.map((name) => (
                    <button
                      key={name}
                      className={`reconcile-opt ${r.action === 'existing' && r.canonical === name ? 'on' : ''}`}
                      onClick={() => setItem(it.tag, { action: 'existing', canonical: name })}
                    >
                      Same as “{name}”
                    </button>
                  ))}
                  <button
                    className={`reconcile-opt ${r.action === 'new' ? 'on' : ''}`}
                    onClick={() => setItem(it.tag, { action: 'new' })}
                  >
                    Add as new place
                  </button>
                  {r.action === 'new' && (
                    <select value={r.type} onChange={(e) => setItem(it.tag, { type: e.target.value })}>
                      {PLACE_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className={`reconcile-opt ${r.action === 'skip' ? 'on' : ''}`}
                    onClick={() => setItem(it.tag, { action: 'skip' })}
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="reconcile-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => onApply(items.map((it) => ({ tag: it.tag, ...res[it.tag] })))}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
