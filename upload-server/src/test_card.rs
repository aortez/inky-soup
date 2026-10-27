//! Queue a client-rendered orientation card without creating a gallery photo.
use crate::{
    api_error::{failure, Failure},
    browser_access::BrowserWrite,
    flash_queue::FlashQueueState,
    orientation,
    storage::StorageLock,
    FlashResponse,
};
use rocket::serde::json::Json;
use rocket::{form::Form, fs::TempFile, http::Status, State};
use std::{fs, io::Read};

#[derive(FromForm)]
pub struct TestCard<'v> {
    rotation_revision: u64,
    file: TempFile<'v>,
}

#[post("/api/flash-test-card", data = "<form>")]
pub async fn flash_test_card(
    _origin: BrowserWrite,
    mut form: Form<TestCard<'_>>,
    storage: &State<StorageLock>,
    queue: &State<FlashQueueState>,
) -> Result<Json<FlashResponse>, Failure> {
    let _guard = storage.lock().await;
    let config = crate::get_display_config();
    if form.rotation_revision != config.rotation_revision {
        return Err(failure(
            Status::Conflict,
            "Frame orientation changed. Reconnect before displaying the test card.",
        ));
    }
    let (path, reserved) = orientation::reserve_snapshot()
        .map_err(|_| failure(Status::InternalServerError, "Could not prepare test card"))?;
    drop(reserved);
    let result = async {
        form.file
            .copy_to(&path)
            .await
            .map_err(|_| failure(Status::InternalServerError, "Could not save test card"))?;
        let mut header = [0; 24];
        let valid = fs::File::open(&path)
            .and_then(|mut file| file.read_exact(&mut header))
            .is_ok()
            && &header[..8] == b"\x89PNG\r\n\x1a\n"
            && &header[12..16] == b"IHDR"
            && u32::from_be_bytes(header[16..20].try_into().unwrap()) == config.width
            && u32::from_be_bytes(header[20..24].try_into().unwrap()) == config.height;
        if !valid {
            return Err(failure(
                Status::BadRequest,
                "Test card must be a PNG matching the frame's current dimensions",
            ));
        }
        let mut queue = queue.lock().await;
        let job_id = queue.enqueue(
            "orientation-test-card.png".into(),
            path.to_string_lossy().into(),
            false,
            config.rotation_degrees,
        );
        Ok(Json(FlashResponse {
            success: true,
            message: "Orientation test card queued".into(),
            job_id,
            queue_position: queue.get_position(job_id).unwrap_or(0),
        }))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}
