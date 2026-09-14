// Plain-node test for src/lib/characters.mjs — the Characters page's pure
// layout logic. Run with: node tests/characters.test.mjs

import assert from 'node:assert/strict';
import {
  alignmentForDisposition,
  bandFor,
  buildRelationEdges,
  clampAlignment,
  clusterNpcs,
  computeCharacterLayout,
  computeDepths,
  computeGroupHulls,
  describeRelation,
  dispositionFor,
  labelOf,
  normalizeNpc,
  relationsOf
} from '../src/lib/characters.mjs';

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

// Terse fixture builder: npc('a', {...}) -> a document with an _id.
const npc = (id, fields = {}) => ({ _id: id, name: id, ...fields });
const rel = (targetId, type, text = '') => ({ targetId, type, text });

// ---------- alignment ----------

await test('clampAlignment: coerces, rounds and clamps to -100…100', () => {
  assert.equal(clampAlignment(150), 100);
  assert.equal(clampAlignment(-150), -100);
  assert.equal(clampAlignment('40'), 40);
  assert.equal(clampAlignment(12.6), 13);
  assert.equal(clampAlignment(undefined), 0);
  assert.equal(clampAlignment('nonsense'), 0);
});

await test('alignment bands map onto the old disposition names', () => {
  assert.equal(dispositionFor(100), 'Ally');
  assert.equal(dispositionFor(70), 'Ally');
  assert.equal(dispositionFor(69), 'Friendly');
  assert.equal(dispositionFor(0), 'Neutral');
  assert.equal(dispositionFor(-24), 'Neutral');
  assert.equal(dispositionFor(-25), 'Suspicious');
  assert.equal(dispositionFor(-70), 'Hostile');
  assert.equal(bandFor(-100).label, 'Hostile');
});

await test('normalizeNpc: old docs get an alignment from their disposition', () => {
  assert.equal(normalizeNpc({ disposition: 'Hostile' }).alignment, -85);
  assert.equal(normalizeNpc({ disposition: 'Ally' }).alignment, 85);
  assert.equal(normalizeNpc({ disposition: 'Unknown' }).alignment, 0);
  // An explicit alignment always wins over the derived one.
  assert.equal(normalizeNpc({ disposition: 'Hostile', alignment: 20 }).alignment, 20);
  assert.equal(alignmentForDisposition('Friendly'), 50);
  // Missing arrays are filled in so the view can read them freely.
  assert.deepEqual(normalizeNpc({}).relations, []);
});

await test('labelOf: name, else descriptor, else Unnamed', () => {
  assert.equal(labelOf({ name: 'Alara' }), 'Alara');
  assert.equal(labelOf({ name: '  ', descriptor: 'half-orc henchman' }), 'half-orc henchman');
  assert.equal(labelOf({}), 'Unnamed');
});

// ---------- relations ----------

await test('buildRelationEdges: skips dangling and self relations', () => {
  const npcs = [
    npc('a', { relations: [rel('b', 'boss'), rel('ghost', 'boss'), rel('a', 'boss')] }),
    npc('b')
  ];
  const edges = buildRelationEdges(npcs);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].parent, 'a');
  assert.equal(edges[0].child, 'b');
});

await test('buildRelationEdges: "works for" is "boss of" upside down, and the pair collapses', () => {
  const upward = buildRelationEdges([npc('a', { relations: [rel('b', 'worksfor')] }), npc('b')]);
  assert.equal(upward[0].parent, 'b');
  assert.equal(upward[0].child, 'a');

  // Both halves recorded: one edge, not two overlapping ones.
  const both = buildRelationEdges([
    npc('boss', { relations: [rel('grunt', 'boss')] }),
    npc('grunt', { relations: [rel('boss', 'worksfor')] })
  ]);
  assert.equal(both.length, 1);
});

await test('buildRelationEdges: level relations carry no hierarchy', () => {
  const edges = buildRelationEdges([npc('a', { relations: [rel('b', 'sibling')] }), npc('b')]);
  assert.equal(edges[0].dir, 'level');
  assert.equal(edges[0].parent, null);
});

await test('computeDepths: chains stack up and cycles terminate', () => {
  const chain = [
    npc('boss', { relations: [rel('lt', 'boss')] }),
    npc('lt', { relations: [rel('grunt', 'boss')] }),
    npc('grunt')
  ];
  const depth = computeDepths(chain, buildRelationEdges(chain));
  assert.equal(depth.boss, 0);
  assert.equal(depth.lt, 1);
  assert.equal(depth.grunt, 2);

  const cycle = [
    npc('a', { relations: [rel('b', 'boss')] }),
    npc('b', { relations: [rel('a', 'boss')] })
  ];
  // The point is that this returns at all rather than spinning.
  const cycleDepth = computeDepths(cycle, buildRelationEdges(cycle));
  assert.ok(Number.isFinite(cycleDepth.a) && Number.isFinite(cycleDepth.b));
});

// ---------- clustering & layout ----------

await test('clusterNpcs: group members cluster by group, loose NPCs merge when related', () => {
  const npcs = [
    npc('g1', { groupId: 'gang' }),
    npc('g2', { groupId: 'gang' }),
    npc('loose1', { relations: [rel('loose2', 'sibling')] }),
    npc('loose2'),
    npc('alone')
  ].map(normalizeNpc);
  const groups = [{ _id: 'gang', name: 'The Gang' }];
  const clusters = clusterNpcs(npcs, groups, buildRelationEdges(npcs));

  assert.equal(clusters.length, 3);
  const gang = clusters.find((c) => c.groupId === 'gang');
  assert.equal(gang.members.length, 2);
  const pair = clusters.find((c) => !c.groupId && c.members.length === 2);
  assert.deepEqual(pair.members.map((n) => n._id).sort(), ['loose1', 'loose2']);
});

await test('clusterNpcs: a groupId with no matching group leaves the NPC loose', () => {
  const npcs = [npc('x', { groupId: 'deleted-group' })].map(normalizeNpc);
  const clusters = clusterNpcs(npcs, [], []);
  assert.equal(clusters[0].groupId, '');
});

await test('layout: friends left, enemies right, within a row and between clusters', () => {
  const npcs = [
    npc('enemy', { alignment: -90 }),
    npc('friend', { alignment: 90 }),
    npc('neutral', { alignment: 0 })
  ];
  const { pos } = computeCharacterLayout(npcs, []);
  assert.ok(pos.friend.x < pos.neutral.x, 'friend sits left of neutral');
  assert.ok(pos.neutral.x < pos.enemy.x, 'neutral sits left of the enemy');
  // Nobody is related, so everyone stays on the top row.
  assert.equal(pos.friend.y, 0);
  assert.equal(pos.enemy.y, 0);
});

await test('layout: a boss sits above the people who work for them', () => {
  const npcs = [
    npc('alara', { alignment: -80, relations: [rel('henchman', 'boss')] }),
    npc('henchman', { alignment: -50 })
  ];
  const { pos } = computeCharacterLayout(npcs, []);
  assert.ok(pos.alara.y < pos.henchman.y);
});

await test('layout: rows are global, so a loose NPC still sits below their boss in a group', () => {
  const npcs = [
    npc('alara', { groupId: 'gang', alignment: -80 }),
    npc('member', { groupId: 'gang', alignment: -60 }),
    npc('loose', { alignment: 0, relations: [rel('alara', 'worksfor')] })
  ];
  const { pos } = computeCharacterLayout(npcs, [{ _id: 'gang', name: 'Gang' }]);
  assert.equal(pos.alara.y, 0);
  assert.ok(pos.loose.y > pos.alara.y, 'the loose hireling hangs below the boss');
});

await test('layout: within a group, members are ordered by alignment left to right', () => {
  const npcs = [
    npc('hostile', { groupId: 'g', alignment: -80 }),
    npc('friendly', { groupId: 'g', alignment: 60 }),
    npc('middling', { groupId: 'g', alignment: 0 })
  ];
  const { pos } = computeCharacterLayout(npcs, [{ _id: 'g', name: 'Gang' }]);
  assert.ok(pos.friendly.x < pos.middling.x);
  assert.ok(pos.middling.x < pos.hostile.x);
});

await test('layout: clusters do not overlap horizontally', () => {
  const npcs = [
    npc('a1', { groupId: 'a', alignment: 80 }),
    npc('a2', { groupId: 'a', alignment: 70 }),
    npc('b1', { groupId: 'b', alignment: -70 }),
    npc('b2', { groupId: 'b', alignment: -80 })
  ];
  const groups = [{ _id: 'a', name: 'A' }, { _id: 'b', name: 'B' }];
  const { pos } = computeCharacterLayout(npcs, groups);
  const aRight = Math.max(pos.a1.x, pos.a2.x);
  const bLeft = Math.min(pos.b1.x, pos.b2.x);
  assert.ok(aRight < bLeft, 'the friendly group finishes before the hostile one starts');
});

await test('computeGroupHulls: boxes wrap their members and skip empty groups', () => {
  const npcs = [
    npc('a', { groupId: 'g' }),
    npc('b', { groupId: 'g' }),
    npc('c', { groupId: '' })
  ].map(normalizeNpc);
  const groups = [{ _id: 'g', name: 'Gang', color: '#70250a' }, { _id: 'empty', name: 'Nobody' }];
  const pos = { a: { x: 0, y: 0 }, b: { x: 200, y: 100 }, c: { x: 900, y: 0 } };
  const hulls = computeGroupHulls(pos, npcs, groups);

  assert.equal(hulls.length, 1);
  const [hull] = hulls;
  assert.equal(hull.count, 2);
  assert.ok(hull.x < 0 && hull.y < 0, 'box is padded outside the members');
  assert.ok(hull.x + hull.w > 200 && hull.y + hull.h > 100);
  assert.ok(hull.x + hull.w < 900, 'the ungrouped NPC is left outside');
});

await test('describeRelation: reads as a sentence, with the note appended', () => {
  assert.equal(describeRelation({ type: 'boss', text: '' }, 'Grak'), 'Boss of Grak');
  assert.equal(
    describeRelation({ type: 'boss', text: 'hired him' }, 'Grak'),
    'Boss of Grak — hired him'
  );
});

await test('relationsOf: includes relations other NPCs point at this one', () => {
  const npcs = [
    npc('alara', { relations: [rel('henchman', 'boss', 'hired him')] }),
    npc('henchman'),
    npc('stranger')
  ];
  const forHenchman = relationsOf(npcs[1], npcs);
  assert.equal(forHenchman.length, 1);
  assert.equal(forHenchman[0].incoming, true);
  assert.equal(forHenchman[0].target._id, 'alara');

  const forAlara = relationsOf(npcs[0], npcs);
  assert.equal(forAlara.length, 1);
  assert.equal(forAlara[0].incoming, false);

  assert.equal(relationsOf(npcs[2], npcs).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
