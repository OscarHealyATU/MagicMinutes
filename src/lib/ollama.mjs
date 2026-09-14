// Tiny client for a local Ollama server (https://ollama.com), used to turn a
// session recap into a written summary when one is running. A plain `fetch`
// works with no Tauri HTTP plugin and no extra CSP entry: the app's CSP is
// null, and Ollama's default OLLAMA_ORIGINS allow-list already includes
// `http://localhost:*` and `tauri://*` (see ollama/ollama config.go
// AllowedOrigins — localhost/127.0.0.1/0.0.0.0 on http+https plus
// app://*, file://*, tauri://*, vscode-webview://*), so no server-side CORS
// config is needed for this app to talk to it.
//
// There is no LLM on Android, so every export here must fail soft: network
// errors and timeouts mean "not available", never a thrown exception that
// would break the always-on non-AI recap path.

const BASE_URL = 'http://localhost:11434';

// Preferred small, fast local models, in order — checked against installed
// model names with startsWith so a tag suffix (e.g. "gemma3:1b-it-qat") still
// matches. Shown in the UI as the "install this" hint.
export const RECOMMENDED_MODEL = 'gemma3:1b';
const PREFERRED_MODEL_PREFIXES = [
  'gemma3:1b',
  'qwen2.5:1.5b',
  'llama3.2:1b',
  'qwen2.5:3b',
  'gemma3:4b',
  'llama3.2:3b'
];

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// GET /api/tags -> { models: [{ name, model, size, digest, details... }] }.
// Any failure (server not running, timeout, bad JSON) is reported as simply
// unavailable — never thrown.
export async function detectOllama({ timeoutMs = 1500 } = {}) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { signal });
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    const models = (Array.isArray(data.models) ? data.models : []).map((m) => ({
      name: m.name || m.model || '',
      sizeBytes: typeof m.size === 'number' ? m.size : 0
    }));
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  } finally {
    clear();
  }
}

// Picks the best installed model for a quick summary: the first preferred
// name that's installed, otherwise the smallest model on disk. Null when
// nothing is installed.
export function pickModel(models) {
  if (!models || !models.length) return null;
  for (const prefix of PREFERRED_MODEL_PREFIXES) {
    const match = models.find((m) => m.name && m.name.startsWith(prefix));
    if (match) return match.name;
  }
  let smallest = models[0];
  for (const m of models) {
    if ((m.sizeBytes || 0) < (smallest.sizeBytes || 0)) smallest = m;
  }
  return smallest.name;
}

// POST /api/generate with stream:false -> a single JSON response whose
// `response` field holds the full generated text. Throws on a non-2xx
// response, a timeout/abort, or a network error — callers should catch this
// (unlike detectOllama, a failure here happens after we already know Ollama
// is up, so it's worth surfacing rather than silently falling back).
export async function generate({ model, prompt, timeoutMs = 60000 }) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal
    });
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = await res.json();
    return (data.response || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Ollama timed out');
    throw err;
  } finally {
    clear();
  }
}
