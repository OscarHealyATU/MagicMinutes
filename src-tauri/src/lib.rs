mod ai;
mod cli;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `magicminutes.exe` starts the app as `ttrpgmap.exe --cli <command...>`.
    let cli_mode = cli::init_from_env();

    let mut context = tauri::generate_context!();
    if cli_mode {
        // The window is created later in `setup`, hidden. In normal mode the
        // config is left alone and Tauri opens the window itself, as ever.
        cli::hold_back_default_window(context.config_mut());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            ai::ai_status,
            ai::ai_generate,
            ai::ai_gpus,
            cli::cli_finish,
            cli::cli_read_file,
            cli::cli_write_file,
            cli::cli_launcher_path
        ])
        .setup(move |app| {
            if cli_mode {
                cli::open_hidden_window(app)?;
            } else {
                std::thread::spawn(ai::clean_temp_files);
            }
            Ok(())
        })
        .build(context)
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                ai::stop_running();
            }
        });
}
