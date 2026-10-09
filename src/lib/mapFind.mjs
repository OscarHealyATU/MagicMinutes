// Pure matching/ranking logic behind the Map page's Ctrl+F "find a place"
// box (see src/components/MapFind.jsx) — searches the same place list the
// map draws stations and zones from (a "zone" is just a place with children,
// see mapZones.mjs). No React/DOM in here, so it's easy to reason about on
// its own.

// Accent/case-insensitive comparison key, e.g. "Cairné" and "cairne" match.
function foldKey(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Up to `limit` places whose name or type matches `query`. Name-start
// matches rank above name-contains, which rank above a type match — typing
// a place's own name is the common case, matching its type (e.g. "city") is
// a cheap bonus for when the name doesn't. Ties keep the places' own order.
export function findPlaces(places, query, limit = 8) {
  const q = foldKey((query || '').trim());
  if (!q) return [];
  const scored = [];
  (places || []).forEach((p, i) => {
    const name = foldKey(p.name);
    const type = foldKey(p.type);
    let score;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (type && type.startsWith(q)) score = 2;
    else if (type && type.includes(q)) score = 3;
    else return;
    scored.push({ place: p, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.place);
}
