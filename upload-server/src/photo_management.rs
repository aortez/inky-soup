//! JSON photo management for hosted clients and the local CLI.

use crate::browser_access::BrowserWrite;
use crate::flash_queue::{FlashJobStatus, FlashQueueState};
use crate::image_locks::ImageLocksState;
use rocket::http::Status;
use rocket::serde::json::{json, Json, Value};
use rocket::serde::Deserialize;
use rocket::State;
use std::fs;
use std::path::Path;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
pub struct DeleteImage {
    filename: String,
    session_id: String,
}

type DeleteResult = Result<Json<Value>, (Status, Json<Value>)>;

fn failure(status: Status, message: &str) -> (Status, Json<Value>) {
    (status, Json(json!({"success": false, "message": message})))
}

#[post("/api/delete-image", data = "<request>")]
pub async fn delete_image(
    _origin: BrowserWrite,
    request: Json<DeleteImage>,
    locks: &State<ImageLocksState>,
    queue: &State<FlashQueueState>,
) -> DeleteResult {
    delete_from(&crate::config::IMAGES_DIR, &request, locks, queue).await
}

async fn delete_from(
    root: &Path,
    request: &DeleteImage,
    locks: &ImageLocksState,
    queue: &FlashQueueState,
) -> DeleteResult {
    let filename = &request.filename;
    if crate::sanitize_filename(filename).as_ref() != Some(filename)
        || filename.contains('\0')
        || request.session_id.is_empty()
    {
        return Err(failure(
            Status::BadRequest,
            "Invalid filename or editing session",
        ));
    }

    // Queue first, then image locks: flash submission uses the same order.
    // Keep both guards through removal so another session cannot take over mid-delete.
    let queue = queue.lock().await;
    let mut locks = locks.lock().await;
    if !locks.get(filename).is_some_and(|lock| {
        lock.session_id == request.session_id && lock.expires_at > Instant::now()
    }) {
        return Err(failure(
            Status::Forbidden,
            "Acquire edit access before deleting this photo",
        ));
    }
    let pending = queue
        .get_queued_jobs()
        .into_iter()
        .chain(queue.get_current_job());
    if pending.into_iter().any(|job| {
        job.filename == *filename
            && matches!(
                job.status,
                FlashJobStatus::Queued | FlashJobStatus::Flashing
            )
    }) {
        return Err(failure(
            Status::Conflict,
            "This photo is queued or refreshing. Wait for the display to finish",
        ));
    }

    fs::remove_file(root.join(filename)).map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            Status::NotFound
        } else {
            Status::InternalServerError
        };
        failure(status, "Could not delete the original photo")
    })?;
    let mut warnings = Vec::new();
    for path in [
        root.join("cache").join(format!("{filename}.png")),
        root.join("thumbs").join(format!("{filename}.png")),
        root.join("dithered").join(format!("{filename}.png")),
        root.join("metadata").join(format!("{filename}.json")),
    ] {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("Could not remove {}: {}", path.display(), error);
                warnings.push("A saved version could not be removed".to_string());
            }
        }
    }
    locks.remove(filename);
    Ok(Json(
        json!({"success": true, "filename": filename, "warnings": warnings}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash_queue::FlashQueue;
    use crate::image_locks::{try_acquire_lock, ImageLock};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[rocket::async_test]
    async fn deletion_requires_ownership_and_an_idle_photo_and_removes_all_versions() {
        let root = std::env::temp_dir().join(format!("inky-delete-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = [
            "photo.png",
            "cache/photo.png.png",
            "thumbs/photo.png.png",
            "dithered/photo.png.png",
            "metadata/photo.png.json",
        ];
        for path in paths {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"disposable test data").unwrap();
        }
        let locks: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));
        let queue: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));
        let request = DeleteImage {
            filename: "photo.png".into(),
            session_id: "owner".into(),
        };
        assert_eq!(
            delete_from(&root, &request, &locks, &queue)
                .await
                .unwrap_err()
                .0,
            Status::Forbidden
        );
        try_acquire_lock(&locks, "photo.png", "other", false)
            .await
            .unwrap();
        assert_eq!(
            delete_from(&root, &request, &locks, &queue)
                .await
                .unwrap_err()
                .0,
            Status::Forbidden
        );
        locks.lock().await.insert(
            "photo.png".into(),
            ImageLock {
                session_id: "owner".into(),
                expires_at: Instant::now(),
            },
        );
        assert_eq!(
            delete_from(&root, &request, &locks, &queue)
                .await
                .unwrap_err()
                .0,
            Status::Forbidden
        );
        try_acquire_lock(&locks, "photo.png", "owner", false)
            .await
            .unwrap();
        queue
            .lock()
            .await
            .enqueue("photo.png".into(), "unused".into(), false, 0);
        assert_eq!(
            delete_from(&root, &request, &locks, &queue)
                .await
                .unwrap_err()
                .0,
            Status::Conflict
        );
        for path in paths {
            assert!(root.join(path).exists());
        }
        *queue.lock().await = FlashQueue::new();
        let invalid = DeleteImage {
            filename: "../photo.png".into(),
            session_id: "owner".into(),
        };
        assert_eq!(
            delete_from(&root, &invalid, &locks, &queue)
                .await
                .unwrap_err()
                .0,
            Status::BadRequest
        );
        let result = delete_from(&root, &request, &locks, &queue).await.unwrap();
        assert_eq!(result["success"], true);
        for path in paths {
            assert!(!root.join(path).exists());
        }
        assert!(!locks.lock().await.contains_key("photo.png"));
        fs::remove_dir_all(root).unwrap();
    }
}
