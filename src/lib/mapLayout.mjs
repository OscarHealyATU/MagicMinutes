// Starting positions for the Map page's stations. Lives here, away from the
// React view, so tests can run it with a seeded random source.

import { descendantsOf } from './mapZones.mjs';

// Stations snap to this grid, both here and when dragged.
export const GRID = 40;

// Simple force layout for stations without a saved position, snapped to the
// grid. `containment` (from buildContainment) additionally seeds a place
// with no saved position next to its parent instead of the global circle,
// and nudges the simulation so children drift toward their parent while
// unrelated stations drift away from other zones' centres.
//
// Places with a saved position never move, so when every place has one there
// is nothing to simulate and the result is just those positions. `random` is
// only for the seeding step; pass a seeded one to get repeatable results.
export function computeLayout(places, edges, containment, ignoreSaved = false, random = Math.random) {
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

  if (free.size === 0) return pos;

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
          x: parentPos.x + (random() - 0.5) * 90,
          y: parentPos.y + (random() - 0.5) * 90
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
      const iFree = free.has(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        // A pair of saved places can't move, so skip the maths for it.
        const jFree = free.has(ids[j]);
        if (!iFree && !jFree) continue;
        const a = pos[ids[i]];
        const b = pos[ids[j]];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (d < 150) {
          const push = ((150 - d) / d) * 0.5;
          if (jFree) { b.x += dx * push; b.y += dy * push; }
          if (iFree) { a.x -= dx * push; a.y -= dy * push; }
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
