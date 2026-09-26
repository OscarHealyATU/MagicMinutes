import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { applyTheme, readTheme } from './lib/theme.mjs';
import { applyColorBlind, applyFontStyle, readColorBlind, readFontStyle } from './lib/a11y.mjs';
// These three (Comic Neue, Lexend, OpenDyslexic) are self-hosted through
// @fontsource, whose own licence files ship inside each package — nothing
// extra to keep here for them. The app's other two fonts, Jim Nightshade and
// Quintessential, are loaded separately (an @font-face in styles.css,
// pointing at the .ttf files in public/fonts/); their OFL notices live
// alongside these three at public/fonts/OFL-*.txt. Only the weights actually
// used are imported below, so Vite doesn't bundle the whole family.
import '@fontsource/comic-neue/400.css';
import '@fontsource/comic-neue/700.css';
import '@fontsource/lexend/400.css';
import '@fontsource/lexend/600.css';
import '@fontsource/opendyslexic/400.css';
import '@fontsource/opendyslexic/700.css';
import './styles.css';

// Before the first paint, so launching with a saved theme/font/CV preference
// doesn't flash the default on the way in.
applyTheme(readTheme(globalThis.localStorage), document.documentElement);
applyFontStyle(readFontStyle(globalThis.localStorage), document.documentElement);
applyColorBlind(readColorBlind(globalThis.localStorage), document.documentElement);

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
