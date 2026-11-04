//! Watching the chosen folders: a change where indexing reads asks the index helper to sync, two seconds after the last
//! one (a camera import or an unzip is a burst of events); in code search's folders a minute after the code goes quiet
//! (ten at most), as on the Mac, so the code index doesn't follow every save. `notify` uses ReadDirectoryChangesW on Windows, inotify on
//! Linux, FSEvents on a Mac. Changes where the crawl never goes are passed over (the engine's `Rules.isWalked`): hidden
//! folders (a leading dot, or Windows' hidden flag, which AppData has), developer folders, `.noindex` folders, skipped
//! folders, and DigUp's own index. With a home folder chosen, other apps' caches would ask for a sync every few seconds.
//! The paths of each burst go to the caller, which can pass over the echo of a move or delete DigUp just did itself
//! (`echo`).

use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// Folders the crawl never walks into, by name: the engine's `Rules.skippedFolderNames`.
const DEVELOPER_FOLDERS: [&str; 8] =
    ["node_modules", "bower_components", "venv", "site-packages", "__pycache__", "DerivedData", "Pods", "Carthage"];

/// A full sync after the system dropped events is expensive: one a minute is plenty, and a storm of them is one sync.
const OVERFLOW_COOLDOWN: Duration = Duration::from_secs(60);
/// Files still being written are looked at again this often, for at most `SETTLE_WINDOW`: a PDF the printer is writing
/// or a video being copied would otherwise be read half-done and fail.
const SETTLE_STEP: Duration = Duration::from_millis(500);
const SETTLE_WINDOW: Duration = Duration::from_secs(10);
/// Where watching failed (a network or exFAT disk), changes are looked for this often instead of not at all.
const POLL: Duration = Duration::from_secs(300);

pub struct FolderWatcher {
    _watcher: Option<notify::RecommendedWatcher>,
    watching: bool,
    /// Cleared when the app drops this (the folders changed): a failing watcher's poll then ends.
    alive: Arc<AtomicBool>,
}

impl Drop for FolderWatcher {
    fn drop(&mut self) { self.alive.store(false, Ordering::Relaxed); }
}

impl FolderWatcher {
    /// Whether the system accepted a watch for every folder: when it didn't, changes are looked for every five minutes
    /// instead (the caller shows "changes aren't watched").
    pub fn watching(&self) -> bool { self.watching }

    /// Watches `folders` (less `skipped` inside them); `shallow` ones are watched one level deep (their rule is "top
    /// level only": changes far inside are dropped by the crawl anyway, and a deep tree would ask for syncs all day).
    /// `changed` runs on the watcher's own thread after each burst of changes, with every path of the burst (none when
    /// the system dropped events): once nothing has changed for `quiet`, or `longest` after the burst began. `types`
    /// are the extensions the crawl skips; a change to a type it never indexes doesn't ask for a sync. A code watcher
    /// passes None: its types are the code index's. Dropping it stops.
    /// shortcut: a change of a type one folder's rule doesn't index still asks for a sync (the game isn't worth
    /// copying the engine's extension tables here); upgrade when a big library shows the cost.
    pub fn start(folders: &[PathBuf], shallow: &[PathBuf], skipped: Vec<PathBuf>, ignore: Option<PathBuf>,
                 types: Option<Vec<String>>, quiet: Duration, longest: Duration,
                 changed: impl Fn(&[PathBuf]) + Send + 'static) -> FolderWatcher {
        let (sender, receiver) = mpsc::channel::<Vec<PathBuf>>();
        let roots = folders.to_vec();
        let alive = Arc::new(AtomicBool::new(true));
        // For a watch the system refuses, and for folders it refuses: their changes are looked for every five minutes.
        let poll_sender = sender.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if event.kind.is_access() {
                return;
            }
            let ignored = |path: &PathBuf| ignore.as_ref().is_some_and(|folder| path.starts_with(folder));
            // No paths: the system dropped events (an overflow), so anything may have changed: the burst keeps none,
            // and a sync runs.
            let empty = event.paths.is_empty();
            let paths: Vec<PathBuf> = event.paths.into_iter()
                .filter(|path| !ignored(path) && walked(path, &roots, &skipped)
                    && types.as_ref().is_none_or(|types| change_may_matter(path, types))).collect();
            if empty || !paths.is_empty() {
                let _ = sender.send(paths);
            }
        });
        // The folders no watch covers: a failing backend or folder is looked for every five minutes instead.
        let mut unwatched = folders.to_vec();
        let watcher = match watcher {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                eprintln!("digup-shell: can't watch folders: {error}");
                None
            }
        };
        let mut watcher = watcher;
        if let Some(watcher) = &mut watcher {
            for folder in folders {
                let mode = if shallow.contains(folder) { RecursiveMode::NonRecursive } else { RecursiveMode::Recursive };
                match watcher.watch(folder, mode) {
                    Ok(()) => unwatched.retain(|path| path != folder),
                    Err(error) => eprintln!("digup-shell: can't watch {}: {error}", folder.display()),
                }
            }
        }
        if !unwatched.is_empty() {
            let (sender, alive, poll_for) = (poll_sender, alive.clone(), unwatched.clone());
            std::thread::spawn(move || {
                while alive.load(Ordering::Relaxed) {
                    // In steps: dropping the watcher must not leave a thread asleep for five minutes.
                    let began = Instant::now();
                    while began.elapsed() < POLL && alive.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                    if !alive.load(Ordering::Relaxed) || sender.send(poll_for.clone()).is_err() {
                        break;
                    }
                }
            });
        }
        std::thread::spawn(move || {
            let mut last_overflow: Option<Instant> = None;
            while let Ok(mut paths) = receiver.recv() {
                let began = std::time::Instant::now();
                // An empty event is the system dropping events: a burst it joins needs a full sync, not its paths.
                let mut dropped = paths.is_empty();
                loop {
                    match receiver.recv_timeout(quiet) {
                        Ok(more) => {
                            if more.is_empty() {
                                dropped = true;
                            } else {
                                paths.extend(more);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                    if began.elapsed() >= longest {
                        break;
                    }
                }
                if dropped {
                    // A storm of dropped events is one sync a minute; a burst made only of them waits its turn.
                    let left = cooldown_left(last_overflow, OVERFLOW_COOLDOWN);
                    if !left.is_zero() {
                        std::thread::sleep(left);
                    }
                    last_overflow = Some(Instant::now());
                    paths.clear();
                } else {
                    settle(&paths, SETTLE_STEP, SETTLE_WINDOW);
                }
                paths.sort_unstable();
                paths.dedup();
                changed(&paths);
            }
        });
        FolderWatcher { _watcher: watcher, watching: unwatched.is_empty(), alive }
    }
}

/// How long a dropped-events sync must wait for the last one to be a minute old.
fn cooldown_left(last: Option<Instant>, cooldown: Duration) -> Duration {
    last.map_or(Duration::ZERO, |last| cooldown.saturating_sub(last.elapsed()))
}

/// Waits for the files of a burst to stop growing: their (size, mtime) seen twice in a row, at most `window` long.
fn settle(paths: &[PathBuf], step: Duration, window: Duration) {
    let began = Instant::now();
    let mut seen = snapshots(paths);
    if seen.iter().all(Option::is_none) {
        return;
    }
    while began.elapsed() < window {
        std::thread::sleep(step);
        let now = snapshots(paths);
        if now == seen {
            return;
        }
        seen = now;
    }
}

/// Each existing file's size and modification time, for `settle` (a folder or a file that's gone: None).
fn snapshots(paths: &[PathBuf]) -> Vec<Option<(u64, Option<SystemTime>)>> {
    paths.iter().map(|path| match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Some((meta.len(), meta.modified().ok())),
        _ => None,
    }).collect()
}

/// The crawl reads `path`: it's inside a chosen folder, and nothing on the way to it from there is skipped. A skipped
/// folder counts only inside the chosen folders that contain it (one chosen inside it is read whole).
fn walked(path: &Path, roots: &[PathBuf], skipped: &[PathBuf]) -> bool {
    roots.iter().any(|root| {
        let Ok(below) = path.strip_prefix(root) else { return false };
        let mut folder = root.clone();
        below.components().all(|part| {
            folder.push(part);
            let name = part.as_os_str().to_string_lossy();
            !(name.starts_with('.')
                || DEVELOPER_FOLDERS.contains(&name.as_ref())
                || name.ends_with(".noindex")
                || skipped.contains(&folder)
                || hidden(&folder))
        })
    })
}

/// What the crawl indexes by extension (the portable `Rules.classify`): documents, PDFs and media matter; source
/// and data files are skipped unless code search's own index reads them. A change to anything else asks for no sync.
const DOCUMENT_EXTENSIONS: [&str; 15] = [
    "txt", "text", "md", "markdown", "typ", "rtf", "docx", "doc", "odt", "html", "htm", "xlsx", "pptx", "ods", "odp",
];
const IMAGE_EXTENSIONS: [&str; 25] = [
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "tif", "tiff", "webp", "heic", "heif", "avif", "psd", "tga",
    "pnm", "ppm", "pgm", "cr2", "nef", "arw", "dng", "raf", "orf", "rw2",
];
const AUDIO_EXTENSIONS: [&str; 16] = [
    "mp3", "m4a", "m4b", "aac", "wav", "wave", "flac", "ogg", "oga", "opus", "aiff", "aif", "wma", "amr", "caf", "mka",
];
const VIDEO_EXTENSIONS: [&str; 15] = [
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "3gp", "3g2", "mpg", "mpeg", "m2v", "ogv", "mxf",
];
/// Mac bundles and library packages can sit on a shared disk; the crawl skips them whole (`FileSystem.packageExtensions`).
const PACKAGE_EXTENSIONS: [&str; 20] = [
    "app", "framework", "bundle", "plugin", "appex", "xpc", "kext", "xcodeproj", "xcworkspace", "playground",
    "photoslibrary", "photolibrary", "musiclibrary", "tvlibrary", "imovielibrary", "fcpbundle", "logicx", "band", "pkg", "dmg",
];

/// Whether a change at `path` can change what's indexed: a folder, or a file of a type the crawl reads, outside a
/// package (which the crawl skips whole) and not of a type the person excluded. A database rewritten every few seconds
/// would otherwise ask for a full sync each time. A path that's gone and has no extension may be a deleted folder.
fn change_may_matter(path: &Path, excluded: &[String]) -> bool {
    if is_package(path) || is_junk(path) {
        return false;
    }
    if path.is_dir() {
        return true;
    }
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()).map(str::to_lowercase) else {
        // A file without an extension isn't indexed; a path that's gone without one may be a folder.
        return !path.exists();
    };
    if excluded.iter().any(|type_| type_.trim_start_matches('.').eq_ignore_ascii_case(&extension)) {
        return false;
    }
    // TypeScript's .ts and MPEG transport streams share an extension; a stream is video, and the rare .ts document
    // is worth a sync either way.
    if extension == "ts" || extension == "mts" || extension == "m2ts" || extension == "pdf" {
        return true;
    }
    DOCUMENT_EXTENSIONS.contains(&extension.as_str())
        || IMAGE_EXTENSIONS.contains(&extension.as_str())
        || AUDIO_EXTENSIONS.contains(&extension.as_str())
        || VIDEO_EXTENSIONS.contains(&extension.as_str())
}

/// A path inside a package (or the package folder itself), whose contents the crawl never reads.
fn is_package(path: &Path) -> bool {
    path.ancestors().any(|folder| {
        folder.extension().and_then(|extension| extension.to_str())
            .is_some_and(|extension| PACKAGE_EXTENSIONS.contains(&extension.to_lowercase().as_str()))
    })
}

/// The engine's `Rules.isJunk`: a program's lock, swap and part-written files. Word keeping a document open rewrote its
/// "~$report.docx" every few seconds, and each write asked for a sync of the whole folder.
fn is_junk(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    let lower = name.to_lowercase();
    if lower.starts_with("~$") || ["desktop.ini", "thumbs.db", "4913"].contains(&lower.as_str()) {
        return true;
    }
    let extension = path.extension().and_then(|extension| extension.to_str()).map(str::to_lowercase);
    matches!(extension.as_deref(), Some("tmp" | "swp" | "swo" | "crdownload"))
}

/// Windows' hidden flag; elsewhere a leading dot is the rule, checked above.
#[cfg(windows)]
fn hidden(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
}

#[cfg(not(windows))]
fn hidden(_: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{change_may_matter, cooldown_left, settle, snapshots, walked, OVERFLOW_COOLDOWN};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    #[test]
    fn only_changes_the_crawl_reads_matter() {
        let read = |path: &str| change_may_matter(&PathBuf::from(path), &[]);
        assert!(read("photo.jpg"));
        assert!(read("notes.md"));
        assert!(read("invoice.pdf"));
        assert!(read("clip.mp4"));
        assert!(read("tone.wav"));
        assert!(read("a.heic"));
        assert!(!read("server.log"));
        assert!(!read("collection-0.wt"));
        assert!(!read("metrics.interim.temp"));
        assert!(!read("data.json"));
        assert!(read("new folder"));   // gone and without an extension: a deleted folder
        assert!(!change_may_matter(Path::new("photo.jpg"), &["jpg".to_string()]));
        assert!(!read("Photos Library.photoslibrary/originals/a.heic"));
        assert!(!read("Tool.app/Contents/Resources/icon.png"));
        // A program's leftovers: Word's lock file beside an open document, a part download, a swap file.
        assert!(!read("~$report.docx"));
        assert!(!read("Ripped.crdownload"));
        assert!(!read(".notes.swp"));
        assert!(!read("Thumbs.db"));
    }

    /// A storm of dropped events is one full sync a minute; the next waits out the minute.
    #[test]
    fn overflow_syncs_wait_a_minute() {
        assert_eq!(cooldown_left(None, OVERFLOW_COOLDOWN), Duration::ZERO);
        assert!(cooldown_left(Some(Instant::now()), OVERFLOW_COOLDOWN) > Duration::from_secs(59));
        let old = Instant::now().checked_sub(Duration::from_secs(120)).unwrap();
        assert_eq!(cooldown_left(Some(old), OVERFLOW_COOLDOWN), Duration::ZERO);
    }

    /// A file still being written is seen changing once, then as it is; a file that's gone or a folder is no file.
    #[test]
    fn a_writing_file_is_seen_changing() {
        let path = std::env::temp_dir().join(format!("digup-settle-{}.txt", std::process::id()));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"first").unwrap();
        let before = snapshots(std::slice::from_ref(&path));
        file.write_all(b" and more").unwrap();
        file.flush().unwrap();
        let after = snapshots(std::slice::from_ref(&path));
        assert_ne!(before, after);
        assert_eq!(after[0].map(|(size, _)| size), Some(14));
        assert_eq!(snapshots(&[std::env::temp_dir().join("digup-not-here")]), vec![None]);
        // An unchanged file settles at once (one step), a folder is no file at all.
        settle(std::slice::from_ref(&path), Duration::from_millis(5), Duration::from_millis(200));
        assert_eq!(snapshots(&[std::env::temp_dir()]), vec![None]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn walks_where_the_crawl_goes() {
        let home = PathBuf::from("/home/me");
        let roots = vec![home.clone(), home.join("Pictures/.private/shared")];
        let skipped = vec![home.join("Music"), home.join("Music/Mixes")];
        let read = |path: &str| walked(&home.join(path), &roots, &skipped);
        assert!(read("Documents/notes.md"));
        assert!(!read(".cache/thumbnails/x.png"));
        assert!(!read("code/app/node_modules/pkg/index.js"));
        assert!(!read("Archive.noindex/old.pdf"));
        assert!(!read("Music/song.mp3"));
        assert!(!read("Music/Mixes/one.mp3"));
        // A folder chosen inside a hidden or skipped one is read whole.
        assert!(read("Pictures/.private/shared/photo.jpg"));
        assert!(!walked(&PathBuf::from("/elsewhere/file.txt"), &roots, &skipped));
    }
}
