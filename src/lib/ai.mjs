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

// Resolves to the written text; throws with a readable message on failure.
export async function aiGenerate(prompt) {
  try {
    return await invokeRust('ai_generate', { prompt: fitPrompt(prompt) });
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e?.message || 'The AI failed.');
  }
}
