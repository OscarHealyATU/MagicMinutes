// Reading and writing a file the user picks. Same shape as src/api.js: under
// Tauri it uses the native dialogs and the fs plugin; in a plain browser (vite
// dev without the Tauri shell) it falls back to a download and a hidden file
// input, so Settings can be worked on without the Rust side running.

import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];
export const NOTES_FILTER = [{ name: 'MagicMinutes notes', extensions: ['json', 'txt'] }];

// The plugin's confirm() needs the Tauri IPC, and window.confirm is a no-op
// inside the webview — so each environment gets the one that actually works.
export async function confirmDialog(message, options) {
  if (inTauri) return confirm(message, options);
  return window.confirm(`${options && options.title ? `${options.title}\n\n` : ''}${message}`);
}

// Returns the path written, or null if the user cancelled.
export async function saveTextFile(suggestedName, text, filters = JSON_FILTER) {
  if (inTauri) {
    const path = await save({ defaultPath: suggestedName, filters });
    if (!path) return null;
    await writeTextFile(path, text);
    return path;
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return suggestedName;
}

// Returns { name, text }, or null if the user cancelled.
export async function openTextFile(filters = JSON_FILTER) {
  if (inTauri) {
    const path = await open({ multiple: false, directory: false, filters });
    if (!path) return null;
    return { name: path, text: await readTextFile(path) };
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    input.style.display = 'none';
    document.body.appendChild(input);
    // No 'cancel' event in older engines: resolving null on a second click is
    // better than leaving the promise pending forever.
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      resolve(file ? { name: file.name, text: await file.text() } : null);
    });
    input.click();
  });
}

// Copies text for pasting elsewhere. The async clipboard API is the normal
// route; the hidden-textarea copy is a fallback for engines that refuse it.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// Hands a mailto: (or web) link to the system, so it opens the user's own
// email app. The webview can't do that by itself under Tauri.
export async function openExternal(url) {
  if (inTauri) return openUrl(url);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
