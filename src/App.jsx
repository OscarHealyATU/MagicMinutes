import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { applyTheme, readTheme, writeTheme } from './lib/theme.mjs';
import NotesView from './views/NotesView.jsx';
import CharactersView from './views/CharactersView.jsx';
import CombosView from './views/CombosView.jsx';
import PlacesView from './views/PlacesView.jsx';
import SessionsView from './views/SessionsView.jsx';
import MapView from './views/MapView.jsx';
import SettingsView from './views/SettingsView.jsx';

// Sidebar layout: world, then people & play, then history
const TAB_GROUPS = [
  [
    { id: 'map', label: 'Map', icon: '🚇', hint: 'Diagrammatic map' },
    { id: 'places', label: 'Places', icon: '🗺️', hint: 'Log all places of note' },
    { id: 'notes', label: 'Notes', icon: '📜', hint: 'Keep track of important details' }
  ],
  [
    { id: 'characters', label: 'Characters', icon: '🎭', hint: 'Your party, the NPCs, and who knows who' },
    { id: 'combos', label: 'Fight Combos', icon: '⚔️', hint: 'Work out turn sequences' }
  ],
  [
    { id: 'sessions', label: 'Recap', icon: '🕰️', hint: 'Session history Summary' },
    { id: 'settings', label: 'Settings', icon: '⚙️', hint: 'Theme, backup and transfer' }
  ]
];

function fmtElapsed(start) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(start)) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function App() {
  const [tab, setTab] = useState('notes');
  const [session, setSession] = useState(null);
  const [sessionsReload, setSessionsReload] = useState(0);
  const [focusSessionId, setFocusSessionId] = useState(null);
  const [focusPlaceId, setFocusPlaceId] = useState(null);
  const [focusNoteId, setFocusNoteId] = useState(null);
  const [focusNpcId, setFocusNpcId] = useState(null);
  const [theme, setTheme] = useState(() => readTheme(globalThis.localStorage));
  const [, setTick] = useState(0);

  // Kept on <html> so the stylesheet can switch both palettes in one place.
  useEffect(() => {
    applyTheme(theme, document.documentElement);
    writeTheme(theme, globalThis.localStorage);
  }, [theme]);

  function openPlace(id) {
    setFocusPlaceId(id);
    setTab('places');
  }

  function openNote(id) {
    setFocusNoteId(id);
    setTab('notes');
  }

  function openNpc(id) {
    setFocusNpcId(id);
    setTab('characters');
  }

  useEffect(() => {
    api.sessions.active().then(setSession).catch(() => {});
  }, []);

  // Re-render every 30s so the elapsed timer stays fresh
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [session]);

  async function startSession() {
    const s = await api.sessions.start();
    setSession(s);
    setSessionsReload((x) => x + 1);
  }

  async function endSession() {
    if (!session) return;
    const ended = await api.sessions.end(session._id);
    setSession(null);
    setFocusSessionId(ended._id);
    setSessionsReload((x) => x + 1);
    setTab('sessions');
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">🐉</span>
          <div>
            <div className="brand-title">MagicMinutes</div>
            <div className="brand-sub">Chart your campaign</div>
          </div>
        </div>
        {TAB_GROUPS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <div className="nav-divider" />}
            {group.map((t) => (
              <button
                key={t.id}
                className={`nav-btn ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="nav-icon">{t.icon}</span>
                <span>
                  <span className="nav-label">{t.label}</span>
                  <span className="nav-hint">{t.hint}</span>
                </span>
              </button>
            ))}
          </React.Fragment>
        ))}

        <div className="session-widget">
          {session ? (
            <>
              <div className="session-live">
                <span className="live-dot" />
                Session {session.number} · {fmtElapsed(session.startedAt)}
              </div>
              <button className="btn danger wide" onClick={endSession}>⏹ End Session</button>
            </>
          ) : (
            <button className="btn primary wide" onClick={startSession}>▶ Start Session</button>
          )}
        </div>
      </nav>
      <main className="content">
        {tab === 'notes' && <NotesView focusId={focusNoteId} />}
        {tab === 'characters' && <CharactersView focusId={focusNpcId} />}
        {tab === 'places' && <PlacesView focusId={focusPlaceId} />}
        {tab === 'map' && <MapView onOpenPlace={openPlace} onOpenNote={openNote} onOpenNpc={openNpc} />}
        {tab === 'combos' && <CombosView />}
        {tab === 'settings' && <SettingsView theme={theme} onThemeChange={setTheme} />}
        {tab === 'sessions' && (
          <SessionsView
            reloadToken={sessionsReload}
            focusId={focusSessionId}
            activeSession={session}
            onEnd={endSession}
          />
        )}
      </main>
    </div>
  );
}
