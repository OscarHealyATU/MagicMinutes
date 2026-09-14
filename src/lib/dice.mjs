// Dice-notation parsing for combo blocks. Pure module — node-testable.
//
// A block's `roll` field can contain, in any mix:
//   dice        "1d6", "2d6", "d8"          → damage pool
//   modifiers   "+5", "- 2"                 → flat damage
//   to-hit      "+7 to hit"                 → attack bonus (not damage)
//   advantage   "advantage", "adv", "ad", "++"   → d20 attack advantage
//   disadvantage "disadvantage", "disadv", "dis", "--"
// The `condition` field is free text; only to-hit and adv/dis markers are
// read from it (so prose like "deal 3d6 next turn" doesn't pollute damage).

const ADV_RE = /\+\+|\b(?:advantage|adv|ad)\b/i;
const DIS_RE = /--|\b(?:disadvantage|disadv|dis)\b/i;
const TO_HIT_RE = /([+-]?\s*\d+)\s*to\s*hit/gi;
const DICE_RE = /\b(\d*)d(\d+)\b/gi;
const MOD_RE = /([+-])\s*(\d+)/g;

export function parseRoll(text) {
  let t = (text || '').toLowerCase();
  const out = { adv: false, dis: false, dice: {}, mod: 0, toHit: 0, hasToHit: false, hasD20: false };

  if (ADV_RE.test(t)) out.adv = true;
  if (DIS_RE.test(t)) out.dis = true;
  t = t.replace(/\+\+|--/g, ' ');

  t = t.replace(TO_HIT_RE, (m, num) => {
    out.toHit += parseInt(num.replace(/\s+/g, ''), 10) || 0;
    out.hasToHit = true;
    return ' ';
  });

  t = t.replace(DICE_RE, (m, count, size) => {
    const s = parseInt(size, 10);
    const c = parseInt(count || '1', 10);
    if (s === 20) out.hasD20 = true; // the attack die, not damage
    else if (s > 0 && c > 0) out.dice[s] = (out.dice[s] || 0) + c;
    return ' ';
  });

  t = t.replace(MOD_RE, (m, sign, num) => {
    out.mod += (sign === '-' ? -1 : 1) * parseInt(num, 10);
    return ' ';
  });

  return out;
}

// Only attack-related info from free-text condition fields
function parseConditionAttack(text) {
  const t = (text || '').toLowerCase();
  const out = { adv: ADV_RE.test(t), dis: DIS_RE.test(t), toHit: 0 };
  let m;
  const re = new RegExp(TO_HIT_RE.source, 'gi');
  while ((m = re.exec(t))) out.toHit += parseInt(m[1].replace(/\s+/g, ''), 10) || 0;
  return out;
}

export function fmtDice(dice, mod) {
  const parts = Object.keys(dice)
    .map(Number)
    .sort((a, b) => b - a)
    .map((s) => `${dice[s]}d${s}`);
  if (mod > 0) parts.push(String(mod));
  let s = parts.join(' + ');
  if (mod < 0) s = s ? `${s} − ${-mod}` : String(mod);
  return s;
}

export function combineBlocks(blocks) {
  const total = { adv: false, dis: false, dice: {}, mod: 0, toHit: 0, hasAttack: false };
  for (const b of blocks || []) {
    const r = parseRoll(b.roll);
    const c = parseConditionAttack(b.condition);
    total.adv = total.adv || r.adv || c.adv;
    total.dis = total.dis || r.dis || c.dis;
    total.toHit += r.toHit + c.toHit;
    total.mod += r.mod;
    total.hasAttack = total.hasAttack || r.hasD20 || r.hasToHit || r.adv || r.dis || c.adv || c.dis || c.toHit !== 0;
    for (const s in r.dice) total.dice[s] = (total.dice[s] || 0) + r.dice[s];
  }

  const advState = total.adv && total.dis ? 'both' : total.adv ? 'adv' : total.dis ? 'dis' : null;
  const hitParts = [];
  if (advState === 'adv') hitParts.push('Advantage');
  if (advState === 'dis') hitParts.push('Disadvantage');
  if (advState === 'both') hitParts.push('Adv & Dis (cancel)');
  if (total.toHit !== 0) hitParts.push(`${total.toHit > 0 ? '+' : ''}${total.toHit} to hit`);

  const max =
    Object.keys(total.dice).reduce((sum, s) => sum + total.dice[s] * Number(s), 0) + total.mod;

  return {
    advState,
    toHit: total.toHit,
    dice: total.dice,
    mod: total.mod,
    hasAttack: total.hasAttack,
    notation: fmtDice(total.dice, total.mod),
    hitLabel: hitParts.join(' '),
    max: Object.keys(total.dice).length ? max : total.mod > 0 ? total.mod : 0
  };
}

const rand = (sides) => 1 + Math.floor(Math.random() * sides);

export function rollCombo(combined) {
  const result = { d20s: null, attackTotal: null, damageRolls: [], damageTotal: null };

  if (combined.hasAttack) {
    if (combined.advState === 'adv' || combined.advState === 'dis') {
      const a = rand(20);
      const b = rand(20);
      const pick = combined.advState === 'adv' ? Math.max(a, b) : Math.min(a, b);
      result.d20s = [a, b];
      result.attackTotal = pick + combined.toHit;
    } else {
      const a = rand(20);
      result.d20s = [a];
      result.attackTotal = a + combined.toHit;
    }
  }

  const sizes = Object.keys(combined.dice).map(Number).sort((a, b) => b - a);
  for (const s of sizes) {
    for (let i = 0; i < combined.dice[s]; i++) {
      result.damageRolls.push({ size: s, value: rand(s) });
    }
  }
  if (result.damageRolls.length || combined.mod) {
    result.damageTotal =
      result.damageRolls.reduce((sum, d) => sum + d.value, 0) + combined.mod;
  }

  return result;
}
