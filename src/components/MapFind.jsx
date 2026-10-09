import React, { useEffect, useMemo, useRef, useState } from 'react';
import { findPlaces } from '../lib/mapFind.mjs';

// The Ctrl+F "find a place" box (opened from MapView's window keydown
// handler, or its 🔍 toolbar button) — suggests places and zones by
// name/type as the player types. This component only searches and reads
// back a pick; MapView owns panning/zooming/pulsing/selecting, since it's
// the one that already knows the map's view state and layout positions.
export default function MapFind({ places, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const results = useMemo(() => findPlaces(places, query), [places, query]);

  // Grabs focus the moment it opens, so Ctrl+F (or the button) can be typed
  // into right away without an extra click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A fresh query always starts from the top suggestion.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function pick(place) {
    if (!place) return;
    onPick(place._id);
  }

  function onInputKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[active]);
    }
    // Escape is handled by the window listener above (it also has to close
    // the box when a suggestion, not the input, has focus).
  }

  return (
    <div className="map-find">
      <input
        ref={inputRef}
        className="map-find-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder="Find a place or zone…"
        aria-label="Find a place or zone on the map"
      />
      {query.trim() && (
        <div className="map-find-list" role="listbox">
          {results.length === 0 ? (
            <div className="map-find-empty">No places match</div>
          ) : (
            results.map((p, i) => (
              <button
                key={p._id}
                type="button"
                role="option"
                aria-selected={i === active}
                className={`map-find-item ${i === active ? 'active' : ''}`}
                // Keeps focus (and so the arrow keys) in the input even when
                // the mouse is used to hover/click a suggestion.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
              >
                <span className="map-find-item-name">{p.name}</span>
                {p.type && <span className="map-find-item-type">{p.type}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
