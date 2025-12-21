#[macro_use] extern crate rocket;

mod cache_worker;
mod cleanup;
mod flash_queue;
mod image_locks;
mod metadata;

use glob::glob;
use log::{debug, error, info, warn};

use rocket_dyn_templates::Template;
use rocket::fairing::{Fairing, Info, Kind};
use rocket::form::{Form, Contextual};
use rocket::fs::{FileServer, TempFile};
use rocket::http::Status;
use rocket::response::Redirect;
use rocket::serde::json::Json;
use rocket::serde::{Deserialize, Serialize};
use rocket::{Rocket, State};

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

use flash_queue::{FlashJob, FlashQueue, FlashQueueState};
use image_locks::ImageLocksState;


#[derive(Debug, FromForm)]
struct DeleteSubmission {
    image_file_path: String
}

#[derive(Debug, FromForm)]
struct FlashSubmission {
    filename: String,
    image_file_path: String,
    session_id: String,
    flash_twice: bool,
}

#[derive(Debug, FromForm)]
struct UploadSubmission<'v> {
    // TODO: validator for any image type that seems to work with the
    // flashing script.
    // #[field(validate = ext(ContentType::PNG))]
    file: TempFile<'v>,
}

#[derive(Debug, FromForm)]
struct SubmitDeleteImage {
    submission: DeleteSubmission,
}

#[derive(Debug, FromForm)]
struct SubmitFlashImage {
    submission: FlashSubmission,
}

#[derive(Debug, FromForm)]
struct SubmitNewImage<'v> {
    submission: UploadSubmission<'v>,
}

/// Information about a gallery image for template rendering.
#[derive(Serialize, Clone)]
#[serde(crate = "rocket::serde")]
struct GalleryImage {
    path: String,
    filename: String,
    thumb_ready: bool,
    filter: String,
    saturation: f32,
    brightness: i32,
    contrast: i32,
    dither_algorithm: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct TemplateContext {
    images: Vec<GalleryImage>,
    values: Vec<String>,
    errors: Vec<String>
}

/// Response for thumb status API endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ThumbStatus {
    ready: bool,
    thumb_path: String,
}

/// Response for display configuration API endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct DisplayConfig {
    width: u32,
    height: u32,
    thumb_width: u32,
    thumb_height: u32,
    model: String,
    color: String,
}

/// Read display configuration from /etc/inky-soup/display.conf.
/// Falls back to 5.7" Inky Impression defaults if file doesn't exist.
fn get_display_config() -> DisplayConfig {
    let config_path = "/etc/inky-soup/display.conf";

    // Default values for 5.7" Inky Impression.
    let mut config = DisplayConfig {
        width: 600,
        height: 448,
        thumb_width: 150,
        thumb_height: 112,
        model: "impression-5.7-default".to_string(),
        color: "multi".to_string(),
    };

    // Try to read config file.
    if let Ok(contents) = fs::read_to_string(config_path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }

            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();

                match key {
                    "DISPLAY_WIDTH" => {
                        if let Ok(v) = value.parse() {
                            config.width = v;
                        }
                    }
                    "DISPLAY_HEIGHT" => {
                        if let Ok(v) = value.parse() {
                            config.height = v;
                        }
                    }
                    "THUMB_WIDTH" => {
                        if let Ok(v) = value.parse() {
                            config.thumb_width = v;
                        }
                    }
                    "THUMB_HEIGHT" => {
                        if let Ok(v) = value.parse() {
                            config.thumb_height = v;
                        }
                    }
                    "DISPLAY_MODEL" => {
                        config.model = value.to_string();
                    }
                    "DISPLAY_COLOR" => {
                        config.color = value.to_string();
                    }
                    _ => {}
                }
            }
        }
        debug!("Loaded display config from {}: {}x{}", config_path, config.width, config.height);
    } else {
        debug!("Using default display config ({}x{})", config.width, config.height);
    }

    config
}

/// Sanitizes a filename to prevent path traversal attacks.
/// Strips any directory components and rejects empty or dangerous filenames.
fn sanitize_filename(filename: &str) -> Option<String> {
    // Extract just the filename part, stripping any path components.
    let name = filename
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("");

    // Reject empty filenames or those that are just dots.
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    // Reject filenames that start with a dot (hidden files).
    if name.starts_with('.') {
        return None;
    }

    Some(name.to_string())
}

fn get_gallery_images() -> Vec<GalleryImage> {
    let mut images: Vec<GalleryImage> = Vec::new();

    for entry in glob("static/images/*").expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                // Skip directories and non-image files.
                if path.is_dir() {
                    continue;
                }

                let filename = path.file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("unknown")
                    .to_string();

                // Skip metadata files (legacy and backup).
                if filename.starts_with("metadata.json") {
                    continue;
                }

                let image_path = format!("images/{}", filename);
                let thumb_path = format!("static/images/thumbs/{}.png", filename);
                let thumb_ready = Path::new(&thumb_path).exists();

                // Load all metadata for this image.
                let meta = metadata::get_all_metadata(&filename);

                images.push(GalleryImage {
                    path: image_path,
                    filename,
                    thumb_ready,
                    filter: meta.filter,
                    saturation: meta.saturation,
                    brightness: meta.brightness,
                    contrast: meta.contrast,
                    dither_algorithm: meta.dither_algorithm,
                });
            },
            Err(e) => warn!("Error reading gallery entry: {:?}", e),
        }
    }

    debug!("Found {} images in gallery", images.len());
    images
}

/// API endpoint to get display configuration.
/// Returns dimensions for the connected Inky Impression display.
#[get("/api/display-config")]
fn display_config() -> Json<DisplayConfig> {
    Json(get_display_config())
}

/// API endpoint to check if a gallery thumbnail exists.
#[get("/api/thumb-status/<filename>")]
fn thumb_status(filename: &str) -> Json<ThumbStatus> {
    let thumb_path = format!("static/images/thumbs/{}.png", filename);
    let ready = Path::new(&thumb_path).exists();

    Json(ThumbStatus {
        ready,
        thumb_path: format!("images/thumbs/{}.png", filename),
    })
}

/// Request to lock or refresh a lock on an image.
#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct LockImageRequest {
    filename: String,
    session_id: String,
}

/// Response for image lock requests.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct LockImageResponse {
    locked: bool,
    expires_in_secs: Option<u64>,
    reason: Option<String>,
}

/// API endpoint to acquire or refresh a lock on an image.
#[post("/api/lock-image", data = "<request>")]
async fn lock_image(
    request: Json<LockImageRequest>,
    locks_state: &State<ImageLocksState>,
) -> Json<LockImageResponse> {
    match image_locks::try_acquire_lock(
        locks_state,
        &request.filename,
        &request.session_id,
    ).await {
        Ok(true) => {
            let expires_in = image_locks::get_lock_remaining_secs(locks_state, &request.filename)
                .await
                .unwrap_or(image_locks::LOCK_DURATION_SECS);

            Json(LockImageResponse {
                locked: true,
                expires_in_secs: Some(expires_in),
                reason: None,
            })
        }
        Ok(false) => {
            let expires_in = image_locks::get_lock_remaining_secs(locks_state, &request.filename).await;
            Json(LockImageResponse {
                locked: false,
                expires_in_secs: expires_in,
                reason: Some("Image is being edited by another user".to_string()),
            })
        }
        Err(e) => Json(LockImageResponse {
            locked: false,
            expires_in_secs: None,
            reason: Some(format!("Lock error: {}", e)),
        }),
    }
}

/// Request to unlock an image.
#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct UnlockImageRequest {
    filename: String,
    session_id: String,
}

/// Response for unlock requests.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct UnlockImageResponse {
    success: bool,
}

/// API endpoint to release a lock on an image.
#[post("/api/unlock-image", data = "<request>")]
async fn unlock_image(
    request: Json<UnlockImageRequest>,
    locks_state: &State<ImageLocksState>,
) -> Json<UnlockImageResponse> {
    match image_locks::release_lock(locks_state, &request.filename, &request.session_id).await {
        Ok(_) => Json(UnlockImageResponse { success: true }),
        Err(_) => Json(UnlockImageResponse { success: false }),
    }
}

/// Response for original image upload endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct UploadResponse {
    success: bool,
    message: String,
    filename: Option<String>,
}

/// Response for upload-dithered endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct UploadDitheredResponse {
    success: bool,
    message: String,
    path: Option<String>,
}

/// Form data for dithered image upload.
#[derive(Debug, FromForm)]
struct DitheredUpload<'v> {
    filename: String,
    filter: String,
    saturation: f32,
    brightness: i32,
    contrast: i32,
    dither_algorithm: String,
    session_id: String,
    file: TempFile<'v>,
}

/// Form data for cache image upload.
#[derive(Debug, FromForm)]
struct CacheUpload<'v> {
    filename: String,
    filter: Option<String>,
    saturation: Option<f32>,
    brightness: Option<i32>,
    contrast: Option<i32>,
    dither_algorithm: Option<String>,
    session_id: Option<String>,
    file: TempFile<'v>,
}

/// Response for upload-cache endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct UploadCacheResponse {
    success: bool,
    message: String,
    path: Option<String>,
}

/// Form data for gallery thumbnail upload.
#[derive(Debug, FromForm)]
struct ThumbUpload<'v> {
    filename: String,
    file: TempFile<'v>,
}

/// Response for upload-thumb endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct UploadThumbResponse {
    success: bool,
    message: String,
    path: Option<String>,
}

/// Response for flash submission (queue).
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct FlashResponse {
    success: bool,
    message: String,
    job_id: u64,
    queue_position: usize,
}

/// Simplified job info for queue display.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct FlashJobSummary {
    job_id: u64,
    filename: String,
    flash_twice: bool,
    queue_position: usize,
}

/// Response for flash status API.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct FlashStatusResponse {
    current_job: Option<FlashJob>,
    queue: Vec<FlashJobSummary>,
    queue_length: usize,
}

/// API endpoint to upload a pre-dithered image.
#[post("/api/upload-dithered", data = "<form>")]
async fn upload_dithered(
    mut form: Form<DitheredUpload<'_>>,
    locks_state: &State<ImageLocksState>,
) -> Json<UploadDitheredResponse> {
    // Sanitize filename to prevent path traversal.
    let filename = match sanitize_filename(&form.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid dithered upload filename: {}", form.filename);
            return Json(UploadDitheredResponse {
                success: false,
                message: "Invalid filename".to_string(),
                path: None,
            });
        }
    };
    let filter = form.filter.clone();
    let saturation = form.saturation;
    let brightness = form.brightness;
    let contrast = form.contrast;
    let dither_algorithm = form.dither_algorithm.clone();
    let session_id = &form.session_id;

    info!(
        "Upload dithered: {} (filter: {}, sat: {}, bright: {}, contrast: {}, dither: {}, session: {})",
        filename, filter, saturation, brightness, contrast, dither_algorithm, session_id
    );

    // Verify lock ownership.
    let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, session_id)
        .await
        .unwrap_or(false);

    if !has_lock {
        warn!("Upload dithered denied for {}: session {} does not own lock", filename, session_id);
        return Json(UploadDitheredResponse {
            success: false,
            message: "You do not have edit access to this image".to_string(),
            path: None,
        });
    }

    // Save dithered image to dithered directory (always as PNG).
    let dithered_path = format!("static/images/dithered/{}.png", filename);

    match form.file.copy_to(&dithered_path).await {
        Ok(()) => {
            // Store all settings in metadata.
            info!(
                "Saving metadata for {}: filter={}, sat={}, bright={}, contrast={}, dither={}",
                filename, filter, saturation, brightness, contrast, dither_algorithm
            );
            metadata::save_all_settings(
                &filename,
                &filter,
                saturation,
                brightness,
                contrast,
                &dither_algorithm,
            );
            debug!("Saved dithered image: {}", filename);

            Json(UploadDitheredResponse {
                success: true,
                message: "Dithered image uploaded successfully".to_string(),
                path: Some(format!("images/dithered/{}.png", filename)),
            })
        }
        Err(e) => {
            error!("Failed to save dithered image {}: {}", filename, e);
            Json(UploadDitheredResponse {
                success: false,
                message: format!("Failed to save dithered image: {}", e),
                path: None,
            })
        }
    }
}

/// API endpoint to upload a pre-generated cache image.
#[post("/api/upload-cache", data = "<form>")]
async fn upload_cache(
    mut form: Form<CacheUpload<'_>>,
    locks_state: &State<ImageLocksState>,
) -> Json<UploadCacheResponse> {
    // Sanitize filename to prevent path traversal.
    let filename = match sanitize_filename(&form.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid cache upload filename: {}", form.filename);
            return Json(UploadCacheResponse {
                success: false,
                message: "Invalid filename".to_string(),
                path: None,
            });
        }
    };

    // Extract all settings.
    let filter = form.filter.clone();
    let saturation = form.saturation;
    let brightness = form.brightness;
    let contrast = form.contrast;
    let dither_algorithm = form.dither_algorithm.clone();
    let session_id = form.session_id.as_ref();

    debug!(
        "Upload cache: {} (filter: {:?}, sat: {:?}, bright: {:?}, contrast: {:?}, dither: {:?}, session: {:?})",
        filename, filter, saturation, brightness, contrast, dither_algorithm, session_id
    );

    // Verify lock ownership if session_id is provided.
    if let Some(sid) = session_id {
        let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, sid)
            .await
            .unwrap_or(false);

        if !has_lock {
            warn!("Upload cache denied for {}: session {} does not own lock", filename, sid);
            return Json(UploadCacheResponse {
                success: false,
                message: "You do not have edit access to this image".to_string(),
                path: None,
            });
        }
    }

    // Save cache image to cache directory.
    let cache_path = format!("static/images/cache/{}.png", filename);

    match form.file.copy_to(&cache_path).await {
        Ok(()) => {
            // Save settings if any are provided.
            if filter.is_some() || saturation.is_some() || brightness.is_some()
                || contrast.is_some() || dither_algorithm.is_some() {

                // Load current metadata to preserve any settings not provided.
                let current = metadata::get_all_metadata(&filename);

                let final_filter = filter.as_deref().unwrap_or(&current.filter);
                let final_saturation = saturation.unwrap_or(current.saturation);
                let final_brightness = brightness.unwrap_or(current.brightness);
                let final_contrast = contrast.unwrap_or(current.contrast);
                let final_dither = dither_algorithm.as_deref().unwrap_or(&current.dither_algorithm);

                info!(
                    "Saving metadata for {}: filter={}, sat={}, bright={}, contrast={}, dither={}",
                    filename, final_filter, final_saturation, final_brightness, final_contrast, final_dither
                );

                metadata::save_all_settings(
                    &filename,
                    final_filter,
                    final_saturation,
                    final_brightness,
                    final_contrast,
                    final_dither,
                );

                // Remove dithered file if it exists since cache changed.
                let dithered_path = format!("static/images/dithered/{}.png", filename);
                if Path::new(&dithered_path).exists() {
                    let _ = fs::remove_file(&dithered_path);
                    debug!("Removed dithered cache: {}", filename);
                }
            }
            debug!("Saved cache image: {}", filename);

            Json(UploadCacheResponse {
                success: true,
                message: "Cache image uploaded successfully".to_string(),
                path: Some(format!("images/cache/{}.png", filename)),
            })
        }
        Err(e) => {
            error!("Failed to save cache image {}: {}", filename, e);
            Json(UploadCacheResponse {
                success: false,
                message: format!("Failed to save cache image: {}", e),
                path: None,
            })
        }
    }
}

/// API endpoint to upload a gallery thumbnail.
#[post("/api/upload-thumb", data = "<form>")]
async fn upload_thumb(mut form: Form<ThumbUpload<'_>>) -> Json<UploadThumbResponse> {
    // Sanitize filename to prevent path traversal.
    let filename = match sanitize_filename(&form.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid thumbnail upload filename: {}", form.filename);
            return Json(UploadThumbResponse {
                success: false,
                message: "Invalid filename".to_string(),
                path: None,
            });
        }
    };
    debug!("Saving gallery thumbnail: {}", filename);

    // Save thumbnail to thumbs directory.
    let thumb_path = format!("static/images/thumbs/{}.png", filename);

    match form.file.copy_to(&thumb_path).await {
        Ok(()) => {
            debug!("Saved gallery thumbnail: {}", filename);
            Json(UploadThumbResponse {
                success: true,
                message: "Thumbnail uploaded successfully".to_string(),
                path: Some(format!("images/thumbs/{}.png", filename)),
            })
        }
        Err(e) => {
            error!("Failed to save thumbnail {}: {}", filename, e);
            Json(UploadThumbResponse {
                success: false,
                message: format!("Failed to save thumbnail: {}", e),
                path: None,
            })
        }
    }
}

#[get("/")]
fn upload_form() -> Template {
    debug!("Rendering gallery page");

    Template::render("index", &TemplateContext {
        images: get_gallery_images(),
        values: vec!["Upload images, then select them from the Gallery to Flash to the screen.".to_string()],
        errors: vec![],
    })
}

#[post("/delete", data = "<form>")]
async fn submit_delete_image<'r>(mut form: Form<Contextual<'r, SubmitDeleteImage>>) -> Result<Redirect, (Status, String)> {
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Delete form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Extract filename for logging.
    let image_file = format!("static/{}", submission.submission.image_file_path.clone());
    let filename = Path::new(&image_file)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("unknown");

    info!("Delete started: {}", filename);

    // Delete original file first - this is the critical operation.
    if let Err(e) = fs::remove_file(&image_file) {
        error!("Delete failed for {}: {}", filename, e);
        return Err((Status::InternalServerError, format!("Failed to delete image: {}", e)));
    }

    // Also delete cached version if it exists (non-fatal if this fails).
    let cache_path = cache_worker::get_cache_path(&image_file);
    if Path::new(&cache_path).exists() {
        if let Err(e) = fs::remove_file(&cache_path) {
            warn!("Failed to remove cached image for {}: {}", filename, e);
        }
    }

    // Also delete gallery thumbnail if it exists (non-fatal if this fails).
    let thumb_path = format!("static/images/thumbs/{}.png", filename);
    if Path::new(&thumb_path).exists() {
        if let Err(e) = fs::remove_file(&thumb_path) {
            warn!("Failed to remove thumbnail for {}: {}", filename, e);
        }
    }

    // Also delete dithered version if it exists (non-fatal if this fails).
    let dithered_path = format!("static/images/dithered/{}.png", filename);
    if Path::new(&dithered_path).exists() {
        if let Err(e) = fs::remove_file(&dithered_path) {
            warn!("Failed to remove dithered image for {}: {}", filename, e);
        }
    }

    // Clean up metadata.
    metadata::delete_metadata(filename);

    info!("Delete completed: {}", filename);
    Ok(Redirect::to(uri!(upload_form)))
}

/// Queue a flash job (returns immediately).
#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(
    mut form: Form<Contextual<'r, SubmitFlashImage>>,
    queue_state: &State<FlashQueueState>,
    locks_state: &State<ImageLocksState>,
) -> Result<Json<FlashResponse>, (Status, String)> {
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Flash form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Get filename and path from submission.
    let filename = &submission.submission.filename;
    let dithered_path = format!("static/{}", submission.submission.image_file_path.clone());
    let flash_twice = submission.submission.flash_twice;
    let session_id = &submission.submission.session_id;

    info!("Flash request received: {} (flash_twice: {}, session: {})", filename, flash_twice, session_id);

    // Verify lock ownership.
    let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, session_id)
        .await
        .unwrap_or(false);

    if !has_lock {
        warn!("Flash denied for {}: session {} does not own lock", filename, session_id);
        return Err((Status::Forbidden, "You do not have edit access to this image".to_string()));
    }

    // Require pre-dithered version to exist (uploaded from preview dialog).
    if !Path::new(&dithered_path).exists() {
        error!("Flash failed for {}: pre-dithered image not found", filename);
        return Err((Status::NotFound, format!("Pre-dithered image not found: {}", filename)));
    }

    // Add to queue.
    let mut queue = queue_state.lock().await;
    let job_id = queue.enqueue(filename.to_string(), dithered_path, flash_twice);
    let queue_position = queue.get_position(job_id).unwrap_or(0);
    drop(queue);

    info!("Flash job {} queued for {} at position {}", job_id, filename, queue_position);

    Ok(Json(FlashResponse {
        success: true,
        message: format!("Flash job queued (position {})", queue_position),
        job_id,
        queue_position,
    }))
}

/// Get flash queue status (all users can see).
#[get("/api/flash/status")]
async fn flash_status(queue_state: &State<FlashQueueState>) -> Json<FlashStatusResponse> {
    let queue = queue_state.lock().await;

    let queue_summaries: Vec<FlashJobSummary> = queue
        .get_queued_jobs()
        .iter()
        .enumerate()
        .map(|(idx, job)| FlashJobSummary {
            job_id: job.job_id,
            filename: job.filename.clone(),
            flash_twice: job.flash_twice,
            queue_position: idx + 1, // +1 because 0 is current job.
        })
        .collect();

    Json(FlashStatusResponse {
        current_job: queue.get_current_job(),
        queue: queue_summaries,
        queue_length: queue.get_queued_jobs().len(),
    })
}

/// Get status for a specific job.
#[get("/api/flash/status/<job_id>")]
async fn flash_job_status(job_id: u64, queue_state: &State<FlashQueueState>) -> Result<Json<FlashJob>, Status> {
    let queue = queue_state.lock().await;

    // Check current job.
    if let Some(ref current) = queue.get_current_job() {
        if current.job_id == job_id {
            return Ok(Json(current.clone()));
        }
    }

    // Check queued jobs.
    if let Some(job) = queue.get_queued_jobs().iter().find(|j| j.job_id == job_id) {
        return Ok(Json(job.clone()));
    }

    Err(Status::NotFound)
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>
) -> Json<UploadResponse> {
    match form.value {
        Some(ref mut submission) => {
            let file = &mut submission.submission.file;

            // Get the full original filename including extension.
            // TempFile::name() strips extensions, so use raw_name() instead.
            let filename = file.raw_name()
                .and_then(|n| sanitize_filename(n.dangerous_unsafe_unsanitized_raw().as_str()))
                .unwrap_or_else(|| {
                    warn!("Upload has no filename, using fallback");
                    "unnamed_upload".to_string()
                });

            info!("Upload started: {}", filename);

            // Save as new image in gallery.
            let image_file_path = format!("static/images/{}", filename);
            match file.copy_to(image_file_path.clone()).await {
                Ok(_) => {
                    info!("Upload completed: {}", filename);
                    // Cache is now generated client-side and uploaded separately via /api/upload-cache.
                    Json(UploadResponse {
                        success: true,
                        message: "Upload completed successfully".to_string(),
                        filename: Some(filename),
                    })
                }
                Err(e) => {
                    error!("Upload failed for {}: {}", filename, e);
                    Json(UploadResponse {
                        success: false,
                        message: format!("Upload failed: {}", e),
                        filename: None,
                    })
                }
            }
        }
        None => {
            warn!("Upload form validation failed");
            Json(UploadResponse {
                success: false,
                message: "Invalid form submission".to_string(),
                filename: None,
            })
        }
    }
}

/// Fairing to spawn background cleanup task.
struct CleanupFairing;

#[rocket::async_trait]
impl Fairing for CleanupFairing {
    fn info(&self) -> Info {
        Info {
            name: "Cleanup Worker",
            kind: Kind::Liftoff,
        }
    }

    async fn on_liftoff(&self, _rocket: &Rocket<rocket::Orbit>) {
        info!("Starting background cleanup worker (runs every 5 minutes)");
        cleanup::spawn_cleanup_task();
    }
}

/// Fairing to spawn background flash queue worker.
struct FlashQueueFairing;

#[rocket::async_trait]
impl Fairing for FlashQueueFairing {
    fn info(&self) -> Info {
        Info {
            name: "Flash Queue Worker",
            kind: Kind::Liftoff,
        }
    }

    async fn on_liftoff(&self, rocket: &Rocket<rocket::Orbit>) {
        info!("Starting flash queue worker");
        let queue_state = rocket
            .state::<FlashQueueState>()
            .expect("FlashQueueState not in managed state")
            .clone();
        flash_queue::spawn_flash_worker(queue_state);
    }
}

#[launch]
fn rocket() -> _ {
    // Ensure image directories exist.
    for dir in &["static/images", "static/images/cache", "static/images/dithered", "static/images/thumbs", "static/images/metadata"] {
        if let Err(e) = fs::create_dir_all(dir) {
            error!("Failed to create directory {}: {}", dir, e);
        }
    }

    // Run migration from legacy metadata format if needed.
    metadata::migrate_legacy_metadata();

    // Initialize flash queue state.
    let flash_queue_state: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));

    // Initialize image locks state.
    let image_locks_state: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));

    rocket::build()
        .manage(flash_queue_state)
        .manage(image_locks_state)
        .mount("/", routes![
            display_config,
            flash_job_status,
            flash_status,
            lock_image,
            submit_delete_image,
            submit_flash_image,
            submit_new_image,
            thumb_status,
            unlock_image,
            upload_cache,
            upload_dithered,
            upload_form,
            upload_thumb
        ])
        .mount("/", FileServer::from("static"))
        .attach(Template::fairing())
        .attach(CleanupFairing)
        .attach(FlashQueueFairing)
}
