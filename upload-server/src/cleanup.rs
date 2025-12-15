use glob::glob;
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tokio::time;

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
    println!("Running cleanup task...");

    // Build set of valid original image filenames.
    let originals = get_original_filenames();
    println!("Found {} original images", originals.len());

    // Clean up cache directory.
    let cache_removed = cleanup_derived_directory("static/images/cache", &originals);

    // Clean up dithered directory.
    let dithered_removed = cleanup_derived_directory("static/images/dithered", &originals);

    // Clean up thumbs directory.
    let thumbs_removed = cleanup_derived_directory("static/images/thumbs", &originals);

    if cache_removed > 0 || dithered_removed > 0 || thumbs_removed > 0 {
        println!(
            "Cleanup complete: removed {} cache, {} dithered, {} thumbs",
            cache_removed, dithered_removed, thumbs_removed
        );
    } else {
        println!("Cleanup complete: no orphaned files found");
    }
}

/// Gets the set of original image filenames (without path).
fn get_original_filenames() -> HashSet<String> {
    let mut filenames = HashSet::new();

    for entry in glob("static/images/*").unwrap_or_else(|_| panic!("Failed to read glob pattern")) {
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
fn cleanup_derived_directory(dir_path: &str, originals: &HashSet<String>) -> usize {
    let mut removed = 0;
    let pattern = format!("{}/*", dir_path);

    for entry in glob(&pattern).unwrap_or_else(|_| panic!("Failed to read glob pattern")) {
        if let Ok(path) = entry {
            if path.is_dir() {
                continue;
            }

            let should_remove = should_remove_derived_file(&path, originals);

            if should_remove {
                if let Err(e) = fs::remove_file(&path) {
                    println!("Failed to remove {}: {}", path.display(), e);
                } else {
                    println!("Removed orphaned file: {}", path.display());
                    removed += 1;
                }
            }
        }
    }

    removed
}

/// Determines if a derived file should be removed.
fn should_remove_derived_file(path: &Path, originals: &HashSet<String>) -> bool {
    let filename = match path.file_name().and_then(|f| f.to_str()) {
        Some(f) => f,
        None => return true, // Invalid filename.
    };

    // Must be a .png file.
    if !filename.ends_with(".png") {
        println!("Orphaned (not .png): {}", path.display());
        return true;
    }

    // Extract original filename by removing the .png suffix.
    // Cache/dithered files are named "{original}.png", so "photo.jpg.png" -> "photo.jpg".
    let original_name = &filename[..filename.len() - 4];

    // Check if original exists.
    if !originals.contains(original_name) {
        println!("Orphaned (no original '{}'): {}", original_name, path.display());
        return true;
    }

    false
}
