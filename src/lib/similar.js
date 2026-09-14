// Small string-distance helpers for catching place-name typos.
// Ported from notemap.

export function levenshtein(a, b) {
  a = a || '';
  b = b || '';
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const norm = (s) => (s || '').trim().toLowerCase();

// Is this name already a documented place (case-insensitive exact match)?
export function isKnown(places, name) {
  const q = norm(name);
  return places.some((p) => norm(p.name) === q);
}

// Existing place names that look like a typo of `name` (near, but not equal).
// Short names get a tighter threshold so unrelated short words don't collide.
export function similarNames(places, name) {
  const q = norm(name);
  if (q.length < 3) return [];
  const threshold = q.length <= 4 ? 1 : 2;
  return places
    .filter((p) => {
      const pn = norm(p.name);
      if (!pn || pn === q) return false;
      return levenshtein(q, pn) <= threshold;
    })
    .map((p) => p.name);
}
