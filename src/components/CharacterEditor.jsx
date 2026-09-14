import React from 'react';
import {
  RELATION_TYPES,
  relationInfo,
  bandFor,
  clampAlignment,
  labelOf,
  GROUP_COLORS
} from '../lib/characters.mjs';

// Shared shell: a centred popup with a title bar and Save / Delete footer.
// Deliberately no click-outside-to-close — a stray click on the backdrop would
// throw away everything typed since the popup opened.
function Modal({ title, onClose, onSave, onDelete, status, children }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="block-btn" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          <span className="status-text">{status}</span>
          <button className="btn danger" onClick={onDelete}>Delete</button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

export function PlayerEditor({ draft, onChange, onSave, onDelete, onClose, status }) {
  const set = (patch) => onChange({ ...draft, ...patch });
  return (
    <Modal
      title="Player character"
      onClose={onClose}
      onSave={onSave}
      onDelete={onDelete}
      status={status}
    >
      <input
        className="title-input"
        value={draft.characterName || ''}
        placeholder="Character name, e.g. Bob"
        onChange={(e) => set({ characterName: e.target.value })}
      />
      <div className="field-row">
        <label>
          Played by
          <input
            value={draft.playerName || ''}
            placeholder="real name, e.g. Sam"
            onChange={(e) => set({ playerName: e.target.value })}
          />
        </label>
        <label>
          Race
          <input
            value={draft.race || ''}
            placeholder="e.g. Tiefling"
            onChange={(e) => set({ race: e.target.value })}
          />
        </label>
        <label>
          Class
          <input
            value={draft.className || ''}
            placeholder="e.g. Sorcerer"
            onChange={(e) => set({ className: e.target.value })}
          />
        </label>
        <label>
          Level
          <input
            value={draft.level || ''}
            placeholder="e.g. 5"
            onChange={(e) => set({ level: e.target.value })}
          />
        </label>
      </div>
      <div className="section-label">Who are they?</div>
      <textarea
        className="content-area small"
        value={draft.description || ''}
        placeholder="Personality, appearance, backstory, goals…"
        onChange={(e) => set({ description: e.target.value })}
      />
      <div className="section-label">Roleplay log</div>
      <textarea
        className="content-area small"
        value={draft.notes || ''}
        placeholder="How they've been roleplayed: memorable lines, choices they made, character growth, secrets revealed…"
        onChange={(e) => set({ notes: e.target.value })}
      />
    </Modal>
  );
}

export function NpcEditor({
  draft,
  npcs,
  groups,
  onChange,
  onSave,
  onDelete,
  onClose,
  onCreateGroup,
  status
}) {
  const set = (patch) => onChange({ ...draft, ...patch });
  const relations = draft.relations || [];
  const band = bandFor(draft.alignment);
  const others = npcs.filter((n) => n._id !== draft._id);

  function setRelation(index, patch) {
    set({ relations: relations.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }

  function addRelation() {
    set({ relations: [...relations, { type: 'knows', targetId: '', text: '' }] });
  }

  function removeRelation(index) {
    set({ relations: relations.filter((_, i) => i !== index) });
  }

  return (
    <Modal title="NPC" onClose={onClose} onSave={onSave} onDelete={onDelete} status={status}>
      <input
        className="title-input"
        value={draft.name || ''}
        placeholder="Name — leave blank if you never learned it"
        onChange={(e) => set({ name: e.target.value })}
      />
      <label className="stack-label">
        Or describe them
        <input
          value={draft.descriptor || ''}
          placeholder="e.g. half-orc henchman, goblin from the goblin gang"
          onChange={(e) => set({ descriptor: e.target.value })}
        />
      </label>

      <div className="section-label">How aligned are they to the party?</div>
      <div className="align-slider">
        <span className="align-end">Enemy</span>
        <input
          type="range"
          min="-100"
          max="100"
          step="5"
          value={clampAlignment(draft.alignment)}
          onChange={(e) => set({ alignment: Number(e.target.value) })}
        />
        <span className="align-end">Ally</span>
        <span className="badge align-badge" style={{ background: band.color }}>
          {band.label} ({clampAlignment(draft.alignment) > 0 ? '+' : ''}
          {clampAlignment(draft.alignment)})
        </span>
      </div>

      <div className="field-row">
        <label>
          Race
          <input
            value={draft.race || ''}
            placeholder="e.g. Half-elf"
            onChange={(e) => set({ race: e.target.value })}
          />
        </label>
        <label>
          Occupation
          <input
            value={draft.occupation || ''}
            placeholder="e.g. Innkeeper"
            onChange={(e) => set({ occupation: e.target.value })}
          />
        </label>
        <label>
          Group
          <select
            value={draft.groupId || ''}
            onChange={(e) => {
              if (e.target.value === '__new') onCreateGroup();
              else set({ groupId: e.target.value });
            }}
          >
            <option value="">— none —</option>
            {groups.map((g) => (
              <option key={g._id} value={g._id}>{g.name}</option>
            ))}
            <option value="__new">＋ New group…</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="grow">
          Location
          <input
            value={draft.location || ''}
            placeholder="Where do they live / where did you meet?"
            onChange={(e) => set({ location: e.target.value })}
          />
        </label>
        <label className="grow">
          First met
          <input
            value={draft.firstMet || ''}
            placeholder="e.g. Session 4, the burning mill"
            onChange={(e) => set({ firstMet: e.target.value })}
          />
        </label>
      </div>

      <div className="section-label">Who are they to other people?</div>
      <div className="relation-stack">
        {relations.length === 0 && (
          <div className="empty-hint">
            No relations yet. Add one to hang this NPC off someone else — a boss sits above
            the people who work for them.
          </div>
        )}
        {relations.map((r, i) => {
          const info = relationInfo(r.type);
          return (
            <div key={i} className="relation-row" style={{ borderLeftColor: info.color }}>
              <select value={r.type} onChange={(e) => setRelation(i, { type: e.target.value })}>
                {RELATION_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              <select
                value={r.targetId || ''}
                onChange={(e) => setRelation(i, { targetId: e.target.value })}
              >
                <option value="">— pick someone —</option>
                {others.map((n) => (
                  <option key={n._id} value={n._id}>{labelOf(n)}</option>
                ))}
              </select>
              <input
                className="block-input"
                value={r.text || ''}
                placeholder={info.hint}
                onChange={(e) => setRelation(i, { text: e.target.value })}
              />
              <button className="block-btn" title="Remove" onClick={() => removeRelation(i)}>✕</button>
            </div>
          );
        })}
        <button className="btn" onClick={addRelation}>+ Add relation</button>
      </div>

      <div className="section-label">What do you know about them?</div>
      <textarea
        className="content-area small"
        value={draft.notes || ''}
        placeholder="Appearance, personality, secrets, what they know, favors owed…"
        onChange={(e) => set({ notes: e.target.value })}
      />
    </Modal>
  );
}

// Small inline manager so groups can be renamed or recoloured without a
// separate page — and without window.prompt, which does nothing in a webview.
export function GroupsPanel({ groups, npcs, onCreate, onPatch, onDelete, onClose }) {
  return (
    <div className="groups-panel">
      <div className="modal-head">
        <h3>Groups</h3>
        <button className="block-btn" title="Close" onClick={onClose}>✕</button>
      </div>
      <div className="groups-list">
        {groups.length === 0 && (
          <div className="empty-hint">
            No groups yet — a gang, a noble house, a temple. NPCs you put in one get drawn
            inside a box together.
          </div>
        )}
        {groups.map((g) => (
          <div key={g._id} className="group-row">
            <input
              value={g.name}
              placeholder="Group name"
              onChange={(e) => onPatch(g._id, { name: e.target.value })}
            />
            <div className="group-swatches">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  className={`group-swatch ${g.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  title="Use this colour"
                  onClick={() => onPatch(g._id, { color: c })}
                />
              ))}
            </div>
            <span className="group-count">
              {npcs.filter((n) => n.groupId === g._id).length} in
            </span>
            <button className="block-btn" title="Delete group" onClick={() => onDelete(g._id)}>✕</button>
          </div>
        ))}
      </div>
      <button className="btn primary" onClick={onCreate}>+ New group</button>
    </div>
  );
}
