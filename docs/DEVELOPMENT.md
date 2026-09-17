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
| `recap.test.mjs` | Session summary material, the no-AI summary, the AI on/off preference |
| `noteText.test.mjs` | The readable note format used for emailing and importing notes |

`npm test` runs them all. The Rust side has its own tests, including one that runs the real
AI engine if its files are in place:

```bash
cd src-tauri && cargo test --lib -- --include-ignored
```

## Building an installer

There are two editions: **standard**, and **AI**, which adds a built-in model for session
summaries. They're the same app with the same identifier and data. The only difference is
whether the `ai/` folder is bundled, and the app checks for it at runtime
(`src-tauri/src/ai.rs`).

```bash
npm run build:standard   # MagicMinutes_<version>_x64-setup.exe, a few MB
npm run build:ai         # MagicMinutes-AI_<version>_x64-setup.exe, about 530 MB
```

Tauri writes both to the same `src-tauri/target/release/bundle/` folder, so each build
script then copies its own installers into `release-installers/` under the edition's
name. Build them in either order. The `nsis` `.exe` is the per-user installer attached to
GitHub releases; the `.msi` is the same app as an MSI.

Either edition installs over the other. An installer hook (`src-tauri/windows/hooks.nsh`)
clears the install folder's `ai/` before copying files, so switching to standard removes
the AI files, and updating the AI edition never leaves an old model behind. Notes live in
`%APPDATA%` and are never touched.

### The AI files

`npm run setup:ai` (run automatically by `build:ai`) fills `src-tauri/ai/`, which git
ignores because the model alone is about 500 MB:

| Path | What it is |
|---|---|
| `ai/llama/` | llama.cpp's prebuilt Windows CPU engine (`llama-completion.exe` and its DLLs), downloaded from the pinned llama.cpp release and checked against its SHA-256 |
| `ai/models/qwen3-0.6b-q4_k_m.gguf` | The model. Copied from Ollama's store, so run `ollama pull qwen3:0.6b` once first |
| `ai/model.json` | Which model file to load, its chat format, and sampling settings |
| `ai/LICENSES/` | Licence texts for the model, llama.cpp and OpenMP, shipped with the app |

`tauri dev` finds the files straight from `src-tauri/ai/`, so AI summaries work in
development once setup has run.

**Swapping the model:** put another GGUF in `ai/models/`, point `model.json`'s `file` at it,
and change `promptTemplate` to that model's chat format (`{prompt}` marks where the text
goes). To make the change stick for fresh checkouts, update `MODEL` and `MODEL_CONFIG` in
`scripts/setup-ai.mjs`. Bigger models are slower, and each one adds its size to the AI
installer.

The engine runs once per summary as a hidden background process, reading its prompt from a
temp file. Nothing keeps running afterwards.

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
    ai.mjs              AI summaries: bridge to the built-in model, on/off preference
    noteText.mjs        readable note format for emailing and importing notes
    dice.mjs            roll-notation parser for combos
    theme.mjs           light/dark preference
src-tauri/              Rust entry point (src/ai.rs runs the AI engine), plugins, capabilities, icons, Android project
  tauri.ai.conf.json    extra config for the AI edition: bundles the ai/ folder
scripts/                setup-ai.mjs (fetch AI files), name-installers.mjs
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

The AI edition is Windows-only for now. Android builds have no `ai/` folder, so "Write a
summary" always writes the plain summary there.

## Regenerating the icon

The icons are generated from `app-icon.png` (1024×1024):

```bash
npm run tauri icon app-icon.png
```
