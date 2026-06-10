// Prevents an extra console window on Windows in release. No effect on Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde_json::Value;
use sysinfo::{Networks, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};

use desktop::AppInfo;

/// Shared `sysinfo` state so we keep prior CPU/network samples between polls
/// (CPU usage and network deltas are only meaningful across two refreshes).
struct Monitor {
    sys: Mutex<System>,
    networks: Mutex<Networks>,
}

// ---------------------------------------------------------------------------
// Preferences (favorites / recents / settings / theme) persisted as JSON
// ---------------------------------------------------------------------------
fn prefs_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
        .join("universe-3d");
    let _ = fs::create_dir_all(&dir);
    dir.join("prefs.json")
}

#[tauri::command]
fn prefs_get() -> Value {
    match fs::read_to_string(prefs_path()) {
        Ok(s) => serde_json::from_str(&s)
            .unwrap_or_else(|_| serde_json::json!({ "favorites": [], "recents": [] })),
        Err(_) => serde_json::json!({ "favorites": [], "recents": [] }),
    }
}

#[tauri::command]
fn prefs_set(prefs: Value) -> bool {
    if let Ok(s) = serde_json::to_string_pretty(&prefs) {
        fs::write(prefs_path(), s).is_ok()
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// App discovery + icons
// ---------------------------------------------------------------------------
#[tauri::command]
fn apps_scan() -> Vec<AppInfo> {
    desktop::scan_apps()
}

#[tauri::command]
fn icon_data(icon_path: String) -> Option<String> {
    desktop::icon_data_url(&icon_path)
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/// Strip XDG field codes (%f %F %u %U ...) from an Exec string.
fn strip_field_codes(exec: &str) -> String {
    let mut out = String::with_capacity(exec.len());
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            // Drop the code letter that follows, if any.
            if matches!(
                chars.peek(),
                Some('f' | 'F' | 'u' | 'U' | 'd' | 'D' | 'n' | 'N' | 'i' | 'c' | 'k' | 'v' | 'm')
            ) {
                chars.next();
                continue;
            }
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// Spawn a command line detached from this process.
fn spawn_detached(cmd: &str, in_terminal: bool) -> std::io::Result<()> {
    let mut command = if in_terminal {
        let mut c = Command::new("x-terminal-emulator");
        c.args(["-e", "sh", "-c", cmd]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    command.spawn().map(|_| ())
}

#[tauri::command]
fn apps_launch(app: AppInfo) -> bool {
    let cmd = strip_field_codes(&app.exec);
    spawn_detached(&cmd, app.terminal).is_ok()
}

/// New utility: run an arbitrary command typed by the user.
#[tauri::command]
fn run_command(command: String, in_terminal: bool) -> Result<bool, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("Empty command".into());
    }
    spawn_detached(cmd, in_terminal)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// New utility: open a terminal in a given directory (defaults to home).
#[tauri::command]
fn open_terminal(path: Option<String>) -> Result<bool, String> {
    let dir = path
        .filter(|p| !p.trim().is_empty())
        .or_else(|| dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
        .unwrap_or_else(|| "/".into());
    Command::new("x-terminal-emulator")
        .current_dir(&dir)
        .spawn()
        .map(|_| true)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// New utility: live system monitor (CPU / RAM / network)
// ---------------------------------------------------------------------------
#[derive(serde::Serialize)]
struct SystemStats {
    cpu: f32,             // overall CPU usage %
    cores: Vec<f32>,      // per-core usage %
    mem_used: u64,        // bytes
    mem_total: u64,       // bytes
    mem_percent: f32,
    swap_used: u64,
    swap_total: u64,
    net_rx: u64,          // bytes received since last poll
    net_tx: u64,          // bytes transmitted since last poll
    uptime: u64,          // seconds
    load_one: f64,        // 1-minute load average
}

#[tauri::command]
fn system_stats(monitor: State<Monitor>) -> SystemStats {
    let mut sys = monitor.sys.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cores: Vec<f32> = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
    let cpu = if cores.is_empty() {
        0.0
    } else {
        cores.iter().sum::<f32>() / cores.len() as f32
    };

    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let mem_percent = if mem_total > 0 {
        mem_used as f32 / mem_total as f32 * 100.0
    } else {
        0.0
    };

    let mut networks = monitor.networks.lock().unwrap();
    networks.refresh();
    let mut net_rx = 0;
    let mut net_tx = 0;
    for (_iface, data) in networks.iter() {
        net_rx += data.received();
        net_tx += data.transmitted();
    }

    let load = System::load_average();

    SystemStats {
        cpu,
        cores,
        mem_used,
        mem_total,
        mem_percent,
        swap_used: sys.used_swap(),
        swap_total: sys.total_swap(),
        net_rx,
        net_tx,
        uptime: System::uptime(),
        load_one: load.one,
    }
}

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------
#[tauri::command]
fn window_hide(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Single instance: a second launch (e.g. panel click) just shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(Monitor {
            sys: Mutex::new(System::new_all()),
            networks: Mutex::new(Networks::new_with_refreshed_list()),
        })
        .setup(|app| {
            // Tray icon with a context menu; clicking toggles the window.
            let show = MenuItem::with_id(app, "show", "Show 3D Universe", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("3D Universe")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Daemon mode: closing the window hides it so re-opening is instant.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            apps_scan,
            apps_launch,
            icon_data,
            prefs_get,
            prefs_set,
            run_command,
            open_terminal,
            system_stats,
            window_hide,
            window_minimize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Universe 3D");
}
