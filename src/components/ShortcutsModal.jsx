import React, { useEffect, useMemo, useRef } from 'react';
import { SHORTCUTS } from '../lib/shortcuts.mjs';

// Groups SHORTCUTS by `where` in the order each group first appears, so
// related entries (every Map/Characters zoom key, every find-box key…) stay
// together without a second, hand-maintained grouping list that could drift
// from the real one.
function groupShortcuts(list) {
  const order = [];
  const byWhere = new Map();
  for (const s of list) {
    if (!byWhere.has(s.where)) {
      byWhere.set(s.where, []);
      order.push(s.where);
    }
    byWhere.get(s.where).push(s);
  }
  return order.map((where) => ({ where, items: byWhere.get(where) }));
}

// A shortcut's `keys` means two different things depending on whether Ctrl
// is one of them: with Ctrl, it's a combo pressed together (render "+"
// between keycaps); without, it's a list of alternatives for the same
// action (e.g. ↑/↓ move the highlighted suggestion in either direction —
// render "/" instead, so this doesn't read as "press both at once").
function KeyCombo({ keys }) {
  const sep = keys.includes('Ctrl') ? '+' : '/';
  return (
    <span className="shortcuts-keys">
      {keys.map((k, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="shortcuts-sep">{sep}</span>}
          <kbd>{k}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

// Settings → Appearance → "⌨ Keyboard shortcuts" opens this. Reads straight
// from shortcuts.mjs's SHORTCUTS — the single list every handler in the app
// is meant to agree with — so this can't drift into a second copy of it.
export default function ShortcutsModal({ onClose, returnFocusRef }) {
  const dialogRef = useRef(null);
  const groups = useMemo(() => groupShortcuts(SHORTCUTS), []);

  // Focus the dialog on open, and hand focus back to whatever opened it
  // (the Settings button) once it's gone — on unmount only, so a re-render
  // that hands this a new `onClose` closure (below) can't refocus the
  // button while the modal is still open.
  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      returnFocusRef?.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 id="shortcuts-title">⌨ Keyboard shortcuts</h3>
          <button className="block-btn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {groups.map((g) => (
            <div key={g.where} className="shortcuts-group">
              <div className="section-label">{g.where}</div>
              {g.items.map((s, i) => (
                <div key={i} className="shortcuts-row">
                  <KeyCombo keys={s.keys} />
                  <span className="shortcuts-action">{s.action}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
