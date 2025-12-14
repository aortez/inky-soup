use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

const METADATA_FILE: &str = "static/images/metadata.json";
const DEFAULT_FILTER: &str = "CatmullRom";

/// Metadata stored for each image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageMetadata {
    pub filter: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_dithered_saturation: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_dithered_cache: Option<bool>,
}

impl Default for ImageMetadata {
    fn default() -> Self {
        Self {
            filter: DEFAULT_FILTER.to_string(),
            last_dithered_saturation: None,
            has_dithered_cache: None,
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
                    println!("Failed to parse metadata file: {}", e);
                    HashMap::new()
                }
            }
        }
        Err(e) => {
            println!("Failed to read metadata file: {}", e);
            HashMap::new()
        }
    }
}

/// Saves metadata to the JSON file.
fn save_metadata_to_file(metadata: &HashMap<String, ImageMetadata>) {
    match serde_json::to_string_pretty(metadata) {
        Ok(json) => {
            if let Err(e) = fs::write(METADATA_FILE, json) {
                println!("Failed to write metadata file: {}", e);
            }
        }
        Err(e) => {
            println!("Failed to serialize metadata: {}", e);
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

/// Converts a filter name string to FilterType.
pub fn parse_filter(filter_name: &str) -> FilterType {
    match filter_name {
        "Lanczos3" => FilterType::Lanczos3,
        "CatmullRom" => FilterType::CatmullRom,
        "Gaussian" => FilterType::Gaussian,
        "Triangle" => FilterType::Triangle,
        "Nearest" => FilterType::Nearest,
        _ => {
            println!("Unknown filter '{}', using default CatmullRom", filter_name);
            FilterType::CatmullRom
        }
    }
}

/// Returns the default filter name.
pub fn default_filter_name() -> &'static str {
    DEFAULT_FILTER
}

/// Sets the dithered saturation value for an image.
pub fn set_dithered_saturation(filename: &str, saturation: f32) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    let entry = cache.entry(filename.to_string()).or_insert_with(Default::default);
    entry.last_dithered_saturation = Some(saturation);
    entry.has_dithered_cache = Some(true);
    save_metadata_to_file(&cache);
}

/// Clears the dithered cache flag for an image (called when filter changes).
pub fn clear_dithered_cache(filename: &str) {
    let mut cache = METADATA_CACHE.lock().unwrap();
    if let Some(entry) = cache.get_mut(filename) {
        entry.has_dithered_cache = Some(false);
        entry.last_dithered_saturation = None;
        save_metadata_to_file(&cache);
    }
}
