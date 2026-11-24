//! Editing a picture where it lies: rotate, flip, crop, resize and a format change. No "edited copy": when the format
//! stays, the file itself changes - the original is copied aside first for an undo, the new bytes go through a temp file
//! beside it and are renamed over (a crash never leaves half a picture). A format change writes `<name>.<ext>` and puts
//! the original in the Recycle Bin. The camera's EXIF orientation is baked into the pixels and reset to 1 (or the next
//! viewer turns them again), and the original's metadata - EXIF/XMP/ICC/comments in a JPEG, text chunks in a PNG, the
//! AI prompts of a PNG carried into a JPEG the way ComfyUI does - is kept. The index catches up by itself: the watcher
//! sees the new size and time and has the file read again.

mod exif_writer;
mod jpeg_meta;
mod png_meta;

use image::GenericImageView;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Which way a flip goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flip {
    Horizontal,
    Vertical,
}

/// The part of the picture to keep, in its pixels after the camera's orientation was applied.
#[derive(Debug, Clone, Copy)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Shrink (or grow) to a long side, or by a percentage.
#[derive(Debug, Clone, Copy)]
pub enum Resize {
    LongSide(u32),
    Percent(u32),
}

/// What the file should be when the edit is done: its own format, JPEG or PNG.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Keep,
    Jpeg,
    Png,
}

/// One edit: every field but `target` and `quality` is optional, and they apply in this order - orientation, rotate,
/// flip, crop, resize.
#[derive(Debug, Clone, Copy)]
pub struct Edit {
    pub rotate: i32,
    pub flip: Option<Flip>,
    pub crop: Option<Crop>,
    pub resize: Option<Resize>,
    pub target: Target,
    pub quality: u8,
}

impl Default for Edit {
    fn default() -> Self {
        Edit { rotate: 0, flip: None, crop: None, resize: None, target: Target::Keep, quality: 92 }
    }
}

/// What the edit did, for the window's note.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
    /// The file grew a new name (PNG to JPG or back); the old one is in the Recycle Bin.
    pub converted: bool,
}

struct UndoEntry {
    path: PathBuf,
    backup: PathBuf,
    /// A converted edit's new file: undoing it takes that away and puts the original back.
    added: Option<PathBuf>,
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
    edit_picture(path, Edit { rotate: degrees, flip, ..Edit::default() })
}

pub fn edit_picture(path: &Path, ops: Edit) -> Result<Outcome, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("the picture couldn't be read: {error}"))?;
    let before = bytes.len() as u64;
    let source = format_of(path)?;
    let orientation = exif_orientation(&bytes);
    let mut image = image::load_from_memory_with_format(&bytes, source)
        .map_err(|error| format!("the picture couldn't be decoded: {error}"))?;
    image.apply_orientation(
        image::metadata::Orientation::from_exif(orientation).unwrap_or(image::metadata::Orientation::NoTransforms));
    image = match ops.rotate.rem_euclid(360) {
        0 => image,
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        other => return Err(format!("a rotation of {other} degrees isn't supported")),
    };
    image = match ops.flip {
        Some(Flip::Horizontal) => image.fliph(),
        Some(Flip::Vertical) => image.flipv(),
        None => image,
    };
    if let Some(crop) = ops.crop {
        if crop.width == 0 || crop.height == 0 {
            return Err("the crop is empty".into());
        }
        if crop.x.saturating_add(crop.width) > image.width() || crop.y.saturating_add(crop.height) > image.height() {
            return Err("the crop is outside the picture".into());
        }
        image = image.crop_imm(crop.x, crop.y, crop.width, crop.height);
    }
    if let Some(resize) = ops.resize {
        let (width, height) = image.dimensions();
        let (target_width, target_height) = match resize {
            Resize::LongSide(long) => {
                let long = long.clamp(16, 16384);
                if long >= width.max(height) {
                    (width, height)
                } else {
                    let scale = f64::from(long) / f64::from(width.max(height));
                    ((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
                }
            }
            Resize::Percent(percent) => {
                let percent = percent.clamp(1, 400);
                let scale = f64::from(percent) / 100.0;
                ((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
            }
        };
        let (target_width, target_height) = (target_width.max(1), target_height.max(1));
        if (target_width, target_height) != (width, height) {
            image = image.resize_exact(target_width, target_height, image::imageops::FilterType::Lanczos3);
        }
    }
    let (width, height) = image.dimensions();
    let target_format = match ops.target {
        Target::Keep => source,
        Target::Jpeg => image::ImageFormat::Jpeg,
        Target::Png => image::ImageFormat::Png,
    };
    let encoded = encode(&image, source, target_format, &bytes, path, ops.quality)?;
    let converted = target_format != source;
    let target_path = if converted {
        path.with_extension(if target_format == image::ImageFormat::Jpeg { "jpg" } else { "png" })
    } else {
        path.to_path_buf()
    };
    if converted && target_path.exists() {
        return Err(format!("{} already exists beside it - nothing was changed", target_path.file_name()
            .and_then(|name| name.to_str()).unwrap_or("a file")));
    }
    let saved = backup(path)?;
    if converted {
        if let Err(error) = write_new(&target_path, &encoded) {
            let _ = std::fs::remove_file(&saved);
            return Err(error);
        }
        if let Err(error) = crate::file_ops::recycle(path) {
            // The old file is still there: a converted copy beside it would be exactly the copy this tool doesn't make.
            let _ = std::fs::remove_file(&target_path);
            let _ = std::fs::remove_file(&saved);
            return Err(format!("the original couldn't be put in the Recycle Bin: {error}"));
        }
        remember(path, saved, Some(target_path.clone()));
    } else {
        if let Err(error) = write_atomic(path, &encoded) {
            let _ = std::fs::remove_file(&saved);
            return Err(error);
        }
        remember(path, saved, None);
    }
    Ok(Outcome { path: target_path, width, height, bytes_before: before, bytes_after: encoded.len() as u64, converted })
}

/// Puts the last edited picture back, exactly as it was; a converted edit also takes its new file away. None when there
/// is nothing to undo.
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
    if let Some(added) = &entry.added {
        if crate::file_ops::recycle(added).is_err() {
            let _ = std::fs::remove_file(added);
        }
    }
    let _ = std::fs::remove_file(&entry.backup);
    Ok(Some(entry.path))
}

fn format_of(path: &Path) -> Result<image::ImageFormat, String> {
    match path.extension().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" | "jfi" | "jif" => Ok(image::ImageFormat::Jpeg),
        "png" => Ok(image::ImageFormat::Png),
        _ => Err("Only JPEG and PNG pictures are edited for now.".into()),
    }
}

fn encode(image: &image::DynamicImage, source: image::ImageFormat, target: image::ImageFormat, original: &[u8],
          path: &Path, quality: u8) -> Result<Vec<u8>, String> {
    match target {
        image::ImageFormat::Jpeg => {
            let rgb = flatten_on_white(&image.to_rgba8());
            let mut out = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(60, 100));
            encoder.encode_image(&rgb).map_err(|error| format!("the picture couldn't be encoded: {error}"))?;
            let segments = if source == image::ImageFormat::Jpeg {
                // APPn/COM segments the encoder dropped: EXIF (its orientation now 1), XMP, ICC, comments.
                reset_orientation(jpeg_meta::extract_segments(original))
            } else {
                prompt_segments(path)?
            };
            Ok(jpeg_meta::merge_missing_segments(&out, &segments))
        }
        image::ImageFormat::Png => {
            let chunks = if source == image::ImageFormat::Png {
                png_meta::extract_text_chunks(path.to_str().ok_or("the picture's path isn't text")?)?
            } else {
                Vec::new()
            };
            let rgba = image.to_rgba8();
            png_meta::encode_png_with_text(rgba.width(), rgba.height(), rgba.as_raw(), &chunks)
        }
        _ => Err("that format isn't supported".into()),
    }
}

/// JPEG has no alpha: a transparent picture goes onto white, as Image Sorter does.
fn flatten_on_white(rgba: &image::RgbaImage) -> image::RgbImage {
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = f32::from(a) / 255.0;
        let mix = |channel: u8| (f32::from(channel) * alpha + 255.0 * (1.0 - alpha)).round() as u8;
        rgb.put_pixel(x, y, image::Rgb([mix(r), mix(g), mix(b)]));
    }
    rgb
}

/// A PNG's AI-generation metadata, carried into a JPEG the way ComfyUI's own save path does: prompt and workflow
/// minified into EXIF Model/Make, A1111's `parameters` into a comment. A prompt too large even minified is refused
/// rather than dropped - the PNG is the file that can hold it.
fn prompt_segments(path: &Path) -> Result<Vec<jpeg_meta::JpegSegment>, String> {
    let chunks = png_meta::extract_text_chunks(path.to_str().ok_or("the picture's path isn't text")?)?;
    let mut prompt = None;
    let mut workflow = None;
    let mut parameters = None;
    for chunk in &chunks {
        match chunk.keyword.as_str() {
            "prompt" => prompt = Some(chunk.text.clone()),
            "workflow" => workflow = Some(chunk.text.clone()),
            "parameters" => parameters = Some(chunk.text.clone()),
            _ => {}
        }
    }
    let mut segments: Vec<jpeg_meta::JpegSegment> = Vec::new();
    match exif_writer::build_exif_app1(prompt.as_deref(), workflow.as_deref()) {
        Ok(Some(data)) => segments.push(jpeg_meta::JpegSegment { marker: 0xE1, data }),
        Ok(None) => {}
        Err(_) => {
            // Over the APP1 limit: the prompt alone in EXIF, the workflow in COM parts, or nothing (never a silent drop).
            match exif_writer::build_exif_app1(prompt.as_deref(), None) {
                Ok(Some(data)) => segments.push(jpeg_meta::JpegSegment { marker: 0xE1, data }),
                Ok(None) => {}
                Err(_) => return Err("the prompts are too big for a JPEG: the PNG is the file that keeps them".into()),
            }
            if let Some(workflow) = workflow {
                let Some(minified) = exif_writer::try_minify_json(&workflow) else {
                    return Err("the prompts are too big for a JPEG: the PNG is the file that keeps them".into());
                };
                for part in split_workflow_parts(&minified) {
                    segments.push(jpeg_meta::JpegSegment { marker: 0xFE, data: part });
                }
            }
        }
    }
    if let Some(parameters) = &parameters {
        if parameters.len() < 65_000 {
            segments.push(jpeg_meta::JpegSegment { marker: 0xFE, data: parameters.as_bytes().to_vec() });
        }
    }
    Ok(segments)
}

/// Splits a minified workflow across COM payloads, each marked so the reader can reassemble them.
fn split_workflow_parts(workflow: &str) -> Vec<Vec<u8>> {
    const PART_MAX: usize = 60_000;
    let bytes = workflow.as_bytes();
    let parts = bytes.len().div_ceil(PART_MAX);
    let mut out = Vec::with_capacity(parts);
    for (index, chunk) in bytes.chunks(PART_MAX).enumerate() {
        let mut part = format!("hkis-workflow-{}-of-{}:", index + 1, parts).into_bytes();
        part.extend_from_slice(chunk);
        out.push(part);
    }
    out
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

fn remember(path: &Path, saved: PathBuf, added: Option<PathBuf>) {
    let mut undo = UNDO.lock().unwrap();
    undo.push(UndoEntry { path: path.to_path_buf(), backup: saved, added });
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

/// A converted picture's file: create-new, so the check above can never be beaten by another writer.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|error| format!("the converted picture couldn't be written: {error}"))?;
    file.write_all(bytes).map_err(|error| format!("the converted picture couldn't be written: {error}"))?;
    file.sync_all().map_err(|error| format!("the converted picture couldn't be written: {error}"))
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

    fn png_with_chunks(path: &Path, width: u32, height: u32, chunks: &[(&str, &str)]) {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&vec![0u8; (width * height * 4) as usize]).unwrap();
            for (keyword, text) in chunks {
                writer.write_text_chunk(&png::text_metadata::TEXtChunk::new(
                    keyword.to_string(), text.to_string())).unwrap();
            }
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
        assert_eq!(outcome.path, path);
        assert!(!outcome.converted);
        assert_eq!(image::image_dimensions(&path).unwrap(), (48, 64));
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
        assert_eq!(exif_orientation(&bytes), 1, "the tag must not turn it again");
    }

    #[test]
    fn flips_horizontally() {
        let dir = folder();
        let path = dir.path().join("flip.png");
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
    fn crops_then_resizes() {
        let dir = folder();
        let path = dir.path().join("crop.png");
        image::RgbaImage::from_pixel(64, 48, image::Rgba([9, 9, 9, 255])).save(&path).unwrap();
        let outcome = edit_picture(&path, Edit {
            crop: Some(Crop { x: 8, y: 8, width: 32, height: 24 }),
            resize: Some(Resize::Percent(50)),
            ..Edit::default()
        }).unwrap();
        assert_eq!((outcome.width, outcome.height), (16, 12));
        assert_eq!(image::image_dimensions(&path).unwrap(), (16, 12));
    }

    #[test]
    fn crop_outside_the_picture_is_refused() {
        let dir = folder();
        let path = dir.path().join("crop.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([1, 2, 3, 255])).save(&path).unwrap();
        let original = std::fs::read(&path).unwrap();
        let error = edit_picture(&path, Edit {
            crop: Some(Crop { x: 10, y: 10, width: 20, height: 20 }),
            ..Edit::default()
        }).unwrap_err();
        assert!(error.contains("outside"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn png_text_survives_a_rotation() {
        let dir = folder();
        let path = dir.path().join("prompt.png");
        png_with_chunks(&path, 4, 2, &[("parameters", "a dog")]);
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

    #[cfg(windows)]
    #[test]
    fn converts_png_to_jpg_with_its_prompts() {
        let dir = folder();
        let path = dir.path().join("comfy.png");
        png_with_chunks(&path, 4, 4, &[
            ("prompt", r#"{"3":{"inputs":{"text":"dog"},"class_type":"CLIPTextEncode"}}"#),
            ("workflow", r#"{"nodes":[]}"#),
        ]);
        let outcome = edit_picture(&path, Edit { target: Target::Jpeg, ..Edit::default() }).unwrap();
        assert!(outcome.converted);
        assert_eq!(outcome.path, dir.path().join("comfy.jpg"));
        assert!(!path.exists(), "the PNG went to the Recycle Bin");
        assert_eq!(image::image_dimensions(&outcome.path).unwrap(), (4, 4));
        // The prompts live in EXIF Make (workflow) and Model (prompt), as ComfyUI writes them.
        let bytes = std::fs::read(&outcome.path).unwrap();
        let data = exif::Reader::new().read_from_container(&mut Cursor::new(&bytes)).unwrap();
        let make = data.get_field(exif::Tag::Make, exif::In::PRIMARY)
            .map(|field| field.display_value().to_string()).unwrap_or_default();
        let model = data.get_field(exif::Tag::Model, exif::In::PRIMARY)
            .map(|field| field.display_value().to_string()).unwrap_or_default();
        assert!(make.contains("workflow"), "make: {make}");
        assert!(model.contains("prompt"), "model: {model}");
    }

    #[cfg(windows)]
    #[test]
    fn conversion_refuses_an_existing_target() {
        let dir = folder();
        let path = dir.path().join("taken.png");
        png_with_chunks(&path, 4, 4, &[]);
        std::fs::write(dir.path().join("taken.jpg"), b"already here").unwrap();
        let original = std::fs::read(&path).unwrap();
        let error = edit_picture(&path, Edit { target: Target::Jpeg, ..Edit::default() }).unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read(dir.path().join("taken.jpg")).unwrap(), b"already here");
    }

    #[cfg(windows)]
    #[test]
    fn undo_takes_a_converted_file_away() {
        let dir = folder();
        let path = dir.path().join("back.png");
        png_with_chunks(&path, 4, 4, &[("prompt", "{}")]);
        let original = std::fs::read(&path).unwrap();
        let outcome = edit_picture(&path, Edit { target: Target::Jpeg, ..Edit::default() }).unwrap();
        assert!(outcome.path.exists());
        let restored = undo().unwrap().unwrap();
        assert_eq!(restored, path);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(!outcome.path.exists(), "the converted file is gone");
    }
}
