//! Editing a picture where it lies: rotate and flip (crop, resize and format join it with the edit sheet). No "edited
//! copy": the file itself changes, so the original is copied aside first for an undo, the new bytes go through a temp
//! file beside it and are renamed over (a crash never leaves half a picture), the camera's EXIF orientation is baked into
//! the pixels and reset to 1 (or the next viewer turns them again), and the original's metadata - EXIF/XMP/ICC/comments
//! in a JPEG, text chunks in a PNG - is carried over. The index catches up by itself: the watcher sees the new size and
//! time and has the file read again.

mod jpeg_meta;
mod png_meta;

use image::GenericImageView;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Which way a flip goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flip {
    Horizontal,
    Vertical,
}

/// What an edit did, for the window's report.
#[derive(Debug, Clone, Copy)]
pub struct Outcome {
    pub width: u32,
    pub height: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

struct UndoEntry {
    path: PathBuf,
    backup: PathBuf,
}

/// The last edits, newest last: a rotation is one keystroke away from being wrong, and the original is the only copy.
static UNDO: Mutex<Vec<UndoEntry>> = Mutex::new(Vec::new());
const UNDO_LIMIT: usize = 10;
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn undo_folder() -> &'static Path {
    static FOLDER: OnceLock<PathBuf> = OnceLock::new();
    FOLDER.get_or_init(|| {
        let folder = std::env::temp_dir().join(format!("digupplus-edits-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&folder);
        folder
    })
}

/// Rotates clockwise by `degrees` (0/90/180/270; 0 just bakes the camera's orientation in) and/or flips, in place.
pub fn edit(path: &Path, degrees: i32, flip: Option<Flip>) -> Result<Outcome, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("the picture couldn't be read: {error}"))?;
    let before = bytes.len() as u64;
    let extension = path.extension().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
    let format = match extension.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" | "jfi" | "jif" => image::ImageFormat::Jpeg,
        "png" => image::ImageFormat::Png,
        _ => return Err("Only JPEG and PNG pictures are edited for now.".into()),
    };
    let orientation = exif_orientation(&bytes);
    let mut turned = image::load_from_memory_with_format(&bytes, format)
        .map_err(|error| format!("the picture couldn't be decoded: {error}"))?;
    // The camera's orientation is part of the picture: apply it, then the person's own turn.
    turned.apply_orientation(
        image::metadata::Orientation::from_exif(orientation).unwrap_or(image::metadata::Orientation::NoTransforms));
    let turned = match degrees.rem_euclid(360) {
        0 => turned,
        90 => turned.rotate90(),
        180 => turned.rotate180(),
        270 => turned.rotate270(),
        other => return Err(format!("a rotation of {other} degrees isn't supported")),
    };
    let turned = match flip {
        Some(Flip::Horizontal) => turned.fliph(),
        Some(Flip::Vertical) => turned.flipv(),
        None => turned,
    };
    let (width, height) = turned.dimensions();
    let encoded = match format {
        image::ImageFormat::Jpeg => {
            let mut out = Vec::new();
            let rgb = turned.to_rgb8();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95);
            encoder.encode_image(&rgb).map_err(|error| format!("the picture couldn't be encoded: {error}"))?;
            // APPn/COM segments the encoder dropped: EXIF (with its orientation now 1), XMP, ICC, comments.
            let segments = reset_orientation(jpeg_meta::extract_segments(&bytes));
            jpeg_meta::merge_missing_segments(&out, &segments)
        }
        _ => {
            let chunks = png_meta::extract_text_chunks(path.to_str().unwrap_or_default())?;
            let rgba = turned.to_rgba8();
            png_meta::encode_png_with_text(width, height, rgba.as_raw(), &chunks)?
        }
    };
    let saved = backup(path)?;
    if let Err(error) = write_atomic(path, &encoded) {
        let _ = std::fs::remove_file(&saved);
        return Err(error);
    }
    remember(path, saved);
    Ok(Outcome { width, height, bytes_before: before, bytes_after: encoded.len() as u64 })
}

/// Puts the last edited picture back, exactly as it was; None when there is nothing to undo.
pub fn undo() -> Result<Option<PathBuf>, String> {
    let Some(entry) = UNDO.lock().unwrap().pop() else { return Ok(None) };
    let bytes = match std::fs::read(&entry.backup) {
        Ok(bytes) => bytes,
        Err(error) => return Err(format!("the undo copy couldn't be read: {error}")),
    };
    if let Err(error) = write_atomic(&entry.path, &bytes) {
        UNDO.lock().unwrap().push(entry);   // still undoable once the file lets go
        return Err(error);
    }
    let _ = std::fs::remove_file(&entry.backup);
    Ok(Some(entry.path))
}

/// The orientation tag says how the stored pixels are to be turned (1 is "as stored").
fn exif_orientation(bytes: &[u8]) -> u8 {
    exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()
        .and_then(|data| {
            data.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
                .map(|value| value as u8)
        })
        .unwrap_or(1)
}

/// The edit baked the orientation into the pixels, so the tag becomes 1.
fn reset_orientation(mut segments: Vec<jpeg_meta::JpegSegment>) -> Vec<jpeg_meta::JpegSegment> {
    for segment in &mut segments {
        if segment.marker == 0xE1 && segment.data.starts_with(b"Exif\0\0") {
            set_orientation_one(&mut segment.data);
        }
    }
    segments
}

/// Rewrites the Orientation (0x0112) of IFD0 in an APP1 "Exif\0\0" payload to 1, in place.
fn set_orientation_one(data: &mut [u8]) {
    let tiff = 6;                                   // "Exif\0\0" before the TIFF header
    if data.len() < tiff + 8 { return; }
    let little = &data[tiff..tiff + 2] == b"II";
    let read16 = |bytes: &[u8], at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let read16be = |bytes: &[u8], at: usize| u16::from_be_bytes([bytes[at], bytes[at + 1]]);
    let read32 = |bytes: &[u8], at: usize| {
        if little { u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) }
        else { u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) }
    };
    let short = |bytes: &[u8], at: usize| if little { read16(bytes, at) } else { read16be(bytes, at) };
    if short(data, tiff + 2) != 42 { return; }
    let ifd = tiff + read32(data, tiff + 4) as usize;
    if ifd + 2 > data.len() { return; }
    let count = short(data, ifd) as usize;
    for index in 0..count {
        let entry = ifd + 2 + index * 12;
        if entry + 12 > data.len() { return; }
        if short(data, entry) == 0x0112 {
            // SHORT, count 1: the value sits inline in the entry's 4-byte field.
            if little {
                data[entry + 8] = 1;
                data[entry + 9] = 0;
            } else {
                data[entry + 8] = 0;
                data[entry + 9] = 1;
            }
            return;
        }
    }
}

fn backup(path: &Path) -> Result<PathBuf, String> {
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let target = undo_folder().join(format!("{serial}.bak"));
    std::fs::copy(path, &target).map_err(|error| format!("the undo copy couldn't be made: {error}"))?;
    Ok(target)
}

fn remember(path: &Path, saved: PathBuf) {
    let mut undo = UNDO.lock().unwrap();
    undo.push(UndoEntry { path: path.to_path_buf(), backup: saved });
    while undo.len() > UNDO_LIMIT {
        if let Some(oldest) = undo.first() {
            let _ = std::fs::remove_file(&oldest.backup);
        }
        undo.remove(0);
    }
}

/// Writes beside the file and renames over it: a reader that holds the file open (the indexer) makes the replace fail
/// for a moment, so it is retried, and a failure leaves the original untouched with only a temp file to remove.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let folder = path.parent().ok_or("the picture has no folder")?;
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("the picture has no name")?;
    let temp = folder.join(format!(".{name}.digup-edit-{}", std::process::id()));
    std::fs::write(&temp, bytes).map_err(|error| format!("the edited picture couldn't be written: {error}"))?;
    for attempt in 0..20 {
        match std::fs::rename(&temp, path) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 19 => {
                let _ = error;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temp);
                return Err(format!("the picture couldn't be replaced: {error}"));
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn folder() -> tempfile::TempDir { tempfile::tempdir().unwrap() }

    fn jpeg_with_orientation(path: &Path, width: u32, height: u32, orientation: u16) {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([120, 60, 30]));
        let mut encoded = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 95).encode_image(&image).unwrap();
        // A minimal Exif APP1: TIFF header, one IFD0 entry (Orientation), no next IFD.
        let mut exif = b"Exif\0\0II\x2A\0\x08\0\0\0".to_vec();
        exif.extend_from_slice(&[1, 0]);
        exif.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0]);
        exif.extend_from_slice(&orientation.to_le_bytes());
        exif.extend_from_slice(&[0, 0, 0, 0]);
        exif.extend_from_slice(&[0, 0, 0, 0]);
        let segment = jpeg_meta::JpegSegment { marker: 0xE1, data: exif };
        std::fs::write(path, jpeg_meta::merge_missing_segments(&encoded, &[segment])).unwrap();
    }

    fn png_with_text(path: &Path, width: u32, height: u32) {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![7u8; (width * height * 4) as usize]).unwrap();
            writer.write_text_chunk(&png::text_metadata::TEXtChunk::new(
                "parameters".to_string(), "a dog".to_string())).unwrap();
            writer.finish().unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn rotates_and_keeps_the_format() {
        let dir = folder();
        let path = dir.path().join("photo.jpg");
        jpeg_with_orientation(&path, 64, 48, 1);
        let outcome = edit(&path, 90, None).unwrap();
        assert_eq!((outcome.width, outcome.height), (48, 64));
        let dimensions = image::image_dimensions(&path).unwrap();
        assert_eq!(dimensions, (48, 64));
        assert!(!dir.path().join(".photo.jpg.digup-edit.tmp").exists());
    }

    #[test]
    fn bakes_the_camera_orientation_and_resets_the_tag() {
        let dir = folder();
        let path = dir.path().join("turned.jpg");
        jpeg_with_orientation(&path, 64, 48, 6);      // stored 64x48, shown 48x64
        let outcome = edit(&path, 0, None).unwrap();
        assert_eq!((outcome.width, outcome.height), (48, 64), "the display orientation is baked in");
        let bytes = std::fs::read(&path).unwrap();
        let orientation = exif_orientation(&bytes);
        assert_eq!(orientation, 1, "the tag must not turn it again");
    }

    #[test]
    fn flips_horizontally() {
        let dir = folder();
        let path = dir.path().join("flip.png");
        // A 4x2 picture with its left column black and the right one white tells a flip from a rotation.
        let mut image = image::RgbaImage::from_pixel(4, 2, image::Rgba([255, 255, 255, 255]));
        for y in 0..2 {
            image.put_pixel(0, y, image::Rgba([0, 0, 0, 255]));
        }
        image.save(&path).unwrap();
        edit(&path, 0, Some(Flip::Horizontal)).unwrap();
        let after = image::open(&path).unwrap().to_rgba8();
        assert_eq!(after.get_pixel(3, 0), &image::Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn png_text_survives_a_rotation() {
        let dir = folder();
        let path = dir.path().join("prompt.png");
        png_with_text(&path, 4, 2);
        edit(&path, 180, None).unwrap();
        let chunks = png_meta::extract_text_chunks(path.to_str().unwrap()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].keyword, "parameters");
        assert_eq!(chunks[0].text, "a dog");
        assert_eq!(image::image_dimensions(&path).unwrap(), (4, 2));
    }

    #[test]
    fn undo_puts_the_bytes_back() {
        let dir = folder();
        let path = dir.path().join("undo.jpg");
        jpeg_with_orientation(&path, 16, 8, 1);
        let original = std::fs::read(&path).unwrap();
        edit(&path, 90, None).unwrap();
        assert_ne!(std::fs::read(&path).unwrap(), original);
        let restored = undo().unwrap().unwrap();
        assert_eq!(restored, path);
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}
