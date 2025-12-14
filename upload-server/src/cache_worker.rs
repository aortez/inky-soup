use image::imageops::FilterType;
use std::path::Path;

// Inky Impression display resolution.
pub const DISPLAY_WIDTH: u32 = 600;
pub const DISPLAY_HEIGHT: u32 = 448;

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
