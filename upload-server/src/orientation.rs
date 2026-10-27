//! Display orientation changes and the private snapshots that flash jobs display.
use crate::{
    api_error::{failure, Failure},
    browser_access::BrowserWrite,
    config, derived_assets, display_settings,
    storage::StorageLock,
};
use rocket::http::Status;
use rocket::serde::json::{json, Json, Value};
use rocket::State;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub struct RotationRequest {
    rotation_degrees: i32,
    expected_revision: u64,
}

type RotationResult = Result<Json<Value>, Failure>;

fn change_rotation(path: &Path, dirs: [&Path; 3], request: &RotationRequest) -> RotationResult {
    let rotation = display_settings::parse_rotation_degrees(request.rotation_degrees)
        .ok_or_else(|| failure(Status::BadRequest, "Choose 0, 90, 180, or 270 degrees"))?;
    let mut settings = display_settings::load_runtime_settings_from_path(path);
    if settings.rotation_revision != request.expected_revision {
        return Err(failure(
            Status::Conflict,
            "Orientation changed in another app. Reconnect before trying again.",
        ));
    }
    let changed = settings.rotation_degrees != rotation;
    let mut removed = derived_assets::DerivedAssetCounts::default();
    if changed {
        settings.rotation_degrees = rotation;
        settings.rotation_revision =
            settings.rotation_revision.checked_add(1).ok_or_else(|| {
                failure(
                    Status::InternalServerError,
                    "Orientation revision is exhausted",
                )
            })?;
        // Persist the revision first. Even failed file removal cannot make an old
        // render valid again, including after 0 -> 180 -> 0 or a server restart.
        display_settings::save_runtime_settings_to_path(path, &settings)
            .map_err(|error| failure(Status::InternalServerError, error))?;
        removed = derived_assets::invalidate_all_derived_assets(dirs[0], dirs[1], dirs[2]);
    }
    Ok(Json(
        json!({"success":true,"changed":changed,"rotation_degrees":rotation,
        "rotation_revision":settings.rotation_revision,"removed_assets":removed}),
    ))
}

#[post("/api/settings/display-rotation", format = "json", data = "<request>")]
pub async fn update_display_rotation(
    _origin: BrowserWrite,
    request: Json<RotationRequest>,
    storage: &State<StorageLock>,
) -> RotationResult {
    let _guard = storage.lock().await;
    let mut result = change_rotation(
        &config::display_runtime_settings_path(),
        [
            &config::cache_dir(),
            &config::thumbs_dir(),
            &config::dithered_dir(),
        ],
        &request,
    )?;
    result["display"] = json!(crate::get_display_config());
    result["pending_images"] = json!(crate::get_gallery_images()
        .iter()
        .filter(|image| image.needs_processing)
        .count());
    Ok(result)
}

pub fn snapshot_image(source: &Path) -> Result<PathBuf, String> {
    snapshot_into(source, &config::flash_jobs_dir())
        .map_err(|error| format!("Could not prepare display job: {error}"))
}

/// Run before accepting jobs. The queue is not persisted, so snapshots left
/// from an earlier server lifetime no longer belong to any live job.
pub fn cleanup_abandoned_snapshots(directory: &Path) -> std::io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_file() && path.extension().is_some_and(|ext| ext == "png") {
            fs::remove_file(path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn snapshot_into(source: &Path, directory: &Path) -> std::io::Result<PathBuf> {
    let mut input = fs::File::open(source)?;
    let (path, mut output) = reserve_in(directory)?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}

pub fn reserve_snapshot() -> std::io::Result<(PathBuf, fs::File)> {
    reserve_in(&config::flash_jobs_dir())
}

fn reserve_in(directory: &Path) -> std::io::Result<(PathBuf, fs::File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(directory)?;
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = directory.join(format!(
        "{epoch}-{}.png",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok((path, output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_cleanup_removes_snapshots_and_preserves_other_files() {
        let root =
            std::env::temp_dir().join(format!("inky-snapshot-cleanup-{}", std::process::id()));
        let images = root.join("images");
        let jobs = root.join("flash-jobs");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(jobs.join("nested.png")).unwrap();
        let original = images.join("photo.png");
        fs::write(&original, b"original pixels").unwrap();
        fs::write(jobs.join("keep.txt"), b"unrelated file").unwrap();
        fs::write(jobs.join("nested.png/keep.png"), b"nested file").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&original, jobs.join("linked.png")).unwrap();

        let first = snapshot_into(&original, &jobs).unwrap();
        let second = snapshot_into(&original, &jobs).unwrap();
        assert_eq!(cleanup_abandoned_snapshots(&jobs).unwrap(), 2);
        assert!(!first.exists());
        assert!(!second.exists());
        assert_eq!(fs::read(&original).unwrap(), b"original pixels");
        assert_eq!(fs::read(jobs.join("keep.txt")).unwrap(), b"unrelated file");
        assert_eq!(
            fs::read(jobs.join("nested.png/keep.png")).unwrap(),
            b"nested file"
        );
        #[cfg(unix)]
        assert!(jobs.join("linked.png").is_symlink());
        assert_eq!(cleanup_abandoned_snapshots(&jobs).unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_invalidate_all_versions_preserve_snapshots_and_reject_stale_writers() {
        let root = std::env::temp_dir().join(format!("inky-orientation-{}", std::process::id()));
        let path = root.join("settings/display.json");
        let dirs = [
            root.join("cache"),
            root.join("thumbs"),
            root.join("dithered"),
        ];
        for dir in &dirs {
            fs::create_dir_all(dir).unwrap();
            fs::write(dir.join("photo.png.png"), b"saved pixels").unwrap();
        }
        let original = root.join("photo.png");
        fs::write(&original, b"original").unwrap();
        let snapshot = snapshot_into(&dirs[2].join("photo.png.png"), &root.join("jobs")).unwrap();
        let update = |degrees, revision| {
            change_rotation(
                &path,
                [&dirs[0], &dirs[1], &dirs[2]],
                &RotationRequest {
                    rotation_degrees: degrees,
                    expected_revision: revision,
                },
            )
        };
        assert_eq!(update(45, 0).unwrap_err().0, Status::BadRequest);
        assert_eq!(update(180, 0).unwrap()["rotation_revision"], 1);
        assert_eq!(fs::read(&snapshot).unwrap(), b"saved pixels");
        assert_eq!(fs::read(original).unwrap(), b"original");
        for dir in &dirs {
            assert!(!dir.join("photo.png.png").exists());
        }
        assert_eq!(update(90, 0).unwrap_err().0, Status::Conflict);
        assert_eq!(update(180, 1).unwrap()["changed"], false);
        assert_eq!(update(0, 1).unwrap()["rotation_revision"], 2);
        assert_eq!(
            display_settings::load_runtime_settings_from_path(&path).rotation_revision,
            2
        );
        fs::remove_dir_all(root).unwrap();
    }
}
