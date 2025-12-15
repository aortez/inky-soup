use log::{error, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

const METADATA_FILE: &str = "static/images/metadata.json";
const DEFAULT_FILTER: &str = "bicubic";

/// Metadata stored for each image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageMetadata {
    pub filter: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_dithered_saturation: Option<f32>,
}

impl Default for ImageMetadata {
    fn default() -> Self {
        Self {
            filter: DEFAULT_FILTER.to_string(),
            last_dithered_saturation: None,
        }
    }
}

// Global metadata cache to avoid reading file on every request.
lazy_static::lazy_static! {
    static ref METADATA_CACHE: Mutex<HashMap<String, ImageMetadata>> = {
        Mutex::new(load_metadata_from_file())
    };
}

/// Loads metadata from the JSON file.
fn load_metadata_from_file() -> HashMap<String, ImageMetadata> {
    let path = Path::new(METADATA_FILE);
    if !path.exists() {
        return HashMap::new();
    }

    match fs::read_to_string(path) {
        Ok(contents) => {
            match serde_json::from_str(&contents) {
                Ok(metadata) => metadata,
                Err(e) => {
                    warn!("Failed to parse metadata file, starting fresh: {}", e);
                    HashMap::new()
                }
            }
        }
        Err(e) => {
            warn!("Failed to read metadata file, starting fresh: {}", e);
            HashMap::new()
        }
    }
}

/// Saves metadata to the JSON file atomically.
/// Writes to a temp file first, then renames to avoid corruption on crash.
fn save_metadata_to_file(metadata: &HashMap<String, ImageMetadata>) {
    let temp_file = format!("{}.tmp", METADATA_FILE);

    match serde_json::to_string_pretty(metadata) {
        Ok(json) => {
            // Write to temp file first.
            if let Err(e) = fs::write(&temp_file, &json) {
                error!("Failed to write temp metadata file: {}", e);
                return;
            }

            // Atomically rename temp file to target file.
            if let Err(e) = fs::rename(&temp_file, METADATA_FILE) {
                error!("Failed to rename metadata file: {}", e);
                // Clean up temp file on failure.
                let _ = fs::remove_file(&temp_file);
            }
        }
        Err(e) => {
            error!("Failed to serialize metadata: {}", e);
        }
    }
}

/// Gets the filter preference for an image.
pub fn get_filter_for_image(filename: &str) -> String {
    let cache = METADATA_CACHE.lock().unwrap();
    cache
        .get(filename)
        .map(|m| m.filter.clone())
        .unwrap_or_else(|| DEFAULT_FILTER.to_string())
}

/// Sets the filter preference for an image.
pub fn set_filter_for_image(filename: &str, filter: &str) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    let entry = cache.entry(filename.to_string()).or_insert_with(Default::default);
    entry.filter = filter.to_string();
    save_metadata_to_file(&cache);
}

/// Removes metadata for a deleted image.
pub fn remove_image_metadata(filename: &str) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    if cache.remove(filename).is_some() {
        save_metadata_to_file(&cache);
    }
}

/// Sets the dithered saturation value for an image.
pub fn set_dithered_saturation(filename: &str, saturation: f32) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    let entry = cache.entry(filename.to_string()).or_insert_with(Default::default);
    entry.last_dithered_saturation = Some(saturation);
    save_metadata_to_file(&cache);
}

/// Clears the dithered saturation for an image (called when filter changes).
pub fn clear_dithered_saturation(filename: &str) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    if let Some(entry) = cache.get_mut(filename) {
        entry.last_dithered_saturation = None;
        save_metadata_to_file(&cache);
    }
}
