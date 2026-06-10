//! Scanning of `.desktop` entries and resolution of their icons.
//! Ported from the original Electron `main.js`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One launchable application discovered on the system.
#[derive(Serialize, Deserialize, Clone)]
pub struct AppInfo {
    pub id: String,
    pub name: String,
    pub comment: String,
    pub exec: String,
    pub icon: Option<String>, // absolute path or null
    pub categories: Vec<String>,
    #[serde(rename = "noDisplay")]
    pub no_display: bool,
    pub terminal: bool,
    pub file: String,
}

/// Directories where `.desktop` entries live (system + user).
fn app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
    }
    dirs
}

/// Icon search roots, ordered by preference.
fn icon_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/icons"),
        PathBuf::from("/usr/local/share/icons"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/icons"));
    }
    dirs.push(PathBuf::from("/usr/share/pixmaps"));
    dirs
}

const ICON_SIZE_PREFERENCE: &[&str] = &[
    "128x128", "96x96", "256x256", "64x64", "scalable", "48x48", "512x512", "32x32",
];
const ICON_EXTS: &[&str] = &["png", "svg", "xpm"];

/// Parse the `[Desktop Entry]` section of a `.desktop` file into a map.
fn parse_desktop_file(path: &Path) -> Option<HashMap<String, String>> {
    let content = fs::read_to_string(path).ok()?;
    let mut entry = HashMap::new();
    let mut in_desktop_entry = false;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq) = line.find('=') {
            entry.insert(line[..eq].to_string(), line[eq + 1..].to_string());
        }
    }
    Some(entry)
}

struct IconHit {
    path: PathBuf,
    priority: i32,
}

/// Build an icon-name -> absolute-path index (one filesystem walk).
fn build_icon_index() -> HashMap<String, IconHit> {
    let mut index: HashMap<String, IconHit> = HashMap::new();

    fn visit(dir: &Path, priority: i32, index: &mut HashMap<String, IconHit>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let full = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if file_type.is_dir() {
                // Boost priority for preferred size dirs so big icons win.
                let size_idx = ICON_SIZE_PREFERENCE.iter().position(|s| *s == name);
                let next = match size_idx {
                    None => priority,
                    Some(i) => priority + (ICON_SIZE_PREFERENCE.len() as i32 - i as i32) * 10,
                };
                visit(&full, next, index);
            } else {
                let ext = full
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if !ICON_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let stem = full
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let better = match index.get(&stem) {
                    Some(prev) => priority > prev.priority,
                    None => true,
                };
                if better {
                    index.insert(stem, IconHit { path: full, priority });
                }
            }
        }
    }

    for root in icon_dirs() {
        visit(&root, 0, &mut index);
    }
    index
}

/// Resolve an `Icon=` value to an absolute file path (or None).
fn resolve_icon(icon_value: &str, index: &HashMap<String, IconHit>) -> Option<String> {
    if icon_value.is_empty() {
        return None;
    }
    if icon_value.starts_with('/') {
        return if Path::new(icon_value).exists() {
            Some(icon_value.to_string())
        } else {
            None
        };
    }
    // Try the literal name, then the name with a known extension stripped.
    let stripped = icon_value
        .rsplit_once('.')
        .filter(|(_, ext)| ICON_EXTS.contains(&ext.to_lowercase().as_str()))
        .map(|(base, _)| base)
        .unwrap_or(icon_value);
    index
        .get(icon_value)
        .or_else(|| index.get(stripped))
        .map(|hit| hit.path.to_string_lossy().to_string())
}

/// Scan all app dirs and return the merged, de-duplicated, sorted list.
pub fn scan_apps() -> Vec<AppInfo> {
    let icon_index = build_icon_index();
    // Keyed by desktop file basename; user dirs override system entries.
    let mut apps: HashMap<String, AppInfo> = HashMap::new();

    for dir in app_dirs() {
        let files = match fs::read_dir(&dir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let fname = file.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".desktop") {
                continue;
            }
            let entry = match parse_desktop_file(&file.path()) {
                Some(e) => e,
                None => continue,
            };
            let get = |k: &str| entry.get(k).cloned().unwrap_or_default();
            if get("Type") != "Application" || get("Name").is_empty() || get("Exec").is_empty() {
                continue;
            }
            if get("Hidden") == "true" {
                continue; // Hidden=true means "deleted"
            }
            let icon = resolve_icon(&get("Icon"), &icon_index);
            let categories: Vec<String> = get("Categories")
                .split(';')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            apps.insert(
                fname.clone(),
                AppInfo {
                    id: fname,
                    name: get("Name"),
                    comment: get("Comment"),
                    exec: get("Exec"),
                    icon,
                    categories,
                    no_display: get("NoDisplay") == "true",
                    terminal: get("Terminal") == "true",
                    file: file.path().to_string_lossy().to_string(),
                },
            );
        }
    }

    let mut list: Vec<AppInfo> = apps.into_values().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

/// Read an icon file and return it as a `data:` URL the webview can render.
pub fn icon_data_url(icon_path: &str) -> Option<String> {
    use base64::Engine;
    let buf = fs::read(icon_path).ok()?;
    let ext = Path::new(icon_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "xpm" => "image/x-xpixmap",
        _ => "image/png",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Some(format!("data:{mime};base64,{b64}"))
}
