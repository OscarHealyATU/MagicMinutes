// Drop-in replacement for the old fetch-based client/src/api.js. Same exported
// shape (`api.list/create/update/remove/sessions.*`) so the React views need no
// changes, but backed by a local SQLite file via @tauri-apps/plugin-sql instead
// of an Express + MongoDB server.
//
// All the actual document-store logic (defaults, id/timestamp handling, patch
// merge, sorting, session recap) lives in ./lib/store.mjs, which is driver-
// agnostic and unit-tested in tests/store.test.mjs. This file is just the thin
// binding: it loads the SQLite database and hands the resulting Database
// instance to the store functions (its .select/.execute methods already match
// the seam store.mjs expects).

import Database from '@tauri-apps/plugin-sql';
import * as store from './lib/store.mjs';
import { makeBrowserDriver, seedDemoData } from './lib/browserDriver.mjs';

let dbPromise = null;

// Under Tauri, a real SQLite file. In a plain browser (vite dev without the
// Tauri shell), an in-memory driver seeded with demo data so the frontend can
// be developed and design-checked without the Rust side.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function getDb() {
  if (!dbPromise) {
    if (inTauri) {
      dbPromise = Database.load('sqlite:ttrpgmap.db').then(async (db) => {
        await store.ensureTables(db);
        return db;
      });
    } else {
      const driver = makeBrowserDriver();
      dbPromise = store
        .ensureTables(driver)
        .then(() => seedDemoData(driver))
        .then(() => driver);
    }
  }
  return dbPromise;
}

export const api = {
  list: async (resource) => store.listDocs(await getDb(), resource),
  create: async (resource, body) => store.createDoc(await getDb(), resource, body),
  update: async (resource, id, body) => store.updateDoc(await getDb(), resource, id, body),
  upsert: async (resource, doc) => store.upsertDoc(await getDb(), resource, doc),
  remove: async (resource, id) => store.removeDoc(await getDb(), resource, id),
  sessions: {
    active: async () => store.sessionsActive(await getDb()),
    start: async () => store.sessionsStart(await getDb()),
    end: async (id) => store.sessionsEnd(await getDb(), id)
  }
};
