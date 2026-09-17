// Copies a finished build's installers into release-installers/ under their
// edition's name, so the two editions can be built in either order without one
// overwriting the other (both builds write the same bundle folder):
//
//   standard  MagicMinutes_<version>_x64-setup.exe
//   ai        MagicMinutes-AI_<version>_x64-setup.exe
//
// Only installers written by this build are taken: anything older than the
// build's start (passed in as --since, in ms) is ignored.
// Run: node scripts/collect-installers.mjs <standard|ai> --since <ms>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [edition, flag, sinceArg] = process.argv.slice(2);
const since = flag === '--since' ? Number(sinceArg) : NaN;
if (!['standard', 'ai'].includes(edition) || !Number.isFinite(since)) {
  console.error('Usage: node scripts/collect-installers.mjs <standard|ai> --since <ms>');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'src-tauri', 'target', 'release', 'bundle');
const out = join(root, 'release-installers');
const { version } = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const prefix = `MagicMinutes_${version}_`;
const rename = (name) => (edition === 'ai' ? `MagicMinutes-AI_${name.slice('MagicMinutes_'.length)}` : name);

mkdirSync(out, { recursive: true });
let copied = 0;
for (const kind of ['nsis', 'msi']) {
  const dir = join(bundle, kind);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!name.startsWith(prefix) || statSync(path).mtimeMs < since) continue;
    copyFileSync(path, join(out, rename(name)));
    console.log(`${kind}: release-installers/${rename(name)}`);
    copied++;
  }
}
if (!copied) {
  console.error(`No ${version} installers from this build were found in ${bundle}.`);
  process.exit(1);
}
