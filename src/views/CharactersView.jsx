import React, { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../fileio.js';
import { api } from '../api.js';
import { NpcEditor, PlayerEditor, GroupsPanel } from '../components/CharacterEditor.jsx';
import { useZoomShortcuts } from '../lib/useZoomShortcuts.js';
import {
  ALIGNMENT_BANDS,
  GROUP_COLORS,
  alignmentColor,
  bandFor,
  buildRelationEdges,
  clampAlignment,
  computeCharacterLayout,
  computeGroupHulls,
  describeRelation,
  dispositionFor,
  dispositionTag,
  HULL_TITLE_SPACE,
  labelOf,
  normalizeNpc,
  relationInfo,
  relationsOf
} from '../lib/characters.mjs';

const NODE_R = 16;

// Fields the NPC popup owns — listed once so save and create agree.
const NPC_FIELDS = [
  'name', 'descriptor', 'race', 'occupation', 'location', 'firstMet',
  'notes', 'alignment', 'groupId', 'relations'
];
const PLAYER_FIELDS = [
  'characterName', 'playerName', 'race', 'className', 'level', 'description', 'notes'
];

function pick(doc, fields) {
  return Object.fromEntries(fields.map((f) => [f, doc[f]]));
}

// Family-tree elbow: straight down out of the parent, across, then into the
// child. Peers get a plain line instead (see the dashed edges below).
function elbowPath(a, b) {
  const mid = a.y + (b.y - a.y) / 2;
  return `M ${a.x} ${a.y + NODE_R} V ${mid} H ${b.x} V ${b.y - NODE_R}`;
}

function matches(npc, query) {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  return ['name', 'descriptor', 'race', 'occupation', 'location', 'notes'].some((f) =>
    (npc[f] || '').toLowerCase().includes(q)
  );
}

// SVG <text> never wraps or clips itself, so an unusually long name would
// otherwise stretch clear across the canvas over every other node. Same cap
// MapView's own truncateLabel uses for station names.
function truncateLabel(text, max = 28) {
  const t = (text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The tree's root row (depth 0 — bosses, unaffiliated NPCs) lays out at y=0,
// which would sit right behind the toolbar/align-axis bars that float over
// the top of the canvas. Starting the camera panned down clears them.
const DEFAULT_TX = 0;
// A centred label on a node near the layout's left edge can clip against the
// canvas edge under the easy-read/OpenDyslexic fonts, which render wider
// than Quintessential — give it a little more breathing room only then, so
// the fantasy default (where it already fits) is untouched.
function initialTx() {
  const font = typeof document !== 'undefined' ? document.documentElement.dataset.font : null;
  return font === 'easy-read' || font === 'opendyslexic' ? 40 : DEFAULT_TX;
}

export default function CharactersView({ focusId, colorBlind, mapScale = 1, onFocusUsed }) {
  // Computed once per mount (the view remounts on every tab switch, so this
  // still picks up a font style changed in Settings the next time you open it).
  const INITIAL_VIEW = useMemo(() => ({ tx: initialTx(), ty: 130 }), []);
  const [npcs, setNpcs] = useState([]);
  const [players, setPlayers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null); // { kind: 'npc' | 'player', draft }
  const [showGroups, setShowGroups] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [view, setView] = useState({ ...INITIAL_VIEW, scale: 1 });
  const [dragPos, setDragPos] = useState({});
  const drag = useRef(null);
  // Debounce timers for group edits, keyed by group id — see patchGroupLocal.
  const groupSaveTimers = useRef({});
  useEffect(
    () => () => {
      // Flush any pending group renames on unmount (tab switch away) rather
      // than dropping the last few keystrokes.
      for (const [id, t] of Object.entries(groupSaveTimers.current)) {
        clearTimeout(t.timer);
        api.update('groups', id, t.patch).catch(() => {});
      }
    },
    []
  );
  const svgRef = useRef(null);
  const centred = useRef(null);

  const layout = useMemo(() => computeCharacterLayout(npcs, groups), [npcs, groups]);

  // Auto layout, overridden by anything the user has dragged into place.
  const pos = useMemo(() => {
    const out = {};
    for (const npc of npcs) {
      const saved =
        npc.mapX != null && npc.mapY != null ? { x: npc.mapX, y: npc.mapY } : null;
      const p = dragPos[npc._id] || saved || layout.pos[npc._id];
      if (p) out[npc._id] = p;
    }
    return out;
  }, [npcs, layout, dragPos]);

  const hulls = useMemo(
    () => computeGroupHulls(pos, npcs, groups, HULL_TITLE_SPACE * mapScale),
    [pos, npcs, groups, mapScale]
  );
  const edges = useMemo(() => buildRelationEdges(npcs), [npcs]);
  const selected = npcs.find((n) => n._id === selectedId) || null;
  const hitCount = useMemo(
    () => (search.trim() ? npcs.filter((n) => matches(n, search)).length : 0),
    [npcs, search]
  );

  function reload() {
    api.list('npcs').then((docs) => setNpcs(docs.map(normalizeNpc))).catch((e) => setStatus(e.message));
    api.list('players').then(setPlayers).catch((e) => setStatus(e.message));
    api.list('groups').then(setGroups).catch(() => setGroups([]));
  }

  useEffect(reload, []);

  useEffect(() => {
    if (focusId) {
      setSelectedId(focusId);
      onFocusUsed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // Bring a node opened from elsewhere (the map, a search hit) into view once.
  useEffect(() => {
    if (!selectedId || !svgRef.current || centred.current === selectedId) return;
    const p = pos[selectedId];
    if (!p) return;
    centred.current = selectedId;
    const rect = svgRef.current.getBoundingClientRect();
    setView((v) => ({ ...v, tx: rect.width / 2 - p.x * v.scale, ty: rect.height / 2 - p.y * v.scale }));
  }, [selectedId, pos]);

  // ---------- creating & saving ----------

  async function createNpc() {
    try {
      const npc = normalizeNpc(await api.create('npcs', { name: '', descriptor: '' }));
      setNpcs((prev) => [npc, ...prev]);
      setEditing({ kind: 'npc', draft: npc });
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function createPlayer() {
    try {
      const player = await api.create('players', { characterName: 'New character' });
      setPlayers((prev) => [player, ...prev]);
      setEditing({ kind: 'player', draft: player });
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function saveEditing() {
    const { kind, draft } = editing;
    setStatus('Saving…');
    try {
      if (kind === 'npc') {
        const patch = pick(draft, NPC_FIELDS);
        patch.alignment = clampAlignment(patch.alignment);
        // Keep the map's colour-by-disposition working off the same slider.
        patch.disposition = dispositionFor(patch.alignment);
        patch.relations = (patch.relations || []).filter((r) => r.targetId);
        const updated = normalizeNpc(await api.update('npcs', draft._id, patch));
        setNpcs((prev) => prev.map((n) => (n._id === updated._id ? updated : n)));
      } else {
        const updated = await api.update('players', draft._id, pick(draft, PLAYER_FIELDS));
        setPlayers((prev) => prev.map((p) => (p._id === updated._id ? updated : p)));
      }
      setStatus('Saved ✓');
      setEditing(null);
      setTimeout(() => setStatus(''), 1500);
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function deleteEditing() {
    const { kind, draft } = editing;
    const name = kind === 'npc' ? labelOf(draft) : draft.characterName;
    if (!(await confirmDialog(`Delete "${name}"?`, { title: 'Confirm delete', kind: 'warning' }))) return;
    try {
      if (kind === 'npc') {
        await api.remove('npcs', draft._id);
        // Drop relations pointing at the NPC that just went away.
        for (const other of npcs) {
          const kept = (other.relations || []).filter((r) => r.targetId !== draft._id);
          if (kept.length !== (other.relations || []).length) {
            await api.update('npcs', other._id, { relations: kept });
          }
        }
        setSelectedId(null);
        reload();
      } else {
        await api.remove('players', draft._id);
        setPlayers((prev) => prev.filter((p) => p._id !== draft._id));
      }
      setEditing(null);
    } catch (e) {
      setStatus(e.message);
    }
  }

  // ---------- groups ----------

  async function createGroup() {
    const group = await api.create('groups', {
      name: `Group ${groups.length + 1}`,
      color: GROUP_COLORS[groups.length % GROUP_COLORS.length]
    });
    setGroups((prev) => [...prev, group]);
    // Straight from the NPC popup's "New group…": put them in it right away.
    if (editing && editing.kind === 'npc') {
      setEditing({ ...editing, draft: { ...editing.draft, groupId: group._id } });
    }
    return group;
  }

  // The name field saves on every keystroke (no separate Save button in this
  // panel), so debounce it instead of firing a request per character — store.mjs
  // still serializes overlapping writes to the same group, but there's no
  // reason to send one per keystroke in the first place. A colour click is
  // its own single patch call, so it rides along with whatever's pending
  // rather than waiting out a fresh debounce.
  function patchGroupLocal(id, patch) {
    setGroups((prev) => prev.map((g) => (g._id === id ? { ...g, ...patch } : g)));
    const pending = groupSaveTimers.current[id];
    if (pending) clearTimeout(pending.timer);
    const mergedPatch = { ...(pending?.patch || {}), ...patch };
    const timer = setTimeout(() => {
      delete groupSaveTimers.current[id];
      api.update('groups', id, mergedPatch).catch((e) => setStatus(e.message));
    }, 500);
    groupSaveTimers.current[id] = { timer, patch: mergedPatch };
  }

  async function deleteGroup(id) {
    const group = groups.find((g) => g._id === id);
    if (!(await confirmDialog(`Delete the group "${group.name}"? Its NPCs stay, just ungrouped.`,
      { title: 'Confirm delete', kind: 'warning' }))) return;
    // A pending debounced rename must not recreate this group after it's gone.
    const pending = groupSaveTimers.current[id];
    if (pending) {
      clearTimeout(pending.timer);
      delete groupSaveTimers.current[id];
    }
    try {
      await api.remove('groups', id);
      for (const npc of npcs.filter((n) => n.groupId === id)) {
        await api.update('npcs', npc._id, { groupId: '' });
      }
    } catch (e) {
      setStatus(e.message);
    }
    setGroups((prev) => prev.filter((g) => g._id !== id));
    reload();
  }

  async function autoArrange() {
    setStatus('Arranging…');
    setDragPos({});
    try {
      // Position-only — must not bump updatedAt (see api.updateLayout) or a
      // single Auto-arrange would make every NPC show up as "edited" in
      // whichever session happens to be running.
      await Promise.all(
        npcs
          .filter((n) => n.mapX != null || n.mapY != null)
          .map((npc) => api.updateLayout('npcs', npc._id, { mapX: null, mapY: null }))
      );
      setNpcs((prev) => prev.map((n) => ({ ...n, mapX: null, mapY: null })));
      setStatus('Arranged ✓');
    } catch (e) {
      setStatus(e.message);
    }
    setTimeout(() => setStatus(''), 1500);
  }

  // ---------- canvas interaction (pointer events, so it works on touch) ----------

  function toWorld(e) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale
    };
  }

  function onBgPointerDown(e) {
    drag.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, tx0: view.tx, ty0: view.ty };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onNodePointerDown(e, id) {
    e.stopPropagation();
    const w = toWorld(e);
    const p = pos[id];
    drag.current = { mode: 'node', id, offX: p.x - w.x, offY: p.y - w.y, moved: false };
    svgRef.current.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView((v) => ({ ...v, tx: d.tx0 + e.clientX - d.startX, ty: d.ty0 + e.clientY - d.startY }));
    } else {
      const w = toWorld(e);
      d.moved = true;
      // Also kept on the ref: pointerup can land before React has re-rendered
      // with the last move, and reading stale state there loses the drag.
      d.last = { x: w.x + d.offX, y: w.y + d.offY };
      setDragPos((prev) => ({ ...prev, [d.id]: d.last }));
    }
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d || d.mode !== 'node') return;
    if (!d.moved) {
      setSelectedId((cur) => (cur === d.id ? null : d.id));
      return;
    }
    const p = d.last || dragPos[d.id];
    if (!p) return;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    setNpcs((prev) => prev.map((n) => (n._id === d.id ? { ...n, mapX: x, mapY: y } : n)));
    setDragPos((prev) => {
      const next = { ...prev };
      delete next[d.id];
      return next;
    });
    // Position-only — see api.updateLayout: a drag isn't an edit.
    api.updateLayout('npcs', d.id, { mapX: x, mapY: y }).catch((e) => setStatus(e.message));
  }

  function onWheel(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const ns = Math.min(2.5, Math.max(0.3, v.scale * (e.deltaY < 0 ? 1.15 : 0.87)));
      const wx = (mx - v.tx) / v.scale;
      const wy = (my - v.ty) / v.scale;
      return { scale: ns, tx: mx - wx * ns, ty: my - wy * ns };
    });
  }

  useZoomShortcuts(svgRef, setView, { min: 0.3, max: 2.5, initial: INITIAL_VIEW });

  const selectedRelations = selected ? relationsOf(selected, npcs) : [];

  return (
    <div className="characters-page">
      <section className="party-band">
        <div className="party-head">
          <h2>The party</h2>
          <span className="party-hint">who plays who</span>
          <button className="btn primary" onClick={createPlayer}>+ Player</button>
        </div>
        <div className="party-row">
          {players.length === 0 && (
            <div className="empty-hint">
              No player characters yet. Add your party so everyone can see which friend is
              playing which character.
            </div>
          )}
          {players.map((p) => (
            <button
              key={p._id}
              className="party-card"
              onClick={() => setEditing({ kind: 'player', draft: p })}
            >
              <span className="party-player">{p.playerName || 'player?'}</span>
              <span className="party-figure">
                <span className="party-token">🙂</span>
                <span className="party-name">{p.characterName || 'Unnamed'}</span>
                <span className="party-sub">
                  {[p.race, p.className, p.level && `lvl ${p.level}`].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="characters-canvas">
        <svg
          ref={svgRef}
          className="characters-svg"
          onPointerDown={onBgPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <defs>
            <pattern id="chargrid" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle className="grid-dot" cx="1" cy="1" r="1" />
            </pattern>
          </defs>
          <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
            <rect x="-4000" y="-4000" width="8000" height="8000" fill="url(#chargrid)" />
            {/* Boxes are decoration only (pointer-events: none in the CSS) —
                a big one would otherwise swallow every attempt to pan. */}
            {hulls.map((h) => (
              <g key={h._id} className="group-hull">
                <rect x={h.x} y={h.y} width={h.w} height={h.h} rx="28" style={{ stroke: h.color }} />
                <text
                  className="group-hull-label"
                  x={h.x + 16}
                  y={h.y + 20}
                  style={{ fill: `color-mix(in srgb, ${h.color} 45%, var(--text))` }}
                >
                  {truncateLabel(h.name)} · {h.count}
                </text>
              </g>
            ))}

            {edges.map((e, i) => {
              const a = pos[e.from];
              const b = pos[e.to];
              if (!a || !b) return null;
              const info = relationInfo(e.type);
              if (e.dir === 'level') {
                // The CSS class already gives every level edge a uniform dash
                // in the default look (relation-edge.level); colour-blind mode
                // overrides it per type via inline style, which outranks the
                // class rule, so sibling/partner/ally/rival/knows each get
                // their own dash instead of all looking the same.
                return (
                  <line
                    key={i}
                    className="relation-edge level"
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    style={{
                      stroke: info.color,
                      strokeDasharray: colorBlind ? info.dash || 'none' : undefined
                    }}
                  />
                );
              }
              const parent = pos[e.parent];
              const child = pos[e.child];
              if (!parent || !child) return null;
              return (
                <path
                  key={i}
                  className="relation-edge"
                  d={elbowPath(parent, child)}
                  stroke={info.color}
                />
              );
            })}

            {npcs.map((npc) => {
              const p = pos[npc._id];
              if (!p) return null;
              const dim = search.trim() && !matches(npc, search);
              return (
                <g
                  key={npc._id}
                  className={`char-node ${selectedId === npc._id ? 'selected' : ''} ${dim ? 'dim' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={(e) => onNodePointerDown(e, npc._id)}
                >
                  <circle r={NODE_R} fill={alignmentColor(npc.alignment)} />
                  {colorBlind && (
                    <text className="char-node-tag" y="4">{dispositionTag(dispositionFor(npc.alignment))}</text>
                  )}
                  <text className="char-node-label" y={NODE_R + 16}>{truncateLabel(labelOf(npc))}</text>
                  {(npc.occupation || npc.race) && (
                    <text className="char-node-sub" y={NODE_R + 30}>
                      {truncateLabel([npc.race, npc.occupation].filter(Boolean).join(' · '))}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="characters-toolbar">
          <span className="status-text">{status}</span>
          <input
            className="search-input inline"
            placeholder="Search NPCs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search.trim() && (
            <span className="search-count">{hitCount === 1 ? '1 match' : `${hitCount} matches`}</span>
          )}
          <button className="btn primary" onClick={createNpc}>+ NPC</button>
          <button className={`btn ${showGroups ? 'primary' : ''}`} onClick={() => setShowGroups((s) => !s)}>
            ⭕ Groups
          </button>
          <button className="btn" onClick={autoArrange}>Auto-arrange</button>
        </div>

        <div className="align-axis">
          {ALIGNMENT_BANDS.map((b) => (
            <span key={b.label} className="align-axis-band">
              <span className="align-axis-dot" style={{ background: b.color }} />
              {b.label}
            </span>
          ))}
          <span className="align-axis-hint">allies left · enemies right</span>
        </div>

        {npcs.length === 0 && (
          <div className="map-empty">
            No NPCs yet. Add the people your party meets — name them, or just describe them
            ("goblin from the goblin gang"), then link them to each other.
          </div>
        )}

        {showGroups && (
          <GroupsPanel
            groups={groups}
            npcs={npcs}
            onCreate={createGroup}
            onPatch={patchGroupLocal}
            onDelete={deleteGroup}
            onClose={() => setShowGroups(false)}
          />
        )}

        {selected && (
          <div className="map-info char-info">
            <div className="map-info-title">{labelOf(selected)}</div>
            <div className="char-info-badges">
              <span className="badge" style={{ background: bandFor(selected.alignment).color }}>
                {bandFor(selected.alignment).label}
              </span>
              {[selected.race, selected.occupation].filter(Boolean).map((t) => (
                <span key={t} className="badge subtle">{t}</span>
              ))}
              {groups.find((g) => g._id === selected.groupId) && (
                <span
                  className="badge"
                  style={{ background: groups.find((g) => g._id === selected.groupId).color }}
                >
                  {groups.find((g) => g._id === selected.groupId).name}
                </span>
              )}
            </div>
            {selected.location && (
              <div className="map-info-conn"><span className="map-conn-label">Location</span>{selected.location}</div>
            )}
            {selected.firstMet && (
              <div className="map-info-conn"><span className="map-conn-label">First met</span>{selected.firstMet}</div>
            )}
            {selectedRelations.length > 0 && (
              <>
                <div className="map-info-npcs-title">Relations</div>
                {selectedRelations.map((r, i) => (
                  <button
                    key={i}
                    className="map-note-row in-card"
                    onClick={() => setSelectedId(r.target._id)}
                  >
                    <span className="map-note-title">
                      <span
                        className="map-npc-dot"
                        style={{ background: relationInfo(r.type).color }}
                      />
                      {r.incoming
                        ? `${labelOf(r.target)} — ${describeRelation(r, 'them').toLowerCase()}`
                        : describeRelation(r, labelOf(r.target))}
                    </span>
                  </button>
                ))}
              </>
            )}
            {selected.notes && <p className="map-info-desc">{selected.notes}</p>}
            <div className="map-info-actions">
              <button
                className="btn primary"
                onClick={() => setEditing({ kind: 'npc', draft: selected })}
              >
                Edit
              </button>
              <button className="btn" onClick={() => setSelectedId(null)}>Close</button>
            </div>
          </div>
        )}

        <div className="map-hint">
          Click a node to see what you know · drag to rearrange · scroll or Ctrl +/− to zoom ·
          drag the background to pan
        </div>
      </section>

      {editing && editing.kind === 'npc' && (
        <NpcEditor
          draft={editing.draft}
          npcs={npcs}
          groups={groups}
          status={status}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={saveEditing}
          onDelete={deleteEditing}
          onClose={() => setEditing(null)}
          onCreateGroup={createGroup}
        />
      )}
      {editing && editing.kind === 'player' && (
        <PlayerEditor
          draft={editing.draft}
          status={status}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={saveEditing}
          onDelete={deleteEditing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
