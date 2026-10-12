// The command-line front door: `magicminutes <command...>`.
//
// This is a small console program with no Tauri in it. The real app is a
// windowed program, and a windowed program can't print to the terminal that
// started it (the shell doesn't wait for it, and it has no console of its own).
// This one does, so it starts `ttrpgmap.exe --cli <args>` next to itself, takes
// the output through pipes, and passes it on with the same exit code. The
// commands themselves run inside the app (src/lib/commands.mjs).

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;

#[cfg(windows)]
mod console {
    // So accents and quotes in notes show properly in a Windows console, which
    // otherwise assumes an old code page. The old one is put back on exit.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleOutputCP() -> u32;
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }

    pub struct Utf8Output(u32);

    impl Utf8Output {
        pub fn new() -> Self {
            // Both calls just fail, harmlessly, if there is no console.
            let old = unsafe { GetConsoleOutputCP() };
            unsafe { SetConsoleOutputCP(65001) };
            Utf8Output(old)
        }
    }

    impl Drop for Utf8Output {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe { SetConsoleOutputCP(self.0) };
            }
        }
    }
}

// Copies bytes through untouched until the app closes its end. A failed write
// (the reader went away) is ignored, but the pipe is still drained so the app
// never blocks on a full one.
fn relay(mut from: impl Read, mut to: impl Write) {
    let mut buf = [0u8; 8192];
    let mut open = true;
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if open && (to.write_all(&buf[..n]).is_err() || to.flush().is_err()) {
                    open = false;
                }
            }
        }
    }
}

// Whether a line of the app's error output is the browser engine talking to
// itself, e.g. "[1012/184550.422:ERROR:ui\gfx\win\window_impl.cc:172] Failed
// to unregister class Chrome_WidgetWin_0" — it prints one as it shuts down
// after every command. Those start "[MMDD/HHMMSS.mmm:LEVEL:".
fn is_engine_log(line: &[u8]) -> bool {
    let Some(rest) = line.strip_prefix(b"[") else {
        return false;
    };
    let digits = |s: &[u8]| s.iter().take_while(|b| b.is_ascii_digit()).count();
    let date = digits(rest);
    if date == 0 || rest.get(date) != Some(&b'/') {
        return false;
    }
    let rest = &rest[date + 1..];
    let time = digits(rest);
    if time == 0 || rest.get(time) != Some(&b'.') {
        return false;
    }
    let rest = &rest[time + 1..];
    let millis = digits(rest);
    millis > 0 && rest.get(millis) == Some(&b':')
}

// Like `relay`, line by line, dropping the engine's own log lines: an agent
// reading the output shouldn't spend attention (or tokens) on them.
fn relay_errors(from: impl Read, mut to: impl Write) {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(from);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if !is_engine_log(&line) {
                    let _ = to.write_all(&line);
                    let _ = to.flush();
                }
            }
        }
    }
}

fn run() -> i32 {
    let app = match std::env::current_exe() {
        Ok(me) => me.with_file_name(if cfg!(windows) { "ttrpgmap.exe" } else { "ttrpgmap" }),
        Err(e) => {
            eprintln!("magicminutes: can't find myself: {e}");
            return 2;
        }
    };
    if !app.is_file() {
        eprintln!("magicminutes: can't find the app at {}", app.display());
        return 2;
    }

    // The working directory is inherited, so relative file names in commands
    // mean what they would in the caller's shell.
    let mut command = Command::new(&app);
    command
        .arg("--cli")
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The app is a windowed program and never needs a console. A debug build is
    // a console program, though, and without this it could pop one up when this
    // launcher was started from something with no console of its own.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("magicminutes: couldn't start {}: {e}", app.display());
            return 2;
        }
    };

    let out = child.stdout.take().map(|s| thread::spawn(move || relay(s, std::io::stdout())));
    let err = child.stderr.take().map(|s| thread::spawn(move || relay_errors(s, std::io::stderr())));

    let status = child.wait();
    for handle in [out, err].into_iter().flatten() {
        let _ = handle.join();
    }
    match status {
        Ok(status) => status.code().unwrap_or(2),
        Err(e) => {
            eprintln!("magicminutes: lost the app: {e}");
            2
        }
    }
}

fn main() {
    #[cfg(windows)]
    let _utf8 = console::Utf8Output::new();
    let code = run();
    // `exit` skips destructors, so put the console code page back first.
    #[cfg(windows)]
    drop(_utf8);
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::is_engine_log;

    #[test]
    fn spots_the_engines_own_log_lines() {
        assert!(is_engine_log(b"[1012/184550.422:ERROR:ui\\gfx\\win\\window_impl.cc:172] Failed to unregister class\n"));
        assert!(is_engine_log(b"[0101/000000.001:WARNING:x.cc:1] y"));
    }

    #[test]
    fn keeps_everything_else() {
        assert!(!is_engine_log(b"The app didn't answer within 120 seconds.\n"));
        assert!(!is_engine_log(b"[note] something in brackets\n"));
        assert!(!is_engine_log(b"[1012] not a log line\n"));
        assert!(!is_engine_log(b""));
    }
}
