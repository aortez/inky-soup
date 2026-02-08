//! Configuration for the inky-soup server.
//! Paths can be overridden via environment variables.

use std::env;
use std::path::PathBuf;
use std::sync::LazyLock;

/// Base directory for image storage.
/// Set via `INKY_SOUP_IMAGES_DIR` env var, defaults to `static/images`.
pub static IMAGES_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    PathBuf::from(env::var("INKY_SOUP_IMAGES_DIR").unwrap_or_else(|_| "static/images".to_string()))
});

/// Path to the cache directory.
pub fn cache_dir() -> PathBuf {
    IMAGES_DIR.join("cache")
}

/// Path to the thumbnails directory.
pub fn thumbs_dir() -> PathBuf {
    IMAGES_DIR.join("thumbs")
}

/// Path to the dithered images directory.
pub fn dithered_dir() -> PathBuf {
    IMAGES_DIR.join("dithered")
}

/// Path to the metadata directory.
pub fn metadata_dir() -> PathBuf {
    IMAGES_DIR.join("metadata")
}

/// Get the full path for a cached image.
pub fn cache_path(filename: &str) -> PathBuf {
    cache_dir().join(format!("{}.png", filename))
}

/// Get the full path for a thumbnail.
pub fn thumb_path(filename: &str) -> PathBuf {
    thumbs_dir().join(format!("{}.png", filename))
}

/// Get the full path for a dithered image.
pub fn dithered_path(filename: &str) -> PathBuf {
    dithered_dir().join(format!("{}.png", filename))
}

/// Get the full path for an original image.
pub fn original_path(filename: &str) -> PathBuf {
    IMAGES_DIR.join(filename)
}

/// Get all directories that need to exist for the server to function.
pub fn required_dirs() -> Vec<PathBuf> {
    vec![
        IMAGES_DIR.clone(),
        cache_dir(),
        thumbs_dir(),
        dithered_dir(),
        metadata_dir(),
    ]
}

/// Get the URL path for serving an image (relative to static mount).
/// This strips the "static/" prefix if present for URL generation.
pub fn url_path(fs_path: &PathBuf) -> String {
    let path_str = fs_path.to_string_lossy();
    if path_str.starts_with("static/") {
        path_str.strip_prefix("static/").unwrap().to_string()
    } else {
        // For absolute paths, return just the images/... portion.
        path_str
            .find("images/")
            .map(|i| path_str[i..].to_string())
            .unwrap_or_else(|| path_str.to_string())
    }
}
