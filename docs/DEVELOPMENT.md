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
| `mapZones.test.mjs` | Map zones: containment, nesting, packing and clamping |
| `mapLayout.test.mjs` | The map's starting layout, checked against a copy of the original algorithm |
| `transfer.test.mjs` | Export/import validation, merge/replace planning, theme preference |
| `recap.test.mjs` | Session summary material, the no-AI summary, the AI on/off preference |
| `noteText.test.mjs` | The readable note format used for emailing and importing notes |
| `a11y.test.mjs` | Font-style and colour-blind mode preferences |
| `commands.test.mjs` | The command-line commands: parsing, notes, search, import plans, backups, `run` files |

`npm test` runs them all. The Rust side has its own tests, including one that runs the real
AI engine if its files are in place:

```bash
cd src-tauri && cargo test --lib -- --include-ignored
```

## Building an installer

There are two editions: **standard**, and **AI**, which adds a built-in model for session
summaries and the command-line tool (see Command-line mode below). They're the same app
with the same identifier and data. The differences are the `ai/` folder, which the app
checks for at runtime (`src-tauri/src/ai.rs`), and `magicminutes.exe` with `AGENTS.md`,
which only `src-tauri/tauri.ai.conf.json` adds.

```bash
npm run build:standard   # MagicMinutes_<version>_x64-setup.exe, a few MB
npm run build:ai         # MagicMinutes-AI_<version>_x64-setup.exe, about 530 MB
```

Tauri writes both to the same `src-tauri/target/release/bundle/` folder, so each build
script then copies its own installers into `release-installers/` under the edition's
name. Build them in either order. Releases build only the NSIS `.exe` (the `targets` in
`tauri.conf.json`): the per-user installer attached to GitHub releases. There is no MSI.

Either edition installs over the other. An installer hook (`src-tauri/windows/hooks.nsh`)
clears the install folder's `ai/`, `magicminutes.exe` and `AGENTS.md` before copying
files, so switching to standard removes the AI files and the command-line tool, and
updating the AI edition never leaves an old model behind. Notes live in `%APPDATA%` and
are never touched.

### The AI files

`npm run setup:ai` (run automatically by `build:ai`) fills `src-tauri/ai/`, which git
ignores because the model alone is about 500 MB:

| Path | What it is |
|---|---|
| `ai/llama/` | llama.cpp's prebuilt Windows **Vulkan** engine (`llama-completion.exe` and its DLLs), downloaded from the pinned llama.cpp release and checked against its SHA-256. It includes the CPU code too, so one engine covers both settings |
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
temp file. Nothing keeps running afterwards. Its output is streamed to the Recap page through
a Tauri `Channel` as it's written, so the summary appears word by word.

**Graphics card:** with **Settings → Use the graphics card** on (the default), the engine
gets `-ngl 99`: every layer goes on the GPU, and llama.cpp picks the device itself, preferring
a dedicated card over built-in graphics. Off, it gets `-ngl 0 --device none`, which is plain
CPU. If a GPU run fails for any reason other than the app closing, `ai.rs` tells the page to
clear what it has shown and runs again on the CPU. Settings lists the usable cards from
`llama-completion --list-devices`.

Measured on an RTX 3050 Ti laptop with a long session (about 2,300 prompt tokens): the CPU
read the notes in 6–9 s and wrote about 17 tokens/s. The GPU read them in 0.4 s and wrote
about 145 tokens/s. The laptop's built-in Radeon managed 3.5 s and 57 tokens/s. The first run
on a card is slow (about 25 s here) while the driver builds and caches its shaders. Vulkan
was chosen over CUDA because it works on NVIDIA, AMD and Intel with just the normal driver,
and adds about 13 MB to the installer against CUDA's roughly 540 MB.

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
    commands.mjs        the command-line commands (see Command-line mode)
    dice.mjs            roll-notation parser for combos
    theme.mjs           light/dark preference
    a11y.mjs            font-style and colour-blind mode preferences
src-tauri/              Rust entry point (src/ai.rs runs the AI engine), plugins, capabilities, icons, Android project
  tauri.ai.conf.json    extra config for the AI edition: bundles ai/ and AGENTS.md, turns on the `cli` feature
scripts/                setup-ai.mjs (fetch AI files), build.mjs, collect-installers.mjs
tests/                  plain Node test scripts
```

### Command-line mode

`magicminutes.exe` lets a terminal (and so an AI agent) drive the app. It comes with the
MagicMinutes AI edition only, not the standard one. The commands reuse the app's own
JavaScript, so there is one copy of the rules for notes, imports and campaigns. The pieces:

1. **Launcher** (`src-tauri/src/bin/magicminutes.rs`): a second `[[bin]]` in the same
   Cargo package, with no Tauri code in it. It runs `ttrpgmap.exe --cli <args>` from the
   same folder, pipes the child's stdout and stderr through, and returns its exit code. It
   has to be a console program: the real app is a windowed one, which a shell doesn't wait
   for and which can't print to the terminal. `default-run = "ttrpgmap"` in `Cargo.toml`
   keeps the app as the main binary; Tauri's installers put every other `[[bin]]` next to it.
   The launcher has `required-features = ["cli"]`, so it is only built with the cargo
   feature `cli`. `tauri.ai.conf.json` turns that on (`build.features`), so the AI
   edition gets it and the standard edition doesn't.
2. **Hidden window** (`src-tauri/src/cli.rs`, `lib.rs`): when `--cli` is the first
   argument, the window in `tauri.conf.json` is set to `create: false` at startup and
   rebuilt in `setup` with `visible(false)` and `skip_taskbar(true)`. An initialization
   script sets `window.__MM_CLI__` to the JSON-encoded arguments. Without `--cli` none of
   this runs and Tauri opens the window itself as before.
3. **The page** (`src/main.jsx`, `src/cli.js`): if `__MM_CLI__` is set, `main.jsx` skips
   React and calls `runCli`, which runs `runCommand` from `src/lib/commands.mjs` and
   reports back with the `cli_finish` Tauri command. That prints the text and exits with
   the code. A 120 s watchdog in Rust exits with code 2 if the page never answers (in a
   debug build the Vite dev server must be running).
4. **Commands** (`src/lib/commands.mjs`): pure logic, tested in `tests/commands.test.mjs`
   with a fake driver. It's given a `ctx` for campaigns, files, backups and the clock.
   `src/cli.js` wires `ctx` to the real thing; `openCampaignDriver` in `src/api.js` opens a
   campaign without making it the active one.

`cli_read_file` and `cli_write_file` exist because the webview's fs plugin is limited to
the app data folder. They refuse to run unless the process was started with `--cli`.
`AGENTS.md` at the repo root is bundled as a resource only by `tauri.ai.conf.json`
(`bundle.resources`) and installs beside the exes. The Settings "For AI assistants" card
asks Rust (`cli_launcher_path`) whether `magicminutes.exe` is next to the app and shows
itself only if it is, so the standard edition never shows it.

To try it in development, start `npm run dev`, run `cargo build --features cli` in
`src-tauri` (without the feature the launcher isn't built), then run
`src-tauri\target\debug\magicminutes.exe help`. **That opens your real campaign database**,
so use `--campaign` with a throwaway campaign.

### Data

Each collection (`notes`, `npcs`, `combos`, `groups`, `places`, `players`,
`sessions`) is a SQLite table of `id TEXT PRIMARY KEY, doc TEXT` rows, where `doc` is the
JSON document. `store.mjs` fills in defaults, so older documents missing newer fields still
load.

Databases from older versions may still hold a `rolls` table (the Fight Combos page used to
save success/failure records). Nothing reads or writes it any more and the app leaves it
alone; new campaigns don't create it. Old backup files with a `rolls` section still import:
that section is skipped and the import says so.

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
