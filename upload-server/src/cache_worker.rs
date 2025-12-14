use glob::glob;
use image::imageops::FilterType;
use rocket::fairing::{Fairing, Info, Kind, Result};
use rocket::{Build, Rocket, Orbit};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

use crate::metadata;

// Inky Impression display resolution.
pub const DISPLAY_WIDTH: u32 = 600;
pub const DISPLAY_HEIGHT: u32 = 448;

pub type CacheSender = mpsc::Sender<CacheRequest>;

#[derive(Debug)]
pub enum CacheRequest {
    /// Create cache with specified filter (filter name as string).
    CreateCache(PathBuf, String),
}

/// Creates a cached 600x448 version of an image for the e-ink display.
/// Returns Ok(()) on success, or an error message on failure.
pub fn create_cached_image(original_path: &Path, filter: FilterType) -> std::result::Result<(), String> {
    let filename = original_path.file_name()
        .ok_or("Invalid filename")?
        .to_str()
        .ok_or("Invalid filename encoding")?;

    // Always save cache as PNG to avoid lossy JPEG recompression.
    let cache_filename = format!("{}.png", filename);
    let cache_path = format!("static/images/cache/{}", cache_filename);

    println!("Creating cached image: {:?} -> {} (filter: {:?})", original_path, cache_path, filter);

    let img = image::open(original_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let resized = img.resize_exact(DISPLAY_WIDTH, DISPLAY_HEIGHT, filter);

    resized.save(&cache_path)
        .map_err(|e| format!("Failed to save cached image: {}", e))?;

    println!("Cached image created: {}", cache_path);
    Ok(())
}

/// Resizes an image and returns the bytes (for preview, does not save to disk).
pub fn resize_image_to_bytes(original_path: &Path, filter: FilterType) -> std::result::Result<Vec<u8>, String> {
    let img = image::open(original_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let resized = img.resize_exact(DISPLAY_WIDTH, DISPLAY_HEIGHT, filter);

    // Encode as PNG for preview.
    let mut bytes: Vec<u8> = Vec::new();
    resized.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {}", e))?;

    Ok(bytes)
}

/// Gets the cache path for a given original image path.
/// Caches are always saved as PNG regardless of source format.
pub fn get_cache_path(original_path: &str) -> String {
    let path = Path::new(original_path);
    let filename = path.file_name()
        .map(|f| f.to_str().unwrap_or("unknown"))
        .unwrap_or("unknown");
    format!("static/images/cache/{}.png", filename)
}

/// Spawns the background cache worker task.
/// Must be called from within an async context (e.g., a fairing).
fn spawn_worker_task(mut rx: mpsc::Receiver<CacheRequest>) {
    tokio::spawn(async move {
        println!("Cache worker started, waiting for requests...");

        while let Some(request) = rx.recv().await {
            match request {
                CacheRequest::CreateCache(path, filter_name) => {
                    println!("Cache worker received request for: {:?} (filter: {})", path, filter_name);

                    // Run blocking image work in spawn_blocking to avoid blocking the async runtime.
                    let path_clone = path.clone();
                    let filter = metadata::parse_filter(&filter_name);
                    let result = tokio::task::spawn_blocking(move || {
                        create_cached_image(&path_clone, filter)
                    }).await;

                    match result {
                        Ok(Ok(())) => println!("Background cache created: {:?}", path),
                        Ok(Err(e)) => println!("Background cache failed for {:?}: {}", path, e),
                        Err(e) => println!("Background task panicked for {:?}: {}", path, e),
                    }
                }
            }
        }

        println!("Cache worker shutting down.");
    });
}

/// Fairing that sets up the cache worker and repairs missing caches on startup.
pub struct CacheWorkerFairing;

#[rocket::async_trait]
impl Fairing for CacheWorkerFairing {
    fn info(&self) -> Info {
        Info {
            name: "Cache Worker",
            kind: Kind::Ignite | Kind::Liftoff,
        }
    }

    async fn on_ignite(&self, rocket: Rocket<Build>) -> Result {
        // Create channel and register sender as managed state.
        let (tx, rx) = mpsc::channel::<CacheRequest>(100);

        // Spawn the worker task now that we're in an async context.
        spawn_worker_task(rx);

        Ok(rocket.manage(tx))
    }

    async fn on_liftoff(&self, rocket: &Rocket<Orbit>) {
        // Scan for missing caches after server is fully started.
        let sender = rocket.state::<CacheSender>().cloned();

        tokio::spawn(async move {
            if let Some(tx) = sender {
                scan_and_repair_caches(tx).await;
            } else {
                println!("Cache repair: No CacheSender found in managed state.");
            }
        });
    }
}

/// Scans for images without cached versions and queues them for caching.
async fn scan_and_repair_caches(tx: CacheSender) {
    println!("Cache repair: Scanning for missing caches...");

    let mut missing_count = 0;
    let mut total_count = 0;

    for entry in glob("static/images/*").expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                // Skip the cache directory and metadata file.
                if path.is_dir() || path.extension().map(|e| e == "json").unwrap_or(false) {
                    continue;
                }

                total_count += 1;

                let filename = path.file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("unknown")
                    .to_string();

                let cache_path = format!("static/images/cache/{}.png", filename);

                if !Path::new(&cache_path).exists() {
                    println!("Cache repair: Missing cache for {}", filename);
                    missing_count += 1;

                    // Look up the filter preference for this image.
                    let filter = metadata::get_filter_for_image(&filename);

                    if let Err(e) = tx.send(CacheRequest::CreateCache(path, filter)).await {
                        println!("Cache repair: Failed to queue {}: {}", filename, e);
                    }
                }
            }
            Err(e) => println!("Cache repair: Glob error: {:?}", e),
        }
    }

    if missing_count > 0 {
        println!("Cache repair: Queued {} of {} images for caching.", missing_count, total_count);
    } else {
        println!("Cache repair: All {} images have caches.", total_count);
    }
}
