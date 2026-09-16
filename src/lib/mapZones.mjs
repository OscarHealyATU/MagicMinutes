// Pure logic behind the Map page's "tube lines" and the containment zones
// drawn under them: how connection blocks turn into edges between places,
// how `inside` / `contains` edges turn into a parent/child tree, and how that
// tree turns into nested octagon "zone" outlines (Shardn contains
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

// A place is a "zone" — drawn as an octagon that other things sit
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
// ---------- Octagon zones ----------
//
// Zones are still laid out, clamped and resized as plain rects (everything
// above works unchanged); they're just *drawn* as an octagon cut from that
// rect. Corners are cut in proportion to the short side, using the ratio of a
// regular octagon, so small and square zones come out symmetrical.
//
// The cut is capped just under twice the content padding: anything clamped
// `pad` in from two edges sits `2 * pad` along the diagonal, so it can never
// fall into a cut-off corner. With the map's 36px padding that cap is 64px.
export const REGULAR_OCTAGON_RATIO = 1 / (2 + Math.SQRT2); // ≈ 0.293
export const OCTAGON_MAX_CUT = 64;

export function octagonCut(rect, maxCut = OCTAGON_MAX_CUT) {
  const short = Math.min(rect.w, rect.h);
  if (!(short > 0)) return 0;
  return Math.max(0, Math.min(maxCut, Math.round(short * REGULAR_OCTAGON_RATIO)));
}

// Zones are always regular octagons: a square with uncapped regular corners.
export function zoneCut(rect) {
  return octagonCut(rect, Infinity);
}

// Whether `box` fits inside the square zone `sq` with none of its corners
// in a cut-off corner.
export function squareFits(sq, box) {
  if (box.x < sq.x - 1e-6 || box.y < sq.y - 1e-6) return false;
  if (box.x + box.w > sq.x + sq.w + 1e-6 || box.y + box.h > sq.y + sq.h + 1e-6) return false;
  const c = zoneCut(sq);
  const l = box.x - sq.x;
  const t = box.y - sq.y;
  const r = sq.x + sq.w - (box.x + box.w);
  const b = sq.y + sq.h - (box.y + box.h);
  return l + t >= c - 1e-6 && r + t >= c - 1e-6 && r + b >= c - 1e-6 && l + b >= c - 1e-6;
}

// Side of the smallest regular octagon that holds a centred cw × ch box with
// its corners clear of the cuts, and whose top edge is long enough for a
// header needing `headerWidth` of straight edge. The +2 leaves a pixel of
// slack each side so rounding a saved position never pushes content out.
export function octagonSideFor(cw, ch, headerWidth = 0) {
  const r = REGULAR_OCTAGON_RATIO;
  return Math.ceil(Math.max(cw, ch, (cw + ch) / (2 * (1 - r)), headerWidth / (1 - 2 * r))) + 2;
}

// The smallest square centred on (cx, cy) that fits `box` with its corners
// clear of the cuts, at least `minSide`. Worked out directly: for the
// top-left corner, (side/2 - dl) + (side/2 - dt) >= cut = ratio * side gives
// side >= (dl + dt) / (1 - ratio), and likewise for the other three. The +2
// slack survives the cut's rounding and a saved position's rounding.
export function smallestSquareAround(cx, cy, box, minSide = 0) {
  let side = minSide;
  if (box) {
    const k = 1 - REGULAR_OCTAGON_RATIO;
    const dl = cx - box.x;
    const dr = box.x + box.w - cx;
    const dt = cy - box.y;
    const db = box.y + box.h - cy;
    side = Math.ceil(Math.max(side, 2 * Math.max(dl, dr, dt, db), (dl + dt) / k, (dr + dt) / k, (dr + db) / k, (dl + db) / k)) + 2;
  } else {
    side = Math.ceil(side);
  }
  return { x: cx - side / 2, y: cy - side / 2, w: side, h: side };
}

// Clockwise from the top edge's left end.
export function octagonPoints(rect, cut = octagonCut(rect)) {
  const { x, y, w, h } = rect;
  const c = Math.max(0, Math.min(cut, w / 2, h / 2));
  return [
    { x: x + c, y },
    { x: x + w - c, y },
    { x: x + w, y: y + c },
    { x: x + w, y: y + h - c },
    { x: x + w - c, y: y + h },
    { x: x + c, y: y + h },
    { x, y: y + h - c },
    { x, y: y + c }
  ];
}

export function octagonPath(rect, cut = octagonCut(rect)) {
  const pts = octagonPoints(rect, cut);
  return `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
}

// Inside (or on) the octagon: inside the rect and not in any cut corner.
export function pointInOctagon(rect, p, cut = octagonCut(rect)) {
  const { x, y, w, h } = rect;
  if (p.x < x || p.x > x + w || p.y < y || p.y > y + h) return false;
  const l = p.x - x;
  const r = x + w - p.x;
  const t = p.y - y;
  const b = y + h - p.y;
  return l + t >= cut && r + t >= cut && r + b >= cut && l + b >= cut;
}

function closestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// The octagon version of edgeAttachPoint: a line from `fromPoint` ends on the
// drawn outline, so lines to a zone don't stop short at an invisible corner.
export function octagonAttachPoint(rect, fromPoint, cut = octagonCut(rect)) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = fromPoint.x - cx;
  const dy = fromPoint.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const pts = octagonPoints(rect, cut);
  const segments = pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);

  const insideRect =
    fromPoint.x > rect.x && fromPoint.x < rect.x + rect.w &&
    fromPoint.y > rect.y && fromPoint.y < rect.y + rect.h;
  // Same rule as edgeAttachPoint: from within the box, go to the nearest bit
  // of outline rather than drawing a stub towards the centre.
  if (insideRect) {
    let best = null;
    let bestD = Infinity;
    for (const [a, b] of segments) {
      const q = closestOnSegment(fromPoint, a, b);
      const d = (q.x - fromPoint.x) ** 2 + (q.y - fromPoint.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best;
  }

  // Ray from the centre towards the point; a convex outline is crossed once.
  let bestT = Infinity;
  for (const [a, b] of segments) {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((a.x - cx) * ey - (a.y - cy) * ex) / denom;
    const u = ((a.x - cx) * dy - (a.y - cy) * dx) / denom;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < bestT) bestT = t;
  }
  if (!Number.isFinite(bestT)) return edgeAttachPoint(rect, fromPoint);
  return { x: cx + dx * bestT, y: cy + dy * bestT };
}

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

// ---------- Lobed zones ----------
//
// A zone holding 1–3 inner zones isn't sized to its contents like the rest.
// It's drawn as one octagon ("lobe") per inner zone, all the same size, laid
// on a small grid so neighbouring lobes share a straight edge and read as one
// outline: a single octagon for one, side by side for two, an L for three.
// Each inner zone sits centred in its lobe (alphabetical order picks the
// lobe) and can't be moved on its own; the zone's own places live in the band
// between the lobe edge and the inner zones. With 0 or 4+ inner zones a zone
// is the plain content-sized octagon from above.
export const LOBE_MAX = 3;
const LOBE_CELLS = {
  1: [[0, 0]],
  2: [[0, 0], [1, 0]],
  3: [[0, 1], [1, 1], [1, 0]]
};
export const LOBE_DEFAULTS = {
  minBand: 96,       // thinnest band allowed between a lobe edge and its inner zone
  stationMargin: 16, // clear space kept around a place's text inside the band
  cornerGap: 24      // clear space between a lobe's cut corner and the inner zone's corner
};
// Extra width a zone's header obstacle gets past its measured width, for the
// note list that runs along below the name.
const HEADER_OBSTACLE_EXTRA = 60;
// The cut of a regular octagon leaves this share of the side as a straight edge.
const STRAIGHT_SHARE = 1 - 2 * REGULAR_OCTAGON_RATIO;

export function isLobedCount(n) {
  return n >= 1 && n <= LOBE_MAX;
}

const byNameThenId = (nameOf) => (a, b) =>
  (nameOf(a) || '').localeCompare(nameOf(b) || '', undefined, { sensitivity: 'base' }) ||
  (a < b ? -1 : a > b ? 1 : 0);

// The box a place's dot plus its text block covers, from its point.
export function stationBox(p, fp) {
  return { x: p.x - 14, y: p.y - 16, w: ((fp && fp.right) || 0) + 14, h: ((fp && fp.down) || 0) + 16 };
}

// `children`: [{w, h, cornerCut}] in lobe order. `memberFootprints`: the
// zone's own places. `saved`: a size the user dragged the zone out to, which
// stretches the lobes (never below the natural size). All coordinates are
// relative to the zone's top-left.
export function lobedGeometry({ children, memberFootprints = [], header = 28, headerWidth = 0, pad = 36, saved = null, ...overrides }) {
  const { minBand, stationMargin, cornerGap } = { ...LOBE_DEFAULTS, ...overrides };
  const cells = LOBE_CELLS[children.length];
  if (!cells) throw new Error(`lobedGeometry needs 1-${LOBE_MAX} inner zones, got ${children.length}`);
  const cols = Math.max(...cells.map((c) => c[0])) + 1;
  const rows = Math.max(...cells.map((c) => c[1])) + 1;
  // Lobes are square (regular octagons), so size them off the inner zones' longer side.
  const maxSide = Math.max(...children.map((c) => Math.max(c.w, c.h)));

  // The band must hold the zone's header, and each place's text both
  // vertically and along a lobe's straight top edge.
  let tallest = 0;
  let widest = 0;
  for (const fp of memberFootprints) {
    const b = stationBox({ x: 0, y: 0 }, fp);
    tallest = Math.max(tallest, b.h);
    widest = Math.max(widest, b.w);
  }
  const widthNeed = widest ? ((widest + stationMargin * 2) / STRAIGHT_SHARE - maxSide) / 2 : 0;
  const headerNeed = headerWidth ? (headerWidth / STRAIGHT_SHARE - maxSide) / 2 : 0;
  const band = Math.ceil(Math.max(minBand, header + pad, tallest + stationMargin * 2, widthNeed, headerNeed));

  // A saved size scales every lobe evenly; it can't stretch them.
  const naturalLobe = maxSide + band * 2;
  // Only a size that already has square lobes counts: an old stretched one
  // would blow the lobes up to its longer side.
  const usable = saved && saved.w > 0 && saved.h > 0 && Math.abs(saved.w / cols - saved.h / rows) <= 1;
  const lobeSide = Math.max(naturalLobe, usable ? saved.w / cols : 0);
  const lobeW = lobeSide;
  const lobeH = lobeSide;

  // Regular-octagon corners, cut back only where one would clip an inner
  // zone's own corner (its diagonal sits l + t + its cut in from the lobe's).
  let cut = Math.round(Math.min(lobeW, lobeH) * REGULAR_OCTAGON_RATIO);
  for (const c of children) {
    const slack = (lobeW - c.w) / 2 + (lobeH - c.h) / 2 + (c.cornerCut || 0) - cornerGap * Math.SQRT2;
    cut = Math.min(cut, Math.floor(slack));
  }
  cut = Math.max(0, cut);

  const lobes = cells.map(([cx, cy]) => ({ x: cx * lobeW, y: cy * lobeH, w: lobeW, h: lobeH, cut }));
  const slots = lobes.map((l, i) => ({ x: l.x + (lobeW - children[i].w) / 2, y: l.y + (lobeH - children[i].h) / 2 }));
  const pick = (better) => lobes.reduce((best, l, i) => (better(l, lobes[best]) ? i : best), 0);
  return {
    band,
    cut,
    lobes,
    slots,
    w: cols * lobeW,
    h: rows * lobeH,
    naturalW: cols * naturalLobe,
    naturalH: rows * naturalLobe,
    cols,
    rows,
    // The name goes on the top-most, then left-most lobe; the resize handle
    // on the bottom-right one, which is always the bounding box's corner.
    labelLobe: pick((l, b) => l.y < b.y || (l.y === b.y && l.x < b.x)),
    handleLobe: pick((l, b) => l.y > b.y || (l.y === b.y && l.x > b.x))
  };
}

// Where a zone's header text starts, measured in from its lobe's left edge:
// just enough to clear the top-left cut (the name's top sits ~6px down).
export function labelInset(cut) {
  return Math.max(14, cut - 4);
}

// Things a lobed zone's own places must stay clear of: its inner zones and
// its header.
function headerObstacle(labelLobeRect, header, headerWidth) {
  return {
    x: labelLobeRect.x + labelInset(labelLobeRect.cut),
    y: labelLobeRect.y,
    w: headerWidth + HEADER_OBSTACLE_EXTRA,
    h: header
  };
}

function lobedObstacles(childRects, labelLobeRect, header, headerWidth) {
  return [...childRects, headerObstacle(labelLobeRect, header, headerWidth)];
}

export function lobesBounds(lobes) {
  return lobes.reduce((acc, l) => unionRect(acc, l), { ...lobes[0] });
}

export function pointInLobes(lobes, p) {
  return lobes.some((l) => pointInOctagon(l, p, l.cut));
}

const samePoint = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

// The visible outline: every lobe edge except the straight edges two lobes
// share. Both lobes run clockwise, so a shared edge appears once each way.
export function lobesOutline(lobes) {
  const segs = [];
  lobes.forEach((l, li) => {
    const pts = octagonPoints(l, l.cut);
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      if (!samePoint(a, b)) segs.push({ a, b, li });
    });
  });
  return segs
    .filter((s) => !segs.some((o) => o.li !== s.li && samePoint(s.a, o.b) && samePoint(s.b, o.a)))
    .map(({ a, b }) => [a, b]);
}

// The outline chained into closed loops, usable for both fill and stroke —
// one path, so there's no seam where lobes meet.
export function lobesPath(lobes) {
  const segs = lobesOutline(lobes);
  const used = segs.map(() => false);
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const loop = [segs[i][0]];
    let cur = i;
    let closed = false;
    for (;;) {
      used[cur] = true;
      const end = segs[cur][1];
      if (samePoint(end, loop[0])) { closed = true; break; }
      const next = segs.findIndex((s, j) => !used[j] && samePoint(s[0], end));
      if (next < 0) { loop.push(end); break; }
      loop.push(segs[next][0]);
      cur = next;
    }
    parts.push(`M ${loop.map((p) => `${p.x} ${p.y}`).join(' L ')}${closed ? ' Z' : ''}`);
  }
  return parts.join(' ');
}

// Where a line from `fromPoint` meets the zone's outline: the nearest lobe
// wins, so a line from the right lands on the right-hand lobe.
export function lobesAttachPoint(lobes, fromPoint) {
  if (lobes.length === 1) return octagonAttachPoint(lobes[0], fromPoint, lobes[0].cut);
  const dist2 = (q) => (q.x - fromPoint.x) ** 2 + (q.y - fromPoint.y) ** 2;
  let best = null;
  if (pointInLobes(lobes, fromPoint)) {
    for (const [a, b] of lobesOutline(lobes)) {
      const q = closestOnSegment(fromPoint, a, b);
      if (!best || dist2(q) < dist2(best)) best = q;
    }
    return best;
  }
  for (const l of lobes) {
    const q = octagonAttachPoint(l, fromPoint, l.cut);
    if (!best || dist2(q) < dist2(best)) best = q;
  }
  return best;
}

// A place's box (grown by `margin`) fits if it's inside the lobes and clear
// of every obstacle. The outline isn't convex (there's a notch where lobes
// meet), so the box's whole perimeter is sampled, not just its corners.
export function boxFitsLobes(box, lobes, obstacles = [], margin = 0) {
  const x0 = box.x - margin;
  const y0 = box.y - margin;
  const x1 = box.x + box.w + margin;
  const y1 = box.y + box.h + margin;
  for (const o of obstacles) {
    if (x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y) return false;
  }
  const nx = Math.max(1, Math.ceil((x1 - x0) / 12));
  const ny = Math.max(1, Math.ceil((y1 - y0) / 12));
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    if (!pointInLobes(lobes, { x, y: y0 }) || !pointInLobes(lobes, { x, y: y1 })) return false;
  }
  for (let j = 1; j < ny; j++) {
    const y = y0 + ((y1 - y0) * j) / ny;
    if (!pointInLobes(lobes, { x: x0, y }) || !pointInLobes(lobes, { x: x1, y })) return false;
  }
  return true;
}

// Candidate spots for a place's point inside `lobes`: a coarse grid, plus the
// exact positions where its box (grown by `margin`) sits flush against an
// edge of a lobe or an obstacle. The flush ones matter: a band sized to just
// fit a place has only one height that works, and a grid alone steps over it.
function candidateSpots(point, fp, lobes, obstacles, margin, step) {
  const box = stationBox({ x: 0, y: 0 }, fp); // box.x = point.x - 14, box.y = point.y - 16
  const bb = lobesBounds(lobes);
  const xs = new Set();
  const ys = new Set();
  if (point) {
    xs.add(point.x);
    ys.add(point.y);
  }
  for (const r of [...lobes, ...obstacles]) {
    for (const left of [r.x + margin, r.x + r.w - margin - box.w, r.x - margin - box.w, r.x + r.w + margin]) xs.add(left - box.x);
    for (const top of [r.y + margin, r.y + r.h - margin - box.h, r.y - margin - box.h, r.y + r.h + margin]) ys.add(top - box.y);
  }
  for (let x = bb.x; x <= bb.x + bb.w; x += step) xs.add(x - box.x);
  for (let y = bb.y; y <= bb.y + bb.h; y += step) ys.add(y - box.y);
  const inRange = (v, lo, hi) => v >= lo - 1e-9 && v <= hi + 1e-9;
  const out = [];
  for (const x of xs) {
    if (!inRange(x + box.x, bb.x, bb.x + bb.w)) continue;
    for (const y of ys) {
      if (inRange(y + box.y, bb.y, bb.y + bb.h)) out.push({ x, y });
    }
  }
  return out;
}

// Dragging calls this every mousemove and layoutZones every render, often with
// the same arguments, so remember recent answers.
const clampCache = new Map();
const CLAMP_CACHE_MAX = 2000;
// Past this many nearest candidates without a fit, give up rather than stall
// a drag: the band is full, and the fix is to make the zone bigger.
const CLAMP_MAX_TRIES = 4000;

// The nearest spot to `point` where a place (with footprint `fp`) fits in the
// band, clear of `obstacles`. If there's no room, the point is left as it is.
export function clampPointToLobes(point, fp, lobes, obstacles = [], margin = 0, step = 20) {
  const fits = (p) => boxFitsLobes(stationBox(p, fp), lobes, obstacles, margin);
  if (fits(point)) return point;
  const rectKey = (r) => `${r.x},${r.y},${r.w},${r.h},${r.cut ?? ''}`;
  const key = [
    point.x, point.y, fp && fp.right, fp && fp.down, margin, step,
    lobes.map(rectKey).join(';'), obstacles.map(rectKey).join(';')
  ].join('|');
  const hit = clampCache.get(key);
  if (hit) return hit;

  const dist2 = (p) => (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
  const spots = candidateSpots(point, fp, lobes, obstacles, margin, step).sort((a, b) => dist2(a) - dist2(b));
  let best = null;
  for (let i = 0; i < spots.length && i < CLAMP_MAX_TRIES; i++) {
    if (fits(spots[i])) {
      best = spots[i];
      break;
    }
  }
  if (best) {
    // The candidates are coarse away from edges; look closer around the hit.
    const coarse = best;
    for (let dx = -step; dx <= step; dx += 4) {
      for (let dy = -step; dy <= step; dy += 4) {
        const p = { x: coarse.x + dx, y: coarse.y + dy };
        if (dist2(p) < dist2(best) && fits(p)) best = p;
      }
    }
  }
  const result = best || point;
  if (clampCache.size >= CLAMP_CACHE_MAX) clampCache.clear();
  clampCache.set(key, result);
  return result;
}

// Auto-arrange's placement of a lobed zone's own places: each takes the first
// free spot in reading order, keeping `gap` from places already put down.
// `ok` is false if any place found no room (it's parked in the first lobe).
export function placeStationsInLobes(ids, footprintOf, lobes, obstacles = [], margin = 0, gap = 12, step = 20) {
  const taken = [...obstacles];
  const positions = {};
  let ok = true;
  for (const id of ids) {
    const fp = footprintOf(id);
    const spots = candidateSpots(null, fp, lobes, taken, margin, step).sort((a, b) => a.y - b.y || a.x - b.x);
    let placed = spots.find((p) => boxFitsLobes(stationBox(p, fp), lobes, taken, margin)) || null;
    if (!placed) {
      ok = false;
      placed = { x: lobes[0].x + lobes[0].cut + 14, y: lobes[0].y + margin + 16 };
    }
    positions[id] = placed;
    const b = stationBox(placed, fp);
    taken.push({ x: b.x - gap, y: b.y - gap, w: b.w + gap * 2, h: b.h + gap * 2 });
  }
  return { positions, ok };
}

function lobeOptsFrom(opts) {
  const out = {};
  for (const k of Object.keys(LOBE_DEFAULTS)) if (opts[k] != null) out[k] = opts[k];
  return out;
}

// Lay out every zone: plain zones are sized to their contents (innermost
// first, so a parent can size around its already-sized children), lobed
// zones are built from their inner zones' sizes and then move those inner
// zones — and everything inside them — to the centres of their lobes.
//
// Returns `zones` outermost-first (so outer bands paint under nested ones)
// and `positions`: the input positions with those moves applied, plus any of
// a lobed zone's own places nudged back into its band. Render from, and drag
// from, the returned positions.
export function layoutZones(places, positions, containment, opts = {}) {
  const pad = opts.pad ?? 36;
  const labelHeadroom = opts.labelHeadroom ?? 28;
  const minW = opts.minW ?? 120;
  const minH = opts.minH ?? 80;
  const lobeOpts = lobeOptsFrom(opts);
  const stationMargin = lobeOpts.stationMargin ?? LOBE_DEFAULTS.stationMargin;
  // Per-station text footprint and per-zone header height, both keyed by id.
  // Falling back to the global `labelHeadroom`/a name-only footprint keeps
  // this usable from call sites (and tests) that don't care about text size.
  const footprintOf = opts.footprintOf;
  const headerOf = opts.headerOf;
  // How much straight top edge a zone's header needs (see octagonSideFor).
  const headerWidthOf = opts.headerWidthOf;
  const { childrenOf, depthOf } = containment;
  const byId = new Map(places.map((p) => [p._id, p]));
  const zoneIdSet = new Set(places.filter((p) => isZone(p, containment)).map((p) => p._id));
  const footprintFor = (id) => (footprintOf && footprintOf(id)) || defaultFootprint(byId.get(id));
  const sortByName = byNameThenId((id) => byId.get(id)?.name);

  const out = { ...positions };
  const rec = new Map(); // zoneId -> computed geometry

  function shiftSubtree(id, dx, dy) {
    if (!dx && !dy) return;
    for (const sid of [id, ...descendantsOf(id, childrenOf)]) {
      if (out[sid]) out[sid] = { x: out[sid].x + dx, y: out[sid].y + dy };
      const r = rec.get(sid);
      if (!r) continue;
      const move = (b) => (b ? { ...b, x: b.x + dx, y: b.y + dy } : b);
      r.rect = move(r.rect);
      r.contentBounds = move(r.contentBounds);
      r.lobes = r.lobes.map(move);
      if (r.stationObstacles) r.stationObstacles = r.stationObstacles.map(move);
    }
  }

  const order = [...zoneIdSet].sort((a, b) => (depthOf[b] || 0) - (depthOf[a] || 0));
  for (const id of order) {
    const place = byId.get(id);
    const children = childrenOf[id] || [];
    const memberIds = children.filter((c) => !zoneIdSet.has(c));
    const childZoneIds = children.filter((c) => zoneIdSet.has(c)).sort(sortByName);
    // This zone's own label/badges/list reserve `header` at the top instead
    // of the flat `labelHeadroom` — a zone with a long note list needs more
    // room up top than one with none.
    const header = headerOf ? (headerOf(id) ?? labelHeadroom) : labelHeadroom;
    const headerWidth = (headerWidthOf && headerWidthOf(id)) || 0;
    const hasSavedSize = place && place.mapW != null && place.mapH != null;

    if (isLobedCount(childZoneIds.length)) {
      const kids = childZoneIds.map((cid) => {
        const z = rec.get(cid);
        return { w: z.rect.w, h: z.rect.h, cornerCut: Math.min(...z.lobes.map((l) => l.cut)) };
      });
      const g = lobedGeometry({
        children: kids,
        memberFootprints: memberIds.map(footprintFor),
        header,
        headerWidth,
        pad,
        // A size dragged out for a different number of lobes (or saved
        // before lobes existed, so mapLobes is missing) would stretch these
        // lobes out of shape, so it only counts when the count still matches.
        saved: hasSavedSize && place.mapLobes === childZoneIds.length ? { w: place.mapW, h: place.mapH } : null,
        ...lobeOpts
      });
      // A saved zone keeps its top-left; an unsaved one is centred on its
      // seed point (a stable spot, unlike its children, which are about to move).
      const anchor = positions[id] || { x: 0, y: 0 };
      const ox = hasSavedSize ? anchor.x : anchor.x - g.w / 2;
      const oy = hasSavedSize ? anchor.y : anchor.y - g.h / 2;
      const lobes = g.lobes.map((l) => ({ ...l, x: l.x + ox, y: l.y + oy }));
      childZoneIds.forEach((cid, i) => {
        const r = rec.get(cid).rect;
        shiftSubtree(cid, ox + g.slots[i].x - r.x, oy + g.slots[i].y - r.y);
      });
      const obstacles = lobedObstacles(childZoneIds.map((cid) => rec.get(cid).rect), lobes[g.labelLobe], header, headerWidth);
      for (const mid of memberIds) {
        if (out[mid]) out[mid] = clampPointToLobes(out[mid], footprintFor(mid), lobes, obstacles, stationMargin);
      }
      rec.set(id, {
        rect: { x: ox, y: oy, w: g.w, h: g.h },
        contentBounds: null,
        // The smallest the user may shrink it to (it shrinks about its centre).
        minSize: { w: g.naturalW, h: g.naturalH },
        grid: { cols: g.cols, rows: g.rows },
        lobes,
        lobed: true,
        labelLobe: g.labelLobe,
        handleLobe: g.handleLobe,
        stationObstacles: obstacles,
        stationMargin
      });
      continue;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const mid of memberIds) {
      const p = out[mid];
      if (!p) continue;
      any = true;
      // A member contributes the box its point-plus-text-footprint spans, not
      // just the point — otherwise a station's own name/note list can hang
      // outside the zone rect that's supposed to contain it.
      const b = stationBox(p, footprintFor(mid));
      if (b.x < minX) minX = b.x;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y < minY) minY = b.y;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    for (const cid of childZoneIds) {
      const r = rec.get(cid)?.rect;
      if (!r) continue;
      any = true;
      if (r.x < minX) minX = r.x;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y < minY) minY = r.y;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
    }

    const contentBounds = any
      ? {
          x: minX - pad,
          y: minY - pad - header,
          w: maxX - minX + pad * 2,
          h: maxY - minY + pad * 2 + header
        }
      : null;

    // Always a square, so the octagon is regular: it grows evenly to fit
    // its contents instead of stretching.
    const anchor = positions[id] || { x: 0, y: 0 };
    const baseSide = Math.max(minW, minH, octagonSideFor(0, 0, headerWidth));
    // Sizes saved before zones were regular (not square) would blow a wide
    // zone up into a huge square, so only a square saved size counts.
    const saved = hasSavedSize && place.mapW === place.mapH
      ? { x: anchor.x, y: anchor.y, w: place.mapW, h: place.mapW }
      : null;
    // Whether everything fits a square, checked the same way a dragged place
    // is clamped (each place's own box against the octagon and the header),
    // so a place dropped anywhere the drag allows never makes the zone grow.
    const contentsFit = (sq) => {
      const l = { ...sq, cut: zoneCut(sq) };
      const obstacles = [headerObstacle(l, header, headerWidth)];
      for (const mid of memberIds) {
        const p = out[mid];
        if (p && !boxFitsLobes(stationBox(p, footprintFor(mid)), [l], obstacles, pad)) return false;
      }
      for (const cid of childZoneIds) {
        const r = rec.get(cid)?.rect;
        if (r && !squareFits(sq, { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 })) return false;
      }
      return true;
    };
    let rect;
    if (saved && saved.w >= baseSide && contentsFit(saved)) {
      rect = saved;
    } else if (saved) {
      // Grow-only: when its contents no longer fit, it grows evenly around
      // both what it was and what it now holds.
      const u = contentBounds ? unionRect(saved, contentBounds) : saved;
      rect = smallestSquareAround(u.x + u.w / 2, u.y + u.h / 2, contentBounds, Math.max(baseSide, u.w, u.h));
    } else if (contentBounds) {
      const side = Math.max(baseSide, octagonSideFor(contentBounds.w, contentBounds.h, headerWidth));
      rect = {
        x: contentBounds.x + contentBounds.w / 2 - side / 2,
        y: contentBounds.y + contentBounds.h / 2 - side / 2,
        w: side,
        h: side
      };
    } else {
      // Childless zone (a bare City/Region) with no saved size yet: the
      // minimum octagon centred on wherever it's anchored.
      rect = { x: anchor.x - baseSide / 2, y: anchor.y - baseSide / 2, w: baseSide, h: baseSide };
    }

    const lobe = { ...rect, cut: zoneCut(rect) };
    rec.set(id, {
      rect,
      contentBounds,
      minSize: (() => {
        const sq = smallestSquareAround(rect.x + rect.w / 2, rect.y + rect.h / 2, contentBounds, baseSide);
        return { w: sq.w, h: sq.h };
      })(),
      grid: { cols: 1, rows: 1 },
      lobes: [lobe],
      lobed: false,
      labelLobe: 0,
      handleLobe: 0,
      // Places keep off the zone's own header, and a full padding from the
      // edge, so dragging one never makes the zone grow under it.
      stationObstacles: [headerObstacle(lobe, header, headerWidth)],
      stationMargin: pad
    });
  }

  const zones = [...zoneIdSet]
    .map((id) => {
      const r = rec.get(id);
      return {
        id,
        name: byId.get(id).name,
        depth: depthOf[id] || 0,
        rect: r.rect,
        contentBounds: r.contentBounds,
        lobes: r.lobes,
        lobed: r.lobed,
        labelLobe: r.labelLobe,
        handleLobe: r.handleLobe,
        stationObstacles: r.stationObstacles,
        stationMargin: r.stationMargin,
        minSize: r.minSize,
        grid: r.grid,
        memberIds: (childrenOf[id] || []).filter((c) => !zoneIdSet.has(c)),
        childZoneIds: (childrenOf[id] || []).filter((c) => zoneIdSet.has(c))
      };
    })
    .sort((a, b) => a.depth - b.depth);

  return { zones, positions: out };
}

// Just the zones from layoutZones, for callers that don't need the moved positions.
export function zoneRects(places, positions, containment, opts = {}) {
  return layoutZones(places, positions, containment, opts).zones;
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
  const headerWidthOf = opts.headerWidthOf;
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

  const lobeOpts = lobeOptsFrom(opts);
  const stationMargin = lobeOpts.stationMargin ?? LOBE_DEFAULTS.stationMargin;
  const sortByName = byNameThenId((id) => byId.get(id)?.name);
  const cornerCutOf = {}; // zoneId -> smallest corner cut, so a lobed parent can clear it

  const zoneOrder = [...zoneIdSet].sort((a, b) => (depthOf[b] || 0) - (depthOf[a] || 0));
  for (const id of zoneOrder) {
    const children = childrenOf[id] || [];
    const ordered = [...children.filter((c) => !zoneIdSet.has(c)), ...children.filter((c) => zoneIdSet.has(c))];
    const header = headerOf ? (headerOf(id) ?? labelHeadroom) : labelHeadroom;
    const headerWidth = (headerWidthOf && headerWidthOf(id)) || 0;
    const zoneKids = children.filter((c) => zoneIdSet.has(c)).sort(sortByName);
    if (isLobedCount(zoneKids.length)) {
      // Same geometry layoutZones builds, so an arranged map doesn't shift
      // the moment it's drawn.
      // The size is returned as a saved size (with its lobe count), which
      // layoutZones honours — so lobes are kept to whole pixels to survive the
      // rounding when it's stored, and grown until every place has room.
      const members = children.filter((c) => !zoneIdSet.has(c));
      const geometry = (saved) =>
        lobedGeometry({
          children: zoneKids.map((cid) => ({ w: sizeOf[cid].w, h: sizeOf[cid].h, cornerCut: cornerCutOf[cid] })),
          memberFootprints: members.map(footprintFor),
          header,
          headerWidth,
          pad,
          saved,
          ...lobeOpts
        });
      const natural = geometry(null);
      const cols = Math.round(natural.w / natural.lobes[0].w);
      const rows = Math.round(natural.h / natural.lobes[0].h);
      let g, placed;
      for (let attempt = 0, grow = 1; attempt < 8; attempt++, grow *= 1.15) {
        g = geometry({
          w: Math.ceil(natural.lobes[0].w * grow) * cols,
          h: Math.ceil(natural.lobes[0].h * grow) * rows
        });
        const childRects = zoneKids.map((cid, i) => ({ ...g.slots[i], w: sizeOf[cid].w, h: sizeOf[cid].h }));
        const obstacles = lobedObstacles(childRects, g.lobes[g.labelLobe], header, headerWidth);
        placed = placeStationsInLobes(members, footprintFor, g.lobes, obstacles, stationMargin);
        if (placed.ok) break;
      }
      zoneKids.forEach((cid, i) => { relPos[cid] = { ...g.slots[i] }; });
      Object.assign(relPos, placed.positions);
      sizeOf[id] = { w: g.w, h: g.h, lobes: zoneKids.length };
      cornerCutOf[id] = g.cut;
      continue;
    }
    const baseSide = Math.max(minW, minH, octagonSideFor(0, 0, headerWidth));
    if (ordered.length === 0) {
      sizeOf[id] = { w: baseSide, h: baseSide };
      cornerCutOf[id] = zoneCut(sizeOf[id]);
      continue;
    }
    // Square, with the packed contents centred (whole pixels, so the saved
    // positions match exactly), the same octagon layoutZones would draw.
    const { w, h } = shelfPack(ordered);
    // Each cell is shifted by a place's dot offset (14, 16) so its drawn box,
    // not just its point, starts inside the padding.
    const cw = w + 14 + pad * 2;
    const ch = h + 16 + pad * 2 + header;
    const side = Math.max(baseSide, octagonSideFor(cw, ch, headerWidth));
    const offX = Math.floor((side - cw) / 2);
    const offY = Math.floor((side - ch) / 2);
    for (const cid of ordered) {
      relPos[cid].x += 14 + pad + offX;
      relPos[cid].y += 16 + pad + header + offY;
    }
    sizeOf[id] = { w: side, h: side };
    cornerCutOf[id] = zoneCut(sizeOf[id]);
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
