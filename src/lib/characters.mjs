// Pure logic behind the Characters page: how an NPC is labelled, how "aligned
// to the party" turns into a colour and an x-position, and how relations turn
// into a family-tree layout with group boxes drawn around it.
//
// No React and no database in here, so tests/characters.test.mjs can exercise
// the whole layout with plain objects.

// Kept for the map's NPC dots, which colour by disposition.
export const DISPOSITION_COLORS = {
  Ally: '#3f5e3a',
  Friendly: '#6d411c',
  Neutral: '#485354',
  Suspicious: '#96602e',
  Hostile: '#70250a',
  Unknown: '#0f3a5c'
};

// Colours offered for group boxes.
export const GROUP_COLORS = [
  '#0f3a5c', '#3f5e3a', '#70250a', '#6d411c',
  '#1d4a52', '#96602e', '#485354', '#2a3439'
];

// -100 = sworn enemy of the party, +100 = one of us. The slider in the NPC
// popup writes this; everything on the page reads it.
export const ALIGNMENT_BANDS = [
  { min: 70, disposition: 'Ally', label: 'Ally', color: DISPOSITION_COLORS.Ally },
  { min: 25, disposition: 'Friendly', label: 'Friendly', color: DISPOSITION_COLORS.Friendly },
  { min: -24, disposition: 'Neutral', label: 'Neutral', color: DISPOSITION_COLORS.Neutral },
  { min: -69, disposition: 'Suspicious', label: 'Suspicious', color: DISPOSITION_COLORS.Suspicious },
  { min: -100, disposition: 'Hostile', label: 'Hostile', color: DISPOSITION_COLORS.Hostile }
];

export function bandFor(alignment) {
  const a = clampAlignment(alignment);
  return ALIGNMENT_BANDS.find((b) => a >= b.min) || ALIGNMENT_BANDS[ALIGNMENT_BANDS.length - 1];
}

export function clampAlignment(alignment) {
  const n = Number(alignment);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-100, Math.min(100, Math.round(n)));
}

export function dispositionFor(alignment) {
  return bandFor(alignment).disposition;
}

// Old NPCs (and ones the map created) only have a disposition; give them a
// sensible slider position instead of dumping them all on neutral.
export function alignmentForDisposition(disposition) {
  switch (disposition) {
    case 'Ally': return 85;
    case 'Friendly': return 50;
    case 'Suspicious': return -50;
    case 'Hostile': return -85;
    default: return 0;
  }
}

export function alignmentColor(alignment) {
  return DISPOSITION_COLORS[dispositionFor(alignment)];
}

// What to write on the node. Nameless NPCs are described by what they are.
export function labelOf(npc) {
  return (npc.name || '').trim() || (npc.descriptor || '').trim() || 'Unnamed';
}

// Fills in fields older documents predate, so the view can read them freely.
export function normalizeNpc(npc) {
  return {
    ...npc,
    descriptor: npc.descriptor || '',
    groupId: npc.groupId || '',
    relations: Array.isArray(npc.relations) ? npc.relations : [],
    alignment:
      npc.alignment == null
        ? alignmentForDisposition(npc.disposition)
        : clampAlignment(npc.alignment)
  };
}

// `dir` says where the *target* sits relative to the NPC holding the relation:
// 'below' puts the target underneath (Alara is the boss of henchman 1),
// 'above' puts it overhead, 'level' keeps them side by side.
export const RELATION_TYPES = [
  { id: 'boss', label: 'Boss of', color: '#70250a', dir: 'below', hint: 'e.g. Alara runs the henchmen' },
  { id: 'worksfor', label: 'Works for', color: '#96602e', dir: 'above', hint: 'e.g. hired muscle, servant' },
  { id: 'parent', label: 'Parent of', color: '#6d411c', dir: 'below', hint: 'blood relation, one rung down' },
  { id: 'child', label: 'Child of', color: '#6d411c', dir: 'above', hint: 'blood relation, one rung up' },
  { id: 'sibling', label: 'Sibling of', color: '#3f5e3a', dir: 'level', hint: 'brother, sister, cousin' },
  { id: 'partner', label: 'Partner of', color: '#1d4a52', dir: 'level', hint: 'married, betrothed, lovers' },
  { id: 'ally', label: 'Allied with', color: '#0f3a5c', dir: 'level', hint: 'friends, sworn to each other' },
  { id: 'rival', label: 'Rival of', color: '#b1441d', dir: 'level', hint: 'enemies, competitors' },
  { id: 'knows', label: 'Knows', color: '#485354', dir: 'level', hint: 'met once, owes a favour…' }
];

export function relationInfo(id) {
  return RELATION_TYPES.find((t) => t.id === id) || RELATION_TYPES[RELATION_TYPES.length - 1];
}

export function describeRelation(relation, targetLabel) {
  const info = relationInfo(relation.type);
  const text = (relation.text || '').trim();
  return `${info.label} ${targetLabel}${text ? ` — ${text}` : ''}`;
}

// ---------- Layout ----------

export const NODE_SPACING = 160;
export const ROW_SPACING = 110;
export const CLUSTER_GAP = 110;
export const HULL_PAD = 46;
export const HULL_TITLE_SPACE = 22;

// Every relation becomes one drawable edge. Both halves of a mutual pair
// ("Alara is the boss of Grak" + "Grak works for Alara") collapse into one.
export function buildRelationEdges(npcs) {
  const known = new Set(npcs.map((n) => n._id));
  const edges = [];
  const seen = new Set();

  for (const npc of npcs) {
    for (const rel of normalizeNpc(npc).relations) {
      if (!rel || !rel.targetId || rel.targetId === npc._id || !known.has(rel.targetId)) continue;
      const info = relationInfo(rel.type);
      const edge =
        info.dir === 'above'
          ? { parent: rel.targetId, child: npc._id }
          : { parent: npc._id, child: rel.targetId };
      const key =
        info.dir === 'level'
          ? `level:${[npc._id, rel.targetId].sort().join('|')}:${info.id}`
          : `tree:${edge.parent}|${edge.child}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: npc._id,
        to: rel.targetId,
        type: info.id,
        dir: info.dir,
        text: rel.text || '',
        parent: info.dir === 'level' ? null : edge.parent,
        child: info.dir === 'level' ? null : edge.child
      });
    }
  }
  return edges;
}

// Longest-path depth, so a henchman under a lieutenant under a boss sits two
// rows down. The iteration cap stops a relation cycle spinning forever.
export function computeDepths(npcs, edges) {
  const depth = {};
  for (const n of npcs) depth[n._id] = 0;
  const tree = edges.filter((e) => e.parent && e.child);
  for (let pass = 0; pass < npcs.length; pass++) {
    let changed = false;
    for (const e of tree) {
      if (depth[e.child] == null || depth[e.parent] == null) continue;
      if (depth[e.child] <= depth[e.parent]) {
        depth[e.child] = depth[e.parent] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return depth;
}

// Grouped NPCs cluster by group. Ungrouped ones start alone and merge with any
// other ungrouped NPC they're related to, so a loose pair stays side by side
// instead of drifting to opposite ends of the page.
export function clusterNpcs(npcs, groups, edges) {
  const groupIds = new Set(groups.map((g) => g._id));
  const parent = {};
  const keyOf = (n) =>
    n.groupId && groupIds.has(n.groupId) ? `g:${n.groupId}` : `n:${n._id}`;

  for (const n of npcs) parent[keyOf(n)] = keyOf(n);

  const find = (k) => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const byId = new Map(npcs.map((n) => [n._id, n]));
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    // Only loose NPCs get pulled together; group members stay in their box.
    if (keyOf(a).startsWith('n:') && keyOf(b).startsWith('n:')) union(keyOf(a), keyOf(b));
  }

  const clusters = new Map();
  for (const n of npcs) {
    const root = find(keyOf(n));
    if (!clusters.has(root)) {
      const groupKey = keyOf(n).startsWith('g:') ? keyOf(n).slice(2) : '';
      clusters.set(root, { key: root, groupId: groupKey, members: [] });
    }
    const cluster = clusters.get(root);
    if (!cluster.groupId && keyOf(n).startsWith('g:')) cluster.groupId = keyOf(n).slice(2);
    cluster.members.push(n);
  }
  return [...clusters.values()];
}

function meanAlignment(members) {
  if (!members.length) return 0;
  return members.reduce((sum, n) => sum + clampAlignment(n.alignment), 0) / members.length;
}

// Friendly on the left, hostile on the right — between clusters and within
// each row of one. Rows come from relation depth, so subordinates hang below
// whoever they answer to.
export function computeCharacterLayout(rawNpcs, rawGroups = []) {
  const npcs = rawNpcs.map(normalizeNpc);
  const edges = buildRelationEdges(npcs);
  const depth = computeDepths(npcs, edges);
  const clusters = clusterNpcs(npcs, rawGroups, edges);

  for (const cluster of clusters) {
    // Rows are global, not per-cluster: someone who works for a gang boss has
    // to sit below them even when they aren't in the gang themselves.
    cluster.rows = new Map();
    for (const n of cluster.members) {
      const row = depth[n._id];
      if (!cluster.rows.has(row)) cluster.rows.set(row, []);
      cluster.rows.get(row).push(n);
    }
    for (const row of cluster.rows.values()) {
      row.sort(
        (a, b) => clampAlignment(b.alignment) - clampAlignment(a.alignment) ||
          labelOf(a).localeCompare(labelOf(b))
      );
    }
    cluster.width = Math.max(...[...cluster.rows.values()].map((r) => r.length)) - 1;
    cluster.align = meanAlignment(cluster.members);
  }

  clusters.sort(
    (a, b) => b.align - a.align || labelOf(a.members[0]).localeCompare(labelOf(b.members[0]))
  );

  const pos = {};
  let cursor = 0;
  for (const cluster of clusters) {
    const spanPx = cluster.width * NODE_SPACING;
    const pad = cluster.groupId ? HULL_PAD : 0;
    const centre = cursor + pad + spanPx / 2;
    for (const [row, members] of cluster.rows) {
      members.forEach((n, i) => {
        pos[n._id] = {
          x: Math.round(centre + (i - (members.length - 1) / 2) * NODE_SPACING),
          y: row * ROW_SPACING
        };
      });
    }
    cursor += spanPx + pad * 2 + CLUSTER_GAP;
  }
  return { pos, edges, depth, clusters };
}

// Boxes are drawn from wherever the members actually ended up, so dragging a
// member out simply stretches the box rather than orphaning them.
export function computeGroupHulls(positions, rawNpcs, groups) {
  const npcs = rawNpcs.map(normalizeNpc);
  const hulls = [];
  for (const group of groups) {
    const members = npcs.filter((n) => n.groupId === group._id && positions[n._id]);
    if (!members.length) continue;
    const xs = members.map((n) => positions[n._id].x);
    const ys = members.map((n) => positions[n._id].y);
    const x = Math.min(...xs) - HULL_PAD;
    const y = Math.min(...ys) - HULL_PAD - HULL_TITLE_SPACE;
    hulls.push({
      _id: group._id,
      name: group.name,
      color: group.color || GROUP_COLORS[0],
      count: members.length,
      x,
      y,
      w: Math.max(...xs) + HULL_PAD - x,
      h: Math.max(...ys) + HULL_PAD - y
    });
  }
  // Big boxes first so a small group nested inside a large one stays clickable.
  return hulls.sort((a, b) => b.w * b.h - a.w * a.h);
}

// Everything the Characters page knows about one NPC's connections, for the
// info card that opens when you click a node.
export function relationsOf(npc, npcs) {
  const byId = new Map(npcs.map((n) => [n._id, n]));
  const own = normalizeNpc(npc).relations
    .filter((r) => r && byId.has(r.targetId))
    .map((r) => ({ ...r, target: byId.get(r.targetId), incoming: false }));

  const incoming = [];
  for (const other of npcs) {
    if (other._id === npc._id) continue;
    for (const r of normalizeNpc(other).relations) {
      if (r && r.targetId === npc._id) {
        incoming.push({ ...r, target: other, incoming: true });
      }
    }
  }
  return [...own, ...incoming];
}
