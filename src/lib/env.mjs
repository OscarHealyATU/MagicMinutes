// True when running inside the Tauri shell (the desktop/Android app), false in
// a plain browser such as `vite dev`. Tauri sets the marker before any page
// script runs, so reading it once at load is enough. `typeof window` keeps
// this safe to import from the plain-node tests.
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
