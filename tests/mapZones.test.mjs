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
  octagonSideFor,
  smallestSquareAround,
  squareFits,
  layoutZones,
  lobedGeometry,
  lobesAttachPoint,
  lobesOutline,
  lobesPath,
  boxFitsLobes,
  clampPointToLobes,
  pointInLobes,
  stationBox,
  OCTAGON_MAX_CUT,
  octagonAttachPoint,
  octagonCut,
  octagonPath,
  octagonPoints,
  packLayout,
  pointInOctagon,
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

// ---------- the real Varrow / Anvils data from the brief ----------

function makeVarrowPlaces() {
  return [
    place('varrow', 'Varrow', [{ type: 'contains', text: 'the Anvils' }]),
    place('anvils', 'Anvils', [{ type: 'contains', text: 'the Ember Forge' }]),
    place('emberForge', 'Ember Forge', []),
    place('gildedGooseInn', 'Gilded Goose Inn', [{ type: 'inside', text: 'Varrow' }]),
    place('greenAlembic', 'The Green Alembic', [
      { type: 'inside', text: 'Varrow' },
      { type: 'near', text: 'The Tin Kettle' }
    ]),
    place('varrowPort', 'Varrow Port', [{ type: 'inside', text: 'Varrow' }]),
    place('tobinsOffice', "Tobin's office", [{ type: 'inside', text: 'Anvils' }]),
    place('saltedBoar', 'The Salted Boar', [{ type: 'inside', text: 'Anvils' }]),
    place('tinKettle', 'The Tin Kettle', [{ type: 'inside', text: 'Anvils' }]),
    place('upperEsterly', 'Upper Esterly', [
      { type: 'direction', text: 'above Varrow' },
      { type: 'contains', text: 'The Moonspire Towers' }
    ]),
    place('moonspireTowers', 'The Moonspire Towers', []),
    place('whistlingReed', 'Whistling Reed', [{ type: 'near', text: 'The Tin Kettle' }]),
    place('stonewoodMill', 'Stonewood Mill', [{ type: 'near', text: 'Whistling Reed' }])
  ];
}

await test('buildEdges: links Whistling Reed to Tin Kettle but not Anvils', () => {
  const places = makeVarrowPlaces();
  const edges = buildEdges(places);
  const wp = edges.filter((e) => e.a === 'whistlingReed' || e.b === 'whistlingReed');
  assert.ok(
    wp.some((e) => e.a === 'tinKettle' || e.b === 'tinKettle'),
    'expected an edge between Whistling Reed and The Tin Kettle'
  );
  assert.ok(
    !wp.some((e) => e.a === 'anvils' || e.b === 'anvils'),
    'Whistling Reed should not link to Anvils'
  );
});

await test('buildEdges: records inside/contains edges with a mentioning first', () => {
  const places = makeVarrowPlaces();
  const edges = buildEdges(places);
  const insideEdge = edges.find((e) => e.type === 'inside' && e.a === 'gildedGooseInn');
  assert.ok(insideEdge, 'Gilded Goose Inn should have an `inside` edge naming Varrow');
  assert.equal(insideEdge.b, 'varrow');

  const containsEdge = edges.find((e) => e.type === 'contains' && e.a === 'varrow');
  assert.ok(containsEdge, 'Varrow should have a `contains` edge naming Anvils');
  assert.equal(containsEdge.b, 'anvils');
});

await test('buildContainment: builds the exact Varrow / Anvils tree', () => {
  const places = makeVarrowPlaces();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);

  assert.equal(containment.parentOf.anvils, 'varrow');
  assert.equal(containment.parentOf.emberForge, 'anvils');
  assert.equal(containment.parentOf.gildedGooseInn, 'varrow');
  assert.equal(containment.parentOf.greenAlembic, 'varrow');
  assert.equal(containment.parentOf.varrowPort, 'varrow');
  assert.equal(containment.parentOf.tobinsOffice, 'anvils');
  assert.equal(containment.parentOf.saltedBoar, 'anvils');
  assert.equal(containment.parentOf.tinKettle, 'anvils');
  assert.equal(containment.parentOf.moonspireTowers, 'upperEsterly');

  // near/direction never create containment
  assert.equal(containment.parentOf.whistlingReed, undefined);
  assert.equal(containment.parentOf.stonewoodMill, undefined);
  assert.equal(containment.parentOf.upperEsterly, undefined);
  assert.equal(containment.parentOf.varrow, undefined);

  assert.deepEqual(new Set(containment.childrenOf.varrow), new Set(['anvils', 'gildedGooseInn', 'greenAlembic', 'varrowPort']));
  assert.deepEqual(new Set(containment.childrenOf.anvils), new Set(['emberForge', 'tobinsOffice', 'saltedBoar', 'tinKettle']));
  assert.deepEqual(new Set(containment.childrenOf.upperEsterly), new Set(['moonspireTowers']));

  assert.ok(containment.roots.includes('varrow'));
  assert.ok(containment.roots.includes('upperEsterly'));
  assert.ok(!containment.roots.includes('anvils'));

  assert.equal(containment.depthOf.varrow, 0);
  assert.equal(containment.depthOf.anvils, 1);
  assert.equal(containment.depthOf.emberForge, 2);
  assert.equal(containment.depthOf.upperEsterly, 0);
  assert.equal(containment.depthOf.moonspireTowers, 1);
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
  const places = makeVarrowPlaces();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  const desc = descendantsOf('varrow', containment.childrenOf);
  assert.ok(desc.has('anvils'));
  assert.ok(desc.has('emberForge')); // grandchild via Anvils
  assert.ok(desc.has('gildedGooseInn'));
  assert.ok(!desc.has('upperEsterly'));
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

function makeVarrowPlacesTyped() {
  const places = makeVarrowPlaces();
  const types = {
    varrow: 'Region',
    anvils: 'City',
    emberForge: 'Town',
    gildedGooseInn: 'Shop / Inn',
    greenAlembic: 'Landmark',
    varrowPort: 'Landmark',
    tobinsOffice: 'Landmark',
    saltedBoar: 'Shop / Inn',
    tinKettle: 'Landmark',
    upperEsterly: 'City',
    moonspireTowers: 'Landmark',
    whistlingReed: 'Landmark',
    stonewoodMill: 'Landmark'
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
  const places = makeVarrowPlacesTyped();
  const edges = buildEdges(places);
  const containment = buildContainment(places, edges);
  const positions = {
    varrow: { x: 0, y: 0 },
    anvils: { x: 400, y: 300 },
    emberForge: { x: 420, y: 340 },
    gildedGooseInn: { x: -100, y: 50 },
    greenAlembic: { x: 200, y: -150 },
    varrowPort: { x: 50, y: 200 },
    tobinsOffice: { x: 380, y: 260 },
    saltedBoar: { x: 440, y: 310 },
    tinKettle: { x: 410, y: 280 },
    upperEsterly: { x: -500, y: -500 },
    moonspireTowers: { x: -480, y: -520 },
    whistlingReed: { x: 700, y: 700 },
    stonewoodMill: { x: 750, y: 750 }
  };
  const { zones, positions: laid } = layoutZones(places, positions, containment);
  const byId = new Map(zones.map((z) => [z.id, z]));

  // varrow, anvils and upperEsterly all have children -> zones. Ember Forge
  // has no children but isn't a City/Region -> not a zone.
  const zoneIds = zones.map((z) => z.id);
  assert.deepEqual(new Set(zoneIds), new Set(['varrow', 'anvils', 'upperEsterly']));

  const varrowIdx = zoneIds.indexOf('varrow');
  const anvilsIdx = zoneIds.indexOf('anvils');
  assert.ok(varrowIdx < anvilsIdx, 'Varrow should be listed before the nested Anvils zone');

  for (const zone of zones) {
    for (const memberId of zone.memberIds) {
      const pt = laid[memberId];
      assert.ok(pointInRect(pt, zone.rect), `${memberId} should fall inside the ${zone.name} rect`);
      assert.ok(pointInLobes(zone.lobes, pt), `${memberId} should fall inside the ${zone.name} outline`);
    }
    for (const childId of zone.childZoneIds) {
      const childRect = byId.get(childId).rect;
      assert.ok(rectInRect(childRect, zone.rect), `${childId}'s rect should sit inside the ${zone.name} rect`);
    }
  }
});

await test('zoneRects: zones are always square, so they draw as regular octagons', () => {
  const { places, containment } = (() => {
    const ps = [
      { _id: 'city', name: 'City', type: 'City', connections: [] },
      { _id: 'a', name: 'Alpha', type: 'Landmark', connections: [{ type: 'inside', text: 'City' }] },
      { _id: 'b', name: 'Bravo', type: 'Landmark', connections: [{ type: 'inside', text: 'City' }] }
    ];
    return { places: ps, containment: buildContainment(ps, buildEdges(ps)) };
  })();
  // A wide row of places.
  const positions = { city: { x: 0, y: 0 }, a: { x: 0, y: 0 }, b: { x: 900, y: 0 } };
  const { zones } = layoutZones(places, positions, containment);
  const z = zones[0];
  assert.equal(z.rect.w, z.rect.h);
  assert.equal(z.lobes[0].cut, octagonCut(z.rect, Infinity), 'regular, uncapped corners');
  assert.ok(z.lobes[0].cut > OCTAGON_MAX_CUT);
  assert.ok(squareFits(z.rect, z.contentBounds), 'contents clear the cut corners');
});

await test('zoneRects: a saved square grows evenly to cover new contents but never shrinks; a stretched legacy size is ignored', () => {
  const places = [
    { _id: 'city', name: 'City', type: 'City', connections: [], mapX: 0, mapY: 0, mapW: 500, mapH: 500 }
  ];
  const containment = { childrenOf: {}, depthOf: { city: 0 } };
  const rect = zoneRects(places, { city: { x: 0, y: 0 } }, containment)[0].rect;
  assert.deepEqual(rect, { x: 0, y: 0, w: 500, h: 500 });

  const places2 = [
    ...places,
    { _id: 'stop', name: 'Stop', type: 'Landmark', connections: [{ type: 'inside', text: 'City' }] }
  ];
  const containment2 = buildContainment(places2, buildEdges(places2));
  const positions2 = { city: { x: 0, y: 0 }, stop: { x: 1000, y: 1000 } };
  const zone = layoutZones(places2, positions2, containment2).zones.find((z) => z.id === 'city');
  assert.equal(zone.rect.w, zone.rect.h);
  assert.ok(zone.rect.w > 500);
  assert.ok(squareFits(zone.rect, zone.contentBounds));
  const r = zone.rect;
  assert.ok(r.x <= 0 && r.y <= 0 && r.x + r.w >= 500 && r.y + r.h >= 500, 'still covers where it was');

  const legacy = [{ _id: 'city', name: 'City', type: 'City', connections: [], mapX: 0, mapY: 0, mapW: 1500, mapH: 300 }];
  const lr = zoneRects(legacy, { city: { x: 0, y: 0 } }, containment)[0].rect;
  assert.ok(lr.w < 1500 && lr.w === lr.h, 'an old stretched size is not blown up into a huge square');
});

await test('zoneRects: a childless zone (bare City/Region) gets the minimum square', () => {
  const places = [{ _id: 'city', name: 'Lonely City', type: 'City', connections: [] }];
  const containment = { childrenOf: {}, depthOf: { city: 0 } };
  const zones = zoneRects(places, { city: { x: 50, y: 50 } }, containment, { minW: 120, minH: 80 });
  assert.equal(zones[0].rect.w, 120);
  assert.equal(zones[0].rect.h, 120);
  assert.equal(zones[0].rect.x + 60, 50, 'centred on its anchor');
});

await test('octagonSideFor/smallestSquareAround: the header fits the straight top edge and contents clear the corners', () => {
  const side = octagonSideFor(300, 100, 250);
  const cut = octagonCut({ w: side, h: side }, Infinity);
  assert.ok(side - 2 * cut >= 250 - 1, 'top edge long enough for the header');
  const box = { x: 10, y: 20, w: 300, h: 100 };
  const sq = smallestSquareAround(160, 70, box);
  assert.ok(squareFits(sq, box));
  assert.ok(!squareFits({ x: sq.x + 3, y: sq.y + 3, w: sq.w - 6, h: sq.h - 6 }, box), 'and it is close to the smallest');
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

await test('zoneRects: a member\'s text footprint, not just its point, is covered by the zone rect (Upper Esterly case)', () => {
  const places = [
    { _id: 'upperEsterly', name: 'Upper Esterly', type: 'City', connections: [] },
    { _id: 'moonspireTowers', name: 'The Moonspire Towers', type: 'Landmark', connections: [] }
  ];
  const containment = { childrenOf: { upperEsterly: ['moonspireTowers'] }, depthOf: { upperEsterly: 0 } };
  const positions = { upperEsterly: { x: 0, y: 0 }, moonspireTowers: { x: 200, y: 100 } };
  // A 4-line list (2 notes + 2 NPCs), the kind that used to spill past the
  // minimum-size zone rect.
  const footprint = stationFootprint({
    noteLines: ['A fairly long note title'],
    npcLines: ['An NPC name here', 'Another one'],
    hasMore: true,
    nameLength: 'The Moonspire Towers'.length
  });
  const pad = 36;
  const zones = zoneRects(places, positions, containment, { pad, footprintOf: (id) => (id === 'moonspireTowers' ? footprint : null) });
  const rect = zones[0].rect;
  assert.ok(rect.x + rect.w >= positions.moonspireTowers.x + footprint.right + pad, 'rect should reach past the station\'s footprint on the right');
  assert.ok(rect.y + rect.h >= positions.moonspireTowers.y + footprint.down + pad, 'rect should reach past the station\'s footprint on the bottom');
});

await test('zoneRects: opts.headerOf reserves a per-zone header above the places (Anvils case)', () => {
  const places = [
    { _id: 'anvils', name: 'Anvils', type: 'City', connections: [] },
    { _id: 'saltedBoar', name: 'The Salted Boar', type: 'Shop / Inn', connections: [] }
  ];
  const containment = { childrenOf: { anvils: ['saltedBoar'] }, depthOf: { anvils: 0 } };
  const positions = { anvils: { x: 0, y: 0 }, saltedBoar: { x: 400, y: 100 } };
  const pad = 36;
  const header = 30 + 20 + 13 * 3 + 8; // label + badges + a 3-line list + margin = 97
  const zone = (h) =>
    layoutZones(places, positions, containment, {
      pad,
      footprintOf: () => ({ right: 0, down: 0 }),
      headerOf: (id) => (id === 'anvils' ? h : null)
    }).zones[0];
  const z = zone(header);
  assert.equal(z.contentBounds.y, 100 - 16 - pad - header, 'the dot sits 16px above the point');
  assert.ok(100 - z.rect.y >= header + pad, 'the place sits below the header');
  assert.equal(z.stationObstacles[0].h, header, 'places are kept off the header');
  assert.ok(zone(header).rect.w > zone(28).rect.w, 'a taller header makes a bigger octagon');
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
  assert.equal(zones[0].contentBounds.y, 100 - 16 - 36 - 0);
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

// ---------- octagon zones ----------

await test('octagonCut: regular-octagon proportion of the short side, capped', () => {
  assert.equal(OCTAGON_MAX_CUT, 64);
  assert.equal(octagonCut({ x: 0, y: 0, w: 1000, h: 600 }), OCTAGON_MAX_CUT);
  assert.equal(octagonCut({ x: 0, y: 0, w: 120, h: 80 }), 23); // 80 / (2 + sqrt 2), rounded
  assert.equal(octagonCut({ x: 0, y: 0, w: 0, h: 50 }), 0);
  assert.equal(octagonCut({ x: 0, y: 0, w: NaN, h: 50 }), 0);
});

await test('octagonCut: a square zone under the cap is a regular octagon (all sides equal)', () => {
  for (const side of [80, 150, 200]) {
    const rect = { x: 0, y: 0, w: side, h: side };
    const pts = octagonPoints(rect, octagonCut(rect));
    const lengths = pts.map((a, i) => {
      const b = pts[(i + 1) % pts.length];
      return Math.hypot(b.x - a.x, b.y - a.y);
    });
    const spread = Math.max(...lengths) - Math.min(...lengths);
    assert.ok(spread <= 2, `${side}px square: sides ${lengths.map((l) => l.toFixed(1)).join(', ')}`);
  }
});

await test('octagonPoints: eight points, all on the rect boundary, and a closed path', () => {
  const rect = { x: 10, y: 20, w: 300, h: 200 };
  const pts = octagonPoints(rect, 30);
  assert.equal(pts.length, 8);
  for (const p of pts) {
    const onEdge = p.x === 10 || p.x === 310 || p.y === 20 || p.y === 220;
    assert.ok(onEdge, `point ${p.x},${p.y} should lie on the rect edge`);
  }
  assert.deepEqual(pts[0], { x: 40, y: 20 });
  assert.deepEqual(pts[2], { x: 310, y: 50 });
  assert.match(octagonPath(rect, 30), /^M 40 20 L .* Z$/);
});

await test('octagonPoints: a cut bigger than the rect allows is clamped, not inverted', () => {
  const pts = octagonPoints({ x: 0, y: 0, w: 40, h: 20 }, 100);
  for (const p of pts) {
    assert.ok(p.x >= 0 && p.x <= 40 && p.y >= 0 && p.y <= 20);
  }
});

await test('pointInOctagon: corners are cut, the middle and flat edges are not', () => {
  const rect = { x: 0, y: 0, w: 200, h: 100 };
  assert.equal(pointInOctagon(rect, { x: 100, y: 50 }, 30), true);
  assert.equal(pointInOctagon(rect, { x: 100, y: 0 }, 30), true);
  assert.equal(pointInOctagon(rect, { x: 5, y: 5 }, 30), false); // in the rect, but in a cut corner
  assert.equal(pointInOctagon(rect, { x: 195, y: 95 }, 30), false);
  assert.equal(pointInOctagon(rect, { x: 250, y: 50 }, 30), false); // outside the rect altogether
});

await test('octagon zones never clip content clamped with the normal zone padding', () => {
  // clampPointToRect keeps stops (and the far corner of their text) at least
  // `pad` in from each edge; even the biggest cut must leave those inside.
  const pad = 36;
  for (const [w, h] of [[120, 80], [260, 180], [900, 500], [2000, 1400]]) {
    const rect = { x: 50, y: -30, w, h };
    const cut = octagonCut(rect);
    const corners = [
      { x: rect.x + pad, y: rect.y + pad },
      { x: rect.x + w - pad, y: rect.y + pad },
      { x: rect.x + pad, y: rect.y + h - pad },
      { x: rect.x + w - pad, y: rect.y + h - pad }
    ];
    for (const c of corners) {
      assert.ok(pointInOctagon(rect, c, cut), `${w}x${h}: ${c.x},${c.y} should be inside the octagon`);
    }
  }
});

await test('octagonAttachPoint: straight-on lines land on the flat edge, diagonal ones on the cut', () => {
  const rect = { x: 0, y: 0, w: 200, h: 200 };
  const cut = 36;
  assert.deepEqual(octagonAttachPoint(rect, { x: 500, y: 100 }, cut), { x: 200, y: 100 });

  // Towards the top-right corner: must stop on the diagonal, not the invisible corner.
  const p = octagonAttachPoint(rect, { x: 400, y: -200 }, cut);
  assert.ok(p.x < 200 && p.y > 0, 'stops short of the rect corner');
  assert.ok(Math.abs((200 - p.x) + p.y - cut) < 1e-6, `(${p.x}, ${p.y}) should lie on the top-right cut`);
});

await test('octagonAttachPoint: from inside the box it goes to the nearest outline point', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(octagonAttachPoint(rect, { x: 50, y: 50 }, 20), { x: 50, y: 50 }); // dead centre
  assert.deepEqual(octagonAttachPoint(rect, { x: 50, y: 8 }, 20), { x: 50, y: 0 }); // top edge
  const corner = octagonAttachPoint(rect, { x: 4, y: 4 }, 20); // in the cut-off corner
  assert.ok(Math.abs(corner.x + corner.y - 20) < 1e-6, 'lands on the top-left diagonal');
});

await test('octagonAttachPoint: with no cut it matches the rect version', () => {
  const rect = { x: 0, y: 0, w: 300, h: 120 };
  for (const from of [{ x: 900, y: 40 }, { x: -50, y: -400 }, { x: 150, y: 600 }]) {
    const a = octagonAttachPoint(rect, from, 0);
    const b = edgeAttachPoint(rect, from);
    assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
  }
});

// ---------- lobed zones (1-3 inner zones) ----------

const kid = (w, h, cornerCut = 23) => ({ w, h, cornerCut });

await test('lobedGeometry: 1, 2 and 3 inner zones make a single lobe, a pair and an L', () => {
  const one = lobedGeometry({ children: [kid(200, 120)] });
  assert.equal(one.lobes.length, 1);
  const two = lobedGeometry({ children: [kid(200, 120), kid(200, 120)] });
  assert.deepEqual(two.lobes.map((l) => [l.x / l.w, l.y / l.h]), [[0, 0], [1, 0]]);
  assert.equal(two.w, two.lobes[0].w * 2);
  const three = lobedGeometry({ children: [kid(200, 120), kid(200, 120), kid(200, 120)] });
  // Bottom-left, bottom-right, top-right; top-left stays empty.
  assert.deepEqual(three.lobes.map((l) => [l.x / l.w, l.y / l.h]), [[0, 1], [1, 1], [1, 0]]);
  assert.equal(three.labelLobe, 2, 'the name goes on the top lobe');
  assert.equal(three.handleLobe, 1, 'the resize handle goes on the bottom-right lobe');
  assert.throws(() => lobedGeometry({ children: [kid(1, 1), kid(1, 1), kid(1, 1), kid(1, 1)] }));
});

await test('lobedGeometry: lobes are all the biggest inner zone\'s size, each inner zone centred in its own', () => {
  const g = lobedGeometry({ children: [kid(400, 300), kid(150, 100)] });
  assert.equal(g.lobes[0].w, g.lobes[1].w);
  assert.equal(g.lobes[0].w, 400 + g.band * 2);
  const small = g.slots[1];
  const lobe = g.lobes[1];
  assert.ok(Math.abs(small.x + 75 - (lobe.x + lobe.w / 2)) < 1e-9);
  assert.ok(Math.abs(small.y + 50 - (lobe.y + lobe.h / 2)) < 1e-9);
});

await test('lobedGeometry: inner zone corners never poke through a lobe\'s cut corner', () => {
  for (const [w, h, band] of [[200, 120, 96], [1200, 900, 96], [300, 300, 200], [2000, 150, 96]]) {
    const innerCut = octagonCut({ w, h });
    const g = lobedGeometry({ children: [kid(w, h, innerCut)], minBand: band });
    const lobe = g.lobes[0];
    const pts = octagonPoints({ x: g.slots[0].x, y: g.slots[0].y, w, h }, innerCut);
    // Each inner corner point keeps the corner gap from the lobe's diagonal:
    // perpendicular distance from the line l + t = cut is (l + t - cut) / √2.
    for (const p of pts) {
      assert.ok(pointInOctagon(lobe, p, lobe.cut), `${w}x${h}: inner corner ${p.x},${p.y} outside the lobe`);
      const lt = Math.min(p.x - lobe.x, lobe.x + lobe.w - p.x) + Math.min(p.y - lobe.y, lobe.y + lobe.h - p.y);
      assert.ok((lt - lobe.cut) / Math.SQRT2 >= 24 - 1, `${w}x${h}: corner gap too small at ${p.x},${p.y}`);
    }
  }
});

await test('lobedGeometry: lobes are square; the band grows to fit places and header; a saved size scales them evenly', () => {
  const g0 = lobedGeometry({ children: [kid(400, 120)] });
  assert.equal(g0.lobes[0].w, g0.lobes[0].h, 'square lobes, even for a wide inner zone');
  const tall = { right: 120, down: 150 };
  const g = lobedGeometry({ children: [kid(200, 120)], memberFootprints: [tall], header: 20 });
  assert.ok(g.band >= stationBox({ x: 0, y: 0 }, tall).h + 32);
  const wide = { right: 400, down: 30 };
  const gw = lobedGeometry({ children: [kid(200, 120)], memberFootprints: [wide] });
  const l = gw.lobes[0];
  assert.ok(l.w - 2 * l.cut >= stationBox({ x: 0, y: 0 }, wide).w + 32 - 1, 'a wide place fits along the straight top edge');
  const hdr = lobedGeometry({ children: [kid(200, 120)], header: 200, pad: 36 });
  assert.ok(hdr.band >= 236);
  const named = lobedGeometry({ children: [kid(100, 100)], headerWidth: 500 });
  assert.ok(named.lobes[0].w - 2 * named.lobes[0].cut >= 500 - 1, 'a long header fits the top edge');

  const natural = lobedGeometry({ children: [kid(200, 120), kid(200, 120)] });
  const scaled = lobedGeometry({ children: [kid(200, 120), kid(200, 120)], saved: { w: natural.w + 400, h: natural.h + 200 } });
  assert.equal(scaled.w, natural.w + 400);
  assert.equal(scaled.h, natural.h + 200, 'scaled evenly, lobes stay square');
  assert.equal(scaled.naturalW, natural.w);
  const tooSmall = lobedGeometry({ children: [kid(200, 120), kid(200, 120)], saved: { w: 10, h: 10 } });
  assert.equal(tooSmall.w, natural.w, 'never smaller than it needs to be');
});

await test('lobesOutline/lobesPath: shared edges disappear and the outline is one closed loop', () => {
  const two = lobedGeometry({ children: [kid(200, 120), kid(200, 120)] }).lobes;
  assert.equal(lobesOutline(two).length, 14);
  const three = lobedGeometry({ children: [kid(200, 120), kid(200, 120), kid(200, 120)] }).lobes;
  assert.equal(lobesOutline(three).length, 20);
  for (const lobes of [two, three]) {
    const path = lobesPath(lobes);
    assert.equal((path.match(/M /g) || []).length, 1, 'one subpath');
    assert.ok(path.endsWith('Z'));
  }
  const single = lobedGeometry({ children: [kid(200, 120)] }).lobes;
  assert.equal(lobesOutline(single).length, 8);
});

await test('lobesAttachPoint: a line lands on the lobe nearest where it comes from', () => {
  const lobes = lobedGeometry({ children: [kid(200, 120), kid(200, 120)] }).lobes;
  const [left, right] = lobes;
  const fromRight = lobesAttachPoint(lobes, { x: right.x + right.w + 500, y: right.y + right.h / 2 });
  assert.ok(Math.abs(fromRight.x - (right.x + right.w)) < 1e-6);
  const fromLeft = lobesAttachPoint(lobes, { x: left.x - 500, y: left.y + left.h / 2 });
  assert.ok(Math.abs(fromLeft.x - left.x) < 1e-6);
  // From inside, the nearest visible edge — never the hidden shared one.
  const mid = { x: left.x + left.w - 5, y: left.y + left.h / 2 };
  const inside = lobesAttachPoint(lobes, mid);
  const onSharedEdge = Math.abs(inside.x - (left.x + left.w)) < 1 &&
    inside.y > left.y + left.cut + 1 && inside.y < left.y + left.h - left.cut - 1;
  assert.ok(!onSharedEdge, `not on the shared edge (got ${inside.x},${inside.y})`);
});

await test('clampPointToLobes: a place dropped on an inner zone moves to the nearest free spot in the band', () => {
  const g = lobedGeometry({ children: [kid(300, 200)] });
  const inner = { ...g.slots[0], w: 300, h: 200 };
  const fp = { right: 100, down: 40 };
  const ok = { x: g.lobes[0].w / 2 - 50, y: g.lobes[0].h - g.band / 2 - 10 };
  assert.ok(boxFitsLobes(stationBox(ok, fp), g.lobes, [inner], 16), 'test point should already fit');
  assert.deepEqual(clampPointToLobes(ok, fp, g.lobes, [inner], 16), ok, 'a point that fits is left alone');
  // Every drop point across the inner zone, not just ones that line up with a
  // search grid — and with a band sized to leave almost no spare height.
  for (const [footprint, geom] of [[fp, g], [{ right: 150, down: 71 }, lobedGeometry({ children: [kid(300, 200)], memberFootprints: [{ right: 150, down: 71 }] })]]) {
    const zoneRect = { ...geom.slots[0], w: 300, h: 200 };
    for (let dx = 0; dx < 300; dx += 7) {
      for (let dy = 0; dy < 200; dy += 11) {
        const moved = clampPointToLobes({ x: zoneRect.x + dx, y: zoneRect.y + dy }, footprint, geom.lobes, [zoneRect], 16);
        assert.ok(boxFitsLobes(stationBox(moved, footprint), geom.lobes, [zoneRect], 16), `no fit found from ${dx},${dy}`);
      }
    }
  }
  const outside = clampPointToLobes({ x: -900, y: -900 }, fp, g.lobes, [inner], 16);
  assert.ok(boxFitsLobes(stationBox(outside, fp), g.lobes, [inner], 16));
});

// Varrow containing three zones (alphabetical: Anvils, Skyport, Upper Esterly), one
// of which holds a zone of its own, plus Varrow's own places.
function lobedWorld() {
  const places = [
    { _id: 'varrow', name: 'Varrow', type: 'City', connections: [] },
    { _id: 'esterly', name: 'Upper Esterly', type: 'Region', connections: [{ type: 'inside', text: 'Varrow' }] },
    { _id: 'anvils', name: 'Anvils', type: 'Region', connections: [{ type: 'inside', text: 'Varrow' }] },
    { _id: 'sky', name: 'Skyport', type: 'Region', connections: [{ type: 'inside', text: 'Varrow' }] },
    { _id: 'dock', name: 'Dock Ward', type: 'Region', connections: [{ type: 'inside', text: 'Skyport' }] },
    { _id: 'furnace', name: 'Ember Forge', type: 'Landmark', connections: [{ type: 'inside', text: 'Anvils' }] },
    { _id: 'towers', name: 'Moonspire Towers', type: 'Landmark', connections: [{ type: 'inside', text: 'Upper Esterly' }] },
    { _id: 'inn', name: 'Gilded Goose Inn', type: 'Shop / Inn', connections: [{ type: 'inside', text: 'Varrow' }] },
    { _id: 'port', name: 'Varrow Port', type: 'Landmark', connections: [{ type: 'inside', text: 'Varrow' }] },
    { _id: 'alley', name: 'Copper Lane', type: 'Landmark', connections: [{ type: 'inside', text: 'Varrow' }] }
  ];
  const containment = buildContainment(places, buildEdges(places));
  return { places, containment };
}

await test('layoutZones: inner zones are centred in lobes in alphabetical order, taking their contents with them', () => {
  const { places, containment } = lobedWorld();
  const positions = {
    varrow: { x: 1000, y: 1000 }, esterly: { x: 0, y: 0 }, anvils: { x: 0, y: 0 }, sky: { x: 0, y: 0 },
    dock: { x: 0, y: 0 }, furnace: { x: 5000, y: 5000 }, towers: { x: -3000, y: 40 },
    inn: { x: 0, y: 0 }, port: { x: 0, y: 0 }, alley: { x: 0, y: 0 }
  };
  const { zones, positions: laid } = layoutZones(places, positions, containment);
  const z = new Map(zones.map((x) => [x.id, x]));
  const varrow = z.get('varrow');
  assert.equal(varrow.lobed, true);
  assert.equal(varrow.lobes.length, 3);
  // Anvils -> bottom-left, Skyport -> bottom-right, Upper Esterly -> top-right.
  const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  ['anvils', 'sky', 'esterly'].forEach((id, i) => {
    const c = centre(z.get(id).rect);
    const l = centre(varrow.lobes[i]);
    assert.ok(Math.abs(c.x - l.x) < 1e-6 && Math.abs(c.y - l.y) < 1e-6, `${id} centred in lobe ${i}`);
  });
  // Skyport has one inner zone, so it's lobed too, with Dock Ward centred inside.
  assert.equal(z.get('sky').lobed, true);
  const dc = centre(z.get('dock').rect);
  const sc = centre(z.get('sky').rect);
  assert.ok(Math.abs(dc.x - sc.x) < 1e-6 && Math.abs(dc.y - sc.y) < 1e-6);
  // Contents moved with their zone.
  assert.ok(pointInRect(laid.furnace, z.get('anvils').rect));
  assert.ok(pointInRect(laid.towers, z.get('esterly').rect));
  // Varrow's own places are in its band: inside the outline, off the inner zones and each other's zones.
  for (const id of ['inn', 'port', 'alley']) {
    assert.ok(pointInLobes(varrow.lobes, laid[id]), `${id} inside Varrow`);
    for (const inner of ['anvils', 'sky', 'esterly']) {
      assert.ok(!pointInRect(laid[id], z.get(inner).rect), `${id} not on ${inner}`);
    }
  }
});

await test('layoutZones: a saved size only stretches the lobes when it was saved for the same lobe count', () => {
  const { places, containment } = lobedWorld();
  const positions = Object.fromEntries(places.map((p) => [p._id, { x: 0, y: 0 }]));
  const natural = layoutZones(places, positions, containment).zones.find((z) => z.id === 'varrow').rect;
  const withSize = (mapLobes) =>
    places.map((p) => (p._id === 'varrow' ? { ...p, mapX: 0, mapY: 0, mapW: natural.w + 300, mapH: natural.h + 300, mapLobes } : p));
  const matching = layoutZones(withSize(3), positions, containment).zones.find((z) => z.id === 'varrow').rect;
  assert.equal(matching.w, natural.w + 300);
  for (const stale of [2, undefined]) {
    const r = layoutZones(withSize(stale), positions, containment).zones.find((z) => z.id === 'varrow').rect;
    assert.equal(r.w, natural.w, `mapLobes ${stale} should be ignored`);
    assert.equal(r.x, 0, 'but the saved top-left still anchors it');
  }
});

await test('layoutZones: 4+ inner zones fall back to one content-sized octagon', () => {
  const { places, containment: _ } = lobedWorld();
  const extra = { _id: 'fourth', name: 'Fourth Ward', type: 'Region', connections: [{ type: 'inside', text: 'Varrow' }] };
  const all = [...places, extra];
  const containment = buildContainment(all, buildEdges(all));
  const positions = Object.fromEntries(all.map((p, i) => [p._id, { x: i * 300, y: i * 200 }]));
  const { zones, positions: laid } = layoutZones(all, positions, containment);
  const varrow = zones.find((x) => x.id === 'varrow');
  assert.equal(varrow.lobed, false);
  assert.equal(varrow.lobes.length, 1);
  // Its inner zones aren't moved by Varrow (Skyport still centres Dock Ward, though).
  assert.deepEqual(laid.anvils, positions.anvils);
});

await test('packLayout + layoutZones: an arranged lobed map is stable and its places don\'t overlap', () => {
  const { places, containment } = lobedWorld();
  const fp = { right: 180, down: 70 };
  const opts = { footprintOf: () => fp };
  const { positions, sizes } = packLayout(places, containment, opts);
  // As Auto-arrange saves it: rounded, with the lobe count.
  const saved = places.map((p) =>
    sizes[p._id]
      ? { ...p, mapW: Math.round(sizes[p._id].w), mapH: Math.round(sizes[p._id].h), mapLobes: sizes[p._id].lobes }
      : p
  );
  const { zones, positions: laid } = layoutZones(saved, positions, containment, opts);
  for (const id of Object.keys(positions)) {
    assert.ok(
      Math.abs(laid[id].x - positions[id].x) < 1e-6 && Math.abs(laid[id].y - positions[id].y) < 1e-6,
      `${id} moved from ${JSON.stringify(positions[id])} to ${JSON.stringify(laid[id])}`
    );
  }
  const varrow = zones.find((x) => x.id === 'varrow');
  assert.equal(varrow.rect.w, sizes.varrow.w);
  const boxes = ['inn', 'port', 'alley'].map((id) => stationBox(laid[id], fp));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      assert.ok(!overlap, 'Varrow\'s places should not overlap each other');
    }
  }
});

await test('packLayout: a lobed zone with more places than its band holds grows until they all fit', () => {
  const extra = Array.from({ length: 14 }, (_, i) => ({
    _id: `p${i}`, name: `Place ${i}`, type: 'Landmark', connections: [{ type: 'inside', text: 'Varrow' }]
  }));
  const { places } = lobedWorld();
  const all = [...places, ...extra];
  const containment = buildContainment(all, buildEdges(all));
  const fp = { right: 200, down: 90 };
  const opts = { footprintOf: () => fp };
  const natural = lobedGeometry({
    children: [kid(1, 1), kid(1, 1), kid(1, 1)],
    memberFootprints: [fp]
  });
  const { positions, sizes } = packLayout(all, containment, opts);
  const saved = all.map((p) =>
    sizes[p._id] ? { ...p, mapW: Math.round(sizes[p._id].w), mapH: Math.round(sizes[p._id].h), mapLobes: sizes[p._id].lobes } : p
  );
  const { zones, positions: laid } = layoutZones(saved, positions, containment, opts);
  const varrow = zones.find((z) => z.id === 'varrow');
  assert.ok(varrow.rect.w > natural.w, 'it grew');
  const ids = ['inn', 'port', 'alley', ...extra.map((p) => p._id)];
  const boxes = ids.map((id) => stationBox(laid[id], fp));
  ids.forEach((id, i) => {
    assert.ok(boxFitsLobes(boxes[i], varrow.lobes, varrow.stationObstacles, 16), `${id} is in the band`);
    assert.deepEqual(laid[id], positions[id], `${id} wasn't moved when drawn`);
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), `${id} overlaps ${ids[j]}`);
    }
  });
});

await test('smallestSquareAround: always fits, and survives rounding the position', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const box = { x: rand() * 400 - 200, y: rand() * 400 - 200, w: rand() * 900 + 1, h: rand() * 900 + 1 };
    const cx = box.x + box.w * (0.3 + rand() * 0.4);
    const cy = box.y + box.h * (0.3 + rand() * 0.4);
    const sq = smallestSquareAround(cx, cy, box, rand() * 300);
    assert.equal(sq.w, sq.h);
    assert.ok(squareFits(sq, box), `box ${i} doesn't fit`);
    assert.ok(squareFits({ ...sq, x: Math.round(sq.x), y: Math.round(sq.y) }, box), `box ${i} doesn't fit after rounding`);
  }
});

await test('layoutZones: dropping a place anywhere the drag allows never makes its zone grow', () => {
  const places = [
    { _id: 'city', name: 'A City With A Longish Name', type: 'City', connections: [] },
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ _id: id, name: `Place ${id}`, type: 'Landmark', connections: [{ type: 'inside', text: 'A City With A Longish Name' }] }))
  ];
  const containment = buildContainment(places, buildEdges(places));
  const fp = { right: 170, down: 60 };
  const opts = { footprintOf: () => fp, headerOf: () => 60, headerWidthOf: () => 240 };
  const { positions, sizes } = packLayout(places, containment, opts);
  const saved = places.map((p) => (sizes[p._id] ? { ...p, mapX: Math.round(positions[p._id].x), mapY: Math.round(positions[p._id].y), mapW: sizes[p._id].w, mapH: sizes[p._id].h } : p));
  const zoneOf = (pos) => layoutZones(saved, pos, containment, opts).zones[0];
  const start = zoneOf(positions);
  assert.deepEqual(start.rect, { x: Math.round(positions.city.x), y: Math.round(positions.city.y), w: sizes.city.w, h: sizes.city.w }, 'arranged zone is drawn as saved');
  const r = start.rect;
  const targets = [
    [r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h / 2],
    [r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y + r.h / 2], [r.x + r.w / 2, r.y + r.h / 2]
  ];
  for (const [tx, ty] of targets) {
    for (const id of ['a', 'f']) {
      const dropped = clampPointToLobes({ x: tx, y: ty }, fp, start.lobes, start.stationObstacles, start.stationMargin);
      const z = zoneOf({ ...positions, [id]: dropped });
      assert.deepEqual(z.rect, r, `${id} dropped near ${tx},${ty} grew the zone`);
    }
  }
});

await test('lobedGeometry: an old stretched saved size is ignored', () => {
  const natural = lobedGeometry({ children: [kid(200, 200), kid(200, 200)] });
  const stretched = lobedGeometry({ children: [kid(200, 200), kid(200, 200)], saved: { w: 2400, h: 300 } });
  assert.equal(stretched.w, natural.w);
  assert.equal(stretched.h, natural.h);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
