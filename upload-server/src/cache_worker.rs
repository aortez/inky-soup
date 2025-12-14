use image::imageops::FilterType;
use std::path::Path;

// Inky Impression display resolution.
pub const DISPLAY_WIDTH: u32 = 600;
pub const DISPLAY_HEIGHT: u32 = 448;

/// Creates a cached 600x448 version of an image for the e-ink display.
/// Returns Ok(()) on success, or an error message on failure.
pub fn create_cached_image(original_path: &Path, filter: FilterType) -> Result<(), String> {
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
pub fn resize_image_to_bytes(original_path: &Path, filter: FilterType) -> Result<Vec<u8>, String> {
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
