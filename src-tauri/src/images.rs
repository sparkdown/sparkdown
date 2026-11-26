//! Images pasted or dropped into a markdown document.
//!
//! The image is stored in the document's own folder under a fresh name
//! (`shot.png`, then `shot-1.png`, ...) and the frontend links it as
//! `![](name)`. An existing file is never replaced. Only PNG, JPEG, GIF and
//! WebP data is accepted (checked by content, not by name), up to
//! [`MAX_IMAGE_BYTES`].

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;

use crate::commands::AppError;
use crate::windows::FolderId;

/// Largest image that can be pasted or dropped into a document.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Longest file stem kept from a pasted or dropped name (in characters).
const MAX_STEM_CHARS: usize = 80;
/// Give up after this many taken names (`shot-1` ... `shot-9999`).
const MAX_NAME_ATTEMPTS: u32 = 10_000;

const REMOTE_MESSAGE: &str = "Images can't be added to a document in a remote folder yet";

/// Image formats a document can embed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageFormat {
    /// The format of `data`, from its leading signature bytes.
    pub fn sniff(data: &[u8]) -> Option<Self> {
        if data.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Png => &["png"],
            Self::Jpeg => &["jpg", "jpeg"],
            Self::Gif => &["gif"],
            Self::Webp => &["webp"],
        }
    }

    /// File extension for this format: `hint` (the extension the original
    /// file had, any case) when it names this format, else the usual one.
    pub fn extension(self, hint: Option<&str>) -> String {
        let exts = self.extensions();
        hint.map(str::to_ascii_lowercase)
            .filter(|h| exts.contains(&h.as_str()))
            .unwrap_or_else(|| exts[0].to_string())
    }
}

/// A file stem that is one plain path segment on every OS: letters, digits,
/// `-`, `_` and inner dots are kept, anything else becomes `-`. Never empty,
/// never hidden, never a reserved Windows device name.
pub fn sanitize_stem(stem: &str) -> String {
    let mut out = String::new();
    for c in stem.chars() {
        let c = if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
            c
        } else {
            '-'
        };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let trimmed: String = out
        .trim_matches(|c| c == '-' || c == '.')
        .chars()
        .take(MAX_STEM_CHARS)
        .collect();
    let trimmed = trimmed.trim_end_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        return "image".into();
    }
    let device = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((device.starts_with("COM") || device.starts_with("LPT"))
            && device.len() == 4
            && device.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("image-{trimmed}")
    } else {
        trimmed
    }
}

/// Write `data` into `dir` as `stem.ext`, or `stem-1.ext`, `stem-2.ext`, ...
/// whichever is free first. Each name is created exclusively, so a file that
/// already exists (or appears meanwhile) is never replaced. New files get the
/// default mode (0666 minus umask). Returns the chosen file name.
pub fn write_unique(dir: &Path, stem: &str, ext: &str, data: &[u8]) -> io::Result<String> {
    for n in 0..MAX_NAME_ATTEMPTS {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let path = dir.join(&name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = file.write_all(data).and_then(|()| file.sync_all());
        if let Err(e) = written {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(e);
        }
        return Ok(name);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("no free name for {stem}.{ext}"),
    ))
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mkd"))
}

/// The folder images for document `doc` go in: the document's own canonical
/// folder. `doc` must be an existing markdown file whose folder is inside the
/// window's folder, or is the folder of a file this window opened or saved.
pub fn image_dir_for(
    doc: &str,
    folder: Option<&FolderId>,
    opened_dirs: &HashSet<String>,
) -> Result<PathBuf, AppError> {
    let canon = fs::canonicalize(doc)
        .map_err(|_| AppError::InvalidPath(format!("Save the document first: {doc}")))?;
    if !canon.is_file() || !is_markdown_path(&canon) {
        return Err(AppError::InvalidPath(format!(
            "Images can only be added to a markdown document: {doc}"
        )));
    }
    let dir = canon
        .parent()
        .ok_or_else(|| AppError::InvalidPath(format!("No parent folder: {doc}")))?
        .to_path_buf();
    let in_folder = folder.is_some_and(|f| f.contains_local(&dir.to_string_lossy()));
    let opened = opened_dirs
        .iter()
        .any(|od| fs::canonicalize(od).is_ok_and(|c| c == dir));
    if in_folder || opened {
        Ok(dir)
    } else {
        Err(AppError::InvalidPath(format!(
            "{} is not a folder this window opened",
            dir.display()
        )))
    }
}

fn check_size(len: u64) -> Result<(), AppError> {
    if len > MAX_IMAGE_BYTES {
        return Err(AppError::FileTooLarge {
            size_mb: len.div_ceil(1024 * 1024),
            max_mb: MAX_IMAGE_BYTES / (1024 * 1024),
        });
    }
    Ok(())
}

fn sniff_or_refuse(data: &[u8]) -> Result<ImageFormat, AppError> {
    ImageFormat::sniff(data)
        .ok_or_else(|| AppError::Other("Only PNG, JPEG, GIF and WebP images can be added".into()))
}

/// Store pasted image bytes beside `doc`, named after `stem`.
pub fn save_bytes(
    doc: &str,
    stem: &str,
    data: &[u8],
    folder: Option<&FolderId>,
    opened_dirs: &HashSet<String>,
) -> Result<String, AppError> {
    check_size(data.len() as u64)?;
    let format = sniff_or_refuse(data)?;
    let dir = image_dir_for(doc, folder, opened_dirs)?;
    Ok(write_unique(
        &dir,
        &sanitize_stem(stem),
        &format.extension(None),
        data,
    )?)
}

/// Copy the image file `source` beside `doc`. A source that already sits in
/// the document's folder is linked as it is, not copied.
pub fn import_file(
    doc: &str,
    source: &str,
    folder: Option<&FolderId>,
    opened_dirs: &HashSet<String>,
) -> Result<String, AppError> {
    let src = fs::canonicalize(source)
        .map_err(|_| AppError::InvalidPath(format!("Invalid or inaccessible path: {source}")))?;
    let meta = fs::metadata(&src)?;
    if !meta.is_file() {
        return Err(AppError::InvalidPath(format!("Not a file: {source}")));
    }
    check_size(meta.len())?;
    let data = fs::read(&src)?;
    check_size(data.len() as u64)?;
    let format = sniff_or_refuse(&data)?;
    let dir = image_dir_for(doc, folder, opened_dirs)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if src.parent() == Some(dir.as_path()) && !name.is_empty() {
        return Ok(name);
    }
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let hint = src.extension().and_then(|e| e.to_str());
    Ok(write_unique(
        &dir,
        &sanitize_stem(&stem),
        &format.extension(hint),
        &data,
    )?)
}

/// This window's folder and the folders of files it opened or saved.
fn window_scope(label: &str) -> (Option<FolderId>, HashSet<String>) {
    let reg = crate::windows::registry();
    let entry = reg.windows.get(label);
    (
        entry.and_then(|w| w.folder.clone()),
        entry.map(|w| w.opened_dirs.clone()).unwrap_or_default(),
    )
}

/// Paste: store base64 image `data` beside the document `doc_path`, named
/// after `name` (a stem; the extension follows the data). Returns the file
/// name to link.
#[tauri::command]
pub async fn save_image(
    webview_window: tauri::WebviewWindow,
    doc_path: String,
    name: String,
    data: String,
) -> Result<String, AppError> {
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        if crate::remote::is_active() {
            return Err(AppError::Other(REMOTE_MESSAGE.into()));
        }
        // base64 is 4 chars per 3 bytes: refuse oversize input before decoding.
        check_size(data.len() as u64 / 4 * 3)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|_| AppError::Other("The pasted image data could not be read".into()))?;
        let (folder, opened_dirs) = window_scope(&label);
        save_bytes(&doc_path, &name, &bytes, folder.as_ref(), &opened_dirs)
    })
    .await
    .map_err(|e| AppError::Other(format!("image task failed: {e}")))?
}

/// Drop: copy the image file `source` beside the document `doc_path`.
/// Returns the file name to link.
#[tauri::command]
pub async fn import_image(
    webview_window: tauri::WebviewWindow,
    doc_path: String,
    source: String,
) -> Result<String, AppError> {
    let label = webview_window.label().to_string();
    crate::windows::spawn_scoped(label.clone(), move || {
        if crate::remote::is_active() {
            return Err(AppError::Other(REMOTE_MESSAGE.into()));
        }
        let (folder, opened_dirs) = window_scope(&label);
        import_file(&doc_path, &source, folder.as_ref(), &opened_dirs)
    })
    .await
    .map_err(|e| AppError::Other(format!("image task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F'];

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sparkdown-images-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn folder(dir: &Path) -> FolderId {
        FolderId::Local {
            path: dir.to_string_lossy().to_string(),
        }
    }

    fn doc_in(dir: &Path) -> String {
        let doc = dir.join("notes.md");
        fs::write(&doc, "# notes\n").unwrap();
        doc.to_string_lossy().to_string()
    }

    #[test]
    fn sniffs_supported_formats_only() {
        assert_eq!(ImageFormat::sniff(PNG), Some(ImageFormat::Png));
        assert_eq!(ImageFormat::sniff(JPEG), Some(ImageFormat::Jpeg));
        assert_eq!(ImageFormat::sniff(b"GIF89a.."), Some(ImageFormat::Gif));
        assert_eq!(
            ImageFormat::sniff(b"RIFF\x10\0\0\0WEBPVP8 "),
            Some(ImageFormat::Webp)
        );
        assert_eq!(ImageFormat::sniff(b"<svg xmlns='x'/>"), None);
        assert_eq!(ImageFormat::sniff(b"RIFF\x10\0\0\0WAVE"), None);
        assert_eq!(ImageFormat::sniff(b""), None);
    }

    #[test]
    fn extension_keeps_a_matching_hint() {
        assert_eq!(ImageFormat::Jpeg.extension(Some("JPEG")), "jpeg");
        assert_eq!(ImageFormat::Jpeg.extension(Some("png")), "jpg");
        assert_eq!(ImageFormat::Png.extension(None), "png");
    }

    #[test]
    fn stems_are_one_plain_segment() {
        assert_eq!(
            sanitize_stem("Screen Shot 2026-11-26 at 10.31"),
            "Screen-Shot-2026-11-26-at-10.31"
        );
        assert_eq!(sanitize_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_stem("a\\b/c:d"), "a-b-c-d");
        assert_eq!(sanitize_stem(".hidden"), "hidden");
        assert_eq!(sanitize_stem("..."), "image");
        assert_eq!(sanitize_stem(""), "image");
        assert_eq!(sanitize_stem("nul"), "image-nul");
        assert_eq!(sanitize_stem("COM1.x"), "image-COM1.x");
        assert_eq!(sanitize_stem("diagramme-été"), "diagramme-été");
        assert_eq!(
            sanitize_stem(&"x".repeat(300)).chars().count(),
            MAX_STEM_CHARS
        );
    }

    #[test]
    fn taken_names_are_never_replaced() {
        let dir = temp_dir("unique");
        fs::write(dir.join("shot.png"), b"old").unwrap();
        fs::write(dir.join("shot-1.png"), b"old1").unwrap();
        let name = write_unique(&dir, "shot", "png", PNG).unwrap();
        assert_eq!(name, "shot-2.png");
        assert_eq!(fs::read(dir.join("shot.png")).unwrap(), b"old");
        assert_eq!(fs::read(dir.join("shot-1.png")).unwrap(), b"old1");
        assert_eq!(fs::read(dir.join("shot-2.png")).unwrap(), PNG);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pasted_bytes_land_beside_the_document() {
        let dir = temp_dir("paste");
        let doc = doc_in(&dir);
        let f = folder(&dir);
        let name = save_bytes(&doc, "image-20261126", PNG, Some(&f), &HashSet::new()).unwrap();
        assert_eq!(name, "image-20261126.png");
        assert_eq!(fs::read(dir.join(&name)).unwrap(), PNG);
        let again = save_bytes(&doc, "image-20261126", PNG, Some(&f), &HashSet::new()).unwrap();
        assert_eq!(again, "image-20261126-1.png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_image_and_oversize_data_is_refused() {
        let dir = temp_dir("refuse");
        let doc = doc_in(&dir);
        let f = folder(&dir);
        assert!(save_bytes(&doc, "x", b"<svg/>", Some(&f), &HashSet::new()).is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        assert!(matches!(
            save_bytes(&doc, "x", &big, Some(&f), &HashSet::new()),
            Err(AppError::FileTooLarge { .. })
        ));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_must_be_saved_markdown_in_a_known_folder() {
        let dir = temp_dir("scope");
        let doc = doc_in(&dir);
        let other = temp_dir("scope-other");
        let f_other = folder(&other);
        // Missing document.
        let missing = dir.join("new.md").to_string_lossy().to_string();
        assert!(image_dir_for(&missing, Some(&folder(&dir)), &HashSet::new()).is_err());
        // Not markdown.
        let txt = dir.join("a.txt");
        fs::write(&txt, "").unwrap();
        assert!(
            image_dir_for(&txt.to_string_lossy(), Some(&folder(&dir)), &HashSet::new()).is_err()
        );
        // Folder elsewhere and not opened: refused.
        assert!(image_dir_for(&doc, Some(&f_other), &HashSet::new()).is_err());
        assert!(image_dir_for(&doc, None, &HashSet::new()).is_err());
        // Opened (or saved) in this window: accepted without a folder.
        let opened: HashSet<String> = [dir.to_string_lossy().to_string()].into();
        assert_eq!(image_dir_for(&doc, None, &opened).unwrap(), dir);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn dropped_files_are_copied_or_linked_in_place() {
        let dir = temp_dir("drop");
        let src_dir = temp_dir("drop-src");
        let doc = doc_in(&dir);
        let f = folder(&dir);
        let src = src_dir.join("My Photo.JPEG");
        fs::write(&src, JPEG).unwrap();
        let name = import_file(&doc, &src.to_string_lossy(), Some(&f), &HashSet::new()).unwrap();
        assert_eq!(name, "My-Photo.jpeg");
        assert_eq!(fs::read(dir.join(&name)).unwrap(), JPEG);
        assert_eq!(fs::read(&src).unwrap(), JPEG);
        // Already beside the document: linked, not duplicated.
        let local = dir.join("diagram.png");
        fs::write(&local, PNG).unwrap();
        let name = import_file(&doc, &local.to_string_lossy(), Some(&f), &HashSet::new()).unwrap();
        assert_eq!(name, "diagram.png");
        assert!(!dir.join("diagram-1.png").exists());
        // A non-image named .png is refused.
        let fake = src_dir.join("fake.png");
        fs::write(&fake, b"not an image").unwrap();
        assert!(import_file(&doc, &fake.to_string_lossy(), Some(&f), &HashSet::new()).is_err());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&src_dir);
    }
}
