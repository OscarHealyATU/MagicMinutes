// Pure logic behind the Map page's "tube lines" and the containment zones
// drawn under them: how connection blocks turn into edges between places,
// how `inside` / `contains` edges turn into a parent/child tree, and how that
// tree turns into nested rounded-rectangle "zone" boxes (Shardn contains
// Cogs, tube-map style) that stops are confined inside of.
//
// No React and no database in here, so tests/mapZones.test.mjs can exercise
// all of it with plain objects.

// Link places whose location-block text mentions another place's name,
// e.g. Between: "the city of Cairne and the town of Eberald" links this
// place to both Cairne and Eberald. `a` is always the place whose block it
// is; `b` is the place mentioned inside that block's text.
export function buildEdges(places) {
  const edges = [];
  const seen = new Set();
  // Longest names first so "Cairne Docks" wins over "Cairne" in the same text
  const byLength = [...places].sort(
    (a, b) => (b.name || '').length - (a.name || '').length
  );

  for (const place of places) {
    for (const block of place.connections || []) {
      let text = (block.text || '').toLowerCase();
      if (!text) continue;
      for (const other of byLength) {
        if (other._id === place._id) continue;
        const name = (other.name || '').trim().toLowerCase();
        if (name.length < 3 || !text.includes(name)) continue;
        text = text.split(name).join('§'); // consume so contained names don't re-match
        const key = [place._id, other._id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a: place._id, b: other._id, type: block.type });
      }
    }
  }
  return edges;
}

// `inside` and `contains` edges describe the same relationship from either
// end: an `inside` block on A naming B means A sits inside B (parent(A) = B);
// a `contains` block on B naming A means B contains A (parent(A) = B too).
// A place keeps only its first parent, and an edge that would make a place
// its own ancestor is dropped rather than applied.
export function buildContainment(places, edges) {
  const validIds = new Set(places.map((p) => p._id));
  const parentOf = {};

  function wouldCycle(childId, parentId) {
    let cur = parentId;
    const seen = new Set();
    while (cur != null) {
      if (cur === childId) return true;
      if (seen.has(cur)) return false; // already-broken chain elsewhere
      seen.add(cur);
      cur = parentOf[cur];
    }
    return false;
  }

  function trySetParent(childId, parentId) {
    if (!childId || !parentId || childId === parentId) return;
    if (!validIds.has(childId) || !validIds.has(parentId)) return;
    if (parentOf[childId] != null) return; // first parent wins
    if (wouldCycle(childId, parentId)) return;
    parentOf[childId] = parentId;
  }

  for (const e of edges) {
    if (e.type === 'inside') trySetParent(e.a, e.b);
    else if (e.type === 'contains') trySetParent(e.b, e.a);
  }

  const childrenOf = {};
  for (const [child, parent] of Object.entries(parentOf)) {
    (childrenOf[parent] = childrenOf[parent] || []).push(child);
  }

  const roots = places.map((p) => p._id).filter((id) => parentOf[id] == null);

  const depthOf = {};
  for (const p of places) {
    let d = 0;
    let cur = p._id;
    const seen = new Set();
    while (parentOf[cur] != null && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf[cur];
      d++;
    }
    depthOf[p._id] = d;
  }

  return { parentOf, childrenOf, roots, depthOf };
}

// All descendants of a place (children, grandchildren, …), guarding against
// a cycle slipping through so this can never loop forever.
export function descendantsOf(id, childrenOf, acc = new Set()) {
  for (const child of childrenOf[id] || []) {
    if (acc.has(child)) continue;
    acc.add(child);
    descendantsOf(child, childrenOf, acc);
  }
  return acc;
}

// A place is a "zone" — drawn as a rounded rectangle that other things sit
// inside of — if it contains at least one other place, or if it's a City or
// Region (so even a childless city still reads as "this is a city" instead
// of vanishing into a plain stop). Everything else is a stop on the line.
export function isZone(place, containment) {
  if (!place) return false;
  const children = (containment && containment.childrenOf[place._id]) || [];
  return children.length > 0 || place.type === 'City' || place.type === 'Region';
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

// Clamp a point inside a rect, inset by `margin` on every side (or by
// `marginRight`/`marginBottom` on those two sides specifically, when a point
// carries a footprint of text extending right/down from it and needs more
// room on those sides than on the left/top). If the rect (after the inset)
// is degenerate — too small to hold the margin — the point collapses to the
// rect's centre rather than producing NaN/inverted bounds.
export function clampPointToRect(point, rect, margin = 0, marginRight = margin, marginBottom = margin) {
  const minX = rect.x + margin;
  const maxX = rect.x + rect.w - marginRight;
  const minY = rect.y + margin;
  const maxY = rect.y + rect.h - marginBottom;
  const x = maxX >= minX ? Math.min(Math.max(point.x, minX), maxX) : rect.x + rect.w / 2;
  const y = maxY >= minY ? Math.min(Math.max(point.y, minY), maxY) : rect.y + rect.h / 2;
  return { x, y };
}

// Clamp a rect's position inside a parent rect, keeping its own width/height.
// `margin` keeps it that far from the parent's sides and bottom, `topMargin`
// from the top (room for the parent's label) — pass the same pad/headroom
// zoneRects uses so the parent never has to grow to keep its padding around
// a child that's being dragged. If the rect is bigger than the allowed area
// in some dimension it can't be fully contained, so it pins to the area's
// top-left on that axis instead.
export function clampRectInRect(rect, parent, margin = 0, topMargin = margin) {
  const { w, h } = rect;
  const minX = parent.x + margin;
  const minY = parent.y + topMargin;
  const maxX = parent.x + parent.w - margin - w;
  const maxY = parent.y + parent.h - margin - h;
  const x = maxX >= minX ? Math.min(Math.max(rect.x, minX), maxX) : minX;
  const y = maxY >= minY ? Math.min(Math.max(rect.y, minY), maxY) : minY;
  return { x, y, w, h };
}

// Slide `rect` out of any `obstacles` (sibling zone rects) it overlaps, keeping
// at least `gap` clear of each, by the smallest nudge that resolves the
// overlap. Repeats a few times so being pushed off one sibling into another
// still settles; a rect that can't be settled is returned as far as it got.
export function pushRectClear(rect, obstacles, gap = 0, maxIter = 6) {
  let { x, y } = rect;
  const { w, h } = rect;
  for (let iter = 0; iter < maxIter; iter++) {
    let movedThisPass = false;
    for (const o of obstacles) {
      const ox = o.x - gap;
      const oy = o.y - gap;
      const ow = o.w + gap * 2;
      const oh = o.h + gap * 2;
      // Distance the rect would have to move in each direction to get clear.
      // All four positive means it overlaps; the smallest one is the nudge.
      const pushLeft = x + w - ox;
      const pushRight = ox + ow - x;
      const pushUp = y + h - oy;
      const pushDown = oy + oh - y;
      if (pushLeft <= 0 || pushRight <= 0 || pushUp <= 0 || pushDown <= 0) continue;
      const mtvX = Math.min(pushLeft, pushRight);
      const mtvY = Math.min(pushUp, pushDown);
      if (mtvX < mtvY) {
        x += pushLeft < pushRight ? -pushLeft : pushRight;
      } else {
        y += pushUp < pushDown ? -pushUp : pushDown;
      }
      movedThisPass = true;
    }
    if (!movedThisPass) break;
  }
  return { x, y, w, h };
}

// How wide/tall `rect` may grow (from its top-left) before it comes within
// `gap` of an obstacle sitting to its right or below it. Only obstacles whose
// span overlaps the rect on the other axis count — a sibling entirely above
// or entirely to the left never limits growth.
export function resizeLimits(rect, obstacles, gap = 0) {
  let maxW = Infinity;
  let maxH = Infinity;
  for (const o of obstacles) {
    const sharesRows = o.y - gap < rect.y + rect.h && o.y + o.h + gap > rect.y;
    const sharesCols = o.x - gap < rect.x + rect.w && o.x + o.w + gap > rect.x;
    if (sharesRows && o.x >= rect.x) maxW = Math.min(maxW, o.x - gap - rect.x);
    if (sharesCols && o.y >= rect.y) maxH = Math.min(maxH, o.y - gap - rect.y);
  }
  return { maxW, maxH };
}

// Where a line drawn from `fromPoint` toward a zone rect's centre crosses
// the rect's boundary — so a line into a zone stops at its edge instead of
// running to the middle. A `fromPoint` already inside the rect has nowhere
// to attach on the boundary, so it just returns the centre.
export function edgeAttachPoint(rect, fromPoint) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const inside =
    fromPoint.x > rect.x && fromPoint.x < rect.x + rect.w &&
    fromPoint.y > rect.y && fromPoint.y < rect.y + rect.h;
  const dx = fromPoint.x - cx;
  const dy = fromPoint.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // From inside the rect (a stop or zone that happens to sit within this
  // zone's box without belonging to it), a line to the centre would just be
  // a stub pointing at nothing — attach to the nearest edge instead so it
  // reads as "out to this zone".
  if (inside) {
    const toLeft = fromPoint.x - rect.x;
    const toRight = rect.x + rect.w - fromPoint.x;
    const toTop = fromPoint.y - rect.y;
    const toBottom = rect.y + rect.h - fromPoint.y;
    const nearest = Math.min(toLeft, toRight, toTop, toBottom);
    if (nearest === toLeft) return { x: rect.x, y: fromPoint.y };
    if (nearest === toRight) return { x: rect.x + rect.w, y: fromPoint.y };
    if (nearest === toTop) return { x: fromPoint.x, y: rect.y };
    return { x: fromPoint.x, y: rect.y + rect.h };
  }

  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// Shared sizing constants for a station's name + note/NPC list text, so
// MapView's SVG layout and this file's rect/clamp math agree on how much
// room a station's own rendered text needs — see `stationFootprint`.
export const TEXT_METRICS = {
  nameCharW: 7,    // px per character of a station/zone name
  listCharW: 6.5,  // px per character of a note/NPC list line
  listIconW: 16,   // fixed width reserved for a list line's icon/dot
  nameCap: 28,     // same truncation cap MapView's truncateLabel uses
  nameRowH: 18,    // vertical space for the name row
  badgeRowH: 20,   // vertical space for the badge row, when there is one
  lineH: 13,       // each note/NPC list line's height
  marginRight: 12, // margin added past the widest text
  marginBottom: 6  // margin added below the last line
};

// How far a station's own rendered text (name, badge row, note/NPC list)
// reaches to the right of and below its point — so a zone's rect and the
// drag clamps can leave room for the whole text block, not just the point.
// `noteLines`/`npcLines` are the already-capped, already-truncated strings
// MapView is about to render (see `noteNpcListFor`/`truncateLabel`);
// `hasMore` is whether a "+N more…" line follows them.
export function stationFootprint(
  { noteLines = [], npcLines = [], hasMore = false, nameLength = 0 },
  metrics = TEXT_METRICS
) {
  const cap = metrics.nameCap;
  const nameWidth = Math.min(nameLength, cap) * metrics.nameCharW;
  const lines = [...noteLines, ...npcLines];
  let widestLine = 0;
  for (const line of lines) {
    const len = Math.min((line || '').length, cap);
    const w = len * metrics.listCharW + metrics.listIconW;
    if (w > widestLine) widestLine = w;
  }
  const lineCount = lines.length + (hasMore ? 1 : 0);
  const hasBadges = lines.length > 0; // matches badgesFor: a badge only shows when there's something to count
  return {
    right: Math.max(nameWidth, widestLine) + metrics.marginRight,
    down: metrics.nameRowH + (hasBadges ? metrics.badgeRowH : 0) + metrics.lineH * lineCount + metrics.marginBottom
  };
}

// A footprint for a place with no known notes/NPCs (or no id in the caller's
// footprint map at all) — just its name. Used as the fallback everywhere a
// footprint is looked up by id, so a missing entry degrades to "no list"
// instead of producing NaN rects.
function defaultFootprint(place) {
  return stationFootprint({ nameLength: ((place && place.name) || '').length });
}

// Compute every zone's rounded-rect geometry, innermost first internally so
// a parent zone's bounding box can include its already-sized child zones,
// then returned outermost-first so MapView paints outer bands before the
// nested ones on top. `positions` gives the anchor point for each place — a
// stop's drawn point, or a zone's top-left when nothing else pins it yet.
export function zoneRects(places, positions, containment, opts = {}) {
  const pad = opts.pad ?? 36;
  const labelHeadroom = opts.labelHeadroom ?? 28;
  const minW = opts.minW ?? 120;
  const minH = opts.minH ?? 80;
  // Per-station text footprint and per-zone header height, both keyed by id.
  // Falling back to the global `labelHeadroom`/a name-only footprint keeps
  // this usable from call sites (and tests) that don't care about text size.
  const footprintOf = opts.footprintOf;
  const headerOf = opts.headerOf;
  const { childrenOf, depthOf } = containment;
  const byId = new Map(places.map((p) => [p._id, p]));
  const zoneIdSet = new Set(places.filter((p) => isZone(p, containment)).map((p) => p._id));

  const order = [...zoneIdSet].sort((a, b) => (depthOf[b] || 0) - (depthOf[a] || 0));
  const rectById = new Map();
  const contentBoundsById = new Map();

  for (const id of order) {
    const place = byId.get(id);
    const children = childrenOf[id] || [];
    const memberIds = children.filter((c) => !zoneIdSet.has(c));
    const childZoneIds = children.filter((c) => zoneIdSet.has(c));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const mid of memberIds) {
      const p = positions[mid];
      if (!p) continue;
      any = true;
      // A member contributes the box its point-plus-text-footprint spans, not
      // just the point — otherwise a station's own name/note list can hang
      // outside the zone rect that's supposed to contain it.
      const fp = (footprintOf && footprintOf(mid)) || defaultFootprint(byId.get(mid));
      if (p.x < minX) minX = p.x;
      if (p.x + fp.right > maxX) maxX = p.x + fp.right;
      if (p.y < minY) minY = p.y;
      if (p.y + fp.down > maxY) maxY = p.y + fp.down;
    }
    for (const cid of childZoneIds) {
      const r = rectById.get(cid);
      if (!r) continue;
      any = true;
      if (r.x < minX) minX = r.x;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y < minY) minY = r.y;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
    }

    // This zone's own label/badges/list reserve `header` at the top instead
    // of the flat `labelHeadroom` — a zone with a long note list needs more
    // room up top than one with none.
    const header = headerOf ? (headerOf(id) ?? labelHeadroom) : labelHeadroom;
    const contentBounds = any
      ? {
          x: minX - pad,
          y: minY - pad - header,
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2 + header
        }
      : null;
    contentBoundsById.set(id, contentBounds);

    const anchor = positions[id] || { x: 0, y: 0 };
    let rect;
    if (place && place.mapW != null && place.mapH != null) {
      // A saved size only ever grows to cover new contents — it never
      // shrinks on its own; that's reserved for an explicit resize.
      const saved = { x: anchor.x, y: anchor.y, w: place.mapW, h: place.mapH };
      rect = contentBounds ? unionRect(saved, contentBounds) : saved;
    } else if (contentBounds) {
      rect = contentBounds;
    } else {
      // Childless zone (a bare City/Region) with no saved size yet: a fixed
      // minimum box centred on wherever it's anchored.
      rect = { x: anchor.x - minW / 2, y: anchor.y - minH / 2, w: minW, h: minH };
    }
    if (rect.w < minW) rect = { ...rect, w: minW };
    if (rect.h < minH) rect = { ...rect, h: minH };

    rectById.set(id, rect);
  }

  return [...zoneIdSet]
    .map((id) => ({
      id,
      name: byId.get(id).name,
      depth: depthOf[id] || 0,
      rect: rectById.get(id),
      contentBounds: contentBoundsById.get(id),
      memberIds: (childrenOf[id] || []).filter((c) => !zoneIdSet.has(c)),
      childZoneIds: (childrenOf[id] || []).filter((c) => zoneIdSet.has(c))
    }))
    .sort((a, b) => a.depth - b.depth);
}

// "Auto-arrange" for zones: a cheap recursive shelf-pack instead of the old
// force layout, so nested zones come out as neat grids instead of a jumble.
// Each zone lays its direct member stops out on a grid, shelves its child
// zones after them (wrapping after `perRow` columns), and sizes itself to
// fit — innermost zones are packed first so a parent can size around its
// already-packed children. Root-level zones and stops are packed the same
// way. Returns absolute positions for every place (a stop's point, or a
// zone's top-left) plus the computed size of every zone.
export function packLayout(places, containment, opts = {}) {
  const gridX = opts.gridX ?? 120;
  const gridY = opts.gridY ?? 90;
  const perRow = opts.perRow ?? 3;
  const zoneGap = opts.zoneGap ?? 32; // breathing room between sibling zones
  const pad = opts.pad ?? 36;
  const labelHeadroom = opts.labelHeadroom ?? 28;
  const minW = opts.minW ?? 120;
  const minH = opts.minH ?? 80;
  const originX = opts.originX ?? 80;
  const originY = opts.originY ?? 80;
  const footprintOf = opts.footprintOf;
  const headerOf = opts.headerOf;
  const { childrenOf, depthOf, roots } = containment;
  const zoneIdSet = new Set(places.filter((p) => isZone(p, containment)).map((p) => p._id));
  const byId = new Map(places.map((p) => [p._id, p]));

  const sizeOf = {}; // zoneId -> {w,h}
  const relPos = {}; // id -> {x,y} relative to its own parent's top-left (or world, for roots)

  function footprintFor(id) {
    return (footprintOf && footprintOf(id)) || defaultFootprint(byId.get(id));
  }

  // Shelf-pack a list of ids (stops and/or already-sized child zones)
  // starting at local (0,0); returns the bounding size of the packed block.
  // A stop's own cell is sized from its text footprint (plus a little
  // breathing room) rather than the flat grid size, so a station with a long
  // note list doesn't overlap the next one over or below it — a stop's `x,y`
  // here is its point (top-left of its footprint), same as a zone's `x,y` is
  // its rect's top-left.
  function shelfPack(ids) {
    let x = 0, y = 0, rowH = 0, col = 0, maxX = 0;
    for (const id of ids) {
      const isZ = zoneIdSet.has(id);
      let w, h;
      if (isZ) {
        // Trailing gap so two sibling zones packed side by side (or one
        // above the other) never share an edge.
        w = sizeOf[id].w + zoneGap;
        h = sizeOf[id].h + zoneGap;
      } else {
        const fp = footprintFor(id);
        w = Math.max(gridX, fp.right + 24);
        h = Math.max(gridY, fp.down + 16);
      }
      if (col >= perRow) { col = 0; x = 0; y += rowH; rowH = 0; }
      relPos[id] = { x, y };
      x += w;
      rowH = Math.max(rowH, h);
      maxX = Math.max(maxX, x);
      col++;
    }
    return { w: maxX, h: y + rowH };
  }

  const zoneOrder = [...zoneIdSet].sort((a, b) => (depthOf[b] || 0) - (depthOf[a] || 0));
  for (const id of zoneOrder) {
    const children = childrenOf[id] || [];
    const ordered = [...children.filter((c) => !zoneIdSet.has(c)), ...children.filter((c) => zoneIdSet.has(c))];
    const header = headerOf ? (headerOf(id) ?? labelHeadroom) : labelHeadroom;
    if (ordered.length === 0) {
      sizeOf[id] = { w: minW, h: minH };
      continue;
    }
    const { w, h } = shelfPack(ordered);
    for (const cid of ordered) {
      relPos[cid].x += pad;
      relPos[cid].y += pad + header;
    }
    sizeOf[id] = { w: Math.max(w + pad * 2, minW), h: Math.max(h + pad * 2 + header, minH) };
  }

  const rootIds = [...roots.filter((id) => !zoneIdSet.has(id)), ...roots.filter((id) => zoneIdSet.has(id))];
  shelfPack(rootIds);

  const positions = {};
  function assignAbsolute(id, baseX, baseY) {
    const r = relPos[id] || { x: 0, y: 0 };
    const abs = { x: baseX + r.x, y: baseY + r.y };
    positions[id] = abs;
    if (zoneIdSet.has(id)) {
      for (const kid of childrenOf[id] || []) assignAbsolute(kid, abs.x, abs.y);
    }
  }
  for (const id of rootIds) assignAbsolute(id, originX, originY);

  return { positions, sizes: sizeOf };
}
