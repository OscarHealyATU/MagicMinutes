import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CONNECTION_TYPES } from './PlacesView.jsx';
import { DISPOSITION_COLORS, labelOf } from '../lib/characters.mjs';
import {
  buildContainment,
  buildEdges,
  clampRectInRect,
  clampPointToLobes,
  descendantsOf,
  labelInset,
  layoutZones,
  LOBE_DEFAULTS,
  lobesAttachPoint,
  lobesPath,
  packLayout,
  pushRectClear,
  stationFootprint,
  TEXT_METRICS
} from '../lib/mapZones.mjs';
import { useZoomShortcuts } from '../lib/useZoomShortcuts.js';

const GRID = 40;
// Shared geometry so a freshly auto-arranged zone's saved size matches what
// zoneRects would compute anyway — no extra "grow" pass needed right after.
const ZONE_GEOMETRY = { pad: 36, labelHeadroom: 28, minW: 120, minH: 80 };
// Sibling zones (same parent, or both at the root) are kept at least this far
// apart — by packLayout when auto-arranging, and by the drag/resize handlers.
const ZONE_GAP = 32;
const PACK_OPTS = { ...ZONE_GEOMETRY, gridX: 120, gridY: 90, perRow: 3, zoneGap: ZONE_GAP };
const RESIZE_HANDLE = 12;

const connInfo = (id) =>
  CONNECTION_TYPES.find((t) => t.id === id) || CONNECTION_TYPES[CONNECTION_TYPES.length - 1];

// `inside` / `contains` blocks are drawn as zones (see mapZones.mjs), not as
// lines — everything else on the tube map is still a coloured line.
const isContainmentType = (type) => type === 'inside' || type === 'contains';

// Simple force layout for stations without a saved position, snapped to the
// grid. `containment` (from buildContainment) additionally seeds a place
// with no saved position next to its parent instead of the global circle,
// and nudges the simulation so children drift toward their parent while
// unrelated stations drift away from other zones' centres.
function computeLayout(places, edges, containment, ignoreSaved = false) {
  const ids = places.map((p) => p._id);
  const pos = {};
  const free = new Set();
  const parentOf = (containment && containment.parentOf) || {};
  const childrenOf = (containment && containment.childrenOf) || {};

  places.forEach((p) => {
    if (!ignoreSaved && p.mapX != null && p.mapY != null) {
      pos[p._id] = { x: p.mapX, y: p.mapY };
    } else {
      free.add(p._id);
    }
  });

  // Seed free places next to their parent when the parent already has a
  // position — as many passes as there are places, so a containment chain
  // of any depth fully propagates (a grandchild picks up a parent that was
  // itself only just seeded this way, and so on down the chain).
  const seedPasses = Math.max(1, ids.length);
  for (let pass = 0; pass < seedPasses; pass++) {
    for (const id of ids) {
      if (pos[id] || !free.has(id)) continue;
      const parentPos = pos[parentOf[id]];
      if (parentPos) {
        pos[id] = {
          x: parentPos.x + (Math.random() - 0.5) * 90,
          y: parentPos.y + (Math.random() - 0.5) * 90
        };
      }
    }
  }

  // Anything left with no placeable parent falls back to the original ring.
  places.forEach((p, i) => {
    if (pos[p._id]) return;
    const angle = (2 * Math.PI * i) / Math.max(places.length, 1);
    pos[p._id] = {
      x: 460 + 230 * Math.cos(angle) + (i % 3) * 15,
      y: 320 + 230 * Math.sin(angle)
    };
  });

  // Zone membership (self + every descendant), computed once up front for
  // the weak "stay out of other zones" push below.
  const zoneMembers = Object.keys(childrenOf).map((parentId) => ({
    parentId,
    members: new Set([parentId, ...descendantsOf(parentId, childrenOf)])
  }));

  for (let iter = 0; iter < 160; iter++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos[ids[i]];
        const b = pos[ids[j]];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < 150) {
          const push = ((150 - d) / d) * 0.5;
          if (free.has(ids[j])) { b.x += dx * push; b.y += dy * push; }
          if (free.has(ids[i])) { a.x -= dx * push; a.y -= dy * push; }
        }
      }
    }
    for (const e of edges) {
      const a = pos[e.a];
      const b = pos[e.b];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 140) / d) * 0.08;
      if (free.has(e.b)) { b.x -= dx * f; b.y -= dy * f; }
      if (free.has(e.a)) { a.x += dx * f; a.y += dy * f; }
    }
    // Gentle pull of each child toward its parent's current position.
    for (const id of ids) {
      if (!free.has(id)) continue;
      const parentPos = pos[parentOf[id]];
      const p = pos[id];
      if (!parentPos) continue;
      p.x += (parentPos.x - p.x) * 0.02;
      p.y += (parentPos.y - p.y) * 0.02;
    }
    // Weak push of non-members away from a zone's centroid, so unrelated
    // stations tend not to sit inside someone else's blob.
    for (const { members } of zoneMembers) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const id of members) {
        const p = pos[id];
        if (!p) continue;
        cx += p.x; cy += p.y; n++;
      }
      if (!n) continue;
      cx /= n; cy /= n;
      for (const id of ids) {
        if (members.has(id) || !free.has(id)) continue;
        const p = pos[id];
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < 120) {
          const push = ((120 - d) / d) * 0.03;
          p.x += dx * push;
          p.y += dy * push;
        }
      }
    }
  }

  for (const id of free) {
    pos[id].x = Math.round(pos[id].x / GRID) * GRID;
    pos[id].y = Math.round(pos[id].y / GRID) * GRID;
  }
  return pos;
}

// Match NPCs to the stations they're from via their free-text location field,
// using the same name matching as the tube lines.
function matchNpcsToPlaces(npcs, places) {
  const byLength = [...places].sort(
    (a, b) => (b.name || '').length - (a.name || '').length
  );
  const map = {};
  for (const npc of npcs) {
    let text = (npc.location || '').toLowerCase();
    if (!text) continue;
    for (const pl of byLength) {
      const name = (pl.name || '').trim().toLowerCase();
      if (name.length < 3 || !text.includes(name)) continue;
      text = text.split(name).join('§');
      (map[pl._id] = map[pl._id] || []).push(npc);
    }
  }
  return map;
}

// Pin notes to stations named in their place field or mentioned in their
// title, tags, or content; notes matching no documented place are "unplaced".
function matchNotesToPlaces(notes, places) {
  const byLength = [...places].sort(
    (a, b) => (b.name || '').length - (a.name || '').length
  );
  const byPlace = {};
  const unplaced = [];
  for (const note of notes) {
    let text = `${note.place || ''} ${note.title || ''} ${(note.tags || []).join(' ')} ${note.content || ''}`.toLowerCase();
    let matched = false;
    for (const pl of byLength) {
      const name = (pl.name || '').trim().toLowerCase();
      if (name.length < 3 || !text.includes(name)) continue;
      text = text.split(name).join('§');
      (byPlace[pl._id] = byPlace[pl._id] || []).push(note);
      matched = true;
    }
    if (!matched) unplaced.push(note);
  }
  return { byPlace, unplaced };
}

function ageOf(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

// Whether two rects overlap or come within `gap` of each other.
function rectsNear(a, b, gap) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// Note/NPC count badges shown under a stop's or zone's label — details live
// in the info card, this is just "there's something here" at a glance.
function badgesFor(id, noteMatch, npcsByPlace, showNotes, showNpcs) {
  const notesHere = showNotes ? noteMatch.byPlace[id] || [] : [];
  const npcsHere = showNpcs ? npcsByPlace[id] || [] : [];
  return [
    notesHere.length > 0 && { icon: '📜', count: notesHere.length },
    npcsHere.length > 0 && { icon: '🧙', count: npcsHere.length }
  ].filter(Boolean);
}

// The old map's under-station note/NPC listing, brought back alongside the
// badges above: a short, read-only preview of what the badges are counting.
const MAX_LIST_NOTES = 4;
const MAX_LIST_NPCS = 4;
const LIST_LINE_HEIGHT = 13;

function truncateLabel(text, max = 28) {
  const t = (text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Same source lists the badge popup uses (and in the same order), just capped
// short here — the popup is still where you go to see everything.
function noteNpcListFor(id, noteMatch, npcsByPlace, showNotes, showNpcs) {
  const allNotes = showNotes ? noteMatch.byPlace[id] || [] : [];
  const allNpcs = showNpcs ? npcsByPlace[id] || [] : [];
  const notes = allNotes.slice(0, MAX_LIST_NOTES);
  const npcs = allNpcs.slice(0, MAX_LIST_NPCS);
  const hidden = (allNotes.length - notes.length) + (allNpcs.length - npcs.length);
  return { notes, npcs, hidden };
}

// How far a station's own name/badges/list reach right and down from its
// point — same lists `noteNpcListFor`/`NoteNpcList` use, so the footprint
// always matches what's actually drawn. Feeds `zoneRects`/`packLayout`'s
// `footprintOf` and the drag clamps, so a zone rect always has room for its
// members' text and a dragged station never overlaps its own zone's edge.
function footprintFor(id, place, noteMatch, npcsByPlace, showNotes, showNpcs) {
  const { notes, npcs, hidden } = noteNpcListFor(id, noteMatch, npcsByPlace, showNotes, showNpcs);
  return stationFootprint(
    {
      noteLines: notes.map((n) => truncateLabel(n.title || 'Untitled')),
      npcLines: npcs.map((npc) => truncateLabel(labelOf(npc))),
      hasMore: hidden > 0,
      nameLength: (place?.name || '').length
    },
    TEXT_METRICS
  );
}

// A zone's own header — the space its label/badges/list reserve at the top
// of its rect — sized the same way a station's footprint is, just without a
// name-width term (the label always starts flush at the zone's left edge).
function headerHeightFor(id, noteMatch, npcsByPlace, showNotes, showNpcs) {
  const { notes, npcs, hidden } = noteNpcListFor(id, noteMatch, npcsByPlace, showNotes, showNpcs);
  const lineCount = notes.length + npcs.length + (hidden > 0 ? 1 : 0);
  const hasBadges = notes.length > 0 || npcs.length > 0;
  return 30 + (hasBadges ? 20 : 0) + LIST_LINE_HEIGHT * lineCount + 8;
}

// How much straight top edge a zone's header needs, so its octagon can be
// sized to fit it. The header starts at the top-left cut, and the diagonal
// moves out 1px per pixel down, so each row gets back roughly twice its depth:
// the name (~10px down) little, the badges (~34px) more, the list (~49px) most.
function headerWidthFor(id, place, noteMatch, npcsByPlace, showNotes, showNpcs) {
  const { notes, npcs, hidden } = noteNpcListFor(id, noteMatch, npcsByPlace, showNotes, showNpcs);
  const nameW = (place?.name || '').length * 11 + 8;
  const badgesW = ((notes.length > 0 ? 1 : 0) + (npcs.length > 0 ? 1 : 0)) * 46;
  const listW = notes.length + npcs.length > 0
    ? stationFootprint(
        {
          noteLines: notes.map((n) => truncateLabel(n.title || 'Untitled')),
          npcLines: npcs.map((npc) => truncateLabel(labelOf(npc))),
          hasMore: hidden > 0
        },
        TEXT_METRICS
      ).right
    : 0;
  return Math.max(0, nameW - 10, badgesW - 34, listW - 49);
}

// Renders that capped list as a column of SVG text under a station/zone's
// badge row. `pointer-events: none` (see .map-station-list) keeps it from
// ever intercepting a drag or a badge click.
function NoteNpcList({ id, x, y, noteMatch, npcsByPlace, showNotes, showNpcs }) {
  const { notes, npcs, hidden } = noteNpcListFor(id, noteMatch, npcsByPlace, showNotes, showNpcs);
  if (notes.length === 0 && npcs.length === 0) return null;
  let line = 0;
  return (
    <g className="map-station-list" transform={`translate(${x},${y})`}>
      {notes.map((n) => {
        const ty = LIST_LINE_HEIGHT * line++;
        return (
          <text key={`n-${n._id}`} className="map-list-note" x="0" y={ty}>
            {`📜 ${truncateLabel(n.title || 'Untitled')}`}
          </text>
        );
      })}
      {npcs.map((npc) => {
        const ty = LIST_LINE_HEIGHT * line++;
        return (
          <g key={`p-${npc._id}`} transform={`translate(0,${ty - 4})`}>
            <circle
              className="map-list-npc-dot"
              cx="3"
              cy="0"
              r="3"
              style={{ fill: DISPOSITION_COLORS[npc.disposition] || 'var(--text-dim)' }}
            />
            <text className="map-list-npc" x="10" y="4">{truncateLabel(labelOf(npc))}</text>
          </g>
        );
      })}
      {hidden > 0 && (
        <text className="map-list-more" x="0" y={LIST_LINE_HEIGHT * line}>{`+${hidden} more…`}</text>
      )}
    </g>
  );
}

// Tube-style path: 45° diagonal first, then straight to the destination
function tubePath(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  const mx = a.x + Math.sign(dx) * d;
  const my = a.y + Math.sign(dy) * d;
  return `M ${a.x} ${a.y} L ${mx} ${my} L ${b.x} ${b.y}`;
}

export default function MapView({ onOpenPlace, onOpenNote, onOpenNpc }) {
  const [places, setPlaces] = useState([]);
  const [npcs, setNpcs] = useState([]);
  const [notes, setNotes] = useState([]);
  const [showNpcs, setShowNpcs] = useState(true);
  const [showNotes, setShowNotes] = useState(true);
  const [newestFirst, setNewestFirst] = useState(false);
  const [pos, setPos] = useState({});
  // Zone width/height, keyed by place id — the size counterpart to `pos`
  // (which doubles as a zone's top-left). Lives locally the same way `pos`
  // does: seeded from the doc's mapW/mapH, updated live while resizing, and
  // persisted on drop without waiting for a refetch.
  const [sizes, setSizes] = useState({});
  const [view, setView] = useState({ tx: 40, ty: 20, scale: 1 });
  const [selectedId, setSelectedId] = useState(null);
  const [status, setStatus] = useState('');
  const drag = useRef(null);
  const svgRef = useRef(null);
  // What's in the database for each place's mapX/mapY, so moves the layout
  // makes by itself (an inner zone re-centred in its lobe, a place nudged
  // back into its band) can be saved after a drag without re-saving everything.
  const savedPosRef = useRef(new Map());
  const needsSaveRef = useRef(false);
  // Bumped when a drag ends, so the save effect runs even if the drop itself
  // changed nothing that re-renders (a resize's size was already set live).
  const [saveTick, setSaveTick] = useState(0);

  const edges = useMemo(() => buildEdges(places), [places]);

  // `inside` / `contains` become zones (drawn as nested rounded rects), not lines.
  const lineEdges = useMemo(() => edges.filter((e) => !isContainmentType(e.type)), [edges]);

  const containment = useMemo(() => buildContainment(places, edges), [places, edges]);

  // `places` merged with the locally-known zone sizes, so zoneRects sees a
  // resize in progress immediately without waiting on the server round-trip.
  const placesWithSizes = useMemo(
    () =>
      places.map((p) =>
        sizes[p._id] ? { ...p, mapW: sizes[p._id].w, mapH: sizes[p._id].h, mapLobes: sizes[p._id].lobes } : p
      ),
    [places, sizes]
  );

  const placeById = useMemo(() => new Map(places.map((p) => [p._id, p])), [places]);

  const npcsByPlace = useMemo(() => matchNpcsToPlaces(npcs, places), [npcs, places]);

  const noteMatch = useMemo(() => matchNotesToPlaces(notes, places), [notes, places]);

  // Every place's text footprint (right/down reach) and every zone's header
  // height, kept as id -> value maps so zoneRects/packLayout/the drag clamps
  // can all look them up by id via a plain function.
  const footprintById = useMemo(() => {
    const m = new Map();
    for (const p of places) m.set(p._id, footprintFor(p._id, p, noteMatch, npcsByPlace, showNotes, showNpcs));
    return m;
  }, [places, noteMatch, npcsByPlace, showNotes, showNpcs]);

  const headerById = useMemo(() => {
    const m = new Map();
    for (const p of places) m.set(p._id, headerHeightFor(p._id, noteMatch, npcsByPlace, showNotes, showNpcs));
    return m;
  }, [places, noteMatch, npcsByPlace, showNotes, showNpcs]);

  const headerWidthById = useMemo(() => {
    const m = new Map();
    for (const p of places) m.set(p._id, headerWidthFor(p._id, p, noteMatch, npcsByPlace, showNotes, showNpcs));
    return m;
  }, [places, noteMatch, npcsByPlace, showNotes, showNpcs]);

  // Zones plus the positions everything is actually drawn at: lobed zones
  // move their inner zones (and those zones' contents) to the lobe centres,
  // so render and drag from `layoutPos`, not the raw `pos` state.
  const layout = useMemo(
    () =>
      layoutZones(placesWithSizes, pos, containment, {
        ...ZONE_GEOMETRY,
        footprintOf: (id) => footprintById.get(id),
        headerOf: (id) => headerById.get(id),
        headerWidthOf: (id) => headerWidthById.get(id)
      }),
    [placesWithSizes, pos, containment, footprintById, headerById, headerWidthById]
  );
  const zones = layout.zones;
  const layoutPos = layout.positions;

  // After a drag, save any position the layout moved on its own. Rounded, so
  // the sub-pixel re-centring that follows a save doesn't trigger another one.
  useEffect(() => {
    if (!needsSaveRef.current || drag.current) return;
    needsSaveRef.current = false;
    const writes = [];
    for (const p of places) {
      const lp = layoutPos[p._id];
      if (!lp || !Number.isFinite(lp.x) || !Number.isFinite(lp.y)) continue;
      const x = Math.round(lp.x);
      const y = Math.round(lp.y);
      const saved = savedPosRef.current.get(p._id);
      if (saved && saved.x === x && saved.y === y) continue;
      savedPosRef.current.set(p._id, { x, y });
      // A zone's top-left and size only describe the same rect together.
      const size = sizes[p._id];
      const patch = size
        ? { mapX: x, mapY: y, mapW: Math.round(size.w), mapH: Math.round(size.h), mapLobes: size.lobes ?? null }
        : { mapX: x, mapY: y };
      writes.push(api.update('places', p._id, patch));
    }
    if (writes.length) Promise.all(writes).catch((e) => setStatus(e.message));
  }, [layoutPos, places, sizes, saveTick]);

  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  const unplacedNotes = useMemo(
    () =>
      [...noteMatch.unplaced].sort((a, b) =>
        newestFirst
          ? new Date(b.createdAt) - new Date(a.createdAt)
          : new Date(a.createdAt) - new Date(b.createdAt)
      ),
    [noteMatch, newestFirst]
  );

  const degree = useMemo(() => {
    const d = {};
    for (const e of lineEdges) {
      d[e.a] = (d[e.a] || 0) + 1;
      d[e.b] = (d[e.b] || 0) + 1;
    }
    return d;
  }, [lineEdges]);

  const legendTypes = useMemo(
    () => [...new Set(lineEdges.map((e) => e.type))].map(connInfo),
    [lineEdges]
  );

  const selected = places.find((p) => p._id === selectedId) || null;

  useEffect(() => {
    // Places, NPCs and notes are fetched together (rather than places alone)
    // so the very first layout pass — before any Auto-arrange — can already
    // size a freshly-seeded stop's packing cell from its real note/NPC list
    // instead of a name-only guess. allSettled so one failing list (e.g. no
    // notes yet) doesn't block the places load.
    Promise.allSettled([api.list('places'), api.list('npcs'), api.list('notes')]).then(
      ([placesRes, npcsRes, notesRes]) => {
        if (placesRes.status === 'rejected') {
          setStatus(placesRes.reason?.message || 'Failed to load places');
          return;
        }
        const docs = placesRes.value;
        const npcDocs = npcsRes.status === 'fulfilled' ? npcsRes.value : [];
        const noteDocs = notesRes.status === 'fulfilled' ? notesRes.value : [];
        setPlaces(docs);
        setNpcs(npcDocs);
        setNotes(noteDocs);

        const docEdges = buildEdges(docs);
        const docContainment = buildContainment(docs, docEdges);
        const layout = computeLayout(docs, docEdges, docContainment);
        const docNoteMatch = matchNotesToPlaces(noteDocs, docs);
        const docNpcsByPlace = matchNpcsToPlaces(npcDocs, docs);
        const docById = new Map(docs.map((p) => [p._id, p]));
        // computeLayout seeds an unpositioned place next to its parent with a
        // random jitter, which is fine for a stray root stop but looks messy
        // for one that belongs to a zone — use the tidy packed grid position
        // for those instead. Root-level stops keep computeLayout's spread.
        const packed = packLayout(docs, docContainment, {
          ...PACK_OPTS,
          footprintOf: (id) => footprintFor(id, docById.get(id), docNoteMatch, docNpcsByPlace, true, true),
          headerOf: (id) => headerHeightFor(id, docNoteMatch, docNpcsByPlace, true, true),
          headerWidthOf: (id) => headerWidthFor(id, docById.get(id), docNoteMatch, docNpcsByPlace, true, true)
        }).positions;
        docs.forEach((p) => {
          if ((p.mapX == null || p.mapY == null) && docContainment.parentOf[p._id]) {
            layout[p._id] = packed[p._id] || layout[p._id];
          }
        });
        savedPosRef.current = new Map(
          docs.filter((p) => p.mapX != null && p.mapY != null).map((p) => [p._id, { x: p.mapX, y: p.mapY }])
        );
        setPos(layout);
        setSizes(
          Object.fromEntries(
            docs
              .filter((p) => p.mapW != null && p.mapH != null)
              .map((p) => [p._id, { w: p.mapW, h: p.mapH, lobes: p.mapLobes }])
          )
        );
      }
    );
  }, []);

  useZoomShortcuts(svgRef, setView, { min: 0.3, max: 3, initial: { tx: 40, ty: 20 } });

  // Keep a dragged place inside its zone's octagon (or, in joined octagons,
  // the band around the inner zones), clear of the zone's header.
  function clampStop(point, d) {
    if (!d.lobes) return point;
    return clampPointToLobes(point, d.footprint, d.lobes, d.obstacles, d.margin);
  }

  async function rearrange() {
    const packOpts = {
      ...PACK_OPTS,
      footprintOf: (id) => footprintById.get(id),
      headerOf: (id) => headerById.get(id),
      headerWidthOf: (id) => headerWidthById.get(id)
    };
    const { positions, sizes: newSizes } = packLayout(places, containment, packOpts);
    setPos(positions);
    setSizes(newSizes);
    for (const p of places) {
      const pt = positions[p._id];
      if (pt) savedPosRef.current.set(p._id, { x: Math.round(pt.x), y: Math.round(pt.y) });
    }
    setStatus('Arranging…');
    try {
      await Promise.all(
        places.map((p) => {
          const pt = positions[p._id];
          if (!pt) return null;
          const patch = { mapX: Math.round(pt.x), mapY: Math.round(pt.y) };
          if (newSizes[p._id]) {
            patch.mapW = Math.round(newSizes[p._id].w);
            patch.mapLobes = newSizes[p._id].lobes ?? null;
            patch.mapH = Math.round(newSizes[p._id].h);
          }
          return api.update('places', p._id, patch);
        })
      );
      setStatus('Layout saved ✓');
    } catch (e) {
      setStatus(e.message);
    }
    setTimeout(() => setStatus(''), 1500);
  }

  function screenToWorld(e) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale
    };
  }

  function onBgMouseDown(e) {
    drag.current = { mode: 'pan', startX: e.clientX, startY: e.clientY, tx0: view.tx, ty0: view.ty };
  }

  // Pin the drawn positions into state before any drag, so the drag's edits
  // and the layout's own moves are in the same coordinates.
  function commitLayoutPositions() {
    setPos(layoutPos);
  }

  // Saved with a zone's size so the size is only reused for the same shape.
  function lobeCount(zone) {
    return zone.lobed ? zone.lobes.length : null;
  }

  function onNodeMouseDown(e, id) {
    e.stopPropagation();
    commitLayoutPositions();
    const w = screenToWorld(e);
    // Snapshot the parent zone's rect once, up front — recomputing it live
    // during the drag would let the zone's own grow-to-fit-contents rule
    // chase the stop being dragged, so the "wall" would never actually stop it.
    const parentId = containment.parentOf[id];
    const parentZone = parentId ? zoneById.get(parentId) : null;
    // Hold a plain zone's octagon where it is for the drag: otherwise it's
    // re-sized from its contents as the place moves (and re-centred, inside
    // joined octagons), sliding the place away from the cursor.
    const holdZone = !!(parentZone && !parentZone.lobed);
    if (holdZone) commitZoneRect(parentZone);
    drag.current = {
      mode: 'node',
      id,
      offX: layoutPos[id].x - w.x,
      offY: layoutPos[id].y - w.y,
      lobes: parentZone ? parentZone.lobes : null,
      obstacles: parentZone ? parentZone.stationObstacles : null,
      margin: parentZone ? parentZone.stationMargin : 0,
      footprint: footprintById.get(id) || { right: 0, down: 0 },
      heldZoneId: holdZone ? parentZone.id : null,
      moved: false
    };
  }

  // Before a zone (with no saved size yet) has ever been dragged or resized,
  // its rect is derived purely from its contents' bounding box — `pos[id]`
  // is just a leftover seed point, not necessarily the rect's top-left (e.g.
  // a childless zone's rect is centred on that seed, not anchored to it).
  // The instant the user grabs the zone, pin `pos`/`sizes` to exactly the
  // rect that's on screen right now, so the drag's own before/after math
  // (which works purely in rect-top-left terms) has no gap to jump across.
  function commitZoneRect(zone) {
    setPos((p) => ({ ...p, [zone.id]: { x: zone.rect.x, y: zone.rect.y } }));
    setSizes((s) => ({ ...s, [zone.id]: { w: zone.rect.w, h: zone.rect.h, lobes: lobeCount(zone) } }));
  }

  // Rects of the zones that share this zone's parent (or are root zones
  // alongside it) — the ones it must stay ZONE_GAP clear of.
  function siblingZoneRects(zoneId) {
    const parentId = containment.parentOf[zoneId];
    return zones
      .filter((z) => z.id !== zoneId && containment.parentOf[z.id] === parentId)
      .map((z) => z.rect);
  }

  // An inner zone of a lobed zone is pinned to its lobe, so grabbing it
  // moves the lobed zone instead (all the way up, if that one is pinned too).
  function dragTargetFor(zone) {
    let z = zone;
    for (;;) {
      const parentId = containment.parentOf[z.id];
      const parent = parentId ? zoneById.get(parentId) : null;
      if (!parent || !parent.lobed) return z;
      z = parent;
    }
  }

  function onZoneMouseDown(e, clicked) {
    e.stopPropagation();
    const zone = dragTargetFor(clicked);
    commitLayoutPositions();
    commitZoneRect(zone);
    const w = screenToWorld(e);
    const parentId = containment.parentOf[zone.id];
    const parentZone = parentId ? zoneById.get(parentId) : null;
    const descendantIds = [...descendantsOf(zone.id, containment.childrenOf)];
    const startPositions = new Map(descendantIds.map((id) => [id, layoutPos[id]]).filter(([, p]) => p));
    drag.current = {
      mode: 'zone',
      id: zone.id,
      clickedId: clicked.id,
      siblingRects: siblingZoneRects(zone.id),
      startRectX: zone.rect.x,
      startRectY: zone.rect.y,
      rectW: zone.rect.w,
      rectH: zone.rect.h,
      startMouseX: w.x,
      startMouseY: w.y,
      parentRect: parentZone ? parentZone.rect : null,
      parentHeader: parentZone ? headerById.get(parentZone.id) : undefined,
      descendantIds,
      startPositions,
      moved: false
    };
  }

  // Zones scale evenly about their centre and never stretch: the handle sets
  // one scale, and a zone of joined octagons keeps its columns:rows shape.
  function onZoneResizeMouseDown(e, zone) {
    e.stopPropagation();
    commitLayoutPositions();
    commitZoneRect(zone);
    const w = screenToWorld(e);
    const parentId = containment.parentOf[zone.id];
    const parentZone = parentId ? zoneById.get(parentId) : null;
    const { cols, rows } = zone.grid;
    const r = zone.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    // An inner zone of joined octagons stays centred in its lobe, and the
    // lobes grow around it, so nothing limits it here.
    const inLobes = !!(parentZone && parentZone.lobed);
    // Free room on each side before the parent's padding or a sibling zone.
    const room = { left: Infinity, right: Infinity, up: Infinity, down: Infinity };
    if (!inLobes) {
      if (parentZone) {
        const p = parentZone.rect;
        const top = p.y + ZONE_GEOMETRY.pad + (headerById.get(parentZone.id) ?? ZONE_GEOMETRY.labelHeadroom);
        room.left = r.x - (p.x + ZONE_GEOMETRY.pad);
        room.right = p.x + p.w - ZONE_GEOMETRY.pad - (r.x + r.w);
        room.up = r.y - top;
        room.down = p.y + p.h - ZONE_GEOMETRY.pad - (r.y + r.h);
      }
      for (const o of siblingZoneRects(zone.id)) {
        if (o.y - ZONE_GAP < r.y + r.h && o.y + o.h + ZONE_GAP > r.y) {
          if (o.x >= cx) room.right = Math.min(room.right, o.x - ZONE_GAP - (r.x + r.w));
          else room.left = Math.min(room.left, r.x - (o.x + o.w + ZONE_GAP));
        }
        if (o.x - ZONE_GAP < r.x + r.w && o.x + o.w + ZONE_GAP > r.x) {
          if (o.y >= cy) room.down = Math.min(room.down, o.y - ZONE_GAP - (r.y + r.h));
          else room.up = Math.min(room.up, r.y - (o.y + o.h + ZONE_GAP));
        }
      }
      for (const k of Object.keys(room)) room[k] = Math.max(0, room[k]);
    }
    const startScale = r.w / cols;
    // Its contents set the floor, but never above its current size, so
    // grabbing the handle can't make it jump bigger.
    const minScale = Math.min(startScale, Math.max(zone.minSize.w / cols, zone.minSize.h / rows));
    const siblings = inLobes ? [] : siblingZoneRects(zone.id);
    // Never below where it already is: a zone that already overlaps a
    // neighbour can still be made smaller or left alone.
    const maxScale = Math.max(
      startScale,
      Math.min((r.w + room.left + room.right) / cols, (r.h + room.up + room.down) / rows)
    );
    drag.current = {
      mode: 'resize',
      id: zone.id,
      cols,
      rows,
      cx,
      cy,
      inLobes,
      start: { x: r.x, y: r.y, w: r.w, h: r.h },
      room,
      // Growing both ways can also reach a sibling off at a diagonal; any
      // sibling not already too close when the resize started is a wall.
      walls: siblings.filter((o) => !rectsNear({ x: r.x, y: r.y, w: r.w, h: r.h }, o, ZONE_GAP)),
      minScale,
      maxScale,
      // How far the grab point is from the rect's bottom-right corner.
      cornerOffX: r.x + r.w - w.x,
      cornerOffY: r.y + r.h - w.y,
      moved: false
    };
  }

  function onMouseMove(e) {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView((v) => ({ ...v, tx: d.tx0 + e.clientX - d.startX, ty: d.ty0 + e.clientY - d.startY }));
    } else if (d.mode === 'node') {
      const w = screenToWorld(e);
      d.moved = true;
      const next = clampStop({ x: w.x + d.offX, y: w.y + d.offY }, d);
      setPos((p) => ({ ...p, [d.id]: next }));
    } else if (d.mode === 'zone') {
      const w = screenToWorld(e);
      d.moved = true;
      const rawX = d.startRectX + (w.x - d.startMouseX);
      const rawY = d.startRectY + (w.y - d.startMouseY);
      let x = rawX;
      let y = rawY;
      const clampToParent = (r) =>
        d.parentRect
          ? clampRectInRect(
              r,
              d.parentRect,
              ZONE_GEOMETRY.pad,
              ZONE_GEOMETRY.pad + (d.parentHeader ?? ZONE_GEOMETRY.labelHeadroom)
            )
          : r;
      // Stay inside the parent, then slide clear of sibling zones; being
      // pushed by a sibling can nudge it back against the parent's edge, so
      // go round once more and let the parent bound have the final say.
      let r = clampToParent({ x: rawX, y: rawY, w: d.rectW, h: d.rectH });
      if (d.siblingRects.length) {
        r = clampToParent(pushRectClear(r, d.siblingRects, ZONE_GAP));
      }
      x = r.x;
      y = r.y;
      const dx = x - d.startRectX;
      const dy = y - d.startRectY;
      setPos((prev) => {
        const next = { ...prev, [d.id]: { x, y } };
        for (const [descId, startP] of d.startPositions) {
          next[descId] = { x: startP.x + dx, y: startP.y + dy };
        }
        return next;
      });
    } else if (d.mode === 'resize') {
      const w = screenToWorld(e);
      // Put the zone's corner under the cursor. An inner zone's centre can
      // move as its lobes grow, so it's read live; anyone else's stays put.
      const live = d.inLobes ? zoneById.get(d.id) : null;
      const cx = live ? live.rect.x + live.rect.w / 2 : d.cx;
      const cy = live ? live.rect.y + live.rect.h / 2 : d.cy;
      const want = Math.max(
        (2 * (w.x + d.cornerOffX - cx)) / d.cols,
        (2 * (w.y + d.cornerOffY - cy)) / d.rows
      );
      // What's inside wins over the neighbours: a zone always holds its contents.
      const scale = Math.max(d.minScale, Math.min(d.maxScale, want));
      const newW = scale * d.cols;
      const newH = scale * d.rows;
      if (!d.inLobes) {
        // Grow evenly on both sides where there's room; when one side is
        // blocked, the rest of the growth goes to the other side.
        const spread = (grow, before, after) => {
          if (grow <= 0) return grow / 2;
          let b = Math.min(grow / 2, before);
          const a = Math.min(grow - b, after);
          b = Math.min(grow - a, before);
          return b;
        };
        const x = d.start.x - spread(newW - d.start.w, d.room.left, d.room.right);
        const y = d.start.y - spread(newH - d.start.h, d.room.up, d.room.down);
        if (d.walls.some((o) => rectsNear({ x, y, w: newW, h: newH }, o, ZONE_GAP))) return;
        setPos((p) => ({ ...p, [d.id]: { x, y } }));
      }
      d.moved = true;
      setSizes((s) => ({ ...s, [d.id]: { ...s[d.id], w: newW, h: newH } }));
    }
  }

  function onMouseUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'node') {
      if (!d.moved) {
        setSelectedId(d.id === selectedId ? null : d.id);
        return;
      }
      let x = Math.round(pos[d.id].x / GRID) * GRID;
      let y = Math.round(pos[d.id].y / GRID) * GRID;
      const c = clampStop({ x, y }, d);
      x = c.x;
      y = c.y;
      setPos((prev) => ({ ...prev, [d.id]: { x, y } }));
      if (d.heldZoneId && sizes[d.heldZoneId] && pos[d.heldZoneId]) {
        // Save the held octagon (position and size together) so a reload matches.
        const held = sizes[d.heldZoneId];
        const hp = { x: Math.round(pos[d.heldZoneId].x), y: Math.round(pos[d.heldZoneId].y) };
        savedPosRef.current.set(d.heldZoneId, hp);
        api
          .update('places', d.heldZoneId, {
            mapX: hp.x,
            mapY: hp.y,
            mapW: Math.round(held.w),
            mapH: Math.round(held.h),
            mapLobes: held.lobes ?? null
          })
          .catch((e) => setStatus(e.message));
      }
      needsSaveRef.current = true;
      setSaveTick((t) => t + 1);
    } else if (d.mode === 'zone') {
      if (!d.moved) {
        setSelectedId(d.clickedId === selectedId ? null : d.clickedId);
        return;
      }
      const zp = pos[d.id];
      const x = Math.round(zp.x / GRID) * GRID;
      const y = Math.round(zp.y / GRID) * GRID;
      const ddx = x - zp.x;
      const ddy = y - zp.y;
      const updates = [{ id: d.id, x, y }];
      for (const descId of d.descendantIds) {
        const dp = pos[descId];
        if (!dp) continue;
        updates.push({ id: descId, x: dp.x + ddx, y: dp.y + ddy });
      }
      setPos((prev) => {
        const next = { ...prev };
        for (const u of updates) next[u.id] = { x: u.x, y: u.y };
        return next;
      });
      // A zone's top-left (`pos`) and its size only mean the same rect once
      // both are saved together — persist the size here too (unchanged by a
      // plain move), otherwise a zone with no saved mapW/mapH yet would jump
      // on the next render: its rect is centred on the anchor until a size
      // is saved, and this move just repointed that anchor at the rect's
      // top-left instead of its old centre.
      setSizes((s) => ({ ...s, [d.id]: { ...s[d.id], w: d.rectW, h: d.rectH } }));
      // The zone's position and size go together; everything inside it is
      // saved by the after-drag effect.
      savedPosRef.current.set(d.id, { x: Math.round(x), y: Math.round(y) });
      needsSaveRef.current = true;
      setSaveTick((t) => t + 1);
      setStatus('Saving…');
      api
        .update('places', d.id, {
          mapX: x,
          mapY: y,
          mapW: Math.round(d.rectW),
          mapH: Math.round(d.rectH),
          mapLobes: sizes[d.id]?.lobes ?? null
        })
        .then(() => {
          setStatus('Saved ✓');
          setTimeout(() => setStatus(''), 1200);
        })
        .catch((e) => setStatus(e.message));
    } else if (d.mode === 'resize') {
      const s = sizes[d.id];
      const p = pos[d.id];
      if (s && p && d.moved) {
        // It grew about its centre, so its top-left moved too; the after-drag
        // effect sees it's already saved.
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        savedPosRef.current.set(d.id, { x, y });
        api
          .update('places', d.id, { mapX: x, mapY: y, mapW: Math.round(s.w), mapH: Math.round(s.h), mapLobes: s.lobes ?? null })
          .catch((e) => setStatus(e.message));
        needsSaveRef.current = true;
        setSaveTick((t) => t + 1);
      }
    }
  }

  function onWheel(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const ns = Math.min(3, Math.max(0.3, v.scale * (e.deltaY < 0 ? 1.15 : 0.87)));
      const wx = (mx - v.tx) / v.scale;
      const wy = (my - v.ty) / v.scale;
      return { scale: ns, tx: mx - wx * ns, ty: my - wy * ns };
    });
  }

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        className="map-svg"
        onMouseDown={onBgMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="mapgrid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle className="grid-dot" cx="1" cy="1" r="1" />
          </pattern>
        </defs>
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          <rect x="-4000" y="-4000" width="8000" height="8000" fill="url(#mapgrid)" />
          {zones.map((zone) => {
            const r0 = zone.rect;
            // Guards against a corrupted mapW/mapH on the doc turning into a
            // NaN rect — an empty/undefined rect would otherwise still reach
            // the SVG attributes below and silently fail to paint.
            if (!r0 || [r0.x, r0.y, r0.w, r0.h].some((n) => !Number.isFinite(n))) return null;
            if (zone.lobes.some((l) => ![l.x, l.y, l.w, l.h, l.cut].every(Number.isFinite))) return null;
            // Deeper (more nested) zones get a stronger tint so a small inner
            // zone (Anvils) reads as a distinct patch inside the paler outer
            // band (Varrow) — color-mix keeps both themed via --accent-strong.
            const tintPct = 7 + Math.min(zone.depth, 3) * 10;
            const tint = `color-mix(in srgb, var(--accent-strong) ${tintPct}%, transparent)`;
            const strokeTint = `color-mix(in srgb, var(--accent-strong) ${Math.min(tintPct + 25, 70)}%, transparent)`;
            const badges = badgesFor(zone.id, noteMatch, npcsByPlace, showNotes, showNpcs);
            // One octagon, or several joined into one outline for a lobed
            // zone. The header (name, badges, list) sits on the top-left-most
            // lobe, indented to clear its cut corner; the resize handle on
            // the bottom-right lobe's diagonal.
            const outline = lobesPath(zone.lobes);
            const head = zone.lobes[zone.labelLobe];
            const hx = head.x + labelInset(head.cut);
            const handle = zone.lobes[zone.handleLobe];
            return (
              <g key={zone.id} className="map-zone">
                <path
                  className="map-zone-fill"
                  d={outline}
                  style={{ fill: tint, stroke: strokeTint, strokeWidth: 2 }}
                />
                <path
                  className="map-zone-border-band"
                  d={outline}
                  onMouseDown={(e) => onZoneMouseDown(e, zone)}
                />
                <text
                  className="map-zone-label"
                  x={hx}
                  y={head.y + 22}
                  onMouseDown={(e) => onZoneMouseDown(e, zone)}
                >
                  {zone.name}
                </text>
                {badges.map((b, i) => (
                  <g
                    key={b.icon}
                    className="map-badge"
                    transform={`translate(${hx + i * 46}, ${head.y + 30})`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setSelectedId(zone.id)}
                  >
                    <rect width="40" height="19" rx="9.5" />
                    <text x="7" y="14">{b.icon}</text>
                    <text className="map-badge-count" x="27" y="14">{b.count}</text>
                  </g>
                ))}
                <NoteNpcList
                  id={zone.id}
                  x={hx}
                  y={head.y + 58}
                  noteMatch={noteMatch}
                  npcsByPlace={npcsByPlace}
                  showNotes={showNotes}
                  showNpcs={showNpcs}
                />
                {/* Sits on the middle of the bottom-right diagonal edge. */}
                <rect
                  className="map-zone-resize-handle"
                  x={handle.x + handle.w - handle.cut / 2 - RESIZE_HANDLE / 2}
                  y={handle.y + handle.h - handle.cut / 2 - RESIZE_HANDLE / 2}
                  width={RESIZE_HANDLE}
                  height={RESIZE_HANDLE}
                  rx="3"
                  onMouseDown={(e) => onZoneResizeMouseDown(e, zone)}
                />
              </g>
            );
          })}
          {lineEdges.map((e, i) => {
            const zoneA = zoneById.get(e.a);
            const zoneB = zoneById.get(e.b);
            const rawA = zoneA ? rectCenter(zoneA.rect) : layoutPos[e.a];
            const rawB = zoneB ? rectCenter(zoneB.rect) : layoutPos[e.b];
            if (!rawA || !rawB) return null;
            const a = zoneA ? lobesAttachPoint(zoneA.lobes, rawB) : rawA;
            const b = zoneB ? lobesAttachPoint(zoneB.lobes, rawA) : rawB;
            return (
              <path
                key={i}
                d={tubePath(a, b)}
                stroke={connInfo(e.type).color}
                strokeWidth="6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {places.filter((p) => !zoneById.has(p._id)).map((p) => {
            const pt = layoutPos[p._id];
            if (!pt || Number.isNaN(pt.x) || Number.isNaN(pt.y)) return null;
            const isInterchange = (degree[p._id] || 0) > 1;
            // Badges give the at-a-glance count; the full card (click a badge
            // or the station) is still where every note/NPC links through.
            const badges = badgesFor(p._id, noteMatch, npcsByPlace, showNotes, showNpcs);
            return (
              <g
                key={p._id}
                className="map-station"
                transform={`translate(${pt.x},${pt.y})`}
                onMouseDown={(e) => onNodeMouseDown(e, p._id)}
              >
                <circle
                  className={selectedId === p._id ? 'selected' : ''}
                  r={isInterchange ? 10 : 7}
                  strokeWidth={isInterchange ? 4 : 3}
                />
                <text className="map-station-label" x="14" y="4">{p.name}</text>
                {badges.map((b, i) => (
                  <g
                    key={b.icon}
                    className="map-badge"
                    transform={`translate(${12 + i * 46}, 12)`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setSelectedId(p._id)}
                  >
                    <rect width="40" height="19" rx="9.5" />
                    <text x="7" y="14">{b.icon}</text>
                    <text className="map-badge-count" x="27" y="14">{b.count}</text>
                  </g>
                ))}
                <NoteNpcList
                  id={p._id}
                  x={12}
                  y={44}
                  noteMatch={noteMatch}
                  npcsByPlace={npcsByPlace}
                  showNotes={showNotes}
                  showNpcs={showNpcs}
                />
              </g>
            );
          })}
        </g>
      </svg>

      <div className="map-toolbar">
        <span className="status-text">{status}</span>
        <button
          className={`btn ${showNpcs ? 'primary' : ''}`}
          title="Show which NPCs are from each place"
          onClick={() => setShowNpcs((s) => !s)}
        >
          👥 NPCs
        </button>
        <button
          className={`btn ${showNotes ? 'primary' : ''}`}
          title="Show notes pinned to the places they mention"
          onClick={() => setShowNotes((s) => !s)}
        >
          📜 Notes
        </button>
        <button className="btn" onClick={rearrange}>Auto-arrange</button>
      </div>

      {showNotes && unplacedNotes.length > 0 && (
        <div className="map-notes-panel">
          <div className="map-notes-head">
            <span>📜 Unplaced notes ({unplacedNotes.length})</span>
            <button
              className="block-btn sort-flip"
              title="Flip sort order"
              onClick={() => setNewestFirst((f) => !f)}
            >
              {newestFirst ? 'newest ↑' : 'oldest ↑'}
            </button>
          </div>
          <div className="map-notes-list">
            {unplacedNotes.map((n) => (
              <button key={n._id} className="map-note-row" onClick={() => onOpenNote(n._id)}>
                <span className="map-note-title">{n.title || 'Untitled'}</span>
                <span className="map-note-age">{ageOf(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(legendTypes.length > 0 || zones.length > 0) && (
        <div className="map-legend">
          {legendTypes.map((t) => (
            <div key={t.id} className="map-legend-row">
              <span className="map-legend-swatch" style={{ background: t.color }} />
              {t.label} line
            </div>
          ))}
          {zones.length > 0 && (
            <div className="map-legend-row">
              <span
                className="map-legend-swatch map-legend-zone"
                style={{ background: 'color-mix(in srgb, var(--accent-strong) 45%, transparent)' }}
              />
              Zone (city / region / contains)
            </div>
          )}
        </div>
      )}

      {places.length === 0 && (
        <div className="map-empty">
          No places documented yet. Add some in the Places tab and they'll appear here as
          stations.
        </div>
      )}
      {places.length > 0 && lineEdges.length === 0 && zones.length === 0 && (
        <div className="map-empty">
          Your places aren't linked yet. In a place's location blocks, mention another
          place by name — e.g. <em>Between: the city of Cairne and the town of Eberald</em> —
          and lines will be drawn between them here.
        </div>
      )}

      {selected && (
        <div className="map-info">
          <div className="map-info-title">{selected.name}</div>
          <div className="badge">{selected.type}</div>
          {(selected.connections || []).filter((c) => c.text).map((c, i) => (
            <div key={i} className="map-info-conn">
              <span className="map-conn-label" style={{ background: connInfo(c.type).color }}>
                {connInfo(c.type).label}
              </span>
              {c.text}
            </div>
          ))}
          {containment.parentOf[selected._id] && (
            <div className="map-info-conn">
              <span className="map-conn-label map-conn-label-zone">Inside</span>
              <button
                className="map-zone-link"
                onClick={() => setSelectedId(containment.parentOf[selected._id])}
              >
                {placeById.get(containment.parentOf[selected._id])?.name}
              </button>
            </div>
          )}
          {(containment.childrenOf[selected._id] || []).length > 0 && (
            <div className="map-info-conn">
              <span className="map-conn-label map-conn-label-zone">Contains</span>
              {containment.childrenOf[selected._id].map((childId, i, arr) => (
                <React.Fragment key={childId}>
                  <button className="map-zone-link" onClick={() => setSelectedId(childId)}>
                    {placeById.get(childId)?.name}
                  </button>
                  {i < arr.length - 1 ? ', ' : ''}
                </React.Fragment>
              ))}
            </div>
          )}
          {(noteMatch.byPlace[selected._id] || []).length > 0 && (
            <>
              <div className="map-info-npcs-title">Notes about here</div>
              {noteMatch.byPlace[selected._id].map((n) => (
                <button key={n._id} className="map-note-row in-card" onClick={() => onOpenNote(n._id)}>
                  <span className="map-note-title">📜 {n.title || 'Untitled'}</span>
                  <span className="map-note-age">{ageOf(n.createdAt)}</span>
                </button>
              ))}
            </>
          )}
          {(npcsByPlace[selected._id] || []).length > 0 && (
            <>
              <div className="map-info-npcs-title">NPCs from here</div>
              {npcsByPlace[selected._id].map((n) => (
                <button key={n._id} className="map-note-row in-card" onClick={() => onOpenNpc(n._id)}>
                  <span className="map-note-title">
                    <span
                      className="map-npc-dot"
                      style={{ background: DISPOSITION_COLORS[n.disposition] || '#485354' }}
                      title={n.disposition}
                    />
                    {labelOf(n)}
                    {n.occupation && <span className="map-npc-occ"> · {n.occupation}</span>}
                  </span>
                  <span className="map-note-age">open →</span>
                </button>
              ))}
            </>
          )}
          {selected.description && (
            <p className="map-info-desc">
              {selected.description.length > 220
                ? selected.description.slice(0, 220) + '…'
                : selected.description}
            </p>
          )}
          <div className="map-info-actions">
            <button className="btn primary" onClick={() => onOpenPlace(selected._id)}>
              Open in Places
            </button>
            <button className="btn" onClick={() => setSelectedId(null)}>Close</button>
          </div>
        </div>
      )}

      <div className="map-hint">
        Drag stations to arrange (they stay inside their zone) · drag a zone by its name or edge
        to move it (zones inside a zone move with it), or the handle on its bottom-right edge to resize · click a station or zone for details ·
        scroll or Ctrl +/− to zoom · drag the background to pan
      </div>
    </div>
  );
}
