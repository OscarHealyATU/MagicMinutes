import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { COLLECTIONS } from '../lib/store.mjs';
import { confirmDialog, openTextFile, saveTextFile } from '../fileio.js';
import { THEMES } from '../lib/theme.mjs';
import { aiStatus, readAiEnabled, writeAiEnabled } from '../lib/ai.mjs';
import {
  buildExport,
  countDocs,
  describePlan,
  exportFilename,
  parseExport,
  planImport
} from '../lib/transfer.mjs';

// Friendly names for the tables, in the order they're shown.
const LABELS = {
  notes: 'Notes',
  places: 'Places',
  npcs: 'NPCs',
  players: 'Player characters',
  groups: 'Groups',
  combos: 'Combos',
  rolls: 'Dice rolls',
  sessions: 'Sessions'
};

async function readAll() {
  const out = {};
  for (const name of COLLECTIONS) {
    out[name] = await api.list(name);
  }
  return out;
}

export default function SettingsView({ theme, onThemeChange }) {
  const [counts, setCounts] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('merge');
  const [ai, setAi] = useState(null);
  const [aiOn, setAiOn] = useState(() => readAiEnabled(globalThis.localStorage));

  function refreshCounts() {
    readAll()
      .then((all) => {
        const c = {};
        for (const name of COLLECTIONS) c[name] = all[name].length;
        setCounts(c);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(refreshCounts, []);
  useEffect(() => {
    aiStatus().then(setAi);
  }, []);

  function toggleAi(on) {
    setAiOn(on);
    writeAiEnabled(on, globalThis.localStorage);
  }

  function say(message) {
    setError('');
    setStatus(message);
  }

  async function doExport() {
    setBusy(true);
    setError('');
    setStatus('Collecting…');
    try {
      const all = await readAll();
      const payload = buildExport(all);
      const written = await saveTextFile(exportFilename(), JSON.stringify(payload, null, 2));
      say(written ? `Exported ${countDocs(all)} entries to ${written}` : 'Export cancelled.');
    } catch (e) {
      setStatus('');
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const file = await openTextFile();
      if (!file) {
        say('Import cancelled.');
        return;
      }
      const data = parseExport(file.text);
      const existing = await readAll();
      const { plan, totals } = planImport(existing, data.collections, mode);

      if (!totals.create && !totals.update && !totals.remove) {
        say('Nothing to change — that file matches what you already have.');
        return;
      }

      const summary = describePlan({ mode, totals });
      const warning =
        mode === 'replace'
          ? `\n\nReplace mode deletes the ${totals.remove} entries that aren't in this file. This cannot be undone — export a backup first if you're not sure.`
          : '';
      const ok = await confirmDialog(`Import "${file.name}"?\n\n${summary}${warning}`, {
        title: 'Confirm import',
        kind: mode === 'replace' ? 'warning' : 'info'
      });
      if (!ok) {
        say('Import cancelled.');
        return;
      }

      setStatus('Importing…');
      // Writes before deletes, deliberately: if this dies partway through, the
      // database is left holding too much rather than too little.
      for (const name of COLLECTIONS) {
        const step = plan[name];
        for (const doc of [...step.create, ...step.update]) await api.upsert(name, doc);
        for (const id of step.remove) await api.remove(name, id);
      }
      refreshCounts();
      say(`Imported. ${summary}${data.skipped.length ? ` Skipped unknown sections: ${data.skipped.join(', ')}.` : ''}`);
    } catch (e) {
      setStatus('');
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <h2 className="settings-title">Settings</h2>

        <section className="settings-card">
          <h3>Appearance</h3>
          <p className="settings-help">
            Applies everywhere, including the map and the characters tree. Remembered between
            launches.
          </p>
          <div className="theme-row">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-option ${theme === t.id ? 'on' : ''}`}
                onClick={() => onThemeChange(t.id)}
              >
                <span className={`theme-swatch ${t.id}`} aria-hidden="true">
                  <span className="theme-swatch-bar" />
                  <span className="theme-swatch-bar short" />
                </span>
                <span className="theme-option-label">{t.label}</span>
                <span className="theme-option-hint">{t.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-card">
          <h3>AI summaries</h3>
          {ai === null ? (
            <p className="settings-help">Checking…</p>
          ) : ai.available ? (
            <>
              <label className="settings-toggle">
                <input type="checkbox" checked={aiOn} onChange={(e) => toggleAi(e.target.checked)} />
                <span>
                  <strong>Summarise sessions with AI</strong>
                  <span className="settings-help">
                    {' '}
                    “Write a summary” on the Recap page uses {ai.model}, which runs entirely on this
                    computer: nothing is sent anywhere, and it works offline. It can occasionally
                    muddle a detail, so give the summary a read. Switched off, you get a plain
                    summary built from your notes.
                  </span>
                </span>
              </label>
            </>
          ) : ai.installed ? (
            <div className="settings-error">⚠ AI summaries can’t run: {ai.reason}</div>
          ) : (
            <p className="settings-help">
              This is the standard edition, so “Write a summary” builds a plain summary from your
              notes. For AI-written summaries, install the <strong>MagicMinutes AI</strong> edition
              from the releases page. It's the same app with a small AI model built in, and it
              keeps all your notes.
            </p>
          )}
        </section>

        <section className="settings-card">
          <h3>Backup &amp; transfer</h3>
          <p className="settings-help">
            Everything lives in one SQLite file on this machine — nothing is synced anywhere.
            Export writes a single JSON file holding your whole campaign: notes, places, NPCs,
            groups, party, combos, rolls and session history. Keep one somewhere safe, and use
            it to move to another machine or your phone. To send just a few notes to someone, use
            Share on the Notes page instead.
          </p>

          {counts && (
            <div className="settings-counts">
              {COLLECTIONS.filter((n) => counts[n] > 0).map((n) => (
                <span key={n} className="badge subtle">
                  {LABELS[n] || n}: {counts[n]}
                </span>
              ))}
              {total === 0 && <span className="empty-hint">Nothing saved yet.</span>}
            </div>
          )}

          <div className="settings-actions">
            <button className="btn primary" disabled={busy} onClick={doExport}>
              ⬇ Export everything
            </button>
          </div>

          <div className="section-label">Import</div>
          <div className="import-modes">
            <label className={`import-mode ${mode === 'merge' ? 'on' : ''}`}>
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
              />
              <span>
                <strong>Merge</strong>
                <span className="settings-help">
                  Adds what's missing and overwrites entries with the same id. Anything not in
                  the file is left alone.
                </span>
              </span>
            </label>
            <label className={`import-mode ${mode === 'replace' ? 'on' : ''}`}>
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
              />
              <span>
                <strong>Replace</strong>
                <span className="settings-help">
                  Makes the file the whole campaign — anything not in it is deleted. Use when
                  restoring a backup.
                </span>
              </span>
            </label>
          </div>

          <div className="settings-actions">
            <button className="btn" disabled={busy} onClick={doImport}>
              ⬆ Import from file…
            </button>
          </div>

          {status && <div className="settings-status">{status}</div>}
          {error && <div className="settings-error">⚠ {error}</div>}
        </section>

        <section className="settings-card">
          <h3>Where your data lives</h3>
          <p className="settings-help">
            On Windows: <code>%APPDATA%\com.oscar.ttrpgmap\ttrpgmap.db</code>
          </p>
          <p className="settings-help">
            Copying that file is the other way to back up or move your campaign — do it while
            the app is closed, or the copy can miss recent changes.
          </p>
        </section>
      </div>
    </div>
  );
}
