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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use desktop::AppInfo;

/// Shared `sysinfo` state so we keep prior CPU/network samples between polls
/// (CPU usage and network deltas are only meaningful across two refreshes).
struct Monitor {
    sys: Mutex<System>,
    networks: Mutex<Networks>,
    /// Cumulative (rx, tx) totals at the previous poll, so `system_stats` can
    /// report the bytes moved since then rather than since boot.
    last_net: Mutex<Option<(u64, u64)>>,
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

/// Split an `Exec=` line into argv following the XDG Desktop Entry spec's
/// quoting rules, dropping field codes (%f %F %u %U ...) as we go.
///
/// Returning argv rather than a string is what keeps launching safe: the
/// program is executed directly instead of being handed to `sh -c`, so a
/// `.desktop` file containing shell metacharacters in its `Exec` line (say
/// `Exec=foo; rm -rf ~`) launches a program called `foo` with those literal
/// arguments instead of running a second command.
fn parse_exec(exec: &str) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut in_quotes = false;
    let mut chars = exec.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            // Inside double quotes a backslash escapes the next character.
            '\\' if in_quotes => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            // Field codes expand to the files/URLs being opened. We always
            // launch without arguments, so they simply vanish.
            '%' if !in_quotes => match chars.peek() {
                Some('%') => {
                    chars.next();
                    current.push('%');
                    has_token = true;
                }
                Some(
                    'f' | 'F' | 'u' | 'U' | 'd' | 'D' | 'n' | 'N' | 'i' | 'c' | 'k' | 'v' | 'm',
                ) => {
                    chars.next();
                }
                _ => {
                    current.push('%');
                    has_token = true;
                }
            },
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    argv.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        argv.push(current);
    }
    argv
}

/// Spawn an already-parsed argv detached from this process.
///
/// `Terminal=true` entries are wrapped in `x-terminal-emulator -e`, which takes
/// the program and its arguments directly — still no shell involved.
fn spawn_argv(argv: &[String], in_terminal: bool) -> std::io::Result<()> {
    let Some((program, args)) = argv.split_first() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty command",
        ));
    };
    let mut command = if in_terminal {
        let mut c = Command::new("x-terminal-emulator");
        c.arg("-e").arg(program).args(args);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };
    // Detach: the launcher hides itself right after, and we never reap these.
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command.spawn().map(|_| ())
}

/// Spawn a user-typed command line. This one *does* go through the shell,
/// because the whole point of the command box is to accept shell syntax
/// (pipes, redirection, globs) that the user typed themselves.
fn spawn_shell(cmd: &str, in_terminal: bool) -> std::io::Result<()> {
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
    spawn_argv(&parse_exec(&app.exec), app.terminal).is_ok()
}

/// Launch one of an entry's `Actions=` entries (e.g. "New Private Window").
///
/// The action's `Exec` is looked up on the server side from the app's own
/// desktop file rather than trusted from the request, so the frontend cannot
/// ask for an arbitrary command line through this door.
#[tauri::command]
fn apps_launch_action(app: AppInfo, action: String) -> Result<bool, String> {
    let found = app
        .actions
        .iter()
        .find(|a| a.id == action)
        .ok_or_else(|| format!("unknown action: {action}"))?;
    spawn_argv(&parse_exec(&found.exec), app.terminal)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// New utility: run an arbitrary command typed by the user.
#[tauri::command]
fn run_command(command: String, in_terminal: bool) -> Result<bool, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("Empty command".into());
    }
    spawn_shell(cmd, in_terminal)
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
    cpu: f32,        // overall CPU usage %
    cores: Vec<f32>, // per-core usage %
    mem_used: u64,   // bytes
    mem_total: u64,  // bytes
    mem_percent: f32,
    swap_used: u64,
    swap_total: u64,
    net_rx: u64,   // bytes received since the previous poll
    net_tx: u64,   // bytes transmitted since the previous poll
    uptime: u64,   // seconds
    load_one: f64, // 1-minute load average
}

#[tauri::command]
fn system_stats(monitor: State<Monitor>) -> SystemStats {
    // A poisoned lock only means a previous poll panicked mid-refresh; the
    // sampler is still usable and the release build aborts on panic anyway, so
    // recover the guard instead of taking the whole app down with it.
    let mut sys = monitor.sys.lock().unwrap_or_else(|e| e.into_inner());
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

    let mut networks = monitor.networks.lock().unwrap_or_else(|e| e.into_inner());
    networks.refresh();
    // `received()` / `transmitted()` are cumulative since the interface came
    // up, so diff them against the previous poll to get throughput. The first
    // poll has no baseline and reports zero rather than a boot-sized spike.
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;
    for data in networks.values() {
        total_rx += data.received();
        total_tx += data.transmitted();
    }
    let mut last_net = monitor.last_net.lock().unwrap_or_else(|e| e.into_inner());
    let (net_rx, net_tx) = match *last_net {
        // saturating_sub guards against counters resetting (iface restarted).
        Some((prev_rx, prev_tx)) => (
            total_rx.saturating_sub(prev_rx),
            total_tx.saturating_sub(prev_tx),
        ),
        None => (0, 0),
    };
    *last_net = Some((total_rx, total_tx));

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

/// Toggle maximize. A maximized window cannot be dragged anywhere, so this is
/// what lets the user un-maximize and move it to another monitor.
#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

/// Move the window to the next monitor, keeping it maximized if it was.
///
/// Dragging works, but on a multi-head setup it is far quicker to send the
/// window across with a keystroke than to un-maximize, drag and re-maximize.
#[tauri::command]
fn window_next_monitor(window: tauri::Window) -> Result<bool, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    if monitors.len() < 2 {
        return Ok(false);
    }
    let current = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no current monitor")?;
    // Identify the current screen by its origin: names are not always set.
    let idx = monitors
        .iter()
        .position(|m| m.position() == current.position())
        .unwrap_or(0);
    let target = &monitors[(idx + 1) % monitors.len()];

    let was_maximized = window.is_maximized().unwrap_or(false);
    if was_maximized {
        // A maximized window ignores position changes; drop out first.
        let _ = window.unmaximize();
    }
    window
        .set_position(tauri::PhysicalPosition::new(
            target.position().x,
            target.position().y,
        ))
        .map_err(|e| e.to_string())?;
    if was_maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
    Ok(true)
}

/// Bring the window to the front (used by the tray, the global hotkey and a
/// second launch of the binary).
fn show_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Show the window if it is hidden, hide it if it is already visible.
fn toggle_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Default summon hotkey. Overridable via the `hotkey` key in prefs.json so a
/// user whose desktop already binds Super+Space can move it.
const DEFAULT_HOTKEY: &str = "Super+Space";

fn configured_hotkey() -> String {
    prefs_get()
        .get("hotkey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_HOTKEY)
        .to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Single instance: a second launch (e.g. panel click) just shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .manage(Monitor {
            sys: Mutex::new(System::new_all()),
            networks: Mutex::new(Networks::new_with_refreshed_list()),
            last_net: Mutex::new(None),
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
                    "show" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Global summon hotkey (default Super+Space). Registration can
            // fail if another program already owns the combination, or on a
            // compositor that forbids global grabs -- that is not fatal, the
            // tray icon still works, so we only log it.
            let hotkey = configured_hotkey();
            match hotkey.parse::<Shortcut>() {
                Ok(shortcut) => {
                    let handle = app.handle().clone();
                    if let Err(e) = app.handle().plugin(
                        tauri_plugin_global_shortcut::Builder::new()
                            .with_handler(move |_app, _shortcut, event| {
                                // Fire once per press, not again on release.
                                if event.state() == ShortcutState::Pressed {
                                    toggle_window(&handle);
                                }
                            })
                            .build(),
                    ) {
                        eprintln!("global shortcut plugin unavailable: {e}");
                    } else if let Err(e) = app.global_shortcut().register(shortcut) {
                        eprintln!("could not register hotkey {hotkey}: {e}");
                    }
                }
                Err(e) => eprintln!("invalid hotkey {hotkey:?} in prefs: {e}"),
            }

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
            apps_launch_action,
            icon_data,
            prefs_get,
            prefs_set,
            run_command,
            open_terminal,
            system_stats,
            window_hide,
            window_minimize,
            window_toggle_maximize,
            window_next_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Universe 3D");
}

#[cfg(test)]
mod tests {
    use super::parse_exec;

    #[test]
    fn splits_plain_command() {
        assert_eq!(parse_exec("firefox"), vec!["firefox"]);
        assert_eq!(parse_exec("gimp -n"), vec!["gimp", "-n"]);
    }

    #[test]
    fn drops_field_codes() {
        assert_eq!(parse_exec("firefox %u"), vec!["firefox"]);
        assert_eq!(parse_exec("gimp-2.10 %U"), vec!["gimp-2.10"]);
        assert_eq!(parse_exec("app %f --flag %i"), vec!["app", "--flag"]);
    }

    #[test]
    fn keeps_escaped_percent() {
        assert_eq!(parse_exec("app 100%%"), vec!["app", "100%"]);
    }

    #[test]
    fn honours_quotes() {
        assert_eq!(
            parse_exec(r#"/opt/My App/run --title "Hello World""#),
            vec!["/opt/My", "App/run", "--title", "Hello World"]
        );
        assert_eq!(
            parse_exec(r#""/opt/My App/run" -x"#),
            vec!["/opt/My App/run", "-x"]
        );
    }

    #[test]
    fn preserves_empty_quoted_argument() {
        assert_eq!(parse_exec(r#"app "" -x"#), vec!["app", "", "-x"]);
    }

    /// The security-relevant case: shell metacharacters in a .desktop file must
    /// stay inert. They become literal argv entries, never a second command.
    #[test]
    fn shell_metacharacters_are_not_interpreted() {
        assert_eq!(
            parse_exec("evil; rm -rf ~"),
            vec!["evil;", "rm", "-rf", "~"]
        );
        assert_eq!(
            parse_exec("app $(whoami) `id` && curl evil.sh"),
            vec!["app", "$(whoami)", "`id`", "&&", "curl", "evil.sh"]
        );
        assert_eq!(
            parse_exec("app | tee /tmp/x"),
            vec!["app", "|", "tee", "/tmp/x"]
        );
    }

    #[test]
    fn handles_empty_and_whitespace() {
        assert!(parse_exec("").is_empty());
        assert!(parse_exec("   ").is_empty());
    }
}
