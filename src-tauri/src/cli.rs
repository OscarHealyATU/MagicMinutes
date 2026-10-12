// Command-line mode, so an AI agent with a terminal can drive the app.
//
// `magicminutes.exe` (src/bin/magicminutes.rs) is a tiny console program that
// runs this app with `--cli` and the user's arguments. In that mode the app
// opens a window nobody ever sees, hands the arguments to the page, lets the
// page run the command with the same JavaScript the app itself uses, and exits
// when the page calls `cli_finish`. Nothing about the commands lives here, so
// there is only one copy of the rules for notes, imports and campaigns.
//
// Normal startup never touches any of this: without `--cli` as the first
// argument, `init_from_env` returns false and the app builds its window from
// tauri.conf.json exactly as before.

use serde::Serialize;
use std::io::Write;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;

// Set once, at startup, only in CLI mode. The file commands below check it, so
// the ordinary app (whose page can call any registered command) gets no new
// way to read or write files.
static CLI_ARGS: OnceLock<Vec<String>> = OnceLock::new();

// If the page hasn't reported back by then (it crashed, or in a debug build the
// dev server isn't running), give up instead of hanging the agent's terminal.
const WATCHDOG: Duration = Duration::from_secs(120);

// Files bigger than this are refused, so a wrong path can't make the page
// swallow a huge file.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// True when the first argument is `--cli`. Remembers the arguments after it.
pub fn init_from_env() -> bool {
    let mut args = std::env::args_os();
    args.next(); // the program itself
    match args.next() {
        Some(first) if first == "--cli" => {
            let rest = args.map(|a| a.to_string_lossy().into_owned()).collect();
            let _ = CLI_ARGS.set(rest);
            true
        }
        _ => false,
    }
}

fn is_cli() -> bool {
    CLI_ARGS.get().is_some()
}

// The arguments as a script for the page. They're JSON-encoded twice: the inner
// pass makes the list, the outer pass turns that into a JS string literal that
// can't be broken out of by quotes, backslashes or newlines in an argument.
// (U+2028/2029 are valid in JSON but were once line breaks in JS, so they're
// escaped by hand.)
fn init_script(args: &[String]) -> String {
    let list = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
    let literal = serde_json::to_string(&list)
        .unwrap_or_else(|_| "\"[]\"".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.__MM_CLI__ = JSON.parse({literal});")
}

/// Makes tauri.conf.json's window not open by itself. Called before the app is
/// built, in CLI mode only; `open_hidden_window` then builds it from that same
/// config. (`create: false` is how Tauri says "I'll create this one myself".)
pub fn hold_back_default_window(config: &mut tauri::Config) {
    for window in config.app.windows.iter_mut() {
        window.create = false;
    }
}

/// The window the page runs in. It is created hidden and kept off the taskbar,
/// so it never flashes on screen.
pub fn open_hidden_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("tauri.conf.json has no window to run the command in")?
        .clone();
    let args = CLI_ARGS.get().cloned().unwrap_or_default();
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .initialization_script(init_script(&args))
        .build()?;
    start_watchdog();
    Ok(())
}

fn start_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(WATCHDOG);
        eprintln!(
            "magicminutes: the app did not answer within {} seconds, so the command was cancelled. \
             (In a debug build, the Vite dev server on port 5179 must be running.)",
            WATCHDOG.as_secs()
        );
        std::process::exit(2);
    });
}

/// The page is done: print what it produced and end the process.
#[tauri::command]
pub fn cli_finish(output: String, code: i32) -> Result<(), String> {
    if !is_cli() {
        return Err("Only available in command-line mode.".into());
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(output.as_bytes());
    if !output.ends_with('\n') {
        let _ = out.write_all(b"\n");
    }
    let _ = out.flush();
    std::process::exit(code);
}

// Text files written on Windows are often not plain UTF-8: PowerShell's `>`
// writes UTF-16 with a byte-order mark. Reading those as UTF-8 would turn the
// text into garbage, so the marks are honoured.
fn decode_text(bytes: Vec<u8>) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Reads a text file for the command layer. The webview's own fs plugin is
/// limited to the app data folder, which is no use for "import this file from my
/// Documents". Relative paths are relative to where the launcher was run.
#[tauri::command]
pub fn cli_read_file(path: String) -> Result<String, String> {
    if !is_cli() {
        return Err("Only available in command-line mode.".into());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Err(format!("that file is {} MB, which is too big", size / (1024 * 1024)));
    }
    std::fs::read(&path).map(decode_text).map_err(|e| e.to_string())
}

/// Writes a text file (UTF-8) for the command layer. Same rules as reading.
#[tauri::command]
pub fn cli_write_file(path: String, text: String) -> Result<(), String> {
    if !is_cli() {
        return Err("Only available in command-line mode.".into());
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherInfo {
    launcher: String,
    launcher_exists: bool,
    agents: String,
    agents_exists: bool,
}

/// Where `magicminutes.exe` and AGENTS.md are, for the Settings card. Safe in
/// normal mode: it only reports paths.
#[tauri::command]
pub fn cli_launcher_path(app: tauri::AppHandle) -> Result<LauncherInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no folder for the app")?;
    let launcher = dir.join(if cfg!(windows) { "magicminutes.exe" } else { "magicminutes" });
    let agents = app
        .path()
        .resource_dir()
        .map(|d| d.join("AGENTS.md"))
        .unwrap_or_else(|_| dir.join("AGENTS.md"));
    Ok(LauncherInfo {
        launcher_exists: launcher.is_file(),
        launcher: launcher.to_string_lossy().into_owned(),
        agents_exists: agents.is_file(),
        agents: agents.to_string_lossy().into_owned(),
    })
}
