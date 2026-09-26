import React, { useEffect, useRef, useState } from 'react';
import { confirmDialog } from '../fileio.js';
import { api } from '../api.js';
import { buildPrompt, collectSessionMaterial, draftSummary, tidyCapitals } from '../lib/recap.mjs';
import { aiGenerate, aiStatus, noAiMessage, readAiEnabled, readAiGpu } from '../lib/ai.mjs';
import { useAutosave } from '../lib/useAutosave.js';

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

export default function SessionsView({ reloadToken, focusId, onFocusUsed, onEnd }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState('');
  // Keyed by session id (not just a flag) so switching sessions mid-generate
  // doesn't show session B the "Working…"/result feedback meant for session A.
  const [aiBusyId, setAiBusyId] = useState(null);
  const [aiStatusById, setAiStatusById] = useState({});
  // The AI's answer so far, per session, while it's being written. Shown in
  // place of the summary box so it appears word by word; only the finished
  // text is saved.
  const [streamById, setStreamById] = useState({});
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
  // Live selectedId, for the long-running summarize() below to check it's
  // still touching the autosave hook's own currently-bound session.
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const selected = sessions.find((s) => s._id === selectedId) || null;

  useEffect(() => {
    api.list('sessions').then((docs) => {
      setSessions(docs);
      if (focusId) {
        setSelectedId(focusId);
        onFocusUsed?.();
      }
    }).catch((e) => setStatus(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, focusId]);

  function patchLocal(id, patch) {
    setSessions((prev) => prev.map((s) => (s._id === id ? { ...s, ...patch } : s)));
  }

  // Recap only ever autosaves {title, summary} — never the whole doc (in
  // particular never `activity`, which is only ever written by sessionsEnd).
  const autosave = useAutosave({
    id: selected?._id ?? null,
    snapshot: selected && { title: selected.title, summary: selected.summary },
    onSave: (id, snap) => api.update('sessions', id, snap),
    onSaved: (id, updated) => patchLocal(id, { updatedAt: updated.updatedAt })
  });

  // Builds a summary from the session's recap material and saves it into the
  // same "Your summary" field the player edits by hand. Uses the built-in
  // model in the AI edition when AI summaries are switched on; otherwise a
  // deterministic, no-AI draft, so this always works (including on Android).
  async function summarize() {
    // One summary at a time, across all sessions: the AI uses the whole CPU.
    if (!selected || aiBusyId) return;
    const sessionId = selected._id;
    const summaryAtStart = selected.summary || '';
    if (summaryAtStart.trim()) {
      const ok = await confirmDialog('Replace your existing summary with a generated one?', {
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
      const enabled = readAiEnabled(globalThis.localStorage);
      const ai = enabled ? await aiStatus() : null;

      let summary = '';
      let resultStatus;
      if (ai && ai.available) {
        // The model reads all the notes before it writes a word, which takes
        // a few seconds on a long session — say so, rather than look stuck.
        setStatusFor('Reading your notes…');
        setStreamById((prev) => ({ ...prev, [sessionId]: '' }));
        let writing = false;
        try {
          const result = await aiGenerate(buildPrompt(material), {
            gpu: readAiGpu(globalThis.localStorage),
            onText: (soFar) => {
              if (!mountedRef.current || !soFar) return;
              if (!writing) {
                writing = true;
                setStatusFor(`Writing with ${ai.model}…`);
              }
              setStreamById((prev) => ({ ...prev, [sessionId]: tidyCapitals(soFar, material) }));
            },
            onRestart: () => {
              if (!mountedRef.current) return;
              writing = false;
              setStatusFor('The graphics card didn’t work, so starting again on the CPU…');
              setStreamById((prev) => ({ ...prev, [sessionId]: '' }));
            }
          });
          summary = tidyCapitals(result.text, material);
          if (summary && result.gpuFallback) {
            resultStatus = `Written by AI on the CPU, because the graphics card didn’t work (${result.gpuFallback}). You can switch the graphics card off in Settings.`;
          }
        } catch (genErr) {
          summary = '';
          resultStatus = noAiMessage({ enabled, status: ai, error: genErr.message });
        }
      }
      if (summary) {
        if (!resultStatus) resultStatus = 'Written by AI ✓';
      } else {
        summary = draftSummary(material);
        if (!resultStatus) resultStatus = noAiMessage({ enabled, status: ai });
      }

      if (!mountedRef.current) return;
      // If the player typed into the summary box while this request was in
      // flight (it can take up to three minutes), their words win — don't save over
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
      // Copy back only `summary`/`updatedAt` — the whole `updated` doc also
      // carries `title`, and applying that here would revert a title the
      // player typed while this request was running.
      patchLocal(sessionId, { summary: updated.summary, updatedAt: updated.updatedAt });
      // This save didn't go through the autosave hook, so tell it the
      // summary field is now clean — otherwise it'd debounce a redundant
      // re-save of the same value a moment later. Only if the hook is still
      // bound to this same session (the player may have switched away
      // while the AI was writing).
      if (selectedIdRef.current === sessionId) autosave.markSaved({ summary: updated.summary });
      setStatusFor(resultStatus);
      if (resultStatus === 'Written by AI ✓') setTimeout(() => setStatusFor(''), 2500);
    } catch (e) {
      if (mountedRef.current) setStatusFor(`Couldn't write a summary: ${e.message}`);
    } finally {
      if (mountedRef.current) {
        setAiBusyId((cur) => (cur === sessionId ? null : cur));
        setStreamById(({ [sessionId]: _done, ...rest }) => rest);
      }
    }
  }

  // "Save" is now "save now" — autosave already keeps title/summary persisted.
  async function saveSession() {
    if (!selected) return;
    await autosave.flush();
  }

  // A delete error auto-clears after a few seconds — otherwise it permanently
  // shadows the autosave status line below it (Saving…/Saved ✓), which keeps
  // working fine underneath even after an unrelated error here.
  function showError(message) {
    setStatus(message);
    setTimeout(() => setStatus((s) => (s === message ? '' : s)), 4000);
  }

  async function deleteSession() {
    if (!selected) return;
    if (!(await confirmDialog(`Delete Session ${selected.number}?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    autosave.markDeleted(selected._id);
    try {
      await api.remove('sessions', selected._id);
      setSessions((prev) => prev.filter((s) => s._id !== selected._id));
      setSelectedId(null);
    } catch (e) {
      // Delete didn't actually go through — restore autosave for this session.
      autosave.unmarkDeleted(selected._id);
      showError(e.message);
    }
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
              <span className="status-text">{status || autosave.status}</span>
              {selected.active && (
                <button className="btn danger" onClick={() => onEnd(selected._id)}>⏹ End Session</button>
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
              <button
                className="btn"
                disabled={!!aiBusyId}
                title={aiBusyId && aiBusyId !== selected._id ? 'Another session’s summary is still being written' : undefined}
                onClick={summarize}
              >
                {aiBusyId === selected._id ? '✨ Working…' : '✨ Write a summary'}
              </button>
              {aiStatusById[selected._id] && (
                <span className="status-text">{aiStatusById[selected._id]}</span>
              )}
            </div>
            {streamById[selected._id] !== undefined ? (
              <div className="content-area ai-stream" aria-live="polite" aria-busy="true">
                {streamById[selected._id] ? (
                  streamById[selected._id]
                ) : (
                  <span className="ai-stream-waiting">Reading your notes…</span>
                )}
                <span className="ai-stream-cursor" aria-hidden="true" />
              </div>
            ) : (
              <textarea
                className="content-area"
                value={selected.summary}
                placeholder="The session in your own words: big moments, cliffhangers, plans for next time…"
                onChange={(e) => patchLocal(selected._id, { summary: e.target.value })}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
