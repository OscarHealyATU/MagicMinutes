// Built-in AI summaries (the AI edition). The engine and model live on the Rust
// side (src-tauri/src/ai.rs); this is the thin bridge to it plus the on/off
// preference. Outside Tauri (a plain browser) and in the standard edition, AI
// is simply unavailable and the recap uses its plain summary.

export const AI_PREF_KEY = 'magicminutes.aiSummaries';

// On unless switched off. localStorage can throw in locked-down webviews, so a
// broken preference falls back to the default rather than breaking the page.
export function readAiEnabled(storage) {
  try {
    return storage?.getItem(AI_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeAiEnabled(enabled, storage) {
  try {
    storage?.setItem(AI_PREF_KEY, enabled ? 'on' : 'off');
    return true;
  } catch {
    return false;
  }
}

// Whether to run the model on the graphics card. On unless switched off: on a
// computer without a usable one the engine just uses the CPU, and if the card
// fails mid-summary the Rust side starts again on the CPU, so "on" is safe.
export const AI_GPU_PREF_KEY = 'magicminutes.aiGpu';

export function readAiGpu(storage) {
  try {
    return storage?.getItem(AI_GPU_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeAiGpu(enabled, storage) {
  try {
    storage?.setItem(AI_GPU_PREF_KEY, enabled ? 'on' : 'off');
    return true;
  } catch {
    return false;
  }
}

// Keeps a prompt inside the model's context window (8,192 tokens) with room
// for the answer. English runs about four characters a token, but made-up
// fantasy names and emoji take more, so this leaves a wide margin.
export const MAX_PROMPT_CHARS = 16000;

export function fitPrompt(prompt) {
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\n(The rest of the notes were left out because they were too long.)`;
}

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invokeRust(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

// { installed, available, model, reason } — never throws. `installed` is
// whether this is the AI edition; `reason` says what's wrong when it is but
// the AI can't run.
export async function aiStatus() {
  if (!inTauri()) return { installed: false, available: false, model: null, reason: null };
  try {
    return await invokeRust('ai_status');
  } catch (e) {
    return { installed: false, available: false, model: null, reason: String(e?.message || e) };
  }
}

// What to tell someone whose summary was written without AI.
export function noAiMessage({ enabled, status, error }) {
  if (!enabled) return 'Written without AI (AI summaries are switched off in Settings).';
  if (error) return `The AI couldn't write it (${error}), so this is a plain summary instead.`;
  if (status?.installed) return `Written without AI: ${status.reason || 'the AI is unavailable.'}`;
  return 'Written without AI. AI summaries come with the MagicMinutes AI edition.';
}

const END_MARKERS = ['[end of text]', '<think>'];

// The part of a still-streaming answer that's fit to show: what the Rust side's
// clean_output keeps, applied to a partial text. Colour codes and a thinking
// block are dropped, an unfinished thinking block hides everything after it,
// and a marker that's only half arrived (a trailing "[end of") is held back
// rather than flashed on screen for a moment.
export function visibleSoFar(raw) {
  let text = String(raw || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b(\[[0-9;?]*)?$/, '');
  const open = text.indexOf('<think>');
  if (open !== -1) {
    const close = text.indexOf('</think>', open);
    text = close === -1 ? text.slice(0, open) : text.slice(0, open) + text.slice(close + '</think>'.length);
  }
  text = text.split('[end of text]').join('');
  for (const marker of END_MARKERS) {
    for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(marker.slice(0, n))) {
        text = text.slice(0, -n);
        break;
      }
    }
  }
  return text.trimStart();
}

// The graphics cards the AI can use, by name. [] when there are none, outside
// Tauri, or in the standard edition. Never throws.
export async function aiGpus() {
  if (!inTauri()) return [];
  try {
    return await invokeRust('ai_gpus');
  } catch {
    return [];
  }
}

// Resolves to { text, gpuFallback }: the written text, and — when the graphics
// card was asked for but failed, so the CPU wrote it instead — why. Throws with
// a readable message on failure.
//   gpu:       run on the graphics card (see readAiGpu)
//   onText:    called with the answer so far each time more of it arrives
//   onRestart: called when the graphics card failed and it's starting again
//              on the CPU; the text shown so far should be cleared
export async function aiGenerate(prompt, { gpu = false, onText, onRestart } = {}) {
  try {
    const { Channel } = await import('@tauri-apps/api/core');
    let raw = '';
    const onStream = new Channel();
    onStream.onmessage = (message) => {
      if (message?.event === 'restart') {
        raw = '';
        onRestart?.(message.reason);
        return;
      }
      if (message?.event === 'text') {
        raw += message.text;
        onText?.(visibleSoFar(raw));
      }
    };
    const result = await invokeRust('ai_generate', { prompt: fitPrompt(prompt), gpu, onStream });
    return { text: result.text, gpuFallback: result.gpuFallback || null };
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e?.message || 'The AI failed.');
  }
}
