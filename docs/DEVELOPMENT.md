# Developing MagicMinutes

MagicMinutes is a [Tauri 2](https://tauri.app) desktop app: a React + Vite frontend in
`src/`, a thin Rust shell in `src-tauri/`, and a local SQLite database.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [Rust](https://rustup.rs) (stable)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.
  On Windows that's the MSVC build tools and WebView2, which Windows 10/11 already have.

## Running

```bash
npm install
npm run tauri dev
```

The first run compiles the Rust side, which takes a few minutes; later runs start in
seconds and the UI hot-reloads as you edit.

**No Rust needed for UI work:** `npm run dev` serves just the frontend at
http://localhost:5179. When the page isn't running inside Tauri, `src/api.js` swaps the
SQLite database for an in-memory store filled with a sample campaign
(`src/lib/browserDriver.mjs`). Nothing persists between reloads. The README screenshots
are taken from this mode.

## Tests

The logic that doesn't need a UI lives in plain modules under `src/lib/` and is tested
with plain Node scripts:

```bash
for f in tests/*.test.mjs; do node "$f"; done
```

| Test file | Covers |
|---|---|
| `store.test.mjs` | The document store: defaults, create/update/upsert/remove, session recaps |
| `characters.test.mjs` | Alignment bands, relations, the family-tree layout and group boxes |
| `mapZones.test.mjs` | Map zones: containment, nesting, packing, clamping and resize limits |
| `transfer.test.mjs` | Export/import validation, merge/replace planning, theme preference |
| `recap.test.mjs` | Session summary material and the no-AI summary |

## Building an installer

```bash
npm run tauri build
```

This writes to `src-tauri/target/release/bundle/`:

- `nsis/MagicMinutes_<version>_x64-setup.exe` — per-user installer, no admin prompt.
  This is the one attached to GitHub releases.
- `msi/MagicMinutes_<version>_x64_en-US.msi` — the same app as an MSI.

The installer is unsigned, so Windows SmartScreen warns on first run.

## How the code is organised

```text
src/
  App.jsx               sidebar, tabs, session timer, theme
  api.js                picks SQLite (Tauri) or the in-memory sample store (browser)
  fileio.js             save/open dialogs and file access, with browser fallbacks
  views/                one component per tab
  components/           shared pieces (block builder, NPC/player editors, place reconcile)
  lib/
    store.mjs           document store over SQLite: one table per collection
    characters.mjs      NPC alignment, relations and the tree layout
    mapZones.mjs        zone geometry for the map
    transfer.mjs        export/import format and merge/replace planning
    recap.mjs           session summary material
    ollama.mjs          optional local AI summaries via Ollama
    dice.mjs            roll-notation parser for combos
    theme.mjs           light/dark preference
src-tauri/              Rust entry point, plugins, capabilities, icons, Android project
tests/                  plain Node test scripts
```

### Data

Each collection (`notes`, `npcs`, `combos`, `groups`, `places`, `players`, `rolls`,
`sessions`) is a SQLite table of `id TEXT PRIMARY KEY, doc TEXT` rows, where `doc` is the
JSON document. `store.mjs` fills in defaults, so older documents missing newer fields still
load.

The app's bundle identifier is `com.oscar.ttrpgmap` and the database file is `ttrpgmap.db`,
from before the app was renamed to MagicMinutes. They were kept on purpose: Tauri stores
app data in a folder named after the identifier, so changing it would make existing
installs look empty. The export format tag (`ttrpgmap-export`) was kept for the same
reason, so old backup files still import.

**If you fork this to publish your own build, change `identifier` in
`src-tauri/tauri.conf.json`** so your app doesn't share a data folder with this one.

### Permissions

Tauri only allows what `src-tauri/capabilities/default.json` grants. File reading and
writing (for export/import) is limited to paths under the user's home folder.

## Android

Tauri can build an Android APK. The `src-tauri/gen/android` project is included, but
you'll need your own setup:

1. Install Android Studio or the command-line SDK, plus an NDK, a JDK 17, and the Rust
   Android targets:
   `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
2. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`.
3. Build: `npx tauri android build --apk --target aarch64`

**Windows note:** the last step of `tauri android build` creates a symlink, which Windows
only allows with Developer Mode on (Settings → System → For developers). Without it, the
Rust part still compiles, and you can finish by hand:

```bash
cp src-tauri/target/aarch64-linux-android/release/libttrpgmap_lib.so \
   src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/
cd src-tauri/gen/android && ./gradlew assembleArm64Release -x rustBuildArm64Release
```

A release APK has to be signed before it will install. Create your own keystore with
`keytool`, sign with `zipalign` + `apksigner` from the Android build tools, and **never
commit the keystore or its passwords** — `.gitignore` excludes `src-tauri/keystore/` for
this reason. Updates to an installed app must be signed with the same key.

The "Write a summary" AI feature needs a local Ollama server, so on Android it always falls
back to the plain summary.

## Regenerating the icon

The icons are generated from `app-icon.png` (1024×1024):

```bash
npm run tauri icon app-icon.png
```
