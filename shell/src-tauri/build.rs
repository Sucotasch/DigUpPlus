use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

fn main() {
    // The pages are embedded at compile time. Rerunning this script is not enough: cargo reuses the app crate's
    // compilation unless one of its inputs changes, so a change to a page alone shipped a build with the old pages
    // (checked in the binary). The stamp is an input of that compilation and changes with the pages.
    println!("cargo:rerun-if-changed=../ui");
    let mut files = Vec::new();
    collect(Path::new("../ui"), &mut files);
    files.sort();
    let mut hasher = DefaultHasher::new();
    for path in files {
        path.hash(&mut hasher);
        if let Ok(meta) = std::fs::metadata(&path) {
            meta.len().hash(&mut hasher);
            if let Some(since) = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()) {
                since.as_nanos().hash(&mut hasher);
            }
        }
    }
    println!("cargo:rustc-env=DIGUP_UI_STAMP={:x}", hasher.finish());
    tauri_build::build()
}

fn collect(folder: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { collect(&path, out) } else { out.push(path) }
    }
}
