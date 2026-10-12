// Plain-node test for src/lib/mapLayout.mjs. The reference below is a copy of
// the force layout as it was before the "nothing to simulate" shortcuts went
// in, so these tests prove the faster version gives exactly the same answer.
// Run with: node tests/mapLayout.test.mjs

import assert from 'node:assert/strict';
import { computeLayout, GRID } from '../src/lib/mapLayout.mjs';
import { buildContainment, buildEdges, descendantsOf } from '../src/lib/mapZones.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.stack || e}`);
  }
}

// ---------- the old implementation, kept as the reference ----------

function referenceLayout(places, edges, containment, ignoreSaved = false, random = Math.random) {
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

  places.forEach((p, i) => {
    if (pos[p._id]) return;
    const angle = (2 * Math.PI * i) / Math.max(places.length, 1);
    pos[p._id] = {
      x: 460 + 230 * Math.cos(angle) + (i % 3) * 15,
      y: 320 + 230 * Math.sin(angle)
    };
  });

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
    for (const id of ids) {
      if (!free.has(id)) continue;
      const parentPos = pos[parentOf[id]];
      const p = pos[id];
      if (!parentPos) continue;
      p.x += (parentPos.x - p.x) * 0.02;
      p.y += (parentPos.y - p.y) * 0.02;
    }
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

// ---------- helpers ----------

// Small repeatable random source (a linear congruential generator).
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// `count` places: every 10th is a region, every 5th a town inside its region,
// most of the rest sit in a town (so nesting is three deep) or float free.
// Some also name a neighbour, so there are line edges as well as containment.
// `saved(i)` says whether place i carries a saved map position.
function makeWorld(count, saved) {
  const rand = seeded(count * 7919);
  const places = [];
  for (let i = 0; i < count; i++) {
    const conns = [];
    const region = i - (i % 10);
    const town = i - (i % 5);
    if (i % 10 !== 0 && i % 5 === 0) conns.push({ type: 'inside', text: `Place ${region}` });
    else if (i % 5 !== 0 && i % 7 !== 0) conns.push({ type: 'inside', text: `Place ${town}` });
    if (i > 2 && rand() < 0.4) conns.push({ type: 'near', text: `Place ${Math.floor(rand() * i)}` });
    const place = {
      _id: `p${i}`,
      name: `Place ${i}`,
      type: i % 10 === 0 ? 'Region' : i % 5 === 0 ? 'Town' : 'Landmark',
      connections: conns
    };
    if (saved(i)) {
      place.mapX = Math.round((rand() * 2000) / GRID) * GRID;
      place.mapY = Math.round((rand() * 1500) / GRID) * GRID;
    }
    places.push(place);
  }
  const edges = buildEdges(places);
  return { places, edges, containment: buildContainment(places, edges) };
}

function compare(world, ignoreSaved = false) {
  const expected = referenceLayout(world.places, world.edges, world.containment, ignoreSaved, seeded(42));
  const actual = computeLayout(world.places, world.edges, world.containment, ignoreSaved, seeded(42));
  assert.deepEqual(actual, expected);
  return actual;
}

// ---------- tests ----------

for (const count of [50, 300]) {
  await test(`computeLayout: ${count} places, all saved - same as the old algorithm, saved spots untouched`, () => {
    const world = makeWorld(count, () => true);
    const out = compare(world);
    for (const p of world.places) assert.deepEqual(out[p._id], { x: p.mapX, y: p.mapY });
  });

  await test(`computeLayout: ${count} places, one unsaved - same as the old algorithm`, () => {
    const world = makeWorld(count, (i) => i !== 3);
    const out = compare(world);
    assert.equal(out.p3.x % GRID, 0, 'snapped to the grid');
    assert.equal(out.p3.y % GRID, 0, 'snapped to the grid');
  });

  await test(`computeLayout: ${count} places, several unsaved - same as the old algorithm`, () => {
    compare(makeWorld(count, (i) => i % 4 !== 1));
  });

  await test(`computeLayout: ${count} places, none saved - same as the old algorithm`, () => {
    compare(makeWorld(count, () => false));
  });

  await test(`computeLayout: ${count} places, ignoreSaved - same as the old algorithm`, () => {
    compare(makeWorld(count, () => true), true);
  });
}

await test('computeLayout: saved places are never moved, even next to unsaved ones', () => {
  const world = makeWorld(50, (i) => i % 3 !== 0);
  const out = computeLayout(world.places, world.edges, world.containment, false, seeded(1));
  for (const p of world.places) {
    if (p.mapX != null) assert.deepEqual(out[p._id], { x: p.mapX, y: p.mapY });
  }
});

await test('computeLayout: with everything saved it never asks for a random number', () => {
  const world = makeWorld(50, () => true);
  let calls = 0;
  computeLayout(world.places, world.edges, world.containment, false, () => {
    calls++;
    return 0.5;
  });
  assert.equal(calls, 0);
});

await test('computeLayout: no places, and places with no containment info, are fine', () => {
  assert.deepEqual(computeLayout([], [], null), {});
  const places = [{ _id: 'a', name: 'Alpha', connections: [] }];
  const out = computeLayout(places, [], null, false, seeded(1));
  assert.deepEqual(out, referenceLayout(places, [], null, false, seeded(1)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
