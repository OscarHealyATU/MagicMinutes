import React, { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { buildJournal } from '../lib/journal.mjs';

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

// The print-only journal itself — a cover page, a contents page, then one
// page per session. Rendered off in a portal (see JournalExport below) so
// the print stylesheet can hide the whole app and show only this.
function PrintJournal({ journal }) {
  return (
    <div className="print-journal">
      <section className="print-cover">
        <h1>{journal.title}</h1>
        <p className="print-cover-range">{journal.rangeLabel}</p>
        <p className="print-cover-date">Generated {fmtDate(journal.generatedAt)}</p>
      </section>
      <section className="print-contents">
        <h2>Contents</h2>
        <ol>
          {journal.sessions.map((s) => (
            <li key={s.number}>
              Session {s.number} — {s.title}
              {s.date ? ` · ${fmtDate(s.date)}` : ''}
            </li>
          ))}
        </ol>
      </section>
      {journal.sessions.map((s) => (
        <section className="print-session" key={s.number}>
          <h2>Session {s.number} — {s.title}</h2>
          {s.date && <p className="print-session-date">{fmtDate(s.date)}</p>}
          {s.paragraphs.length === 0 ? (
            <p className="print-session-empty">No summary was written for this session.</p>
          ) : (
            s.paragraphs.map((lines, pi) => (
              <p key={pi}>
                {lines.map((line, li) => (
                  <React.Fragment key={li}>
                    {line}
                    {li < lines.length - 1 && <br />}
                  </React.Fragment>
                ))}
              </p>
            ))
          )}
          {s.activity.length > 0 && (
            <div className="print-changed">
              <h3>What changed</h3>
              <ul>
                {s.activity.map((a, ai) => (
                  <li key={ai}>{a.action === 'created' ? 'New' : 'Edited'} {a.kind}: {a.name}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// "📖 Export journal" on the Recap page: every session recap as a printable
// keepsake. Builds the journal (src/lib/journal.mjs), renders it into a
// portal attached straight to <body> (so the print stylesheet's "hide
// everything except this" rule doesn't have to fight #root's own layout),
// then hands off to the system print dialog via window.print() — WebView2
// is Chromium-based and supports script-triggered printing (including
// "Microsoft Print to PDF") the same as desktop Chrome/Edge, so no plugin
// or fallback is needed here (see the task report for the docs checked).
export default function JournalExport({ sessions, defaultTitle = 'Campaign journal', onClose }) {
  const [title, setTitle] = useState(defaultTitle);
  const [rangeMode, setRangeMode] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeDates, setIncludeDates] = useState(true);
  const [includeActivity, setIncludeActivity] = useState(false);
  const [includeEmptySummary, setIncludeEmptySummary] = useState(false);
  const [journal, setJournal] = useState(null);
  const [portalEl, setPortalEl] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keyboard users land in the dialog when it opens and back on the button
  // that opened it when it closes, like the Shortcuts window.
  const titleRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    titleRef.current?.focus();
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  // A dedicated node straight under <body>, outside #root, so the print
  // stylesheet can hide .app and show just this without fighting z-index or
  // overflow rules meant for the normal UI. Removed again when the dialog
  // closes — nothing about this needs to survive that.
  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'print-journal-portal';
    document.body.appendChild(el);
    setPortalEl(el);
    return () => {
      document.body.removeChild(el);
    };
  }, []);

  function currentOptions() {
    return {
      title,
      range:
        rangeMode === 'range'
          ? { mode: 'range', from: from === '' ? null : Number(from), to: to === '' ? null : Number(to) }
          : { mode: 'all' },
      includeDates,
      includeActivity,
      includeEmptySummary
    };
  }

  const preview = buildJournal(sessions, currentOptions());

  function printJournal() {
    const built = buildJournal(sessions, currentOptions());
    // window.print() is synchronous from the page's point of view, so the
    // portal's content has to already be in the DOM before it's called —
    // flushSync forces that commit instead of waiting for React's normal
    // (async) batching, which would otherwise print last render's (empty)
    // portal.
    flushSync(() => setJournal(built));
    window.print();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal journal-modal" role="dialog" aria-modal="true" aria-labelledby="journal-export-title">
        <div className="modal-head">
          <h3 id="journal-export-title">📖 Export journal</h3>
          <button className="block-btn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="stack-label">
            Title
            <input
              ref={titleRef}
              className="block-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Campaign journal"
            />
          </label>

          <div className="stack-label">
            Sessions
            <div className="journal-range">
              <label className="journal-radio">
                <input
                  type="radio"
                  name="journal-range"
                  checked={rangeMode === 'all'}
                  onChange={() => setRangeMode('all')}
                />
                All sessions
              </label>
              <div className="journal-range-row">
                <label className="journal-radio">
                  <input
                    type="radio"
                    name="journal-range"
                    checked={rangeMode === 'range'}
                    onChange={() => setRangeMode('range')}
                  />
                  Range
                </label>
                <label className="journal-range-field">
                  From
                  <input
                    className="block-input journal-range-num"
                    type="number"
                    min="1"
                    value={from}
                    disabled={rangeMode !== 'range'}
                    onChange={(e) => { setRangeMode('range'); setFrom(e.target.value); }}
                  />
                </label>
                <label className="journal-range-field">
                  to
                  <input
                    className="block-input journal-range-num"
                    type="number"
                    min="1"
                    value={to}
                    disabled={rangeMode !== 'range'}
                    onChange={(e) => { setRangeMode('range'); setTo(e.target.value); }}
                  />
                </label>
              </div>
            </div>
          </div>

          <label className="settings-toggle">
            <input type="checkbox" checked={includeDates} onChange={(e) => setIncludeDates(e.target.checked)} />
            Include session dates
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={includeActivity}
              onChange={(e) => setIncludeActivity(e.target.checked)}
            />
            Include what changed each session
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={includeEmptySummary}
              onChange={(e) => setIncludeEmptySummary(e.target.checked)}
            />
            Include sessions with no summary
          </label>
        </div>
        <div className="modal-foot">
          <span className="status-text">
            {preview.sessions.length === 0
              ? 'No sessions match — nothing to export yet.'
              : `${preview.sessions.length} session${preview.sessions.length === 1 ? '' : 's'} · ${preview.rangeLabel}`}
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={preview.sessions.length === 0} onClick={printJournal}>
            🖨 Print / Save as PDF
          </button>
        </div>
      </div>
      {portalEl && createPortal(journal ? <PrintJournal journal={journal} /> : null, portalEl)}
    </div>
  );
}
