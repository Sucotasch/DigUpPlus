//! What the person chose: the folders DigUp searches, what it skips in them, the hotkey, and whether setup is done. A
//! JSON file in the app's config folder (%APPDATA%\com.sucotasch.digupplus on Windows,
//! ~/.config/com.sucotasch.digupplus on Linux). Launch arguments (`--roots`, `--hotkey`) stand in for it in dev runs.

use crate::hours::Hours;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Serde defaults for settings that older files don't have: the engine's own gate, and the measured layer cutoffs.
fn default_zgate() -> f64 { 2.0 }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// The folders searched and kept indexed.
    pub folders: Vec<String>,
    /// Folders inside them that aren't (`FolderSelection` in the engine).
    pub skipped: Vec<String>,
    /// File extensions left out ("heic", "txt").
    pub skip_types: Vec<String>,
    /// Recording extensions read by their tags alone (Settings → Folders → Recordings): the words of their title,
    /// artist and album, no sound decoded (`--tag-type`). Changing it queues those files again.
    pub tag_types: Vec<String>,
    /// A rule for a searched folder (`Rules…` in Settings → Folders): which kinds it holds, and whether its
    /// subfolders are walked (`--root-rule`). Folders without one are searched whole, as they always were. The kinds
    /// are strings, not an enum: a name from a newer version must not make the whole settings file unreadable.
    pub root_rules: BTreeMap<String, RootRule>,
    /// How far a meaning match must stand out to count (`Searcher.zGate`): lower finds more, weaker matches. None: the
    /// engine's 2.0. Sent to the search service with the folders, so the panel and the window agree. `Option` and not a
    /// number with a default, because `Settings::default()` (no settings file yet) doesn't apply serde's defaults.
    pub zgate: Option<f64>,
    /// Where the Images filter cuts its cosine layers: "standard" (the measured 0.648/0.600), "loose" or "strict".
    /// The window counts from it (`IMAGE_TIER_PROFILES` in window.js); the panel has no layers. None: standard.
    pub image_tiers: Option<String>,
    /// The panel's hotkey (Tauri's accelerator form); empty: the default.
    pub hotkey: String,
    /// Onboarding is done: the shell starts in the tray.
    pub set_up: bool,
    /// The panel sits centered where the desktop places windows itself (Wayland), in a window that fills the screen.
    pub center_panel: bool,
    /// Index only between these times of day (hours.rs); the times are kept while it's off.
    pub index_hours_on: bool,
    pub index_hours: Hours,
    /// Code search: its folders (an index of its own, code.sqlite), the folders skipped inside them, and the editor its
    /// results open in (editors.rs: an editor's id, "" for the first one found, "default" for the file's default app).
    pub code_folders: Vec<String>,
    pub code_skipped: Vec<String>,
    pub code_editor: String,
    /// Code search was turned off and its index is still to be deleted (Windows won't delete a file a helper has open).
    pub delete_code_index: bool,
    /// Where the window was left, for the next time it opens.
    pub window: Option<WindowPlace>,
    /// A click on the tray icon (Windows): "panel" shows the search panel, anything else opens the window.
    pub tray_click: String,
    /// The model runs on the processor even where the graphics card measured faster (Settings → General): for a card
    /// whose results come back wrong or empty. The helpers get `DIGUP_DEVICE=cpu`.
    pub processor_only: bool,
    /// Asking before moving or copying several files was turned off (Settings → General): one file never asks.
    pub confirm_move_copy_off: bool,
    /// Asking before deleting (to the Recycle Bin) was turned off (Settings → General).
    pub confirm_delete_off: bool,
    /// Index folders that look like datasets after all (Settings → Folders): the crawler skips them by default,
    /// which buries whole photo subfolders of a collection that happen to look alike.
    pub include_datasets: bool,
    /// The folder with both model files (Settings → Storage). None: the default folder.
    pub models_folder: Option<String>,
    /// The volume the folder was chosen on: a drive letter that comes back with another disk must not be written to.
    pub models_volume: Option<u64>,
    /// The person deleted the model files: don't download them again on the next start.
    pub model_removed: bool,
    /// The old folder after a move: its files go once the new model is ready (retried at the next start on failure).
    pub model_cleanup: Option<String>,
    /// Where the index lives (Settings → Storage). None: the default folder under the app's data folder.
    pub index_folder: Option<String>,
}

/// A folder's rule: the kinds it holds (empty: all), whether its subfolders are walked, and how its recordings are
/// read (by tags, by their sound, or both). The bits are optional: a rule saved before they existed (0.1.6) has
/// neither, and reads them from `kinds` — recordings were included exactly when `audio` was.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RootRule {
    pub kinds: Vec<String>,
    pub shallow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_tags: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_content: Option<bool>,
}

impl Default for RootRule {
    fn default() -> Self {
        RootRule { kinds: Vec::new(), shallow: false, audio_tags: None, audio_content: None }
    }
}

impl RootRule {
    /// Recordings are in this rule's kinds at all.
    fn reads_audio(&self) -> bool { self.kinds.iter().any(|kind| kind == "audio") }

    /// The bits as they act, with a 0.1.6 file's rule reading recordings exactly when it included them.
    pub fn tags_bit(&self) -> bool { self.audio_tags.unwrap_or_else(|| self.reads_audio()) }
    pub fn content_bit(&self) -> bool { self.audio_content.unwrap_or_else(|| self.reads_audio()) }
}

/// The window's size inside its frame (logical pixels), where it was (physical; Wayland doesn't tell), whether it
/// filled the screen, and the preview pane's width (None: the stylesheet's default).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowPlace {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
    pub side: Option<f64>,
}

impl Settings {
    /// The gate in use: what was chosen, or the engine's own. (`Settings::default()` has none: no settings file yet.)
    pub fn gate(&self) -> f64 { self.zgate.unwrap_or(default_zgate()) }

    /// The Images layers' cutoffs by profile (the window's `IMAGE_TIER_PROFILES` holds the same numbers). `"standard"`
    /// when nothing was chosen, and for a name this version doesn't know.
    pub fn tier_profile(name: &str) -> &'static str {
        match name {
            "loose" => "loose",
            "strict" => "strict",
            _ => "standard",
        }
    }

    /// What a settings change asks for: a number the engine can use, and a profile it knows. A value out of range is
    /// brought back into it rather than rejected — a person typing "1" meaning a looser gate shouldn't lose it to a
    /// silent no-op.
    pub fn search_settings(zgate: f64, image_tiers: &str) -> (f64, String) {
        let zgate = if zgate.is_finite() { zgate.clamp(0.5, 5.0) } else { default_zgate() };
        (zgate, Self::tier_profile(image_tiers).to_string())
    }
    /// The file's settings, or the defaults when there's none (or it can't be read). A file that can't be parsed is
    /// kept as `settings.json.bad`: the choices in it are the person's, and the next save would overwrite them for
    /// good. A file that can't be read at all (permissions) stays where it is; the log line is the only trace.
    pub fn load(path: &Path) -> Settings {
        match std::fs::read(path) {
            Ok(data) => match serde_json::from_slice(&data) {
                Ok(settings) => settings,
                Err(error) => {
                    let backup = path.with_extension("json.bad");
                    match std::fs::rename(path, &backup) {
                        Ok(()) => eprintln!("digup-shell: {} couldn't be read ({error}); kept it as {}",
                                            path.display(), backup.display()),
                        Err(backup_error) => eprintln!("digup-shell: {} couldn't be read ({error}); keeping it aside \
                                                        failed too ({backup_error})", path.display()),
                    }
                    Settings::default()
                }
            },
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("digup-shell: can't read {}: {error}", path.display());
                }
                Settings::default()
            }
        }
    }

    /// Written whole to a temporary file first, so a crash never leaves half of it.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let temporary = path.with_extension("json.new");
        std::fs::write(&temporary, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_settings_survive_a_round_trip_and_older_files_default_them() {
        let folder = std::env::temp_dir().join(format!("DigUp-settings-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("settings.json");
        let settings = Settings { models_folder: Some("G:\\Ai\\Модели".into()), models_volume: Some(42),
                                      model_removed: true, model_cleanup: Some("C:\\old".into()),
                                      index_folder: Some("H:\\DigUp\\Index".into()), ..Settings::default() };
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.models_folder, settings.models_folder);
        assert_eq!(loaded.models_volume, Some(42));
        assert!(loaded.model_removed);
        assert_eq!(loaded.model_cleanup, settings.model_cleanup);
        assert_eq!(loaded.index_folder, settings.index_folder);
        std::fs::write(&path, br#"{"setUp":true}"#).unwrap();
        let older = Settings::load(&path);
        assert!(older.models_folder.is_none() && older.models_volume.is_none() && !older.model_removed);
        assert!(older.index_folder.is_none());
        // The preview pane's width rides with the window's place, and an older file without it defaults to None.
        let path = folder.join("place.json");
        let settings = Settings { window: Some(WindowPlace { width: 1040.0, height: 700.0, x: None, y: None,
                                                              maximized: false, side: Some(412.0) }),
                                  ..Settings::default() };
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.window.and_then(|place| place.side), Some(412.0));
        std::fs::write(&path, br#"{"window": {"width": 1040.0, "height": 700.0}}"#).unwrap();
        assert_eq!(Settings::load(&path).window.and_then(|place| place.side), None);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_folder_rule_survives_a_round_trip_and_older_files_have_none() {
        let folder = std::env::temp_dir().join(format!("DigUp-rules-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("settings.json");
        let mut settings = Settings::default();
        settings.root_rules.insert("D:\\Photos".into(),
                                   RootRule { kinds: vec!["image".into(), "screenshot".into()], shallow: false,
                                              ..RootRule::default() });
        settings.root_rules.insert("D:\\Records".into(),
                                   RootRule { kinds: vec!["audio".into()], shallow: true, ..RootRule::default() });
        settings.save(&path).unwrap();
        assert_eq!(Settings::load(&path).root_rules, settings.root_rules);
        // A file from before rules were a setting keeps working, with no rules.
        std::fs::write(&path, br#"{"folders":["C:/One"]}"#).unwrap();
        assert!(Settings::load(&path).root_rules.is_empty());
        // A kind this version doesn't know stays in the file (the glue drops it) instead of losing the settings.
        std::fs::write(&path, br#"{"folders":["C:/One"],"rootRules":{"C:/One":{"kinds":["hologram","audio"],"shallow":true}}}"#).unwrap();
        let odd = Settings::load(&path);
        assert_eq!(odd.folders, vec!["C:/One"]);
        assert_eq!(odd.root_rules["C:/One"].kinds, vec!["hologram", "audio"]);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn search_settings_default_to_the_engine_and_keep_a_chosen_gate() {
        let folder = std::env::temp_dir().join(format!("DigUp-search-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("settings.json");
        // A file from before these settings: the engine's gate and the measured layer cutoffs.
        std::fs::write(&path, br#"{"folders":["C:/One"]}"#).unwrap();
        let older = Settings::load(&path);
        assert_eq!(older.gate(), 2.0);
        assert_eq!(Settings::tier_profile(older.image_tiers.as_deref().unwrap_or("standard")), "standard");
        // No settings file yet (a first run): the derived Default has no gate at all, which must still search at 2.0.
        assert!(Settings::default().zgate.is_none());
        assert_eq!(Settings::default().gate(), 2.0);
        // A chosen gate and profile ride along, and an unknown profile reads as standard.
        let settings = Settings { zgate: Some(1.4), image_tiers: Some("hologram".into()), ..Settings::default() };
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.gate(), 1.4);
        assert_eq!(Settings::tier_profile(loaded.image_tiers.as_deref().unwrap_or("standard")), "standard");
        // What a change is kept as: a usable number and a known profile.
        assert_eq!(Settings::search_settings(1.4, "loose"), (1.4, "loose".to_string()));
        assert_eq!(Settings::search_settings(0.0, "strict"), (0.5, "strict".to_string()));
        assert_eq!(Settings::search_settings(99.0, "nope"), (5.0, "standard".to_string()));
        assert_eq!(Settings::search_settings(f64::NAN, "loose"), (2.0, "loose".to_string()));
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_malformed_settings_file_is_kept_aside_as_bad_and_defaults_are_used() {
        let folder = std::env::temp_dir().join(format!("DigUp-settings-bad-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("settings.json");
        let broken = br#"{"folders": ["C:/Keep"], "hotkey"#;
        std::fs::write(&path, broken).unwrap();
        let loaded = Settings::load(&path);
        assert!(loaded.folders.is_empty());          // the defaults, not a half-read file
        assert!(!path.exists());                     // the bad file was moved, so a save can't overwrite it
        let kept = std::fs::read(folder.join("settings.json.bad")).unwrap();
        assert_eq!(kept, broken.as_slice());         // the person's choices are recoverable
        // A missing file is the ordinary first run: defaults, and nothing to keep aside.
        let missing = folder.join("none.json");
        assert!(Settings::load(&missing).folders.is_empty());
        let _ = std::fs::remove_dir_all(&folder);
    }
}
