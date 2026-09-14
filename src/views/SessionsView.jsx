import React, { useEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { api } from '../api.js';
import { buildPrompt, collectSessionMaterial, draftSummary } from '../lib/recap.mjs';
import { RECOMMENDED_MODEL, detectOllama, generate, pickModel } from '../lib/ollama.mjs';

const KIND_LABELS = {
  note: '📜 Notes',
  npc: '🧙 NPCs',
  combo: '⚔️ Combos',
  place: '🗺️ Places',
  player: '🎭 Players'
};

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

function fmtDuration(start, end) {
  if (!start) return '';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function SessionsView({ reloadToken, focusId, activeSession, onEnd }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState('');
  // Keyed by session id (not just a flag) so switching sessions mid-generate
  // doesn't show session B the "Working…"/result feedback meant for session A.
  const [aiBusyId, setAiBusyId] = useState(null);
  const [aiStatusById, setAiStatusById] = useState({});
  // Latest sessions, readable from inside the long-running summarize() so it
  // can tell whether the player edited the summary while it was working.
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const selected = sessions.find((s) => s._id === selectedId) || null;

  useEffect(() => {
    api.list('sessions').then((docs) => {
      setSessions(docs);
      if (focusId) setSelectedId(focusId);
    }).catch((e) => setStatus(e.message));
  }, [reloadToken, focusId]);

  function patchLocal(id, patch) {
    setSessions((prev) => prev.map((s) => (s._id === id ? { ...s, ...patch } : s)));
  }

  // Builds a summary from the session's recap material and saves it into the
  // same "Your summary" field the player edits by hand. Prefers a local
  // Ollama model when one is running; otherwise falls back to a deterministic,
  // no-AI draft so this always works (including on Android, which has no LLM).
  async function summarize() {
    if (!selected || aiBusyId === selected._id) return;
    const sessionId = selected._id;
    const summaryAtStart = selected.summary || '';
    if (summaryAtStart.trim()) {
      const ok = await confirm('Replace your existing summary with a generated one?', {
        title: 'Overwrite summary',
        kind: 'warning'
      });
      if (!ok) return;
    }

    const setStatusFor = (msg) => setAiStatusById((prev) => ({ ...prev, [sessionId]: msg }));

    setAiBusyId(sessionId);
    setStatusFor('Gathering session notes…');
    try {
      const [notes, places, npcs] = await Promise.all([
        api.list('notes'),
        api.list('places'),
        api.list('npcs')
      ]);
      const material = collectSessionMaterial(selected, { notes, places, npcs });
      const { available, models } = await detectOllama({ timeoutMs: 1500 });
      const model = available ? pickModel(models) : null;

      let summary = '';
      let resultStatus;
      if (model) {
        setStatusFor(`Asking ${model}…`);
        try {
          summary = await generate({ model, prompt: buildPrompt(material), timeoutMs: 60000 });
        } catch (genErr) {
          summary = '';
          resultStatus = `Ollama failed (${genErr.message}) — wrote a plain summary instead.`;
        }
      }
      if (summary) {
        resultStatus = 'Written by AI ✓';
      } else {
        summary = draftSummary(material);
        if (!resultStatus) {
          resultStatus = available
            ? `Written without AI (no small model installed — run \`ollama pull ${RECOMMENDED_MODEL}\`).`
            : 'Written without AI. For a better summary install Ollama and run `ollama pull gemma3:1b`, then start Ollama and try again.';
        }
      }

      if (!mountedRef.current) return;
      // If the player typed into the summary box while this (up to a
      // minute-long) request was in flight, their words win — don't save over
      // them. Compare against what the box held when the button was clicked.
      const current = sessionsRef.current.find((s) => s._id === sessionId);
      if ((current ? current.summary || '' : '') !== summaryAtStart) {
        setStatusFor('You edited the summary while I was writing, so I kept your version.');
        return;
      }
      // Only the summary field changes here — never send `title`, since the
      // player may have edited it in the meantime and that must not be clobbered.
      const updated = await api.update('sessions', sessionId, { summary });
      if (!mountedRef.current) return;
      patchLocal(sessionId, updated);
      setStatusFor(resultStatus);
      if (resultStatus === 'Written by AI ✓') setTimeout(() => setStatusFor(''), 2500);
    } catch (e) {
      if (mountedRef.current) setStatusFor(`Couldn't write a summary: ${e.message}`);
    } finally {
      if (mountedRef.current) setAiBusyId((cur) => (cur === sessionId ? null : cur));
    }
  }

  async function saveSession() {
    if (!selected) return;
    setStatus('Saving…');
    const updated = await api.update('sessions', selected._id, {
      title: selected.title,
      summary: selected.summary
    });
    patchLocal(selected._id, updated);
    setStatus('Saved ✓');
    setTimeout(() => setStatus(''), 1500);
  }

  async function deleteSession() {
    if (!selected) return;
    if (!(await confirm(`Delete Session ${selected.number}?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    await api.remove('sessions', selected._id);
    setSessions((prev) => prev.filter((s) => s._id !== selected._id));
    setSelectedId(null);
  }

  const groups = {};
  for (const a of selected?.activity || []) {
    (groups[a.kind] = groups[a.kind] || []).push(a);
  }

  return (
    <div className={`split-view ${selected ? 'detail-open' : ''}`}>
      <aside className="list-pane">
        <div className="list-header">
          <h2>Sessions</h2>
        </div>
        <div className="item-list">
          {sessions.length === 0 && (
            <div className="empty-hint">
              No sessions yet. Click “Start Session” in the sidebar when you sit down to play —
              when you end it, everything you wrote gets collected into a recap.
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s._id}
              className={`item-card ${selectedId === s._id ? 'selected' : ''}`}
              onClick={() => setSelectedId(s._id)}
            >
              <div className="item-title">
                Session {s.number}{s.title ? ` — ${s.title}` : ''}
              </div>
              <div className="item-meta">
                {s.active ? (
                  <span className="badge live-badge">● LIVE</span>
                ) : (
                  <span className="badge">{fmtDuration(s.startedAt, s.endedAt)}</span>
                )}
                <span className="item-date">{fmtDateTime(s.startedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="editor-pane">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-icon">🕰️</div>
            <p>
              Select a session to see its recap — everything you added or edited while it ran,
              plus your own summary in your own words.
            </p>
          </div>
        ) : (
          <>
            <button className="btn mobile-back" onClick={() => setSelectedId(null)}>← Back</button>
            <div className="editor-toolbar">
              <span className="status-text">{status}</span>
              {selected.active && activeSession && (
                <button className="btn danger" onClick={onEnd}>⏹ End Session</button>
              )}
              <button className="btn primary" onClick={saveSession}>Save</button>
              <button className="btn danger" onClick={deleteSession}>Delete</button>
            </div>

            <div className="session-heading">
              <span className="session-number">Session {selected.number}</span>
              <input
                className="title-input grow"
                value={selected.title}
                placeholder="Give it a title, e.g. The Heist at Eberald"
                onChange={(e) => patchLocal(selected._id, { title: e.target.value })}
              />
            </div>

            <div className="session-times">
              <span>▶ {fmtDateTime(selected.startedAt)}</span>
              <span>⏹ {selected.active ? 'in progress' : fmtDateTime(selected.endedAt)}</span>
              <span>⌛ {fmtDuration(selected.startedAt, selected.endedAt)}</span>
            </div>

            {selected.active ? (
              <div className="live-banner">
                This session is running. Everything you create or edit is being tracked — end
                the session to generate the recap.
              </div>
            ) : (
              <>
                <div className="section-label">What happened (auto recap)</div>
                {selected.activity.length === 0 ? (
                  <div className="empty-hint">
                    Nothing was added or edited during this session.
                  </div>
                ) : (
                  <div className="recap-grid">
                    {Object.entries(groups).map(([kind, items]) => (
                      <div key={kind} className="recap-group">
                        <div className="recap-group-title">{KIND_LABELS[kind] || kind}</div>
                        {items.map((a, i) => (
                          <div key={i} className="recap-item">
                            <span className={`action-badge ${a.action}`}>
                              {a.action === 'created' ? 'new' : 'edited'}
                            </span>
                            {a.name}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="section-label">Your summary</div>
            <div className="ai-summary-bar">
              <button className="btn" disabled={aiBusyId === selected._id} onClick={summarize}>
                {aiBusyId === selected._id ? '✨ Working…' : '✨ Write a summary'}
              </button>
              {aiStatusById[selected._id] && (
                <span className="status-text">{aiStatusById[selected._id]}</span>
              )}
            </div>
            <textarea
              className="content-area"
              value={selected.summary}
              placeholder="The session in your own words: big moments, cliffhangers, plans for next time…"
              onChange={(e) => patchLocal(selected._id, { summary: e.target.value })}
            />
          </>
        )}
      </section>
    </div>
  );
}
