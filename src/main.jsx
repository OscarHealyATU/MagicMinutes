import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, readTheme } from './lib/theme.mjs';
import './styles.css';

// Before the first paint, so launching with the light theme saved doesn't
// flash the dark palette on the way in.
applyTheme(readTheme(globalThis.localStorage), document.documentElement);

createRoot(document.getElementById('root')).render(<App />);
