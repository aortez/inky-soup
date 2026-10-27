//! Non-destructive source rotation, independent of frame mounting orientation.
use crate::{
    api_error::{failure, Failure},
    browser_access::BrowserWrite,
    config,
    image_locks::ImageLocksState,
    metadata,
    storage::{self, StorageLock},
};
use rocket::{
    http::Status,
    serde::json::{json, Json, Value},
    State,
};
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
pub struct PhotoRotation {
    filename: String,
    session_id: String,
    photo_rotation_degrees: i32,
    expected_revision: u64,
    operation_id: Option<String>,
}

type RotationResult = Result<Json<Value>, Failure>;

#[post("/api/settings/photo-rotation", format = "json", data = "<request>")]
pub async fn update_photo_rotation(
    _origin: BrowserWrite,
    request: Json<PhotoRotation>,
    storage: &State<StorageLock>,
    locks: &State<ImageLocksState>,
) -> RotationResult {
    let filename = &request.filename;
    if crate::sanitize_filename(filename).as_ref() != Some(filename) || filename.contains('\0') {
        return Err(failure(Status::BadRequest, "Invalid filename"));
    }
    let degrees =
        crate::display_settings::parse_rotation_degrees(request.photo_rotation_degrees)
            .ok_or_else(|| failure(Status::BadRequest, "Choose 0, 90, 180, or 270 degrees"))?;
    if request.operation_id.as_ref().is_some_and(|id| {
        id.is_empty()
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }) {
        return Err(failure(Status::BadRequest, "Invalid rotation operation ID"));
    }
    let Some(_storage) =
        storage::lock_for_editor(storage, locks, filename, &request.session_id).await
    else {
        return Err(failure(
            Status::Forbidden,
            "Acquire edit access before rotating this photo",
        ));
    };
    if !config::original_path(filename).is_file() {
        return Err(failure(Status::NotFound, "Photo not found"));
    }
    let mut meta = metadata::get_all_metadata(filename);
    let previous_operation = meta.photo_rotation_operation.clone();
    let replayed = previous_operation
        .as_ref()
        .is_some_and(|operation| request.operation_id.as_ref() == Some(&operation.id));
    if replayed
        && !previous_operation.as_ref().is_some_and(|operation| {
            operation.expected_revision == request.expected_revision
                && operation.rotation_degrees == degrees
                && operation.revision == meta.photo_rotation_revision
                && meta.photo_rotation_degrees == degrees
        })
    {
        return Err(failure(
            Status::Conflict,
            "Rotation operation ID was reused with different settings",
        ));
    }
    if !replayed && meta.photo_rotation_revision != request.expected_revision {
        return Err(failure(
            Status::Conflict,
            "This photo was rotated elsewhere. Reopen it from the gallery before saving.",
        ));
    }
    let changed = !replayed && meta.photo_rotation_degrees != degrees;
    if changed {
        meta.photo_rotation_degrees = degrees;
        meta.photo_rotation_revision = meta
            .photo_rotation_revision
            .checked_add(1)
            .ok_or_else(|| failure(Status::InternalServerError, "Photo revision is exhausted"))?;
    }
    if !replayed {
        meta.photo_rotation_operation =
            request
                .operation_id
                .as_ref()
                .map(|id| metadata::PhotoRotationOperation {
                    id: id.clone(),
                    expected_revision: request.expected_revision,
                    rotation_degrees: degrees,
                    revision: meta.photo_rotation_revision,
                });
    }
    if changed || meta.photo_rotation_operation != previous_operation {
        // Persist the receipt and revision together before deleting any pixels.
        metadata::try_save_metadata(filename, &meta)
            .map_err(|_| failure(Status::InternalServerError, "Could not save photo rotation"))?;
    }
    if changed {
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
        json!({"success":true,"changed":changed,"replayed":replayed,"filename":filename,
        "photo_rotation_degrees":degrees,"photo_rotation_revision":meta.photo_rotation_revision,
        "needs_processing":meta.dither_photo_revision != meta.photo_rotation_revision || !config::dithered_path(filename).exists()}),
    ))
}
