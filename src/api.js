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
//
// ---------- Multiple campaigns ----------
// Each campaign is its own SQLite file. `ttrpgmap.db` — the "home" database —
// never moves and never gets rewritten by this feature: it just gained one
// extra table (`campaigns`, see lib/campaigns.mjs) holding the registry of
// every campaign plus which one is active. The `default` campaign IS
// ttrpgmap.db, so opening it reuses the home connection instead of a second
// one; any other campaign is `campaign-<id>.db`, its own file next to it.
// Everything below `getDb()` keeps talking to a single db exactly as before —
// it just happens to be whichever campaign is active.

import Database from '@tauri-apps/plugin-sql';
import { BaseDirectory, remove } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import * as store from './lib/store.mjs';
import * as campaigns from './lib/campaigns.mjs';
import { buildExport } from './lib/transfer.mjs';
import { writeAppDataBackup } from './fileio.js';
import {
  dropBrowserCampaignDriver,
  getBrowserCampaignDriver,
  getBrowserRegistryDriver,
  hasBrowserCampaignDriver,
  seedDemoData
} from './lib/browserDriver.mjs';

let homeDbPromise = null; // the registry, and (when active) the default campaign's own db
let dbPromise = null; // whichever campaign is currently active

// Under Tauri, a real SQLite file. In a plain browser (vite dev without the
// Tauri shell), an in-memory driver seeded with demo data so the frontend can
// be developed and design-checked without the Rust side.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function sqlitePath(file) {
  return `sqlite:${file}`;
}

// The registry always lives in ttrpgmap.db (Tauri) or the sessionStorage-
// backed registry driver (browser) — see lib/browserDriver.mjs.
function getHomeDb() {
  if (!homeDbPromise) {
    homeDbPromise = (
      inTauri ? Database.load(sqlitePath(campaigns.DEFAULT_CAMPAIGN_FILE)) : Promise.resolve(getBrowserRegistryDriver())
    ).then(async (db) => {
      await campaigns.ensureRegistryTable(db);
      return db;
    });
  }
  return homeDbPromise;
}

// Opens (or reuses) the connection for whichever campaign is currently
// active, making sure its document tables exist. `default` reuses the home
// connection rather than opening ttrpgmap.db a second time.
async function openActiveCampaignDb(homeDb) {
  const active = await campaigns.getActiveCampaign(homeDb);
  // Best-effort: a failed/slow write here must never block opening the db.
  campaigns.touchLastOpened(homeDb, active._id).catch(() => {});

  if (!inTauri) {
    const isNew = !hasBrowserCampaignDriver(active._id);
    const driver = getBrowserCampaignDriver(active._id);
    await store.ensureTables(driver);
    // Demo data only ever seeds the browser's default campaign, and only
    // the first time its driver is created in this JS lifetime.
    if (isNew && active._id === campaigns.DEFAULT_CAMPAIGN_ID) await seedDemoData(driver);
    return driver;
  }

  if (active._id === campaigns.DEFAULT_CAMPAIGN_ID) {
    await store.ensureTables(homeDb);
    return homeDb;
  }
  const db = await Database.load(sqlitePath(active.file));
  await store.ensureTables(db);
  return db;
}

function getDb() {
  if (!dbPromise) {
    dbPromise = getHomeDb().then((homeDb) => openActiveCampaignDb(homeDb));
  }
  return dbPromise;
}

// Best-effort full path for a file in the app data folder, for messages that
// tell the owner where to find something by hand — falls back to the bare
// file name if the path API itself is unavailable (shouldn't happen under
// Tauri, but a message with a relative name is still useful, not a crash).
async function appDataPath(file) {
  try {
    return await join(await appDataDir(), file);
  } catch {
    return file;
  }
}

export const api = {
  list: async (resource) => store.listDocs(await getDb(), resource),
  create: async (resource, body) => store.createDoc(await getDb(), resource, body),
  update: async (resource, id, body) => store.updateDoc(await getDb(), resource, id, body),
  // Same as update, but doesn't bump updatedAt — for position/size-only writes
  // (map drags, auto-arrange, character-tree drags) so moving something isn't
  // indistinguishable from editing it in a session's recap.
  updateLayout: async (resource, id, body) =>
    store.updateDoc(await getDb(), resource, id, body, { touch: false }),
  upsert: async (resource, doc) => store.upsertDoc(await getDb(), resource, doc),
  remove: async (resource, id) => store.removeDoc(await getDb(), resource, id),
  sessions: {
    active: async () => store.sessionsActive(await getDb()),
    start: async () => store.sessionsStart(await getDb()),
    end: async (id) => store.sessionsEnd(await getDb(), id)
  },
  campaigns: {
    list: async () => campaigns.listCampaigns(await getHomeDb()),
    active: async () => campaigns.getActiveCampaign(await getHomeDb()),
    create: async (name) => campaigns.createCampaign(await getHomeDb(), name),
    rename: async (id, name) => campaigns.renameCampaign(await getHomeDb(), id, name),

    // Sets the active campaign in the registry and reports whether it
    // actually changed, so the caller (CampaignSwitcher.jsx) only reloads
    // when something really did. Doesn't reload itself — the switch and the
    // reload are deliberately two steps so a caller can flush anything
    // pending first.
    switchTo: async (id) => {
      const homeDb = await getHomeDb();
      const current = await campaigns.getActiveCampaign(homeDb);
      if (current._id === id) return false;
      await campaigns.getCampaign(homeDb, id); // throws if `id` doesn't exist
      await campaigns.setActiveCampaignId(homeDb, id);
      return true;
    },

    // Deletes a campaign that isn't `default` and isn't active. Always backs
    // it up first and aborts entirely if that backup fails — nothing is
    // touched. Once backed up, it's unlisted from the registry even if the
    // file itself couldn't be removed (reported back so the caller can tell
    // the owner where to find it).
    remove: async (id) => {
      const homeDb = await getHomeDb();
      const active = await campaigns.getActiveCampaign(homeDb);
      campaigns.assertCanDelete(id, active._id);
      const target = await campaigns.getCampaign(homeDb, id);

      if (!inTauri) {
        // No real file to back up or delete in a plain browser — just drop
        // it from the registry and from memory if it was ever opened.
        dropBrowserCampaignDriver(id);
        await campaigns.deleteCampaignRow(homeDb, id);
        return { backedUp: false, fileRemoved: false };
      }

      // Load (creating the file if this campaign was made but never
      // switched to) so its documents can be read for the backup.
      const targetDb = await Database.load(sqlitePath(target.file));
      await store.ensureTables(targetDb);
      const all = {};
      for (const name of store.COLLECTIONS) all[name] = await store.listDocs(targetDb, name);

      const safeName = target.name.replace(/[^\w-]+/g, '_').slice(0, 40) || id;
      try {
        await writeAppDataBackup(
          `campaign-backup-${safeName}-${id}.json`,
          JSON.stringify(buildExport(all), null, 2)
        );
      } catch (e) {
        // Delete is irreversible — if the safety net itself couldn't be
        // written, stop here rather than deleting anything with no way back.
        throw new Error(`Couldn't back up "${target.name}" before deleting it, so nothing was deleted: ${e.message}`);
      }

      // Close the connection before touching the file — a held connection
      // can make the delete fail, or leave -wal/-shm behind, on some
      // platforms. Passing the path closes only this pool, not every open db.
      await targetDb.close(sqlitePath(target.file));

      let fileError = null;
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          await remove(`${target.file}${suffix}`, { baseDir: BaseDirectory.AppData });
        } catch (e) {
          if (suffix === '') fileError = e; // the sidecar files may just not exist — only the main file missing is worth reporting
        }
      }

      // Unlisted either way: a file that couldn't be deleted automatically
      // shouldn't stay picked from the switcher forever.
      await campaigns.deleteCampaignRow(homeDb, id);

      if (fileError) {
        return {
          backedUp: true,
          fileRemoved: false,
          fileError: fileError.message,
          filePath: await appDataPath(target.file)
        };
      }
      return { backedUp: true, fileRemoved: true };
    }
  }
};
