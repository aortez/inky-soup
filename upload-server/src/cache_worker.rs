use std::path::Path;

/// Gets the cache path for a given original image path.
/// Caches are always saved as PNG regardless of source format.
pub fn get_cache_path(original_path: &str) -> String {
    let path = Path::new(original_path);
    let filename = path.file_name()
        .map(|f| f.to_str().unwrap_or("unknown"))
        .unwrap_or("unknown");
    format!("static/images/cache/{}.png", filename)
}
