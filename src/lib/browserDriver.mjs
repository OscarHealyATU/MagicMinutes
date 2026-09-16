// In-memory driver used when the app runs in a plain browser (vite dev without
// Tauri) — same seam as @tauri-apps/plugin-sql's Database object, same SQL
// shapes as tests/store.test.mjs's fake. Lets the frontend be developed and
// design-checked in a normal browser; nothing persists across reloads.

import { buildCreateDoc } from './store.mjs';

export function makeBrowserDriver() {
  const tables = new Map(); // table name -> Map(id -> doc JSON string)

  function table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }

  return {
    async execute(sql, params = []) {
      let m;
      if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/i))) {
        table(m[1]);
        return { rowsAffected: 0 };
      }
      if ((m = sql.match(/^INSERT INTO (\w+) \(id, doc\) VALUES/i))) {
        const [id, doc] = params;
        table(m[1]).set(id, doc);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^UPDATE (\w+) SET doc = \$1 WHERE id = \$2/i))) {
        const [doc, id] = params;
        table(m[1]).set(id, doc);
        return { rowsAffected: 1 };
      }
      if ((m = sql.match(/^DELETE FROM (\w+) WHERE id = \$1/i))) {
        const [id] = params;
        table(m[1]).delete(id);
        return { rowsAffected: 1 };
      }
      throw new Error(`browser driver: unhandled execute SQL: ${sql}`);
    },

    async select(sql, params = []) {
      let m;
      if ((m = sql.match(/^SELECT doc FROM (\w+) WHERE id = \$1/i))) {
        const [id] = params;
        const doc = table(m[1]).get(id);
        return doc ? [{ doc }] : [];
      }
      if ((m = sql.match(/^SELECT (?:id, )?doc FROM (\w+)/i))) {
        return [...table(m[1]).entries()].map(([id, doc]) => ({ id, doc }));
      }
      throw new Error(`browser driver: unhandled select SQL: ${sql}`);
    }
  };
}

// A small but complete sample campaign, so the browser preview (and the README
// screenshots taken from it) show every feature working: nested zones, each
// kind of map line, note/NPC badges, an unplaced note, a relation tree with
// groups, a combo with dice, and a finished session with a recap.
//
// Place connections use `type` ids from CONNECTION_TYPES and combo blocks use
// `type` ids from BLOCK_TYPES — the map and combo builder ignore anything else.
export async function seedDemoData(driver) {
  async function put(resource, body) {
    const doc = buildCreateDoc(resource, body);
    await driver.execute(`INSERT INTO ${resource} (id, doc) VALUES ($1, $2)`, [
      doc._id,
      JSON.stringify(doc)
    ]);
    return doc;
  }

  // ---------- Places ----------
  // The Vall Marches holds Cairne and Eberald, which hold the inn, the tannery
  // and the sealed shaft, so the Marches draws as two joined octagons with a
  // zone in each. The rest link up as lines.
  await put('places', {
    name: 'The Vall Marches',
    type: 'Region',
    description: 'Marshy border country, patrolled by nobody in particular.',
    connections: []
  });
  await put('places', {
    name: 'Cairne',
    type: 'City',
    description: 'Trade city on the marsh edge. Home base for now.',
    connections: [{ type: 'inside', text: 'the western edge of The Vall Marches' }]
  });
  await put('places', {
    name: 'The Lantern Inn',
    type: 'Shop / Inn',
    description: 'Warm, loud, and full of people who hear things.',
    connections: [{ type: 'inside', text: "Cairne's market square" }]
  });
  await put('places', {
    name: 'Old Tannery',
    type: 'Landmark',
    description: 'Smells terrible. The Ash Gang like it that way.',
    connections: [{ type: 'inside', text: 'the east docks of Cairne' }]
  });
  await put('places', {
    name: 'Eberald',
    type: 'Town',
    description: 'Mining town, mostly shut since the shaft was sealed.',
    connections: [
      { type: 'inside', text: 'the hills of The Vall Marches' },
      { type: 'route', text: "the King's Road, two days north of Cairne" }
    ]
  });
  await put('places', {
    name: 'The Sealed Shaft',
    type: 'Dungeon',
    description: 'Bricked up after the collapse. Someone keeps unbricking it.',
    connections: [{ type: 'inside', text: 'the north end of Eberald' }]
  });
  await put('places', {
    name: 'Whispering Falls',
    type: 'Landmark',
    description: 'A waterfall that carries voices from somewhere upstream.',
    connections: [{ type: 'near', text: 'an hour upriver from Eberald' }]
  });
  await put('places', {
    name: 'Greywater Marsh',
    type: 'Wilderness',
    description: 'Reeds taller than a person. Easy to get lost, easier to get eaten.',
    connections: [{ type: 'between', text: 'Cairne and the Sunken Bell Tower' }]
  });
  await put('places', {
    name: 'Sunken Bell Tower',
    type: 'Dungeon',
    description: 'Half-drowned tower. The bell still works.',
    connections: [{ type: 'note', text: 'the ferryman at Whispering Falls knows a dry path' }]
  });

  // ---------- Notes ----------
  await put('notes', {
    title: 'The sunken bell tower',
    category: 'Location',
    place: 'Sunken Bell Tower',
    tags: ['mystery'],
    content:
      'Half-sunk in Greywater Marsh. Locals say it rings on its own the night before a storm. Farah wants us to look into it.'
  });
  await put('notes', {
    title: 'Deal with the ferryman',
    category: 'Quest',
    place: 'Whispering Falls',
    tags: ['promise', 'gold'],
    content: 'We owe Old Marsh 20gp and one honest favour. He remembers debts.'
  });
  await put('notes', {
    title: 'Overheard at the Lantern',
    category: 'Session Log',
    place: 'The Lantern Inn',
    tags: ['rumour'],
    content: 'Two miners from Eberald arguing about the sealed shaft. "It breathes," one said.'
  });
  await put('notes', {
    title: "Alara's ledger",
    category: 'Lore',
    place: 'Old Tannery',
    tags: ['clue'],
    content: 'Payments to someone who signs with a crescent. Big sums, every new moon.'
  });
  await put('notes', {
    title: 'Session 4 cliffhanger',
    category: 'Session Log',
    place: 'Eberald',
    tags: ['cliffhanger'],
    pinned: true,
    content: 'We opened the sealed shaft. Something down there opened its eyes.'
  });
  await put('notes', {
    title: 'Things Bramblewick owes people',
    category: 'Misc',
    place: '',
    tags: ['debts'],
    content: 'Two silver to Vareth. An apology to Bob. A goat (long story).'
  });

  // ---------- Characters ----------
  const gang = await put('groups', { name: 'The Ash Gang', color: '#70250a' });
  const lantern = await put('groups', { name: 'The Lantern', color: '#3f5e3a' });

  const farah = await put('npcs', {
    name: 'Farah of the Lantern',
    race: 'Human',
    occupation: 'Innkeeper',
    location: 'The Lantern Inn',
    disposition: 'Friendly',
    alignment: 60,
    groupId: lantern._id,
    firstMet: 'Session 1, the Lantern common room',
    notes: 'Knows everyone. Pays in rumours.'
  });
  const mirel = await put('npcs', {
    name: 'Mirel Tanhow',
    race: 'Human',
    occupation: 'Mine foreman',
    location: 'Eberald',
    disposition: 'Friendly',
    alignment: 40,
    firstMet: 'Session 4, at the shaft entrance',
    notes: 'Wants the shaft sealed again. Knows more than she says.'
  });
  await put('npcs', {
    name: '',
    descriptor: 'Lantern pot-boy',
    race: 'Human',
    location: 'The Lantern Inn',
    disposition: 'Friendly',
    alignment: 30,
    groupId: lantern._id,
    relations: [
      { type: 'worksfor', targetId: farah._id, text: 'runs her errands' },
      { type: 'child', targetId: mirel._id, text: 'sends his wages home to Eberald' }
    ],
    notes: 'Listens at every door in the place.'
  });
  const alara = await put('npcs', {
    name: 'Alara Vesk',
    race: 'Human',
    occupation: 'Gang boss',
    location: 'Old Tannery',
    disposition: 'Hostile',
    alignment: -80,
    groupId: gang._id,
    firstMet: 'Session 3, the burning mill',
    notes: 'Runs the Ash Gang out of the old tannery. Wants the bell tower for herself.'
  });
  await put('npcs', {
    name: '',
    descriptor: 'half-orc henchman',
    race: 'Half-orc',
    location: 'Old Tannery',
    disposition: 'Suspicious',
    alignment: -55,
    groupId: gang._id,
    relations: [{ type: 'worksfor', targetId: alara._id, text: 'the one with the scar' }],
    notes: 'Broke the innkeeper’s door. Did not enjoy it.'
  });
  await put('npcs', {
    name: '',
    descriptor: 'goblin lookout',
    race: 'Goblin',
    location: 'Greywater Marsh',
    disposition: 'Neutral',
    alignment: -20,
    groupId: gang._id,
    relations: [{ type: 'worksfor', targetId: alara._id, text: 'only for coin' }],
    notes: 'Would sell Alara out for a warm meal.'
  });
  await put('npcs', {
    name: 'Old Marsh',
    race: 'Unknown',
    occupation: 'Ferryman',
    location: 'Whispering Falls',
    disposition: 'Neutral',
    alignment: 0,
    relations: [{ type: 'knows', targetId: farah._id, text: 'owes her a favour' }],
    notes: 'Never blinks. Counts favours like coins.'
  });

  await put('players', {
    characterName: 'Bramblewick',
    playerName: 'Sam',
    race: 'Halfling',
    className: 'Rogue',
    level: '4',
    description: 'Too curious for a long life.'
  });
  await put('players', {
    characterName: 'Vareth',
    playerName: 'Priya',
    race: 'Half-elf',
    className: 'Cleric',
    level: '4',
    description: 'Keeps the party alive and disapproving.'
  });
  await put('players', {
    characterName: 'Bob',
    playerName: 'Tom',
    race: 'Dwarf',
    className: 'Fighter',
    level: '4',
    description: 'Named himself. Regrets nothing.'
  });

  // ---------- Combos ----------
  await put('combos', {
    name: 'Shadow strike opener',
    description: 'Round one, when we win initiative and there is cover nearby.',
    blocks: [
      { type: 'bonus', text: 'Hide behind the smoke', condition: '', roll: '' },
      { type: 'action', text: 'Shortbow at the flanked target', condition: 'if still hidden', roll: '+7 to hit adv 1d6+4' },
      { type: 'feat', text: 'Sneak Attack', condition: 'if the arrow hits', roll: '2d6' },
      { type: 'movement', text: 'Back behind the pillar', condition: '', roll: '' }
    ]
  });
  await put('rolls', {
    comboName: 'Shadow strike opener',
    notation: '1d20+7',
    die: 20,
    rolls: [18],
    modifier: 7,
    total: 25,
    outcome: 'success'
  });

  // ---------- Sessions ----------
  await put('sessions', {
    number: 3,
    title: 'Smoke over the tannery',
    active: false,
    startedAt: '2026-09-06T18:00:00.000Z',
    endedAt: '2026-09-06T21:40:00.000Z',
    summary: 'We tailed the Ash Gang to the old tannery and found Alara’s ledger. Bob set something on fire. It was mostly fine.',
    activity: [
      { kind: 'note', name: "Alara's ledger", action: 'created' },
      { kind: 'npc', name: 'Alara Vesk', action: 'created' },
      { kind: 'place', name: 'Old Tannery', action: 'created' }
    ]
  });
  await put('sessions', {
    number: 4,
    title: 'The shaft beneath Eberald',
    active: false,
    startedAt: '2026-09-13T18:00:00.000Z',
    endedAt: '2026-09-13T22:15:00.000Z',
    summary: '',
    activity: [
      { kind: 'note', name: 'Session 4 cliffhanger', action: 'created' },
      { kind: 'note', name: 'Overheard at the Lantern', action: 'created' },
      { kind: 'npc', name: 'Mirel Tanhow', action: 'created' },
      { kind: 'place', name: 'Eberald', action: 'updated' }
    ]
  });
}
