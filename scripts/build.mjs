// Builds one edition and collects its installers into release-installers/.
// Run: node scripts/build.mjs <standard|ai>   (or npm run build:standard / build:ai)

import { execSync } from 'node:child_process';

const edition = process.argv[2];
if (!['standard', 'ai'].includes(edition)) {
  console.error('Usage: node scripts/build.mjs <standard|ai>');
  process.exit(1);
}

// A second of slack, since file times can round down.
const started = Date.now() - 1000;
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (edition === 'ai') {
  run('node scripts/setup-ai.mjs');
  run('npx tauri build --config src-tauri/tauri.ai.conf.json');
} else {
  run('npx tauri build');
}
run(`node scripts/collect-installers.mjs ${edition} --since ${started}`);
