import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { applyTheme, readTheme, writeTheme } from './lib/theme.mjs';
import {
  applyColorBlind,
  applyFontStyle,
  readColorBlind,
  readFontStyle,
  writeColorBlind,
  writeFontStyle
} from './lib/a11y.mjs';
import { applyTextSizes, readTextSizes, writeTextSizes } from './lib/textSizes.mjs';
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
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [sessionsReload, setSessionsReload] = useState(0);
  const [focusSessionId, setFocusSessionId] = useState(null);
  const [focusPlaceId, setFocusPlaceId] = useState(null);
  const [focusNoteId, setFocusNoteId] = useState(null);
  const [focusNpcId, setFocusNpcId] = useState(null);
  const [theme, setTheme] = useState(() => readTheme(globalThis.localStorage));
  const [fontStyle, setFontStyle] = useState(() => readFontStyle(globalThis.localStorage));
  const [colorBlind, setColorBlind] = useState(() => readColorBlind(globalThis.localStorage));
  const [textSizes, setTextSizes] = useState(() => readTextSizes(globalThis.localStorage));
  const [, setTick] = useState(0);

  // Kept on <html> so the stylesheet can switch both palettes in one place.
  useEffect(() => {
    applyTheme(theme, document.documentElement);
    writeTheme(theme, globalThis.localStorage);
  }, [theme]);

  useEffect(() => {
    applyFontStyle(fontStyle, document.documentElement);
    writeFontStyle(fontStyle, globalThis.localStorage);
  }, [fontStyle]);

  useEffect(() => {
    applyColorBlind(colorBlind, document.documentElement);
    writeColorBlind(colorBlind, globalThis.localStorage);
  }, [colorBlind]);

  useEffect(() => {
    applyTextSizes(textSizes, document.documentElement);
    writeTextSizes(textSizes, globalThis.localStorage);
  }, [textSizes]);

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

  function refreshActiveSession() {
    api.sessions.active().then(setSession).catch(() => {});
  }

  useEffect(refreshActiveSession, []);

  // The sidebar's idea of "the active session" only ever came from that one
  // fetch on mount, so a session started or ended somewhere else — an import
  // on the Settings tab, or another window/instance — never showed up until
  // a restart. Re-checking on every tab change and whenever the window
  // regains focus catches those without polling constantly.
  useEffect(refreshActiveSession, [tab]);
  useEffect(() => {
    window.addEventListener('focus', refreshActiveSession);
    return () => window.removeEventListener('focus', refreshActiveSession);
  }, []);

  // Re-render every 30s so the elapsed timer stays fresh
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [session]);

  async function startSession() {
    // Guards against a double-click firing two requests before the first
    // one lands — store.mjs also serializes concurrent starts, but the
    // button guard avoids even sending the second request.
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionError('');
    try {
      const s = await api.sessions.start();
      setSession(s);
      setSessionsReload((x) => x + 1);
    } catch (e) {
      setSessionError(e.message);
    } finally {
      setSessionBusy(false);
    }
  }

  // Ends a session by id — the sidebar's own End Session button has none to
  // pass (it always means "the active one"), but Recap's End button needs to
  // end whichever session is selected there, which isn't necessarily the
  // sidebar's active session (e.g. right after an import, or if the store
  // ever ends up with more than one LIVE session).
  async function endSession(id) {
    const targetId = id || session?._id;
    if (!targetId || sessionBusy) return;
    setSessionBusy(true);
    setSessionError('');
    try {
      const ended = await api.sessions.end(targetId);
      // `ended` is null when the session was already gone (deleted from
      // Recap, or removed by an import) — nothing to focus on, just make
      // sure the sidebar isn't still showing it as live.
      if (ended) setFocusSessionId(ended._id);
      setSessionsReload((x) => x + 1);
      setTab('sessions');
    } catch (e) {
      setSessionError(e.message);
    } finally {
      setSessionBusy(false);
      refreshActiveSession();
    }
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">🐉</span>
          <div className="sidebar-brand-text">
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
              <button className="btn danger wide" disabled={sessionBusy} onClick={() => endSession()}>
                ⏹ End Session
              </button>
            </>
          ) : (
            <button className="btn primary wide" disabled={sessionBusy} onClick={startSession}>
              ▶ Start Session
            </button>
          )}
          {sessionError && <div className="status-text">{sessionError}</div>}
        </div>
      </nav>
      <main className="content">
        {tab === 'notes' && <NotesView focusId={focusNoteId} onFocusUsed={() => setFocusNoteId(null)} />}
        {tab === 'characters' && (
          <CharactersView
            focusId={focusNpcId}
            colorBlind={colorBlind}
            mapScale={textSizes.map}
            onFocusUsed={() => setFocusNpcId(null)}
          />
        )}
        {tab === 'places' && <PlacesView focusId={focusPlaceId} onFocusUsed={() => setFocusPlaceId(null)} />}
        {tab === 'map' && (
          <MapView
            onOpenPlace={openPlace}
            onOpenNote={openNote}
            onOpenNpc={openNpc}
            colorBlind={colorBlind}
            fontStyle={fontStyle}
            mapScale={textSizes.map}
            onOpenSettings={() => setTab('settings')}
          />
        )}
        {tab === 'combos' && <CombosView />}
        {tab === 'settings' && (
          <SettingsView
            theme={theme}
            onThemeChange={setTheme}
            fontStyle={fontStyle}
            onFontStyleChange={setFontStyle}
            colorBlind={colorBlind}
            onColorBlindChange={setColorBlind}
            textSizes={textSizes}
            onTextSizesChange={setTextSizes}
          />
        )}
        {tab === 'sessions' && (
          <SessionsView
            reloadToken={sessionsReload}
            focusId={focusSessionId}
            onFocusUsed={() => setFocusSessionId(null)}
            onEnd={endSession}
          />
        )}
      </main>
    </div>
  );
}
