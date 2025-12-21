//! Per-image metadata storage.
//!
//! Each image has its own JSON file in the metadata directory.
//! Files are read on demand and written atomically (temp file + rename).

use crate::config;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
const DEFAULT_FILTER: &str = "bicubic";
const DEFAULT_SATURATION: f32 = 0.5;
const DEFAULT_BRIGHTNESS: i32 = 0;
const DEFAULT_CONTRAST: i32 = 0;
const DEFAULT_DITHER_ALGORITHM: &str = "floyd-steinberg";

/// Metadata stored for each image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageMetadata {
    #[serde(default = "default_filter")]
    pub filter: String,
    #[serde(default = "default_saturation")]
    pub saturation: f32,
    #[serde(default = "default_brightness")]
    pub brightness: i32,
    #[serde(default = "default_contrast")]
    pub contrast: i32,
    #[serde(default = "default_dither_algorithm")]
    pub dither_algorithm: String,
}

fn default_filter() -> String {
    DEFAULT_FILTER.to_string()
}

fn default_saturation() -> f32 {
    DEFAULT_SATURATION
}

fn default_brightness() -> i32 {
    DEFAULT_BRIGHTNESS
}

fn default_contrast() -> i32 {
    DEFAULT_CONTRAST
}

fn default_dither_algorithm() -> String {
    DEFAULT_DITHER_ALGORITHM.to_string()
}

impl Default for ImageMetadata {
    fn default() -> Self {
        Self {
            filter: DEFAULT_FILTER.to_string(),
            saturation: DEFAULT_SATURATION,
            brightness: DEFAULT_BRIGHTNESS,
            contrast: DEFAULT_CONTRAST,
            dither_algorithm: DEFAULT_DITHER_ALGORITHM.to_string(),
        }
    }
}

/// Legacy metadata format for migration.
#[derive(Debug, Deserialize)]
struct LegacyImageMetadata {
    filter: String,
    #[serde(default)]
    last_dithered_saturation: Option<f32>,
}

/// Ensures the metadata directory exists.
pub fn ensure_metadata_dir() {
    let path = config::metadata_dir();
    if !path.exists() {
        if let Err(e) = fs::create_dir_all(&path) {
            error!("Failed to create metadata directory: {}", e);
        }
    }
}

/// Returns the path to a metadata file for a given image filename.
fn get_metadata_path(filename: &str) -> PathBuf {
    config::metadata_dir().join(format!("{}.json", filename))
}

/// Loads metadata for an image. Returns default if file doesn't exist.
pub fn load_metadata(filename: &str) -> ImageMetadata {
    let path = get_metadata_path(filename);

    if !path.exists() {
        return ImageMetadata::default();
    }

    match fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(metadata) => metadata,
            Err(e) => {
                warn!(
                    "Failed to parse metadata for '{}', using defaults: {}",
                    filename, e
                );
                ImageMetadata::default()
            }
        },
        Err(e) => {
            warn!(
                "Failed to read metadata for '{}', using defaults: {}",
                filename, e
            );
            ImageMetadata::default()
        }
    }
}

/// Saves metadata for an image atomically.
pub fn save_metadata(filename: &str, metadata: &ImageMetadata) {
    ensure_metadata_dir();

    let path = get_metadata_path(filename);
    let temp_path = path.with_extension("json.tmp");

    match serde_json::to_string_pretty(metadata) {
        Ok(json) => {
            // Write to temp file first.
            if let Err(e) = fs::write(&temp_path, &json) {
                error!("Failed to write temp metadata for '{}': {}", filename, e);
                return;
            }

            // Atomically rename temp file to target file.
            if let Err(e) = fs::rename(&temp_path, &path) {
                error!("Failed to rename metadata file for '{}': {}", filename, e);
                let _ = fs::remove_file(&temp_path);
            }
        }
        Err(e) => {
            error!("Failed to serialize metadata for '{}': {}", filename, e);
        }
    }
}

/// Deletes metadata for an image.
pub fn delete_metadata(filename: &str) {
    let path = get_metadata_path(filename);
    if path.exists() {
        if let Err(e) = fs::remove_file(&path) {
            error!("Failed to delete metadata for '{}': {}", filename, e);
        }
    }
}

/// Validates if a filter name is recognized.
fn is_valid_filter(filter: &str) -> bool {
    matches!(
        filter,
        "bicubic" | "lanczos" | "mitchell" | "bilinear" | "nearest"
    )
}

/// Validates if a dither algorithm is recognized.
fn is_valid_dither_algorithm(algorithm: &str) -> bool {
    matches!(algorithm, "floyd-steinberg" | "atkinson" | "ordered")
}

/// Gets the filter preference for an image.
pub fn get_filter_for_image(filename: &str) -> String {
    let metadata = load_metadata(filename);

    if is_valid_filter(&metadata.filter) {
        metadata.filter
    } else {
        warn!(
            "Invalid filter '{}' for '{}', using default",
            metadata.filter, filename
        );
        DEFAULT_FILTER.to_string()
    }
}

/// Saves all settings for an image.
pub fn save_all_settings(
    filename: &str,
    filter: &str,
    saturation: f32,
    brightness: i32,
    contrast: i32,
    dither_algorithm: &str,
) {
    let metadata = ImageMetadata {
        filter: filter.to_string(),
        saturation,
        brightness,
        contrast,
        dither_algorithm: dither_algorithm.to_string(),
    };
    save_metadata(filename, &metadata);
}

/// Gets the saturation for an image.
pub fn get_saturation_for_image(filename: &str) -> f32 {
    load_metadata(filename).saturation
}

/// Gets all metadata for an image (for passing to templates).
pub fn get_all_metadata(filename: &str) -> ImageMetadata {
    let mut metadata = load_metadata(filename);

    // Validate and correct invalid values.
    if !is_valid_filter(&metadata.filter) {
        metadata.filter = DEFAULT_FILTER.to_string();
    }
    if !is_valid_dither_algorithm(&metadata.dither_algorithm) {
        metadata.dither_algorithm = DEFAULT_DITHER_ALGORITHM.to_string();
    }

    metadata
}

/// Saves all dither-related settings for an image.
/// Called when flashing an image.
pub fn save_dither_settings(
    filename: &str,
    saturation: f32,
    brightness: i32,
    contrast: i32,
    dither_algorithm: &str,
) {
    let mut metadata = load_metadata(filename);
    metadata.saturation = saturation;
    metadata.brightness = brightness;
    metadata.contrast = contrast;
    metadata.dither_algorithm = dither_algorithm.to_string();
    save_metadata(filename, &metadata);
}

/// Returns a list of all filenames that have metadata files.
pub fn get_all_filenames() -> Vec<String> {
    let path = config::metadata_dir();
    if !path.exists() {
        return Vec::new();
    }

    match fs::read_dir(&path) {
        Ok(entries) => entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let filename = entry.file_name().to_string_lossy().to_string();
                // Strip .json extension to get original filename.
                filename.strip_suffix(".json").map(|s| s.to_string())
            })
            .collect(),
        Err(e) => {
            error!("Failed to read metadata directory: {}", e);
            Vec::new()
        }
    }
}

/// Removes metadata files for images that no longer exist.
/// Returns the number of files removed.
pub fn cleanup_orphaned_metadata(existing_images: &[String]) -> usize {
    let metadata_files = get_all_filenames();
    let mut removed = 0;

    for filename in metadata_files {
        if !existing_images.contains(&filename) {
            delete_metadata(&filename);
            removed += 1;
        }
    }

    if removed > 0 {
        info!("Cleaned up {} orphaned metadata file(s)", removed);
    }

    removed
}

/// Migrates from the legacy single-file metadata format.
/// Called once at startup if the legacy file exists.
pub fn migrate_legacy_metadata() {
    let legacy_path = config::IMAGES_DIR.join("metadata.json");
    if !legacy_path.exists() {
        return;
    }

    // Check if migration already happened (backup exists).
    let backup_path = config::IMAGES_DIR.join("metadata.json.migrated");
    if backup_path.exists() {
        // Migration already done, remove the legacy file if it somehow reappeared.
        warn!("Legacy metadata file exists but migration backup also exists, removing legacy file");
        let _ = fs::remove_file(legacy_path);
        return;
    }

    info!("Migrating legacy metadata.json to per-file format...");

    // Read the legacy file.
    let contents = match fs::read_to_string(&legacy_path) {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to read legacy metadata file: {}", e);
            return;
        }
    };

    // Parse the legacy format.
    let legacy_data: HashMap<String, LegacyImageMetadata> = match serde_json::from_str(&contents) {
        Ok(data) => data,
        Err(e) => {
            error!("Failed to parse legacy metadata file: {}", e);
            return;
        }
    };

    // Ensure metadata directory exists.
    ensure_metadata_dir();

    // Migrate each entry.
    let mut migrated = 0;
    for (filename, legacy) in legacy_data {
        let metadata = ImageMetadata {
            filter: legacy.filter,
            saturation: legacy.last_dithered_saturation.unwrap_or(DEFAULT_SATURATION),
            brightness: DEFAULT_BRIGHTNESS,
            contrast: DEFAULT_CONTRAST,
            dither_algorithm: DEFAULT_DITHER_ALGORITHM.to_string(),
        };
        save_metadata(&filename, &metadata);
        migrated += 1;
    }

    // Backup the legacy file.
    if let Err(e) = fs::rename(legacy_path, backup_path) {
        error!("Failed to backup legacy metadata file: {}", e);
    } else {
        info!(
            "Migration complete: {} entries migrated, legacy file backed up",
            migrated
        );
    }
}
