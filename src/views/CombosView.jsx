import React, { useEffect, useMemo, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { api } from '../api.js';
import BlockStack from '../components/BlockStack.jsx';
import { combineBlocks, rollCombo } from '../lib/dice.mjs';

export const BLOCK_TYPES = [
  { id: 'action', label: 'Action', color: '#70250a', hint: 'Attack, Cast a Spell, Dash…' },
  { id: 'bonus', label: 'Bonus Action', color: '#6d411c', hint: 'Off-hand attack, Healing Word…' },
  { id: 'reaction', label: 'Reaction', color: '#485354', hint: 'Opportunity attack, Shield…' },
  { id: 'movement', label: 'Movement', color: '#0f3a5c', hint: 'Move, disengage path…' },
  { id: 'spell', label: 'Spell', color: '#1d4a52', hint: 'Spell name, slot level, target…' },
  { id: 'feat', label: 'Feat', color: '#96602e', hint: 'Feat or class feature to trigger' },
  { id: 'item', label: 'Item', color: '#3f5e3a', hint: 'Potion, magic item, ammo…' },
  { id: 'free', label: 'Free / Note', color: '#2a3439', hint: 'Free interaction or reminder' }
];

const typeInfo = (id) => BLOCK_TYPES.find((t) => t.id === id) || BLOCK_TYPES[7];

// The COMBO total row + roll/log footer that replaced the old dice calculator.
// Everything is derived live from the blocks' roll/condition fields.
function ComboTotal({ combo }) {
  const [result, setResult] = useState(null);
  const [logMsg, setLogMsg] = useState('');
  const [manualDmg, setManualDmg] = useState('');

  const combined = useMemo(() => combineBlocks(combo.blocks), [combo.blocks]);

  // Clear a stale roll when the combo's dice change or another combo is selected
  useEffect(() => {
    setResult(null);
    setManualDmg('');
  }, [combo._id, combined.notation, combined.hitLabel]);

  const primary = combo.blocks.find((b) => b.type === 'action' && b.text) || null;

  function doRoll() {
    setResult(rollCombo(combined));
  }

  async function logOutcome(outcome) {
    const sizes = Object.keys(combined.dice).map(Number).sort((a, b) => b - a);
    // A typed damage total (physical dice) wins over the in-app roll
    const manualTotal = manualDmg.trim() === '' ? null : Number(manualDmg);
    const manual = manualTotal != null && !Number.isNaN(manualTotal);
    await api.create('rolls', {
      comboId: combo._id,
      comboName: combo.name,
      notation: combined.notation || combined.hitLabel || '',
      die: manual || result?.damageRolls?.length ? sizes[0] || 0 : result?.d20s ? 20 : 0,
      rolls: manual
        ? []
        : result?.damageRolls?.length
          ? result.damageRolls.map((d) => d.value)
          : result?.d20s || [],
      modifier: manual || result?.damageRolls?.length ? combined.mod : combined.toHit,
      total: manual ? manualTotal : result?.damageTotal ?? result?.attackTotal ?? 0,
      outcome,
      manual
    });
    setResult(null);
    setManualDmg('');
    setLogMsg(`Logged as ${outcome} — no peeking mid-game!`);
    setTimeout(() => setLogMsg(''), 3000);
  }

  const hasAnything = combined.notation || combined.hitLabel;

  return (
    <div className="combo-total-wrap">
      <div className="block combo-total">
        <span className="block-grip" style={{ opacity: 0 }}>⋮⋮</span>
        <span className="block-label">Combo</span>
        <span className="total-field" title="Primary action">
          {primary ? primary.text : combo.name}
        </span>
        <span className="total-field" title="Attack roll">
          {combined.hitLabel || '—'}
        </span>
        <span className="total-field total-roll" title="Combined damage dice">
          {combined.notation || '—'}
        </span>
        <span className="total-max" title="Maximum possible damage">
          {combined.max > 0 ? `${combined.max} max` : '—'}
        </span>
      </div>

      <div className="combo-roll-bar">
        {hasAnything ? (
          <button className="btn primary" onClick={doRoll}>🎲 Roll combo</button>
        ) : (
          <span className="outcome-hint">
            Add dice to the blocks above (e.g. 1d6, +7 to hit, advantage) to calculate the combo.
          </span>
        )}

        {result && (
          <span className="dice-result inline-result">
            {result.d20s && (
              <>
                <span className="dice-notation">to hit:</span>
                {result.d20s.map((v, i) => (
                  <span key={`a${i}`} className={`die-face ${v === 20 ? 'nat20' : ''} ${v === 1 ? 'nat1' : ''}`}>{v}</span>
                ))}
                {combined.toHit !== 0 && (
                  <span className="dice-mod">{combined.toHit > 0 ? `+${combined.toHit}` : combined.toHit}</span>
                )}
                <span className="dice-total">= {result.attackTotal}</span>
              </>
            )}
            {result.damageTotal != null && (
              <>
                <span className="dice-notation">dmg:</span>
                {result.damageRolls.map((d, i) => (
                  <span key={`d${i}`} className="die-face" title={`d${d.size}`}>{d.value}</span>
                ))}
                {combined.mod !== 0 && (
                  <span className="dice-mod">{combined.mod > 0 ? `+${combined.mod}` : combined.mod}</span>
                )}
                <span className="dice-total">= {result.damageTotal}</span>
              </>
            )}
          </span>
        )}

        {result && (
          <button
            className="btn cancel-roll"
            title="Discard this roll without logging it"
            onClick={() => setResult(null)}
          >
            Cancel
          </button>
        )}

        <span className="combo-roll-spacer" />
        <span className="outcome-hint">{result ? 'How did it go?' : 'Log an attempt:'}</span>
        <input
          className="dmg-input"
          type="number"
          min="0"
          value={manualDmg}
          placeholder="dmg"
          title="Rolled physical dice? Type the damage total here before logging"
          onChange={(e) => setManualDmg(e.target.value)}
        />
        <button className="btn outcome-success" onClick={() => logOutcome('success')}>✓ Success</button>
        <button className="btn outcome-failure" onClick={() => logOutcome('failure')}>✗ Failed</button>
      </div>
      {logMsg && <div className="status-text">{logMsg}</div>}
    </div>
  );
}

export default function CombosView() {
  const [combos, setCombos] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState('');

  const selected = combos.find((c) => c._id === selectedId) || null;

  useEffect(() => {
    api.list('combos').then(setCombos).catch((e) => setStatus(e.message));
  }, []);

  async function createCombo() {
    const combo = await api.create('combos', {
      name: 'New combo',
      blocks: [
        { type: 'movement', text: '', condition: '', roll: '' },
        { type: 'action', text: '', condition: '', roll: '' },
        { type: 'bonus', text: '', condition: '', roll: '' }
      ]
    });
    setCombos([combo, ...combos]);
    setSelectedId(combo._id);
  }

  function patchLocal(id, patch) {
    setCombos((prev) => prev.map((c) => (c._id === id ? { ...c, ...patch } : c)));
  }

  async function saveCombo() {
    if (!selected) return;
    setStatus('Saving…');
    const blocks = selected.blocks.map(({ type, text, condition, roll }) => ({
      type, text, condition, roll
    }));
    const updated = await api.update('combos', selected._id, {
      name: selected.name,
      description: selected.description,
      blocks
    });
    patchLocal(selected._id, updated);
    setStatus('Saved ✓');
    setTimeout(() => setStatus(''), 1500);
  }

  async function deleteCombo() {
    if (!selected) return;
    if (!(await confirm(`Delete "${selected.name}"?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    await api.remove('combos', selected._id);
    setCombos((prev) => prev.filter((c) => c._id !== selected._id));
    setSelectedId(null);
  }

  return (
    <div className={`split-view ${selected ? 'detail-open' : ''}`}>
      <aside className="list-pane">
        <div className="list-header">
          <h2>Combos</h2>
          <button className="btn primary" onClick={createCombo}>+ New</button>
        </div>
        <div className="item-list">
          {combos.length === 0 && (
            <div className="empty-hint">
              No combos yet. Build your turn like a Scratch program — snap together an Action,
              Bonus Action, Movement and more.
            </div>
          )}
          {combos.map((c) => (
            <button
              key={c._id}
              className={`item-card ${selectedId === c._id ? 'selected' : ''}`}
              onClick={() => setSelectedId(c._id)}
            >
              <div className="item-title">{c.name}</div>
              <div className="combo-preview">
                {c.blocks.map((b, i) => (
                  <span
                    key={i}
                    className="combo-dot"
                    title={typeInfo(b.type).label}
                    style={{ background: typeInfo(b.type).color }}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="editor-pane">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-icon">⚔️</div>
            <p>
              Select a combo or create one. Add blocks for each part of your turn, note the
              condition behind each, and put its dice in the roll box — the combo line adds it
              all up.
            </p>
          </div>
        ) : (
          <>
            <button className="btn mobile-back" onClick={() => setSelectedId(null)}>← Back</button>
            <div className="editor-toolbar">
              <span className="status-text">{status}</span>
              <button className="btn primary" onClick={saveCombo}>Save</button>
              <button className="btn danger" onClick={deleteCombo}>Delete</button>
            </div>
            <input
              className="title-input"
              value={selected.name}
              placeholder="Combo name, e.g. Nova Round"
              onChange={(e) => patchLocal(selected._id, { name: e.target.value })}
            />
            <input
              className="subtitle-input"
              value={selected.description}
              placeholder="When to use it, e.g. boss fight opener when I have a 3rd-level slot"
              onChange={(e) => patchLocal(selected._id, { description: e.target.value })}
            />
            <BlockStack
              blockTypes={BLOCK_TYPES}
              blocks={selected.blocks}
              extended
              onChange={(blocks) => patchLocal(selected._id, { blocks })}
            />
            <ComboTotal combo={selected} />
          </>
        )}
      </section>
    </div>
  );
}
