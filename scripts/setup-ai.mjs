// Puts the files for the AI edition in src-tauri/ai/ (which git ignores; they
// are far too big for the repo):
//
//   ai/llama/     llama.cpp's prebuilt CPU engine (llama-completion + DLLs)
//   ai/models/    the model file (a GGUF)
//   ai/model.json which model to load and how to prompt it
//   ai/LICENSES/  licence texts that must ship alongside those files
//
// Everything is pinned and checked against a known SHA-256, so every AI build
// ships exactly the same engine and model. Run: node scripts/setup-ai.mjs
//
// To use a different model later: put its .gguf in ai/models/, point
// model.json's "file" at it, and change "promptTemplate" to that model's chat
// format. Then update MODEL below so fresh checkouts fetch the new one.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AI = join(ROOT, 'src-tauri', 'ai');

const LLAMA = {
  build: 'b11017',
  zip: 'llama-b11017-bin-win-cpu-x64.zip',
  sha256: '0bd069a6251c9026993cdc59217c08b7507d41b66ad4a3b0e226f702ac9058d2',
  // Only what llama-completion needs to run; the zip holds many other tools.
  keep: (name) =>
    /^llama-completion(\.exe|-impl\.dll)$/.test(name) ||
    /^(llama|llama-common|ggml|ggml-base|libomp)\.dll$/.test(name) ||
    /^ggml-cpu-.+\.dll$/.test(name) ||
    name === 'LICENSE-LLVM-OpenMP'
};

const MODEL = {
  name: 'Qwen3 0.6B',
  file: 'qwen3-0.6b-q4_k_m.gguf',
  sha256: '7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa',
  // The same file `ollama pull qwen3:0.6b` stores, named by its hash.
  ollamaBlob: join(homedir(), '.ollama', 'models', 'blobs', 'sha256-7f4030143c1c477224c5434f8272c662a8b042079a0a584f0a27a1684fe2e1fa'),
  license: 'https://huggingface.co/Qwen/Qwen3-0.6B/raw/main/LICENSE'
};

const MODEL_CONFIG = {
  name: MODEL.name,
  file: `models/${MODEL.file}`,
  // Qwen3's chat format, with its "thinking" switched off: an empty think
  // block tells the model to answer straight away.
  promptTemplate: '<|im_start|>user\n{prompt} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
  contextSize: 8192,
  maxTokens: 450,
  // Qwen's recommended settings for non-thinking mode, plus its suggested
  // presence penalty against the small model repeating itself.
  args: ['--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--min-p', '0', '--presence-penalty', '1.5'],
  // Qwen's control tokens, removed from notes before they go in the template.
  stripTokens: ['<|im_start|>', '<|im_end|>', '<|endoftext|>']
};

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, to) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

async function setupLlama() {
  const dir = join(AI, 'llama');
  // A marker written last, listing every file: a run that failed partway (an
  // exe without its DLLs) has no marker and gets redone from scratch.
  const marker = join(dir, '.complete');
  if (existsSync(marker)) {
    const listed = readFileSync(marker, 'utf8').split('\n').filter(Boolean);
    if (listed.length && listed.every((name) => existsSync(join(dir, name)))) {
      console.log('engine: already in place');
      return;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  const tmp = mkdtempSync(join(tmpdir(), 'mm-llama-'));
  try {
    const zip = join(tmp, LLAMA.zip);
    console.log(`engine: downloading ${LLAMA.zip}…`);
    await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA.build}/${LLAMA.zip}`, zip);
    const got = await sha256(zip);
    if (got !== LLAMA.sha256) throw new Error(`engine: checksum mismatch (got ${got})`);
    const out = join(tmp, 'x');
    mkdirSync(out);
    // Windows 10+ ships bsdtar, which reads zip files. Named by full path,
    // because Git Bash's GNU tar comes first on PATH and can't.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', zip, '-C', out]);
    // Assemble in a staging folder and move it into place in one step.
    const staging = join(tmp, 'llama');
    mkdirSync(staging);
    const kept = readdirSync(out).filter(LLAMA.keep);
    if (!kept.includes('llama-completion.exe')) throw new Error('engine: llama-completion.exe not found in the zip');
    for (const name of kept) copyFileSync(join(out, name), join(staging, name));
    writeFileSync(join(staging, '.complete'), kept.join('\n') + '\n');
    mkdirSync(AI, { recursive: true });
    try {
      renameSync(staging, dir);
    } catch {
      // Temp is on another drive: copy instead.
      mkdirSync(dir, { recursive: true });
      for (const name of [...kept, '.complete']) copyFileSync(join(staging, name), join(dir, name));
    }
    console.log(`engine: copied ${kept.length} files`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function setupModel() {
  const dir = join(AI, 'models');
  const target = join(dir, MODEL.file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(target) && (await sha256(target)) === MODEL.sha256) {
    console.log('model: already in place');
  } else if (existsSync(MODEL.ollamaBlob) && (await sha256(MODEL.ollamaBlob)) === MODEL.sha256) {
    // Copy under a temporary name, so an interrupted copy never looks finished.
    copyFileSync(MODEL.ollamaBlob, `${target}.part`);
    renameSync(`${target}.part`, target);
    console.log('model: copied from Ollama');
  } else {
    throw new Error(
      'model: not found. Install Ollama, run `ollama pull qwen3:0.6b`, then run this script again.'
    );
  }
  writeFileSync(join(AI, 'model.json'), JSON.stringify(MODEL_CONFIG, null, 2) + '\n');
}

async function setupLicenses() {
  const dir = join(AI, 'LICENSES');
  mkdirSync(dir, { recursive: true });
  const qwen = join(dir, 'Qwen3-LICENSE.txt');
  if (!existsSync(qwen)) await download(MODEL.license, qwen);
  const llama = join(dir, 'llama.cpp-LICENSE.txt');
  if (!existsSync(llama)) await download(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${LLAMA.build}/LICENSE`, llama);
  const omp = join(AI, 'llama', 'LICENSE-LLVM-OpenMP');
  if (existsSync(omp)) copyFileSync(omp, join(dir, 'LLVM-OpenMP-LICENSE.txt'));
  writeFileSync(
    join(dir, 'README.txt'),
    [
      'MagicMinutes AI edition — third-party components',
      '',
      `Model: ${MODEL.name} (Qwen3-0.6B) by the Qwen team, Alibaba Cloud. Apache License 2.0, see Qwen3-LICENSE.txt.`,
      'This is a modified version: quantised to 4 bits (GGUF, Q4_K_M) as distributed by Ollama. No other changes.',
      '',
      `Engine: llama.cpp ${LLAMA.build} by the ggml authors. MIT License, see llama.cpp-LICENSE.txt.`,
      'Includes the LLVM OpenMP runtime (libomp.dll), see LLVM-OpenMP-LICENSE.txt.',
      ''
    ].join('\r\n')
  );
  console.log('licences: in place');
}

await setupLlama();
await setupModel();
await setupLicenses();
console.log(`AI files ready in ${AI}`);
