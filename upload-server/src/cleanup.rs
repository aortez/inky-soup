use glob::glob;
use log::{debug, info, warn};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tokio::time;

use crate::config;
use crate::metadata;

const CLEANUP_INTERVAL_SECS: u64 = 300; // 5 minutes.

/// Spawns the background cleanup task.
pub fn spawn_cleanup_task() {
    tokio::spawn(async {
        let mut interval = time::interval(Duration::from_secs(CLEANUP_INTERVAL_SECS));

        loop {
            interval.tick().await;
            run_cleanup();
        }
    });
}

/// Runs a single cleanup pass.
fn run_cleanup() {
    debug!("Running cleanup task...");

    // Build set of valid original image filenames.
    let originals = get_original_filenames();
    debug!("Found {} original images", originals.len());

    // Clean up cache directory.
    let cache_removed = cleanup_derived_directory(&config::cache_dir(), &originals);

    // Clean up dithered directory.
    let dithered_removed = cleanup_derived_directory(&config::dithered_dir(), &originals);

    // Clean up thumbs directory.
    let thumbs_removed = cleanup_derived_directory(&config::thumbs_dir(), &originals);

    // Clean up metadata directory.
    let originals_vec: Vec<String> = originals.iter().cloned().collect();
    let metadata_removed = metadata::cleanup_orphaned_metadata(&originals_vec);

    if cache_removed > 0 || dithered_removed > 0 || thumbs_removed > 0 || metadata_removed > 0 {
        info!(
            "Cleanup complete: removed {} cache, {} dithered, {} thumbs, {} metadata",
            cache_removed, dithered_removed, thumbs_removed, metadata_removed
        );
    } else {
        debug!("Cleanup complete: no orphaned files found");
    }
}

/// Gets the set of original image filenames (without path).
fn get_original_filenames() -> HashSet<String> {
    let mut filenames = HashSet::new();

    let pattern = format!("{}/*", config::IMAGES_DIR.display());
    for entry in glob(&pattern).unwrap_or_else(|_| panic!("Failed to read glob pattern")) {
        if let Ok(path) = entry {
            // Skip directories and metadata file.
            if path.is_dir() || path.extension().map(|e| e == "json").unwrap_or(false) {
                continue;
            }

            if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                filenames.insert(filename.to_string());
            }
        }
    }

    filenames
}

/// Cleans up a derived directory (cache or dithered).
/// Removes files that:
/// - Don't end in .png
/// - Don't have a corresponding original image
/// Returns the number of files removed.
fn cleanup_derived_directory(dir_path: &Path, originals: &HashSet<String>) -> usize {
    let mut removed = 0;
    let pattern = format!("{}/*", dir_path.display());

    for entry in glob(&pattern).unwrap_or_else(|_| panic!("Failed to read glob pattern")) {
        if let Ok(path) = entry {
            if path.is_dir() {
                continue;
            }

            let removal_reason = get_removal_reason(&path, originals);

            if let Some(reason) = removal_reason {
                if let Err(e) = fs::remove_file(&path) {
                    warn!("Failed to remove orphaned file {}: {}", path.display(), e);
                } else {
                    warn!("Removed orphaned file: {} ({})", path.display(), reason);
                    removed += 1;
                }
            }
        }
    }

    removed
}

/// Determines if a derived file should be removed and why.
/// Returns Some(reason) if the file should be removed, None otherwise.
fn get_removal_reason(path: &Path, originals: &HashSet<String>) -> Option<String> {
    let filename = match path.file_name().and_then(|f| f.to_str()) {
        Some(f) => f,
        None => return Some("invalid filename".to_string()),
    };

    // Must be a .png file.
    if !filename.ends_with(".png") {
        return Some("not a .png file".to_string());
    }

    // Extract original filename by removing the .png suffix.
    // Cache/dithered files are named "{original}.png", so "photo.jpg.png" -> "photo.jpg".
    let original_name = &filename[..filename.len() - 4];

    // Check if original exists.
    if !originals.contains(original_name) {
        return Some(format!("original '{}' no longer exists", original_name));
    }

    None
}
