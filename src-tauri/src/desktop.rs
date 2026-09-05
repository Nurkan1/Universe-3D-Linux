//! Scanning of `.desktop` entries and resolution of their icons.
//! Ported from the original Electron `main.js`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// One action declared by a `.desktop` entry's `Actions=` key, e.g. Firefox's
/// "Open a New Private Window". Each has its own `Exec` line.
#[derive(Serialize, Deserialize, Clone)]
pub struct DesktopAction {
    pub id: String,
    pub name: String,
    pub exec: String,
}

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
    /// Extra launch modes from the entry's `Actions=` key (may be empty).
    pub actions: Vec<DesktopAction>,
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

/// A parsed `.desktop` file: the main `[Desktop Entry]` group plus every
/// `[Desktop Action <id>]` group, keyed by action id.
struct DesktopFile {
    entry: HashMap<String, String>,
    action_groups: HashMap<String, HashMap<String, String>>,
}

/// Parse a `.desktop` file into its `[Desktop Entry]` group and action groups.
fn parse_desktop_file(path: &Path) -> Option<DesktopFile> {
    let content = fs::read_to_string(path).ok()?;
    let mut entry = HashMap::new();
    let mut action_groups: HashMap<String, HashMap<String, String>> = HashMap::new();
    // Which group the following key=value lines belong to.
    let mut current: Option<Option<String>> = None; // None group = [Desktop Entry]

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = if header == "Desktop Entry" {
                Some(None)
            } else if let Some(id) = header.strip_prefix("Desktop Action ") {
                let id = id.trim().to_string();
                action_groups.entry(id.clone()).or_default();
                Some(Some(id))
            } else {
                None // some other group (e.g. a vendor extension): ignore
            };
            continue;
        }
        let Some(group) = current.as_ref() else {
            continue;
        };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let (key, value) = (line[..eq].to_string(), line[eq + 1..].to_string());
        match group {
            None => {
                entry.insert(key, value);
            }
            Some(id) => {
                if let Some(g) = action_groups.get_mut(id) {
                    g.insert(key, value);
                }
            }
        }
    }
    Some(DesktopFile {
        entry,
        action_groups,
    })
}

struct IconHit {
    path: PathBuf,
    priority: i32,
}

/// On-disk cache of the resolved icon index.
///
/// Walking every theme under `/usr/share/icons` costs tens of thousands of
/// `stat` calls on a full Kali install, which made startup visibly slow. The
/// resolved name -> path map is cached and reused as long as none of the icon
/// roots have been modified since it was written.
#[derive(Serialize, Deserialize)]
struct IconCache {
    /// Newest mtime (unix seconds) seen across the icon roots when cached.
    stamp: u64,
    /// Icon name -> absolute path.
    icons: HashMap<String, String>,
}

fn icon_cache_path() -> PathBuf {
    let dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("universe-3d");
    let _ = fs::create_dir_all(&dir);
    dir.join("icon-index.json")
}

/// Cheap freshness stamp: the newest mtime across the icon root directories.
///
/// Installing or removing a theme touches its root, so this catches the cases
/// that matter without re-walking the whole tree.
fn icon_roots_stamp() -> u64 {
    fn mtime(path: &Path) -> u64 {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
    let mut newest = 0;
    for root in icon_dirs() {
        newest = newest.max(mtime(&root));
        // One level down catches a theme being added or updated in place.
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                newest = newest.max(mtime(&entry.path()));
            }
        }
    }
    newest
}

fn load_icon_cache(stamp: u64) -> Option<HashMap<String, String>> {
    let raw = fs::read_to_string(icon_cache_path()).ok()?;
    let cache: IconCache = serde_json::from_str(&raw).ok()?;
    (cache.stamp == stamp).then_some(cache.icons)
}

fn store_icon_cache(stamp: u64, icons: &HashMap<String, String>) {
    let cache = IconCache {
        stamp,
        icons: icons.clone(),
    };
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = fs::write(icon_cache_path(), json);
    }
}

/// Build an icon-name -> absolute-path index (one filesystem walk).
fn walk_icon_index() -> HashMap<String, IconHit> {
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
                    index.insert(
                        stem,
                        IconHit {
                            path: full,
                            priority,
                        },
                    );
                }
            }
        }
    }

    for root in icon_dirs() {
        visit(&root, 0, &mut index);
    }
    index
}

/// Icon index, served from the on-disk cache when the icon roots are unchanged.
fn build_icon_index() -> HashMap<String, String> {
    let stamp = icon_roots_stamp();
    if let Some(cached) = load_icon_cache(stamp) {
        return cached;
    }
    let icons: HashMap<String, String> = walk_icon_index()
        .into_iter()
        .map(|(name, hit)| (name, hit.path.to_string_lossy().to_string()))
        .collect();
    store_icon_cache(stamp, &icons);
    icons
}

/// Resolve an `Icon=` value to an absolute file path (or None).
fn resolve_icon(icon_value: &str, index: &HashMap<String, String>) -> Option<String> {
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
        .cloned()
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
            let parsed = match parse_desktop_file(&file.path()) {
                Some(e) => e,
                None => continue,
            };
            let entry = &parsed.entry;
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
            // `Actions=` lists action ids in display order; each needs a
            // matching `[Desktop Action <id>]` group with Name and Exec.
            let actions: Vec<DesktopAction> = get("Actions")
                .split(';')
                .filter(|s| !s.is_empty())
                .filter_map(|id| {
                    let group = parsed.action_groups.get(id)?;
                    let name = group.get("Name")?.clone();
                    let exec = group.get("Exec")?.clone();
                    if name.is_empty() || exec.is_empty() {
                        return None;
                    }
                    Some(DesktopAction {
                        id: id.to_string(),
                        name,
                        exec,
                    })
                })
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
                    actions,
                },
            );
        }
    }

    let mut list: Vec<AppInfo> = apps.into_values().collect();
    list.sort_by_key(|a| a.name.to_lowercase());
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
