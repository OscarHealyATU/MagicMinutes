import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import AppearancePreview from '../components/AppearancePreview.jsx';
import { COLLECTIONS } from '../lib/store.mjs';
import { confirmDialog, openTextFile, saveTextFile, writeAppDataBackup } from '../fileio.js';
import { THEMES } from '../lib/theme.mjs';
import { FONT_STYLES } from '../lib/a11y.mjs';
import { aiGpus, aiStatus, readAiEnabled, readAiGpu, writeAiEnabled, writeAiGpu } from '../lib/ai.mjs';
import {
  buildExport,
  countDocs,
  describePlan,
  describePlanByCollection,
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

export default function SettingsView({
  theme,
  onThemeChange,
  fontStyle,
  onFontStyleChange,
  colorBlind,
  onColorBlindChange
}) {
  const [counts, setCounts] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('merge');
  const [ai, setAi] = useState(null);
  const [aiOn, setAiOn] = useState(() => readAiEnabled(globalThis.localStorage));
  const [gpuOn, setGpuOn] = useState(() => readAiGpu(globalThis.localStorage));
  const [gpus, setGpus] = useState(null); // null while still looking

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
    aiStatus().then((status) => {
      setAi(status);
      // Only the AI edition has an engine to ask.
      if (status.available) aiGpus().then(setGpus);
    });
  }, []);

  function toggleAi(on) {
    setAiOn(on);
    writeAiEnabled(on, globalThis.localStorage);
  }

  function toggleGpu(on) {
    setGpuOn(on);
    writeAiGpu(on, globalThis.localStorage);
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
      // Per-collection, not just the totals — "1 replaced" reads very
      // differently depending on whether that's one note or every NPC in the
      // campaign, and Replace especially needs that spelled out before
      // someone confirms it.
      const breakdown = describePlanByCollection({ plan }, (n) => LABELS[n] || n);
      const detail = breakdown.length ? `\n\n${breakdown.join('\n')}` : '';
      const warning =
        mode === 'replace'
          ? `\n\nReplace mode deletes the ${totals.remove} entries that aren't in this file. A safety backup of what you currently have is saved automatically before this runs.`
          : '';
      const ok = await confirmDialog(`Import "${file.name}"?\n\n${summary}${detail}${warning}`, {
        title: 'Confirm import',
        kind: mode === 'replace' ? 'warning' : 'info'
      });
      if (!ok) {
        say('Import cancelled.');
        return;
      }

      let backupNote = '';
      if (mode === 'replace') {
        setStatus('Backing up your current data…');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let path;
        try {
          path = await writeAppDataBackup(
            `magicminutes-safety-backup-${stamp}.json`,
            JSON.stringify(buildExport(existing), null, 2)
          );
        } catch (backupErr) {
          // Replace is irreversible, so if the safety net itself couldn't be
          // written, stop here rather than deleting anything with no way
          // back — a blocked import is recoverable; a failed backup plus a
          // completed delete is not.
          throw new Error(
            `Couldn't write a safety backup, so nothing was changed: ${backupErr.message}`
          );
        }
        // `path` is null in a plain browser (no app data folder to write
        // to) — expected there, not a failure, so the import still proceeds.
        backupNote = path
          ? ` A safety backup was saved to ${path}.`
          : ' (No safety backup was made — this only happens in the installed app, not this preview.)';
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
      const notices = [
        data.skipped.length ? `Skipped unknown sections: ${data.skipped.join(', ')}.` : '',
        data.duplicates.length ? `Duplicate ids were collapsed in: ${data.duplicates.join(', ')}.` : ''
      ].filter(Boolean).join(' ');
      say(`Imported. ${summary}${notices ? ` ${notices}` : ''}${backupNote}`);
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

          <div className="section-label">Font style</div>
          <p className="settings-help">
            Easy-read and OpenDyslexic apply everywhere too — the map, the characters tree,
            lists and forms.
          </p>
          <div className="theme-row font-row">
            {FONT_STYLES.map((f) => (
              <button
                key={f.id}
                className={`theme-option font-option font-option-${f.id} ${fontStyle === f.id ? 'on' : ''}`}
                onClick={() => onFontStyleChange(f.id)}
              >
                <span className="theme-option-label font-option-name">{f.label}</span>
                <span className="theme-option-hint">{f.hint}</span>
              </button>
            ))}
          </div>

          <div className="section-label">Colour-blind mode</div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={colorBlind}
              onChange={(e) => onColorBlindChange(e.target.checked)}
            />
            <span>
              <strong>Adjust colours that carry meaning on their own</strong>
              <span className="settings-help">
                {' '}
                Retunes NPC disposition, map connection lines and the characters tree's
                relationship lines for better separation under colour blindness, and adds dash
                patterns and letter tags so those lines and dots don't rely on colour alone.
              </span>
            </span>
          </label>

          <AppearancePreview colorBlind={colorBlind} />
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
              {gpus === null ? (
                <p className="settings-help">Looking for a graphics card…</p>
              ) : gpus.length ? (
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={gpuOn}
                    disabled={!aiOn}
                    onChange={(e) => toggleGpu(e.target.checked)}
                  />
                  <span>
                    <strong>Use the graphics card</strong>
                    <span className="settings-help">
                      {' '}
                      Much faster: a summary takes a few seconds instead of up to half a minute.
                      Found: {gpus.join(', ')}. The very first summary on a card is slower while
                      it gets ready. If the card ever fails, the summary is written on the CPU
                      instead. Switch this off to save battery on a laptop.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="settings-help">
                  No graphics card the AI can use was found, so summaries are written on the CPU.
                </p>
              )}
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
