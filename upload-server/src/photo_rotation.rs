//! Non-destructive source rotation, independent of frame mounting orientation.
use crate::{
    browser_access::BrowserWrite, config, image_locks::ImageLocksState, metadata,
    orientation::OrientationState,
};
use rocket::{
    http::Status,
    serde::json::{json, Json, Value},
    State,
};
use serde::Deserialize;
use std::{fs, time::Instant};

#[derive(Deserialize)]
pub struct PhotoRotation {
    filename: String,
    session_id: String,
    photo_rotation_degrees: i32,
    expected_revision: u64,
}

type RotationResult = Result<Json<Value>, (Status, Json<Value>)>;
fn failure(status: Status, message: &str) -> (Status, Json<Value>) {
    (status, Json(json!({"success":false,"message":message})))
}

#[post("/api/settings/photo-rotation", format = "json", data = "<request>")]
pub async fn update_photo_rotation(
    _origin: BrowserWrite,
    request: Json<PhotoRotation>,
    orientation: &State<OrientationState>,
    locks: &State<ImageLocksState>,
) -> RotationResult {
    let filename = &request.filename;
    if crate::sanitize_filename(filename).as_ref() != Some(filename) || filename.contains('\0') {
        return Err(failure(Status::BadRequest, "Invalid filename"));
    }
    let degrees =
        crate::display_settings::parse_rotation_degrees(request.photo_rotation_degrees)
            .ok_or_else(|| failure(Status::BadRequest, "Choose 0, 90, 180, or 270 degrees"))?;
    let _orientation = orientation.lock().await;
    let locks = locks.lock().await;
    if !locks.get(filename).is_some_and(|lock| {
        lock.session_id == request.session_id && lock.expires_at > Instant::now()
    }) {
        return Err(failure(
            Status::Forbidden,
            "Acquire edit access before rotating this photo",
        ));
    }
    if !config::original_path(filename).is_file() {
        return Err(failure(Status::NotFound, "Photo not found"));
    }
    let mut meta = metadata::get_all_metadata(filename);
    if meta.photo_rotation_revision != request.expected_revision {
        return Err(failure(
            Status::Conflict,
            "This photo was rotated elsewhere. Reopen it from the gallery before saving.",
        ));
    }
    let changed = meta.photo_rotation_degrees != degrees;
    if changed {
        meta.photo_rotation_degrees = degrees;
        meta.photo_rotation_revision = meta
            .photo_rotation_revision
            .checked_add(1)
            .ok_or_else(|| failure(Status::InternalServerError, "Photo revision is exhausted"))?;
        // Persist first: revision stamps reject stale pixels even if deletion fails.
        metadata::try_save_metadata(filename, &meta)
            .map_err(|_| failure(Status::InternalServerError, "Could not save photo rotation"))?;
        for path in [
            config::cache_path(filename),
            config::thumb_path(filename),
            config::dithered_path(filename),
        ] {
            if let Err(error) = fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("Could not remove {}: {}", path.display(), error);
                }
            }
        }
    }
    Ok(Json(
        json!({"success":true,"changed":changed,"filename":filename,
        "photo_rotation_degrees":degrees,"photo_rotation_revision":meta.photo_rotation_revision,
        "needs_processing":meta.dither_photo_revision != meta.photo_rotation_revision || !config::dithered_path(filename).exists()}),
    ))
}
