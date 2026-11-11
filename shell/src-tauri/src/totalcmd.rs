//! Total Commander: the window's results opened as a list in its panel (`LOADLIST:` on its command line, the same
//! "feed to listbox" its own search does). No plugin: the panel shows the real files of any folders at once, in the
//! order DigUp ranked them, and F3, copy, move and delete work on them as usual.
//!
//! A list is one absolute path a line, in UTF-16 with a BOM and CRLF (Total Commander reads ANSI or UTF-16, and this
//! keeps any name), and it stays on disk: Total Commander rereads it when its panel refreshes.

use crate::options::Options;
use crate::settings::Settings;
use std::path::{Path, PathBuf};

/// How many paths one list may hold. A whole ranking is normally a few thousand; past this the list file and Total
/// Commander both get slow, and nobody works through twenty thousand rows in one panel.
pub const LIMIT: usize = 20_000;

/// How many lists stay in the folder; older ones go (each is a snapshot, and a panel may still reread its own).
const KEEP: usize = 20;

/// The program to run: the path chosen in Settings, or the install Total Commander's registry entry names (a portable
/// copy has no entry, hence the choice).
pub fn program(settings: &Settings) -> Option<PathBuf> {
    let chosen = PathBuf::from(settings.totalcmd.trim());
    if !settings.totalcmd.trim().is_empty() && chosen.is_file() {
        return Some(chosen);
    }
    installed()
}

/// The install the registry names: `HKCU\Software\Ghisler\Total Commander` → `InstallDir`, 64-bit program first.
#[cfg(windows)]
fn installed() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() };
    let (key, name) = (wide("Software\\Ghisler\\Total Commander"), wide("InstallDir"));
    let mut buffer = [0u16; 260];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(),
                     buffer.as_mut_ptr().cast(), &mut size)
    };
    if status != 0 || size < 2 {
        return None;
    }
    let folder = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize / 2 - 1]));
    ["TOTALCMD64.EXE", "TOTALCMD.EXE"].iter()
        .map(|exe| folder.join(exe))
        .find(|program| program.is_file())
}

#[cfg(not(windows))]
fn installed() -> Option<PathBuf> {
    None
}

/// The list file's bytes: a BOM, then each path (its separators as `\`) and CRLF, in the order given.
pub fn list_bytes(paths: &[String]) -> Vec<u8> {
    let mut text = String::with_capacity(paths.iter().map(|path| path.len() + 2).sum());
    for path in paths {
        text.push_str(&path.replace('/', "\\"));
        text.push_str("\r\n");
    }
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

/// The paths that are still there, in their order (a row can name a file on a drive that's away), up to `LIMIT`.
pub fn existing(paths: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths.iter()
        .filter(|path| Path::new(path).is_file() && seen.insert(path.to_lowercase()))
        .take(LIMIT)
        .cloned()
        .collect()
}

/// Where the lists go: a folder whose own path has no space in it. Total Commander's command line reads
/// `LOADLIST:path` up to the first space (measured on 11.55: a list under a folder with one opens nothing), so the
/// app's data folder — a portable copy often sits in "D:\My Tools\…", and a profile can be "John Smith" — can't be
/// used. The temp folder, then ProgramData, then the data folder, each tried until one takes the write.
pub fn lists_folder(options: &Options) -> Result<PathBuf, String> {
    let candidates = [
        Some(std::env::temp_dir().join("DigUpPlus")),
        std::env::var_os("ProgramData").map(|root| PathBuf::from(root).join("DigUpPlus")),
        options.data_root().map(|root| root.join("lists")),
    ];
    let mut problem = String::new();
    for folder in candidates.into_iter().flatten() {
        if folder.to_string_lossy().contains(' ') {
            continue;
        }
        match std::fs::create_dir_all(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) => problem = format!("{}: {error}", folder.display()),
        }
    }
    Err(format!("there's no folder for the list that Total Commander can open (it reads a path only up to the first \
                 space): {problem}"))
}

/// Writes a snapshot of the list (a new file each time: a panel that is refreshed rereads its own, unchanged) and
/// drops the oldest beyond `KEEP`.
pub fn write_list(folder: &Path, paths: &[String]) -> std::io::Result<PathBuf> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis()).unwrap_or(0);
    let file = folder.join(format!("results-{stamp}.lst"));
    std::fs::write(&file, list_bytes(paths))?;
    if let Ok(entries) = std::fs::read_dir(folder) {
        let ours = |name: &std::ffi::OsStr| name.to_string_lossy().starts_with("results-");
        let mut names: Vec<_> = entries.filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
            .filter(|name| ours(name)).collect();
        names.sort();
        for name in names.iter().rev().skip(KEEP) {
            let _ = std::fs::remove_file(folder.join(name));
        }
    }
    Ok(file)
}

/// Starts Total Commander with the list: `/O` hands it to a running copy (or starts one), `/T` opens a new tab so the
/// panels in use stay as they are.
pub fn open(program: &Path, list: &Path, new_tab: bool) -> std::io::Result<()> {
    let mut command = std::process::Command::new(program);
    // A portable copy finds its wincmd.ini beside the program, not in whatever folder DigUp was started from.
    if let Some(folder) = program.parent() {
        command.current_dir(folder);
    }
    command.arg("/O");
    if new_tab {
        command.arg("/T");
    }
    command.arg(format!("LOADLIST:{}", list.display()));
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(bytes: &[u8]) -> String {
        assert_eq!(&bytes[..2], &[0xFF, 0xFE], "a list starts with a UTF-16 BOM");
        let units: Vec<u16> = bytes[2..].chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn a_list_is_utf16_one_path_a_line_in_order() {
        let text = text_of(&list_bytes(&["C:/Photos/a b.jpg".into(), "C:/Фото/лист.png".into()]));
        assert_eq!(text, "C:\\Photos\\a b.jpg\r\nC:\\Фото\\лист.png\r\n");
    }

    #[test]
    fn only_the_twenty_newest_lists_stay() {
        let folder = std::env::temp_dir().join(format!("digup-tc-keep-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let other = folder.join("notes.txt");
        std::fs::write(&other, b"x").unwrap();
        for _ in 0..21 {
            write_list(&folder, &["C:/a.txt".to_string()]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let lists = std::fs::read_dir(&folder).unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("results-"))
            .count();
        assert_eq!(lists, 20, "the oldest list goes");
        assert!(other.exists(), "a file that isn't a list is left alone");
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn only_files_that_are_there_are_written() {
        let folder = std::env::temp_dir().join(format!("digup-tc-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let (here, gone) = (folder.join("here.txt"), folder.join("gone.txt"));
        std::fs::write(&here, b"x").unwrap();
        let paths: Vec<String> = [here.display().to_string(), gone.display().to_string(),
                                  here.display().to_string()].map(String::from).to_vec();
        let kept = existing(&paths);
        assert_eq!(kept, vec![here.display().to_string()], "a file that left the disk is skipped, and a duplicate once");
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
