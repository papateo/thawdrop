#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, DragDropEvent, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Paths the user has actually picked via the native file dialog or dropped
/// onto a window, in this run of the app. `read_file_as_base64` only ever
/// reads from this set — an arbitrary path string reaching the command via
/// `invoke` (e.g. from a future XSS bug or a compromised frontend dependency)
/// can't be used to read files the user never chose.
struct AllowedPaths(Mutex<HashSet<String>>);

impl AllowedPaths {
    fn allow(&self, path: &str) {
        self.0.lock().unwrap().insert(path.to_string());
    }

    fn contains(&self, path: &str) -> bool {
        self.0.lock().unwrap().contains(path)
    }
}

/// Every share opens its own small window; the label is a stable hash of the
/// file path so re-sharing the same file focuses the existing window instead
/// of stacking duplicates.
fn window_label_for(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("share-{:x}", hasher.finish())
}

#[tauri::command]
fn read_file_as_base64(path: String, allowed: State<AllowedPaths>) -> Result<serde_json::Value, String> {
    if !allowed.contains(&path) {
        return Err("This file wasn't selected through Thawdrop's picker or drag-and-drop.".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("This is a folder — expand it into its files first.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    Ok(serde_json::json!({
        "name": name,
        "data": general_purpose::STANDARD.encode(bytes),
    }))
}

/// Upper bound on files collected from one folder, so a stray pick of e.g. the
/// home directory doesn't try to load the whole disk into memory.
const MAX_FOLDER_FILES: usize = 5000;

#[derive(serde::Serialize)]
struct ShareEntry {
    path: String,
    /// Path shown to the receiver, `/`-separated. For files inside a picked
    /// folder it starts with the folder's own name so the structure is kept.
    name: String,
}

fn collect_folder_files(dir: &std::path::Path, prefix: &str, out: &mut Vec<ShareEntry>) -> Result<(), String> {
    let mut children: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .collect();
    children.sort_by_key(|entry| entry.file_name());

    for entry in children {
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        // Symlinks are skipped so a link inside the folder can't smuggle in
        // files from outside what the user actually picked.
        if file_type.is_symlink() {
            continue;
        }
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy());
        if file_type.is_dir() {
            collect_folder_files(&entry.path(), &name, out)?;
        } else if file_type.is_file() {
            if out.len() >= MAX_FOLDER_FILES {
                return Err(format!("This folder has more than {MAX_FOLDER_FILES} files — pick a smaller one."));
            }
            out.push(ShareEntry {
                path: entry.path().display().to_string(),
                name,
            });
        }
    }
    Ok(())
}

/// Turns the paths the user picked into the flat list of files to share,
/// walking any folders. Only paths already allow-listed (picked or dropped)
/// are accepted, and the files found inside a folder inherit that permission.
#[tauri::command]
fn expand_paths(paths: Vec<String>, allowed: State<AllowedPaths>) -> Result<Vec<ShareEntry>, String> {
    let mut entries = Vec::new();
    for path in &paths {
        if !allowed.contains(path) {
            return Err("This file wasn't selected through Thawdrop's picker or drag-and-drop.".into());
        }
        let p = std::path::Path::new(path);
        let file_name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        if std::fs::metadata(p).map_err(|e| e.to_string())?.is_dir() {
            collect_folder_files(p, &file_name, &mut entries)?;
        } else {
            entries.push(ShareEntry { path: path.clone(), name: file_name });
        }
    }
    if entries.is_empty() {
        return Err("Nothing to share — the folder has no files.".into());
    }
    if entries.len() > MAX_FOLDER_FILES {
        return Err(format!("Too many files (more than {MAX_FOLDER_FILES}) — pick fewer."));
    }
    for entry in &entries {
        allowed.allow(&entry.path);
    }
    Ok(entries)
}

#[tauri::command]
fn pick_folder(allowed: State<AllowedPaths>) -> Option<String> {
    let path = rfd::FileDialog::new().pick_folder()?.display().to_string();
    allowed.allow(&path);
    Some(path)
}

#[tauri::command]
fn pick_files(allowed: State<AllowedPaths>) -> Option<Vec<String>> {
    let paths = rfd::FileDialog::new().pick_files()?;
    let paths: Vec<String> = paths.into_iter().map(|p| p.display().to_string()).collect();
    for path in &paths {
        allowed.allow(path);
    }
    Some(paths)
}

fn extract_share_path(argv: &[String]) -> Option<String> {
    argv.iter()
        .position(|a| a == "--share")
        .and_then(|i| argv.get(i + 1))
        .cloned()
}

fn open_share_window(app: &AppHandle, path: String) {
    app.state::<AllowedPaths>().allow(&path);

    let label = window_label_for(&path);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return;
    }
    let url = format!("share.html?path={}", urlencoding::encode(&path));
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Thawdrop")
        .inner_size(420.0, 560.0)
        .resizable(false)
        .build();
}

fn main() {
    tauri::Builder::default()
        .manage(AllowedPaths(Mutex::new(HashSet::new())))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = extract_share_path(&argv) {
                open_share_window(app, path);
            }
        }))
        .invoke_handler(tauri::generate_handler![read_file_as_base64, expand_paths, pick_files, pick_folder])
        .setup(|app| {
            let share_item = MenuItem::with_id(app, "share", "Share a file…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Thawdrop", true, None::<&str>)?;
            let share_folder_item = MenuItem::with_id(app, "share_folder", "Share a folder…", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&share_item, &share_folder_item, &quit_item])?;

            let icon_bytes = include_bytes!("../icons/32x32.png");
            let decoded = image::load_from_memory(icon_bytes)?.to_rgba8();
            let (icon_width, icon_height) = decoded.dimensions();
            let tray_icon = tauri::image::Image::new_owned(decoded.into_raw(), icon_width, icon_height);

            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("Thawdrop — peer-to-peer file sharing")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "share" => {
                        if let Some(path) = rfd::FileDialog::new().pick_file() {
                            open_share_window(app, path.display().to_string());
                        }
                    }
                    "share_folder" => {
                        if let Some(path) = rfd::FileDialog::new().pick_folder() {
                            open_share_window(app, path.display().to_string());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The main window's dropzone lets users drag files straight in;
            // capture those paths on the Rust side (the native drag-drop
            // event, not anything the webview's JS can spoof) so they're
            // allow-listed for `read_file_as_base64` the same way a dialog
            // pick is.
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                        let allowed = app_handle.state::<AllowedPaths>();
                        for path in paths {
                            allowed.allow(&path.display().to_string());
                        }
                    }
                });
            }

            // The very first launch (e.g. from a Finder/Explorer context menu)
            // arrives as our own process args, not through the single-instance
            // plugin, which only fires for a *second* launch.
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = extract_share_path(&args) {
                open_share_window(&app.handle().clone(), path);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Thawdrop");
}
