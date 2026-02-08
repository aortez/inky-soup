//! Utilities for invalidating derived image assets.

use log::warn;
use rocket::serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(crate = "rocket::serde")]
pub struct DerivedAssetCounts {
    pub cache: usize,
    pub thumbs: usize,
    pub dithered: usize,
}

fn remove_png_files(dir_path: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir_path) else {
        return 0;
    };

    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }

        let is_png = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false);

        if !is_png {
            continue;
        }

        match fs::remove_file(&path) {
            Ok(()) => {
                removed += 1;
            }
            Err(e) => {
                warn!("Failed to remove derived file '{}': {}", path.display(), e);
            }
        }
    }

    removed
}

/// Removes all derived PNG assets across cache/thumb/dithered directories.
pub fn invalidate_all_derived_assets(
    cache_dir: &Path,
    thumbs_dir: &Path,
    dithered_dir: &Path,
) -> DerivedAssetCounts {
    DerivedAssetCounts {
        cache: remove_png_files(cache_dir),
        thumbs: remove_png_files(thumbs_dir),
        dithered: remove_png_files(dithered_dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("{}_{}_{}", prefix, std::process::id(), nanos));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_file(path: &Path) {
        fs::write(path, b"test").unwrap();
    }

    #[test]
    fn test_invalidate_all_derived_assets_counts_removed_png_files() {
        let base = unique_temp_dir("inky_soup_derived_assets");
        let cache_dir = base.join("cache");
        let thumbs_dir = base.join("thumbs");
        let dithered_dir = base.join("dithered");
        fs::create_dir_all(&cache_dir).unwrap();
        fs::create_dir_all(&thumbs_dir).unwrap();
        fs::create_dir_all(&dithered_dir).unwrap();

        write_file(&cache_dir.join("a.jpg.png"));
        write_file(&cache_dir.join("ignore.txt"));
        write_file(&thumbs_dir.join("b.jpg.png"));
        write_file(&thumbs_dir.join("c.jpg.PNG"));
        write_file(&dithered_dir.join("d.jpg.png"));

        let counts = invalidate_all_derived_assets(&cache_dir, &thumbs_dir, &dithered_dir);
        assert_eq!(
            counts,
            DerivedAssetCounts {
                cache: 1,
                thumbs: 2,
                dithered: 1,
            }
        );

        assert!(cache_dir.join("ignore.txt").exists());
        assert!(!cache_dir.join("a.jpg.png").exists());
        assert!(!thumbs_dir.join("b.jpg.png").exists());
        assert!(!thumbs_dir.join("c.jpg.PNG").exists());
        assert!(!dithered_dir.join("d.jpg.png").exists());

        fs::remove_dir_all(base).unwrap();
    }
}
