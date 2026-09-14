// Plain-node test for src/lib/mapZones.mjs — the Map page's edge/containment/
// hull logic. Run with: node tests/mapZones.test.mjs

import assert from 'node:assert/strict';
import {
  buildContainment,
  buildEdges,
  clampPointToRect,
  clampRectInRect,
  descendantsOf,
  edgeAttachPoint,
  isZone,
  packLayout,
  pushRectClear,
  resizeLimits,
  stationFootprint,
  TEXT_METRICS,
  zoneRects
} from '../src/lib/mapZones.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// Terse fixture builder: place('id', 'Name', [{type, text}]) -> a place doc.
const place = (id, name, connections = []) => ({ _id: id, name, connections });

// ---------- the real Shardn / Cogs data from the brief ----------

function makeShardnPlaces() {
  return [
    place('shardn', 'Shardn', [{ type: 'contains', text: 'the Cogs' }]),
    place('cogs', 'Cogs', [{ type: 'contains', text: 'the Choir Furnace' }]),
    place('choirFurnace', 'Choir Furnace', []),
    place('skybridgeInn', 'Skybridge Inn', [{ type: 'inside', text: 'Shardn' }]),
    place('verdantCrucibel', 'The Verdant Crucibel', [
      { type: 'inside', text: 'Shardn' },
      { type: 'near', text: 'The Brass Lantern' }
    ]),
    place('shardnPort', 'Shardn Port', [{ type: 'inside', text: 'Shardn' }]),
    place('orinnsOffice', "Orinn's office", [{ type: 'inside', text: 'Cogs' }]),
    place('redHammerPub', 'The Red Hammer Pub', [{ type: 'inside', text: 'Cogs' }]),
    place('brassLantern', 'The Brass Lantern', [{ type: 'inside', text: 'Cogs' }]),
    place('upperMenthis', 'Upper Menthis', [
      { type: 'direction', text: 'above Shardn' },
      { type: 'contains', text: 'The SkySpire Towers' }
    ]),
    place('skySpireTowers', 'The SkySpire Towers', []),
    place('whisperingPage', 'Whispering Page', [{ type: 'near', text: 'The Brass Lantern' }]),
    place('ironRootForge', 'Iron Root Forge', [{ type: 'near', text: 'Whispering Page' }])
  ];
}

await test('buildEdges: links Whispering Page to Brass Lantern but not Cogs', () => {
  const places = makeShardnPlaces();
  const edges = buildEdges(places);
  const wp = edges.filter((e) => e.a === 'whisperingPage' || e.b === 'whisperingPage');
  assert.ok(
    wp.some((e) => e.a === 'brassLantern' || e.b === 'brassLantern'),
    'expected an edge between Whispering Page and The Brass Lantern'
  );
  assert.ok(
    !wp.some((e) => e.a === 'cogs' || e.b === 'cogs'),
    'Whispering Page should not link to Cogs'
  );
});

await test('buildEdges: records inside/contains edges with a mentioning first', () => {
  const places = makeShardnPlaces();
  const edges = buildEdges(places);
  const insideEdge = edges.find((e) => e.type === 'inside' && e.a === 'skybridgeInn');
  assert.ok(insideEdge, 'Skybridge Inn should have an `inside` edge naming Shardn');
  assert.equal(insideEdge.b, 'shardn');

  const containsEdge = edges.find((e) => e.type === 'contains' && e.a === 'shardn');
  assert.ok(containsEdge, 'Shardn should have a `contains` edge naming Cogs');
  assert.equal(containsEdge.b, 'cogs');
});

await test('buildContainment: builds the exact Shardn / Cogs tree', () => {
  const places = makeShardnPlaces();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);

  assert.equal(containment.parentOf.cogs, 'shardn');
  assert.equal(containment.parentOf.choirFurnace, 'cogs');
  assert.equal(containment.parentOf.skybridgeInn, 'shardn');
  assert.equal(containment.parentOf.verdantCrucibel, 'shardn');
  assert.equal(containment.parentOf.shardnPort, 'shardn');
  assert.equal(containment.parentOf.orinnsOffice, 'cogs');
  assert.equal(containment.parentOf.redHammerPub, 'cogs');
  assert.equal(containment.parentOf.brassLantern, 'cogs');
  assert.equal(containment.parentOf.skySpireTowers, 'upperMenthis');

  // near/direction never create containment
  assert.equal(containment.parentOf.whisperingPage, undefined);
  assert.equal(containment.parentOf.ironRootForge, undefined);
  assert.equal(containment.parentOf.upperMenthis, undefined);
  assert.equal(containment.parentOf.shardn, undefined);

  assert.deepEqual(new Set(containment.childrenOf.shardn), new Set(['cogs', 'skybridgeInn', 'verdantCrucibel', 'shardnPort']));
  assert.deepEqual(new Set(containment.childrenOf.cogs), new Set(['choirFurnace', 'orinnsOffice', 'redHammerPub', 'brassLantern']));
  assert.deepEqual(new Set(containment.childrenOf.upperMenthis), new Set(['skySpireTowers']));

  assert.ok(containment.roots.includes('shardn'));
  assert.ok(containment.roots.includes('upperMenthis'));
  assert.ok(!containment.roots.includes('cogs'));

  assert.equal(containment.depthOf.shardn, 0);
  assert.equal(containment.depthOf.cogs, 1);
  assert.equal(containment.depthOf.choirFurnace, 2);
  assert.equal(containment.depthOf.upperMenthis, 0);
  assert.equal(containment.depthOf.skySpireTowers, 1);
});

await test('buildContainment: first parent wins', () => {
  // Names need to be >= 3 chars — buildEdges ignores shorter names entirely.
  const places = [
    place('a', 'Aldby', [{ type: 'inside', text: 'Beckton' }, { type: 'inside', text: 'Carwick' }]),
    place('b', 'Beckton', []),
    place('c', 'Carwick', [])
  ];
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  assert.equal(containment.parentOf.a, 'b');
});

await test('buildContainment: drops an edge that would create a cycle', () => {
  const places = [
    place('a', 'Aldby', [{ type: 'inside', text: 'Beckton' }]),
    place('b', 'Beckton', [{ type: 'inside', text: 'Aldby' }])
  ];
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  assert.equal(containment.parentOf.a, 'b');
  assert.equal(containment.parentOf.b, undefined, 'B->A would make B its own descendant\'s parent');
});

// ---------- descendantsOf ----------

await test('descendantsOf: collects grandchildren too', () => {
  const places = makeShardnPlaces();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  const desc = descendantsOf('shardn', containment.childrenOf);
  assert.ok(desc.has('cogs'));
  assert.ok(desc.has('choirFurnace')); // grandchild via Cogs
  assert.ok(desc.has('skybridgeInn'));
  assert.ok(!desc.has('upperMenthis'));
});

// ---------- isZone ----------

await test('isZone: a childless City is still a zone', () => {
  const containment = { childrenOf: {} };
  assert.equal(isZone({ _id: 'a', type: 'City' }, containment), true);
});

await test('isZone: a childless Landmark is a stop, not a zone', () => {
  const containment = { childrenOf: {} };
  assert.equal(isZone({ _id: 'a', type: 'Landmark' }, containment), false);
});

await test('isZone: a Landmark with a child becomes a zone', () => {
  const containment = { childrenOf: { a: ['b'] } };
  assert.equal(isZone({ _id: 'a', type: 'Landmark' }, containment), true);
});

// ---------- zoneRects ----------

function makeShardnPlacesTyped() {
  const places = makeShardnPlaces();
  const types = {
    shardn: 'Region',
    cogs: 'City',
    choirFurnace: 'Town',
    skybridgeInn: 'Shop / Inn',
    verdantCrucibel: 'Landmark',
    shardnPort: 'Landmark',
    orinnsOffice: 'Landmark',
    redHammerPub: 'Shop / Inn',
    brassLantern: 'Landmark',
    upperMenthis: 'City',
    skySpireTowers: 'Landmark',
    whisperingPage: 'Landmark',
    ironRootForge: 'Landmark'
  };
  return places.map((p) => ({ ...p, type: types[p._id] }));
}

function pointInRect(pt, rect) {
  return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

function rectInRect(inner, outer) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

await test('zoneRects: every member stop and child zone sits inside its zone, outer before inner', () => {
  const places = makeShardnPlacesTyped();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  const positions = {
    shardn: { x: 0, y: 0 },
    cogs: { x: 400, y: 300 },
    choirFurnace: { x: 420, y: 340 },
    skybridgeInn: { x: -100, y: 50 },
    verdantCrucibel: { x: 200, y: -150 },
    shardnPort: { x: 50, y: 200 },
    orinnsOffice: { x: 380, y: 260 },
    redHammerPub: { x: 440, y: 310 },
    brassLantern: { x: 410, y: 280 },
    upperMenthis: { x: -500, y: -500 },
    skySpireTowers: { x: -480, y: -520 },
    whisperingPage: { x: 700, y: 700 },
    ironRootForge: { x: 750, y: 750 }
  };
  const zones = zoneRects(places, positions, containment);
  const byId = new Map(zones.map((z) => [z.id, z]));

  // shardn, cogs and upperMenthis all have children -> zones. Choir Furnace
  // has no children but isn't a City/Region -> not a zone.
  const zoneIds = zones.map((z) => z.id);
  assert.deepEqual(new Set(zoneIds), new Set(['shardn', 'cogs', 'upperMenthis']));

  const shardnIdx = zoneIds.indexOf('shardn');
  const cogsIdx = zoneIds.indexOf('cogs');
  assert.ok(shardnIdx < cogsIdx, 'Shardn should be listed before the nested Cogs zone');

  for (const zone of zones) {
    for (const memberId of zone.memberIds) {
      const pt = positions[memberId];
      assert.ok(pointInRect(pt, zone.rect), `${memberId} should fall inside the ${zone.name} rect`);
    }
    for (const childId of zone.childZoneIds) {
      const childRect = byId.get(childId).rect;
      assert.ok(rectInRect(childRect, zone.rect), `${childId}'s rect should sit inside the ${zone.name} rect`);
    }
  }
});

await test('zoneRects: a saved rect is grown to cover new contents but never shrunk', () => {
  const places = [
    { _id: 'city', name: 'City', type: 'City', connections: [], mapX: 0, mapY: 0, mapW: 500, mapH: 400 }
  ];
  const containment = { childrenOf: {}, depthOf: { city: 0 } };
  // No members, so the only pressure on the rect is the saved size itself.
  const zones = zoneRects(places, { city: { x: 0, y: 0 } }, containment);
  const rect = zones[0].rect;
  assert.equal(rect.w, 500);
  assert.equal(rect.h, 400);

  // Now add a member far outside the saved rect — it must grow to cover it,
  // but the parts that already fit inside stay put (grow-only, not re-fit).
  const places2 = [
    ...places,
    { _id: 'stop', name: 'Stop', type: 'Landmark', connections: [{ type: 'inside', text: 'City' }] }
  ];
  const edges2 = buildEdges(places2);
  const containment2 = buildContainment(places2, edges2);
  const positions2 = { city: { x: 0, y: 0 }, stop: { x: 1000, y: 1000 } };
  const zones2 = zoneRects(places2, positions2, containment2);
  const grown = zones2.find((z) => z.id === 'city').rect;
  assert.ok(grown.w > 500 && grown.h > 400, 'rect should have grown to cover the far-away member');
  assert.ok(pointInRect(positions2.stop, grown));
  // The original saved top-left is still covered (never shrunk away from).
  assert.ok(grown.x <= 0 && grown.y <= 0);
});

await test('zoneRects: a childless zone (bare City/Region) gets the minimum size', () => {
  const places = [{ _id: 'city', name: 'Lonely City', type: 'City', connections: [] }];
  const containment = { childrenOf: {}, depthOf: { city: 0 } };
  const zones = zoneRects(places, { city: { x: 50, y: 50 } }, containment, { minW: 120, minH: 80 });
  assert.equal(zones[0].rect.w, 120);
  assert.equal(zones[0].rect.h, 80);
});

// ---------- stationFootprint ----------

await test('stationFootprint: no notes/NPCs is just the name row, no badges or list lines', () => {
  const fp = stationFootprint({ nameLength: 5 });
  assert.equal(fp.down, 18 + 6); // nameRowH + marginBottom, no badge row, no lines
  assert.equal(fp.right, 5 * TEXT_METRICS.nameCharW + TEXT_METRICS.marginRight);
});

await test('stationFootprint: 3 notes + 2 NPCs reserves a badge row plus 5 list lines', () => {
  const fp = stationFootprint({
    noteLines: ['Note one', 'Note two', 'Note three'],
    npcLines: ['Some NPC', 'Another NPC'],
    hasMore: false,
    nameLength: 10
  });
  assert.equal(fp.down, 18 + 20 + 13 * 5 + 6);
});

await test('stationFootprint: a line longer than the 28-char cap is measured at the cap, not its full length', () => {
  const capped = stationFootprint({ noteLines: ['x'.repeat(28)], nameLength: 1 });
  const overCap = stationFootprint({ noteLines: ['x'.repeat(80)], nameLength: 1 });
  assert.equal(overCap.right, capped.right, 'a line past 28 chars should not keep growing the footprint');
  assert.equal(overCap.right, 28 * TEXT_METRICS.listCharW + TEXT_METRICS.listIconW + TEXT_METRICS.marginRight);
});

// ---------- zoneRects with footprints/per-zone headers ----------

await test('zoneRects: a member\'s text footprint, not just its point, is covered by the zone rect (Upper Menthis case)', () => {
  const places = [
    { _id: 'upperMenthis', name: 'Upper Menthis', type: 'City', connections: [] },
    { _id: 'skySpireTowers', name: 'The SkySpire Towers', type: 'Landmark', connections: [] }
  ];
  const containment = { childrenOf: { upperMenthis: ['skySpireTowers'] }, depthOf: { upperMenthis: 0 } };
  const positions = { upperMenthis: { x: 0, y: 0 }, skySpireTowers: { x: 200, y: 100 } };
  // A 4-line list (2 notes + 2 NPCs), the kind that used to spill past the
  // minimum-size zone rect.
  const footprint = stationFootprint({
    noteLines: ['A fairly long note title'],
    npcLines: ['An NPC name here', 'Another one'],
    hasMore: true,
    nameLength: 'The SkySpire Towers'.length
  });
  const pad = 36;
  const zones = zoneRects(places, positions, containment, { pad, footprintOf: (id) => (id === 'skySpireTowers' ? footprint : null) });
  const rect = zones[0].rect;
  assert.ok(rect.x + rect.w >= positions.skySpireTowers.x + footprint.right + pad, 'rect should reach past the station\'s footprint on the right');
  assert.ok(rect.y + rect.h >= positions.skySpireTowers.y + footprint.down + pad, 'rect should reach past the station\'s footprint on the bottom');
});

await test('zoneRects: opts.headerOf reserves a per-zone header instead of the flat labelHeadroom (Cogs case)', () => {
  const places = [
    { _id: 'cogs', name: 'Cogs', type: 'City', connections: [] },
    { _id: 'redHammerPub', name: 'The Red Hammer Pub', type: 'Shop / Inn', connections: [] }
  ];
  const containment = { childrenOf: { cogs: ['redHammerPub'] }, depthOf: { cogs: 0 } };
  const positions = { cogs: { x: 0, y: 0 }, redHammerPub: { x: 400, y: 100 } };
  const pad = 36;
  const header = 30 + 20 + 13 * 3 + 8; // label + badges + a 3-line list + margin = 97
  assert.equal(header, 97);
  const zones = zoneRects(places, positions, containment, {
    pad,
    footprintOf: () => ({ right: 0, down: 0 }), // isolate the header's effect on the top edge
    headerOf: (id) => (id === 'cogs' ? header : null)
  });
  const rect = zones.find((z) => z.id === 'cogs').rect;
  assert.equal(rect.y, 100 - pad - header);
});

await test('zoneRects: a headerOf of exactly 0 is honoured, not replaced by the labelHeadroom fallback', () => {
  // `?? labelHeadroom` (not `|| labelHeadroom`) is what makes a real 0 stick.
  const places = [
    { _id: 'zone', name: 'Zone', type: 'City', connections: [] },
    { _id: 'member', name: 'Member', type: 'Landmark', connections: [] }
  ];
  const containment = { childrenOf: { zone: ['member'] }, depthOf: { zone: 0 } };
  const positions = { zone: { x: 0, y: 0 }, member: { x: 100, y: 100 } };
  const zones = zoneRects(places, positions, containment, {
    pad: 36,
    footprintOf: () => ({ right: 0, down: 0 }),
    headerOf: () => 0
  });
  assert.equal(zones[0].rect.y, 100 - 36 - 0);
});

// ---------- clamping a station's footprint inside its zone ----------

await test('clampPointToRect: asymmetric right/bottom margins keep a dragged footprint fully inside its zone', () => {
  const rect = { x: 0, y: 0, w: 400, h: 300 };
  const footprint = { right: 150, down: 80 };
  const pad = 36;
  const clamped = clampPointToRect({ x: 5000, y: 5000 }, rect, pad, pad + footprint.right, pad + footprint.down);
  assert.deepEqual(clamped, { x: 400 - 36 - 150, y: 300 - 36 - 80 });
});

// ---------- pushRectClear / resizeLimits ----------

await test('pushRectClear: a dragged zone slides out of a sibling by the smallest move, keeping the gap', () => {
  const sibling = { x: 200, y: 0, w: 200, h: 200 };
  // Overlapping the sibling's left edge by 20px — cheapest fix is to move left.
  const out = pushRectClear({ x: 120, y: 50, w: 100, h: 50 }, [sibling], 32);
  assert.deepEqual(out, { x: 200 - 32 - 100, y: 50, w: 100, h: 50 });
  // Deep inside the sibling but near its bottom — cheapest fix is downward.
  const down = pushRectClear({ x: 250, y: 170, w: 100, h: 50 }, [sibling], 32);
  assert.equal(down.y, 200 + 32);
  assert.equal(down.x, 250);
});

await test('pushRectClear: a rect already clear (gap included) is untouched, and settles between two siblings', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 300, y: 0, w: 100, h: 100 };
  const clear = { x: 150, y: 0, w: 50, h: 50 }; // 50 from a, 100 from b
  assert.deepEqual(pushRectClear(clear, [a, b], 32), clear);
  // Pushed off `a` straight into `b`'s gap zone: a second pass must resolve it.
  const settled = pushRectClear({ x: 90, y: 0, w: 150, h: 50 }, [a, b], 32);
  const gapTo = (r, o) => Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w), o.y - (r.y + r.h), r.y - (o.y + o.h));
  assert.ok(gapTo(settled, a) >= 32 || gapTo(settled, b) >= 32, 'must be clear of at least one sibling after settling');
});

await test('resizeLimits: growth stops short of a sibling to the right or below, ignores ones elsewhere', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const right = { x: 300, y: 20, w: 50, h: 50 };   // shares rows -> limits width
  const below = { x: 20, y: 250, w: 50, h: 50 };   // shares cols -> limits height
  const away = { x: 300, y: 300, w: 50, h: 50 };   // diagonal -> limits nothing
  const above = { x: 0, y: -200, w: 50, h: 50 };   // above -> limits nothing
  assert.deepEqual(resizeLimits(rect, [right, below, away, above], 32), { maxW: 300 - 32, maxH: 250 - 32 });
  assert.deepEqual(resizeLimits(rect, [], 32), { maxW: Infinity, maxH: Infinity });
});

// ---------- packLayout with footprints ----------

await test('packLayout: sibling zones are packed with a gap so they never touch', () => {
  // Two childless cities (zones) side by side inside a region, plus two
  // root-level cities — siblings at both levels must stay `zoneGap` apart.
  const places = [
    { _id: 'region', name: 'Region', type: 'Region', connections: [] },
    { _id: 'c1', name: 'City One', type: 'City', connections: [] },
    { _id: 'c2', name: 'City Two', type: 'City', connections: [] },
    { _id: 'r1', name: 'Root One', type: 'City', connections: [] },
    { _id: 'r2', name: 'Root Two', type: 'City', connections: [] }
  ];
  const containment = {
    childrenOf: { region: ['c1', 'c2'] },
    depthOf: { region: 0, c1: 1, c2: 1, r1: 0, r2: 0 },
    roots: ['region', 'r1', 'r2']
  };
  const { positions, sizes } = packLayout(places, containment, { perRow: 3, zoneGap: 32 });
  const rect = (id) => ({ x: positions[id].x, y: positions[id].y, w: sizes[id].w, h: sizes[id].h });
  const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
  assert.ok(gapBetween(rect('c1'), rect('c2')) >= 32, 'nested siblings should be at least zoneGap apart');
  assert.ok(gapBetween(rect('region'), rect('r1')) >= 32, 'root siblings should be at least zoneGap apart');
  assert.ok(gapBetween(rect('r1'), rect('r2')) >= 32, 'root siblings should be at least zoneGap apart');
});


function bboxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

await test('packLayout: footprint-aware stations packed into the same zone never overlap', () => {
  const stationIds = ['s1', 's2', 's3', 's4', 's5'];
  const places = [
    { _id: 'zone', name: 'Zone', type: 'City', connections: [] },
    ...stationIds.map((id) => ({ _id: id, name: `Station ${id}`, type: 'Landmark', connections: [] }))
  ];
  const containment = {
    childrenOf: { zone: stationIds },
    depthOf: { zone: 0, ...Object.fromEntries(stationIds.map((id) => [id, 1])) },
    roots: ['zone']
  };
  // A wide 4-line list — big enough that the flat default grid (120x90)
  // would have let these overlap without the footprint-aware pitch.
  const footprint = stationFootprint({
    noteLines: ['A fairly long note title indeed'],
    npcLines: ['Another fairly long NPC name', 'A third NPC name here'],
    hasMore: true,
    nameLength: 12
  });
  const { positions } = packLayout(places, containment, { footprintOf: () => footprint, perRow: 3 });
  const boxes = stationIds.map((id) => ({
    x: positions[id].x,
    y: positions[id].y,
    w: footprint.right,
    h: footprint.down
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!bboxesOverlap(boxes[i], boxes[j]), `${stationIds[i]} and ${stationIds[j]} should not overlap`);
    }
  }
  // Not just "no overlap" — the actual column/row pitch (3 per row) must be
  // the footprint-aware advance from spec F, not the flat 120x90 grid that
  // would have let a wide list clip into the next cell.
  const expectedPitchX = Math.max(120, footprint.right + 24);
  const expectedPitchY = Math.max(90, footprint.down + 16);
  assert.equal(positions.s2.x - positions.s1.x, expectedPitchX, 'horizontal pitch should reserve footprint.right + 24');
  assert.equal(positions.s4.y - positions.s1.y, expectedPitchY, 'row pitch (after wrapping at perRow=3) should reserve footprint.down + 16');
});

// ---------- clampPointToRect / clampRectInRect ----------

await test('clampPointToRect: a point already inside is unchanged', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(clampPointToRect({ x: 50, y: 60 }, rect, 10), { x: 50, y: 60 });
});

await test('clampPointToRect: pushes an outside point to the inset edge', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(clampPointToRect({ x: -20, y: 500 }, rect, 10), { x: 10, y: 90 });
});

await test('clampRectInRect: a rect already inside is unchanged', () => {
  const parent = { x: 0, y: 0, w: 200, h: 200 };
  const rect = { x: 20, y: 20, w: 50, h: 50 };
  assert.deepEqual(clampRectInRect(rect, parent), rect);
});

await test('clampRectInRect: a rect larger than its parent clamps to the parent\'s top-left', () => {
  const parent = { x: 10, y: 10, w: 100, h: 100 };
  const rect = { x: 500, y: 500, w: 300, h: 300 };
  const clamped = clampRectInRect(rect, parent);
  assert.equal(clamped.x, 10);
  assert.equal(clamped.y, 10);
  assert.equal(clamped.w, 300);
  assert.equal(clamped.h, 300);
});

await test('clampRectInRect: margins keep a child zone clear of the parent\'s padding and label', () => {
  const parent = { x: 0, y: 0, w: 400, h: 300 };
  // Dragged far past the bottom-right: stops `margin` short of the sides/bottom.
  assert.deepEqual(
    clampRectInRect({ x: 900, y: 900, w: 100, h: 50 }, parent, 36, 64),
    { x: 264, y: 214, w: 100, h: 50 }
  );
  // Dragged past the top-left: stops `margin` in from the left, `topMargin` down.
  assert.deepEqual(
    clampRectInRect({ x: -50, y: -50, w: 100, h: 50 }, parent, 36, 64),
    { x: 36, y: 64, w: 100, h: 50 }
  );
  // Already inside the padded area: untouched.
  assert.deepEqual(
    clampRectInRect({ x: 100, y: 100, w: 100, h: 50 }, parent, 36, 64),
    { x: 100, y: 100, w: 100, h: 50 }
  );
});

// ---------- edgeAttachPoint ----------

await test('edgeAttachPoint: lands on the rect boundary toward the source point', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 }; // centre (50,50)
  const pt = edgeAttachPoint(rect, { x: 500, y: 50 });
  assert.equal(pt.x, 100); // right edge
  assert.equal(pt.y, 50);
});

await test('edgeAttachPoint: a point already inside the rect attaches to the nearest edge', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(edgeAttachPoint(rect, { x: 60, y: 10 }), { x: 60, y: 0 }); // top is closest
  assert.deepEqual(edgeAttachPoint(rect, { x: 95, y: 40 }), { x: 100, y: 40 }); // right is closest
  assert.deepEqual(edgeAttachPoint(rect, { x: 50, y: 50 }), { x: 50, y: 50 }); // dead centre: nowhere better
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
