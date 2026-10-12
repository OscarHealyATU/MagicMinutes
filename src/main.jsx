import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { applyTheme, readTheme } from './lib/theme.mjs';
import { applyColorBlind, applyFontStyle, readColorBlind, readFontStyle } from './lib/a11y.mjs';
import { applyTextSizes, readTextSizes } from './lib/textSizes.mjs';
// Comic Neue, Lexend and OpenDyslexic are self-hosted from @fontsource (their
// licence files ship inside each package); fonts.css has their @font-face
// rules. The app's other two fonts, Jim Nightshade and Quintessential, are
// loaded separately (an @font-face in styles.css, pointing at the .ttf files
// in public/fonts/); their OFL notices live alongside at public/fonts/OFL-*.txt.
import './fonts.css';
import './styles.css';

// Started from the command line (magicminutes.exe)? The Rust side put the
// arguments here before any page script ran. That run has no interface: it
// does the command and reports back, so none of the app below is started.
// Only the Rust side can set this, and the command-line code is loaded only
// when it's there, so the normal app never pays for it.
const cliArgs = globalThis.__MM_CLI__;

if (Array.isArray(cliArgs)) {
  import('./cli.js')
    .then((m) => m.runCli(cliArgs.map(String)))
    .catch(async (e) => {
      // Couldn't even load: still tell Rust, so the terminal gets an answer now
      // instead of after the watchdog.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cli_finish', { output: `Internal error: ${e && e.message ? e.message : e}`, code: 2 });
      } catch {
        // Nothing more to try; the watchdog ends the process.
      }
    });
} else {
  // Before the first paint, so launching with a saved theme/font/CV preference
  // doesn't flash the default on the way in.
  applyTheme(readTheme(globalThis.localStorage), document.documentElement);
  applyFontStyle(readFontStyle(globalThis.localStorage), document.documentElement);
  applyColorBlind(readColorBlind(globalThis.localStorage), document.documentElement);
  applyTextSizes(readTextSizes(globalThis.localStorage), document.documentElement);

  createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
