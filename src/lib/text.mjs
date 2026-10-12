// SVG <text> never wraps or clips itself, so an unusually long name would
// otherwise stretch clear across the canvas over every other node. 28 is the
// same cap mapZones.mjs's TEXT_METRICS.nameCap reserves room for.
export function truncateLabel(text, max = 28) {
  const t = (text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
