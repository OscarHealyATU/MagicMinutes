// Command-line mode: the page that runs when the app is started as
// `ttrpgmap.exe --cli ...` (by magicminutes.exe). It never shows a UI. It takes
// the arguments the Rust side put in window.__MM_CLI__, runs the command with
// src/lib/commands.mjs, and hands the text back to Rust (`cli_finish`), which
// prints it and exits.
//
// This file is only the wiring: opening databases, reading and writing files,
// the safety backup. What the commands do lives in commands.mjs.

import { invoke } from '@tauri-apps/api/core';
import { api, closeAllDatabases, openCampaignDriver } from './api.js';
import { writeAppDataBackup } from './fileio.js';
import { runCommand } from './lib/commands.mjs';

const ctx = {
  async listCampaigns() {
    const [campaigns, active] = await Promise.all([api.campaigns.list(), api.campaigns.active()]);
    return { campaigns, activeId: active._id };
  },
  // null = the active campaign. Either way this only opens a connection; it
  // never moves the app's "active campaign" pointer.
  openCampaign: (id) => openCampaignDriver(id),
  // Adds it to the list but leaves the app on the campaign it was on.
  createCampaign: (name) => api.campaigns.create(name),
  // Plain file access goes through Rust, because the webview's fs plugin can
  // only see the app data folder. Rust refuses these outside CLI mode.
  readFile: (path) => invoke('cli_read_file', { path }),
  writeFile: (path, text) => invoke('cli_write_file', { path, text }),
  async backup(name, text) {
    const path = await writeAppDataBackup(name, text);
    if (!path) throw new Error('there is no app data folder to write to');
    return path;
  },
  now: () => new Date().toISOString()
};

export async function runCli(args) {
  let result;
  try {
    result = await runCommand(args, ctx);
  } catch (e) {
    result = { output: `Internal error: ${e && e.message ? e.message : e}`, code: 2 };
  }
  // Close cleanly before the process exits, so nothing is left sitting in
  // SQLite's side files. A failure here mustn't hide the command's result.
  await closeAllDatabases().catch(() => {});
  await invoke('cli_finish', { output: result.output, code: result.code });
}
