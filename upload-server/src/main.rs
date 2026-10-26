#[macro_use] extern crate rocket;

mod browser_access;
mod cache_worker;
mod cleanup;
mod config;
mod device;
mod derived_assets;
mod display_settings;
mod flash_queue;
mod image_locks;
mod metadata;
mod orientation;
mod photo_management;
mod photo_rotation;
mod slideshow;
#[cfg(test)]
mod slideshow_tests;
mod test_card;
#[cfg(test)]
mod orientation_tests;

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

use browser_access::BrowserWrite;
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
    rotation_revision: Option<u64>,
    photo_rotation_revision: Option<u64>,
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
    favorite: bool,
    path: String,
    filename: String,
    thumb_ready: bool,
    needs_processing: bool,
    photo_rotation_degrees: u16,
    photo_rotation_revision: u64,
    filter: String,
    fit_mode: String,
    cache_version: u32,
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
    physical_width: u32,
    physical_height: u32,
    rotation_degrees: u16,
    rotation_revision: u64,
    photo_rotation_supported: bool,
    orientation_test_supported: bool,
}

/// Read display configuration from /etc/inky-soup/display.conf.
/// Falls back to 13.3" Inky Impression 2025 defaults if file doesn't exist.
fn get_display_config() -> DisplayConfig {
    let config_path = std::env::var("INKY_SOUP_DISPLAY_CONFIG")
        .unwrap_or_else(|_| "/etc/inky-soup/display.conf".to_string());

    // Default values for 13.3" Inky Impression 2025.
    let mut config = DisplayConfig {
        width: 1600,
        height: 1200,
        thumb_width: 150,
        thumb_height: 112,
        model: "impression-13.3-2025".to_string(),
        color: "multi".to_string(),
        physical_width: 1600,
        physical_height: 1200,
        rotation_degrees: 0,
        rotation_revision: 0,
        photo_rotation_supported: true,
        orientation_test_supported: true,
    };

    // Try to read config file.
    if let Ok(contents) = fs::read_to_string(&config_path) {
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

    let settings = display_settings::load_runtime_settings();
    config.physical_width = config.width;
    config.physical_height = config.height;
    config.rotation_degrees = settings.rotation_degrees;
    config.rotation_revision = settings.rotation_revision;
    (config.width, config.height) = display_settings::compute_logical_dimensions(
        config.width, config.height, settings.rotation_degrees);
    (config.thumb_width, config.thumb_height) = display_settings::compute_logical_dimensions(
        config.thumb_width, config.thumb_height, settings.rotation_degrees);
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
    let revision = display_settings::load_runtime_settings().rotation_revision;

    let glob_pattern = format!("{}/*", config::IMAGES_DIR.display());
    for entry in glob(&glob_pattern).expect("Failed to read glob pattern") {
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
                let thumb_path = config::thumb_path(&filename);
                let thumb_ready = thumb_path.exists();

                // Load all metadata for this image.
                let meta = metadata::get_all_metadata(&filename);

                images.push(GalleryImage {
                    favorite: meta.favorite,
                    path: image_path,
                    filename: filename.clone(),
                    thumb_ready: thumb_ready && meta.thumb_rotation_revision == revision
                        && meta.thumb_photo_revision == meta.photo_rotation_revision,
                    photo_rotation_degrees: meta.photo_rotation_degrees,
                    photo_rotation_revision: meta.photo_rotation_revision,
                    needs_processing: meta.processing_pending || !thumb_ready
                        || !config::cache_path(&filename).exists()
                        || !config::dithered_path(&filename).exists()
                        || meta.cache_rotation_revision != revision
                        || meta.thumb_rotation_revision != revision
                        || meta.dither_rotation_revision != revision
                        || meta.cache_photo_revision != meta.photo_rotation_revision
                        || meta.thumb_photo_revision != meta.photo_rotation_revision
                        || meta.dither_photo_revision != meta.photo_rotation_revision,
                    filter: meta.filter,
                    fit_mode: meta.fit_mode,
                    cache_version: meta.cache_version,
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

/// The same gallery data used by the local UI, available to the hosted client.
#[get("/api/images")]
fn gallery_images() -> Json<Vec<GalleryImage>> {
    Json(get_gallery_images())
}

/// API endpoint to check if a gallery thumbnail exists.
#[get("/api/thumb-status/<filename>")]
fn thumb_status(filename: &str) -> Json<ThumbStatus> {
    let thumb_path = config::thumb_path(filename);
    let meta = metadata::get_all_metadata(filename);
    let ready = thumb_path.exists() && meta.thumb_photo_revision == meta.photo_rotation_revision
        && meta.thumb_rotation_revision
        == display_settings::load_runtime_settings().rotation_revision;

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
    #[serde(default)]
    refresh_only: bool,
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
    _origin: BrowserWrite,
    request: Json<LockImageRequest>,
    locks_state: &State<ImageLocksState>,
) -> Json<LockImageResponse> {
    let filename = match sanitize_filename(&request.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid lock filename: {}", request.filename);
            return Json(LockImageResponse {
                locked: false,
                expires_in_secs: None,
                reason: Some("Invalid filename".to_string()),
            });
        }
    };

    match image_locks::try_acquire_lock(
        locks_state,
        &filename,
        &request.session_id,
        request.refresh_only,
    ).await {
        Ok(true) => {
            let expires_in = image_locks::get_lock_remaining_secs(locks_state, &filename)
                .await
                .unwrap_or(image_locks::LOCK_DURATION_SECS);

            Json(LockImageResponse {
                locked: true,
                expires_in_secs: Some(expires_in),
                reason: None,
            })
        }
        Ok(false) => {
            let expires_in = image_locks::get_lock_remaining_secs(locks_state, &filename).await;
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
    _origin: BrowserWrite,
    request: Json<UnlockImageRequest>,
    locks_state: &State<ImageLocksState>,
) -> Json<UnlockImageResponse> {
    let filename = match sanitize_filename(&request.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid unlock filename: {}", request.filename);
            return Json(UnlockImageResponse { success: false });
        }
    };

    match image_locks::release_lock(locks_state, &filename, &request.session_id).await {
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
    rotation_revision: Option<u64>,
    photo_rotation_revision: Option<u64>,
    filter: String,
    fit_mode: Option<String>,
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
    rotation_revision: Option<u64>,
    photo_rotation_revision: Option<u64>,
    filter: Option<String>,
    fit_mode: Option<String>,
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
    rotation_revision: Option<u64>,
    photo_rotation_revision: Option<u64>,
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
    source: slideshow::FlashSource,
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
    _origin: BrowserWrite,
    mut form: Form<DitheredUpload<'_>>,
    locks_state: &State<ImageLocksState>,
    orientation: &State<orientation::OrientationState>,
    slideshow: &State<slideshow::SlideshowState>,
) -> Json<UploadDitheredResponse> {
    let _orientation = orientation.lock().await;
    let revision = display_settings::load_runtime_settings().rotation_revision;
    if form.rotation_revision.unwrap_or(0) != revision {
        return Json(UploadDitheredResponse {
            success: false,
            message: "Display orientation changed. Reconnect and regenerate this photo.".into(),
            path: None,
        });
    }

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
    let meta = metadata::get_all_metadata(&filename);
    if form.photo_rotation_revision.unwrap_or(0) != meta.photo_rotation_revision {
        return Json(UploadDitheredResponse {
            success: false,
            message: "Photo rotation changed. Reopen this photo before saving.".into(),
            path: None,
        });
    }
    let filter = form.filter.clone();
    let fit_mode = form.fit_mode.clone().unwrap_or_else(|| "contain".to_string());
    let fit_mode = if fit_mode == "cover" { "cover".to_string() } else { "contain".to_string() };
    let saturation = form.saturation;
    let brightness = form.brightness;
    let contrast = form.contrast;
    let dither_algorithm = form.dither_algorithm.clone();
    let session_id = &form.session_id;

    info!(
        "Upload dithered: {} (filter: {}, fit: {}, sat: {}, bright: {}, contrast: {}, dither: {}, session: {})",
        filename, filter, fit_mode, saturation, brightness, contrast, dither_algorithm, session_id
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
    let dithered_path = config::dithered_path(&filename);

    let mut pending = metadata::get_all_metadata(&filename);
    pending.processing_pending = true;
    if let Err(error) = metadata::try_save_metadata(&filename, &pending) {
        return Json(UploadDitheredResponse { success: false,
            message: format!("Could not start display image save: {error}"), path: None });
    }
    match form.file.copy_to(&dithered_path).await {
        Ok(()) => {
            // Store all settings in metadata.
            info!(
                "Saving metadata for {}: filter={}, fit={}, sat={}, bright={}, contrast={}, dither={}",
                filename, filter, fit_mode, saturation, brightness, contrast, dither_algorithm
            );
            let mut meta = metadata::get_all_metadata(&filename);
            meta.filter = filter;
            meta.fit_mode = fit_mode;
            meta.saturation = saturation;
            meta.brightness = brightness;
            meta.contrast = contrast;
            meta.dither_algorithm = dither_algorithm;
            meta.dither_rotation_revision = revision;
            meta.dither_photo_revision = meta.photo_rotation_revision;
            meta.processing_pending = !(config::cache_path(&filename).is_file()
                && config::thumb_path(&filename).is_file()
                && meta.cache_rotation_revision == revision && meta.thumb_rotation_revision == revision
                && meta.cache_photo_revision == meta.photo_rotation_revision
                && meta.thumb_photo_revision == meta.photo_rotation_revision);
            if let Err(error) = metadata::try_save_metadata(&filename, &meta) {
                return Json(UploadDitheredResponse {
                    success: false, message: format!("Could not save image settings: {error}"), path: None,
                });
            }
            // Clients commit a complete save/upload in cache -> thumbnail -> dithered
            // order. Partial uploads and settings that still need rendering do not
            // postpone the slideshow.
            if get_gallery_images().iter().any(|image| image.filename == filename && !image.needs_processing) {
                if let Err(error) = slideshow.lock().await.content_completed(flash_queue::current_time_millis()) {
                    return Json(UploadDitheredResponse {
                        success: false, message: format!("Could not save slideshow completion: {error}"), path: None,
                    });
                }
            }
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
    _origin: BrowserWrite,
    mut form: Form<CacheUpload<'_>>,
    locks_state: &State<ImageLocksState>,
    orientation: &State<orientation::OrientationState>,
) -> Json<UploadCacheResponse> {
    let _orientation = orientation.lock().await;
    let revision = display_settings::load_runtime_settings().rotation_revision;
    if form.rotation_revision.unwrap_or(0) != revision {
        return Json(UploadCacheResponse {
            success: false,
            message: "Display orientation changed. Reconnect and regenerate this photo.".into(),
            path: None,
        });
    }

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
    let meta = metadata::get_all_metadata(&filename);
    if form.photo_rotation_revision.unwrap_or(0) != meta.photo_rotation_revision {
        return Json(UploadCacheResponse {
            success: false,
            message: "Photo rotation changed. Reopen this photo before saving.".into(),
            path: None,
        });
    }

    // Extract all settings.
    let filter = form.filter.clone();
    let fit_mode = form.fit_mode.clone();
    let saturation = form.saturation;
    let brightness = form.brightness;
    let contrast = form.contrast;
    let dither_algorithm = form.dither_algorithm.clone();
    let session_id = form.session_id.as_ref();

    debug!(
        "Upload cache: {} (filter: {:?}, fit: {:?}, sat: {:?}, bright: {:?}, contrast: {:?}, dither: {:?}, session: {:?})",
        filename, filter, fit_mode, saturation, brightness, contrast, dither_algorithm, session_id
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
    let cache_path = config::cache_path(&filename);

    let mut pending = metadata::get_all_metadata(&filename);
    pending.processing_pending = true;
    if let Err(error) = metadata::try_save_metadata(&filename, &pending) {
        return Json(UploadCacheResponse { success: false,
            message: format!("Could not start image save: {error}"), path: None });
    }
    if let Err(error) = fs::remove_file(config::dithered_path(&filename)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Json(UploadCacheResponse { success: false,
                message: format!("Could not invalidate display image: {error}"), path: None });
        }
    }
    match form.file.copy_to(&cache_path).await {
        Ok(()) => {
            let mut meta = metadata::get_all_metadata(&filename);
            if let Some(value) = filter { meta.filter = value; }
            if let Some(value) = fit_mode { meta.fit_mode = value; }
            if let Some(value) = saturation { meta.saturation = value; }
            if let Some(value) = brightness { meta.brightness = value; }
            if let Some(value) = contrast { meta.contrast = value; }
            if let Some(value) = dither_algorithm { meta.dither_algorithm = value; }
            meta.cache_version = 2;
            meta.cache_rotation_revision = revision;
            meta.cache_photo_revision = meta.photo_rotation_revision;
            if let Err(error) = metadata::try_save_metadata(&filename, &meta) {
                return Json(UploadCacheResponse {
                    success: false, message: format!("Could not save image settings: {error}"), path: None,
                });
            }
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
async fn upload_thumb(
    _origin: BrowserWrite,
    mut form: Form<ThumbUpload<'_>>,
    orientation: &State<orientation::OrientationState>,
) -> Json<UploadThumbResponse> {
    let _orientation = orientation.lock().await;
    let revision = display_settings::load_runtime_settings().rotation_revision;
    if form.rotation_revision.unwrap_or(0) != revision {
        return Json(UploadThumbResponse {
            success: false,
            message: "Display orientation changed. Reconnect and regenerate this photo.".into(),
            path: None,
        });
    }

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
    let meta = metadata::get_all_metadata(&filename);
    if form.photo_rotation_revision.unwrap_or(0) != meta.photo_rotation_revision {
        return Json(UploadThumbResponse {
            success: false,
            message: "Photo rotation changed. Reopen this photo before saving.".into(),
            path: None,
        });
    }
    debug!("Saving gallery thumbnail: {}", filename);

    // Save thumbnail to thumbs directory.
    let thumb_path = config::thumb_path(&filename);

    match form.file.copy_to(&thumb_path).await {
        Ok(()) => {
            let mut meta = metadata::get_all_metadata(&filename);
            meta.thumb_rotation_revision = revision;
            meta.thumb_photo_revision = meta.photo_rotation_revision;
            if let Err(error) = metadata::try_save_metadata(&filename, &meta) {
                return Json(UploadThumbResponse { success: false,
                    message: format!("Could not save thumbnail metadata: {error}"), path: None });
            }
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
async fn submit_delete_image<'r>(_origin: BrowserWrite, mut form: Form<Contextual<'r, SubmitDeleteImage>>, orientation: &State<orientation::OrientationState>) -> Result<Redirect, (Status, String)> {
    let _orientation = orientation.lock().await;
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Delete form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Extract filename for logging.
    let filename = Path::new(&submission.submission.image_file_path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("unknown");
    let image_file = config::original_path(filename);

    info!("Delete started: {}", filename);

    // Delete original file first - this is the critical operation.
    if let Err(e) = fs::remove_file(&image_file) {
        error!("Delete failed for {}: {}", filename, e);
        return Err((Status::InternalServerError, format!("Failed to delete image: {}", e)));
    }

    // Also delete cached version if it exists (non-fatal if this fails).
    let cache_path = config::cache_path(filename);
    if cache_path.exists() {
        if let Err(e) = fs::remove_file(&cache_path) {
            warn!("Failed to remove cached image for {}: {}", filename, e);
        }
    }

    // Also delete gallery thumbnail if it exists (non-fatal if this fails).
    let thumb_path = config::thumb_path(filename);
    if thumb_path.exists() {
        if let Err(e) = fs::remove_file(&thumb_path) {
            warn!("Failed to remove thumbnail for {}: {}", filename, e);
        }
    }

    // Also delete dithered version if it exists (non-fatal if this fails).
    let dithered_path = config::dithered_path(filename);
    if dithered_path.exists() {
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
    _origin: BrowserWrite,
    mut form: Form<Contextual<'r, SubmitFlashImage>>,
    queue_state: &State<FlashQueueState>,
    locks_state: &State<ImageLocksState>,
    orientation: &State<orientation::OrientationState>,
) -> Result<Json<FlashResponse>, (Status, String)> {
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Flash form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Sanitize filename to prevent path traversal.
    let filename = match sanitize_filename(&submission.submission.filename) {
        Some(name) => name,
        None => {
            warn!("Rejected invalid flash filename: {}", submission.submission.filename);
            return Err((Status::BadRequest, "Invalid filename".to_string()));
        }
    };

    // Get path from sanitized filename.
    let dithered_path = config::dithered_path(&filename);
    let flash_twice = submission.submission.flash_twice;
    let session_id = &submission.submission.session_id;

    info!("Flash request received: {} (flash_twice: {}, session: {})", filename, flash_twice, session_id);

    // Serialize file validation/enqueue with photo deletion.
    let _orientation = orientation.lock().await;
    let display = get_display_config();
    if submission.submission.rotation_revision.unwrap_or(0) != display.rotation_revision
        || metadata::get_all_metadata(&filename).dither_rotation_revision != display.rotation_revision
    {
        return Err((Status::Conflict,
            "Display orientation changed. Regenerate this photo before displaying it.".into()));
    }
    let photo = metadata::get_all_metadata(&filename);
    if photo.processing_pending {
        return Err((Status::Conflict, "Finish saving this photo before displaying it.".into()));
    }
    if submission.submission.photo_rotation_revision.unwrap_or(0) != photo.photo_rotation_revision
        || photo.dither_photo_revision != photo.photo_rotation_revision {
        return Err((Status::Conflict, "Photo rotation changed. Regenerate this photo before displaying it.".into()));
    }
    let mut queue = queue_state.lock().await;

    // Verify lock ownership.
    let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, session_id)
        .await
        .unwrap_or(false);

    if !has_lock {
        warn!("Flash denied for {}: session {} does not own lock", filename, session_id);
        return Err((Status::Forbidden, "You do not have edit access to this image".to_string()));
    }

    // Require pre-dithered version to exist (uploaded from preview dialog).
    if !dithered_path.exists() {
        error!("Flash failed for {}: pre-dithered image not found", filename);
        return Err((Status::NotFound, format!("Pre-dithered image not found: {}", filename)));
    }

    // Add to queue while file validation is still protected.
    let snapshot = orientation::snapshot_image(&dithered_path)
        .map_err(|error| (Status::InternalServerError, error))?;
    let job_id = queue.enqueue(filename.clone(), snapshot.to_string_lossy().to_string(),
        flash_twice, display.rotation_degrees);
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
            source: job.source,
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

    if let Some(job) = queue.find_job(job_id) {
        return Ok(Json(job));
    }

    Err(Status::NotFound)
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    _origin: BrowserWrite,
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>,
    orientation: &State<orientation::OrientationState>,
) -> Json<UploadResponse> {
    let _orientation = orientation.lock().await;
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
            let image_file_path = config::original_path(&filename);
            let mut pending = metadata::get_all_metadata(&filename);
            pending.processing_pending = true;
            if let Err(error) = metadata::try_save_metadata(&filename, &pending) {
                return Json(UploadResponse { success: false,
                    message: format!("Could not start image upload: {error}"), filename: None });
            }
            match file.copy_to(&image_file_path).await {
                Ok(_) => {
                    // Replacing an original cannot leave the previous photo eligible
                    // for automatic display while its new pixels are being prepared.
                    for path in [config::cache_path(&filename), config::thumb_path(&filename), config::dithered_path(&filename)] {
                        if let Err(error) = fs::remove_file(&path) {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                return Json(UploadResponse { success: false,
                                    message: format!("Could not invalidate old image: {error}"), filename: None });
                            }
                        }
                    }
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
        let slideshow = rocket.state::<slideshow::SlideshowState>().expect("Slideshow state").clone();
        flash_queue::spawn_flash_worker(queue_state.clone(), slideshow.clone());
        slideshow::spawn(slideshow,
            rocket.state::<orientation::OrientationState>().expect("Orientation state").clone(),
            queue_state, rocket.state::<ImageLocksState>().expect("Image locks").clone(), rocket.shutdown());
    }
}

#[launch]
fn rocket() -> _ {
    // Ensure image directories exist.
    for dir in config::required_dirs() {
        if let Err(e) = fs::create_dir_all(&dir) {
            error!("Failed to create directory {}: {}", dir.display(), e);
        }
    }

    // This must precede queue creation and request handling: every existing
    // snapshot belongs to a job abandoned by a previous server lifetime.
    match orientation::cleanup_abandoned_snapshots(&config::flash_jobs_dir()) {
        Ok(0) => {},
        Ok(count) => info!("Removed {} abandoned flash snapshots", count),
        Err(error) => warn!("Could not clean abandoned flash snapshots: {}", error),
    }

    // Run migration from legacy metadata format if needed.
    metadata::migrate_legacy_metadata();

    // Initialize flash queue state.
    let flash_queue_state: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));

    // Initialize image locks state.
    let image_locks_state: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));

    let mut rocket = rocket::build()
        .manage(device::Device::load(&config::settings_dir()).expect("Could not load frame identity"))
        .manage(browser_access::BrowserAccess::from_env())
        .attach(browser_access::Cors)
        .manage(orientation::OrientationState::default())
        .manage(Arc::new(Mutex::new(slideshow::Slideshow::load(
            config::settings_dir().join("slideshow.json"), flash_queue::current_time_millis()
        ).expect("Could not load slideshow settings"))) as slideshow::SlideshowState)
        .manage(flash_queue_state)
        .manage(image_locks_state)
        .mount("/", routes![
            browser_access::preflight,
            display_config,
            device::identity,
            orientation::update_display_rotation,
            gallery_images,
            slideshow::set_favorite,
            slideshow::configure,
            slideshow::status,
            photo_management::delete_image,
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
            upload_thumb,
            photo_rotation::update_photo_rotation,
            test_card::flash_test_card
        ])
        // Use rank 10 (lower priority) for root static server so /images can take precedence.
        .mount("/", FileServer::from("static").rank(10));

    // Mount separate images FileServer only when images are outside of static/.
    let images_dir_str = config::IMAGES_DIR.to_string_lossy();
    if !images_dir_str.starts_with("static/") && !images_dir_str.starts_with("./static/") {
        info!("Mounting images from external directory: {}", images_dir_str);
        // Use rank 1 (higher priority) for images.
        rocket = rocket.mount("/images", FileServer::from(config::IMAGES_DIR.as_path()).rank(1));
    }

    rocket
        .attach(Template::fairing())
        .attach(CleanupFairing)
        .attach(FlashQueueFairing)
}
