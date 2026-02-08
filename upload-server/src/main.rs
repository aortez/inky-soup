#[macro_use]
extern crate rocket;

mod cache_worker;
mod cleanup;
mod config;
mod derived_assets;
mod display_settings;
mod flash_queue;
mod image_locks;
mod metadata;

use glob::glob;
use log::{debug, error, info, warn};

use rocket::fairing::{Fairing, Info, Kind};
use rocket::form::{Contextual, Form};
use rocket::fs::{FileServer, TempFile};
use rocket::http::Status;
use rocket::response::Redirect;
use rocket::serde::json::Json;
use rocket::serde::{Deserialize, Serialize};
use rocket::{Rocket, State};
use rocket_dyn_templates::Template;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

use derived_assets::{invalidate_all_derived_assets, DerivedAssetCounts};
use flash_queue::{FlashJob, FlashQueue, FlashQueueState};
use image_locks::ImageLocksState;

#[derive(Debug, FromForm)]
struct DeleteSubmission {
    image_file_path: String,
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
    errors: Vec<String>,
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
    // Logical dimensions (after applying rotation). Kept as canonical and legacy fields.
    width: u32,
    height: u32,
    thumb_width: u32,
    thumb_height: u32,
    logical_width: u32,
    logical_height: u32,
    logical_thumb_width: u32,
    logical_thumb_height: u32,
    // Physical panel dimensions from base display config.
    physical_width: u32,
    physical_height: u32,
    physical_thumb_width: u32,
    physical_thumb_height: u32,
    rotation_degrees: u16,
    model: String,
    color: String,
}

#[derive(Debug)]
struct BaseDisplayConfig {
    width: u32,
    height: u32,
    thumb_width: u32,
    thumb_height: u32,
    model: String,
    color: String,
}

/// Read display configuration from /etc/inky-soup/display.conf.
/// Falls back to 13.3" Inky Impression 2025 defaults if file doesn't exist.
fn get_display_config() -> DisplayConfig {
    let config_path = "/etc/inky-soup/display.conf";

    // Default values for 13.3" Inky Impression 2025.
    let mut base = BaseDisplayConfig {
        width: 1600,
        height: 1200,
        thumb_width: 150,
        thumb_height: 112,
        model: "impression-13.3-2025".to_string(),
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
                            base.width = v;
                        }
                    }
                    "DISPLAY_HEIGHT" => {
                        if let Ok(v) = value.parse() {
                            base.height = v;
                        }
                    }
                    "THUMB_WIDTH" => {
                        if let Ok(v) = value.parse() {
                            base.thumb_width = v;
                        }
                    }
                    "THUMB_HEIGHT" => {
                        if let Ok(v) = value.parse() {
                            base.thumb_height = v;
                        }
                    }
                    "DISPLAY_MODEL" => {
                        base.model = value.to_string();
                    }
                    "DISPLAY_COLOR" => {
                        base.color = value.to_string();
                    }
                    _ => {}
                }
            }
        }
        debug!(
            "Loaded display config from {}: {}x{}",
            config_path, base.width, base.height
        );
    } else {
        debug!(
            "Using default display config ({}x{})",
            base.width, base.height
        );
    }

    let rotation_degrees = display_settings::load_rotation_degrees();
    let (logical_width, logical_height) =
        display_settings::compute_logical_dimensions(base.width, base.height, rotation_degrees);
    let (logical_thumb_width, logical_thumb_height) = display_settings::compute_logical_dimensions(
        base.thumb_width,
        base.thumb_height,
        rotation_degrees,
    );

    DisplayConfig {
        // Legacy fields continue to represent logical dimensions.
        width: logical_width,
        height: logical_height,
        thumb_width: logical_thumb_width,
        thumb_height: logical_thumb_height,
        logical_width,
        logical_height,
        logical_thumb_width,
        logical_thumb_height,
        physical_width: base.width,
        physical_height: base.height,
        physical_thumb_width: base.thumb_width,
        physical_thumb_height: base.thumb_height,
        rotation_degrees,
        model: base.model,
        color: base.color,
    }
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

    let glob_pattern = format!("{}/*", config::IMAGES_DIR.display());
    for entry in glob(&glob_pattern).expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                // Skip directories and non-image files.
                if path.is_dir() {
                    continue;
                }

                let filename = path
                    .file_name()
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
                    path: image_path,
                    filename,
                    thumb_ready,
                    filter: meta.filter,
                    fit_mode: meta.fit_mode,
                    cache_version: meta.cache_version,
                    saturation: meta.saturation,
                    brightness: meta.brightness,
                    contrast: meta.contrast,
                    dither_algorithm: meta.dither_algorithm,
                });
            }
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

#[derive(Debug, Deserialize)]
#[serde(crate = "rocket::serde")]
struct UpdateDisplayRotationRequest {
    rotation_degrees: i32,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct DisplayRotationResponse {
    success: bool,
    message: String,
    rotation_degrees: u16,
    removed_assets: DerivedAssetCounts,
    regenerated_assets: DerivedAssetCounts,
    originals_to_regenerate: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ErrorResponse {
    success: bool,
    message: String,
}

fn count_original_images() -> usize {
    let mut count = 0usize;
    let glob_pattern = format!("{}/*", config::IMAGES_DIR.display());
    for entry in glob(&glob_pattern).expect("Failed to read glob pattern") {
        if let Ok(path) = entry {
            if path.is_dir() {
                continue;
            }

            let filename = path
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or_default();
            if filename.starts_with("metadata.json") {
                continue;
            }

            count += 1;
        }
    }

    count
}

fn create_flash_job_snapshot(source_path: &Path) -> Result<PathBuf, String> {
    let snapshots_dir = config::flash_jobs_dir();
    fs::create_dir_all(&snapshots_dir).map_err(|e| {
        format!(
            "Failed to create flash snapshot directory '{}': {}",
            snapshots_dir.display(),
            e
        )
    })?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snapshot_path = snapshots_dir.join(format!(
        "flash-job-{}-{}.png",
        std::process::id(),
        timestamp
    ));

    fs::copy(source_path, &snapshot_path).map_err(|e| {
        format!(
            "Failed to snapshot dithered image '{}' -> '{}': {}",
            source_path.display(),
            snapshot_path.display(),
            e
        )
    })?;

    Ok(snapshot_path)
}

/// API endpoint to update global display rotation setting.
#[post("/api/settings/display-rotation", data = "<request>")]
fn update_display_rotation(
    request: Json<UpdateDisplayRotationRequest>,
) -> Result<Json<DisplayRotationResponse>, (Status, Json<ErrorResponse>)> {
    let rotation_degrees = match display_settings::parse_rotation_degrees(request.rotation_degrees)
    {
        Some(value) => value,
        None => {
            return Err((
                Status::BadRequest,
                Json(ErrorResponse {
                    success: false,
                    message: "rotation_degrees must be one of 0, 90, 180, 270".to_string(),
                }),
            ));
        }
    };

    let current_rotation = display_settings::load_rotation_degrees();
    if current_rotation == rotation_degrees {
        return Ok(Json(DisplayRotationResponse {
            success: true,
            message: format!("Rotation unchanged at {}°", rotation_degrees),
            rotation_degrees,
            removed_assets: DerivedAssetCounts::default(),
            regenerated_assets: DerivedAssetCounts::default(),
            originals_to_regenerate: count_original_images(),
        }));
    }

    if let Err(e) = display_settings::save_rotation_degrees(rotation_degrees) {
        error!(
            "Failed to persist display rotation {}: {}",
            rotation_degrees, e
        );
        return Err((
            Status::InternalServerError,
            Json(ErrorResponse {
                success: false,
                message: format!("Failed to persist rotation: {}", e),
            }),
        ));
    }

    let removed_assets = invalidate_all_derived_assets(
        &config::cache_dir(),
        &config::thumbs_dir(),
        &config::dithered_dir(),
    );
    let originals_to_regenerate = count_original_images();

    Ok(Json(DisplayRotationResponse {
        success: true,
        message: format!(
            "Mount rotation updated to {}°. Cleared derived assets; reload to regenerate cache, thumbnails, and dithered outputs.",
            rotation_degrees
        ),
        rotation_degrees,
        removed_assets,
        regenerated_assets: DerivedAssetCounts::default(),
        originals_to_regenerate,
    }))
}

/// API endpoint to check if a gallery thumbnail exists.
#[get("/api/thumb-status/<filename>")]
fn thumb_status(filename: &str) -> Json<ThumbStatus> {
    let thumb_path = config::thumb_path(filename);
    let ready = thumb_path.exists();

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
    )
    .await
    {
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
    filter: String,
    fit_mode: Option<String>,
    saturation: f32,
    brightness: i32,
    contrast: i32,
    dither_algorithm: String,
    session_id: Option<String>,
    file: TempFile<'v>,
}

/// Form data for cache image upload.
#[derive(Debug, FromForm)]
struct CacheUpload<'v> {
    filename: String,
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
            warn!(
                "Rejected invalid dithered upload filename: {}",
                form.filename
            );
            return Json(UploadDitheredResponse {
                success: false,
                message: "Invalid filename".to_string(),
                path: None,
            });
        }
    };
    let filter = form.filter.clone();
    let fit_mode = form
        .fit_mode
        .clone()
        .unwrap_or_else(|| "contain".to_string());
    let fit_mode = if fit_mode == "cover" {
        "cover".to_string()
    } else {
        "contain".to_string()
    };
    let saturation = form.saturation;
    let brightness = form.brightness;
    let contrast = form.contrast;
    let dither_algorithm = form.dither_algorithm.clone();
    let session_id = form.session_id.as_deref();

    info!(
        "Upload dithered: {} (filter: {}, fit: {}, sat: {}, bright: {}, contrast: {}, dither: {}, session: {:?})",
        filename, filter, fit_mode, saturation, brightness, contrast, dither_algorithm, session_id
    );

    if let Some(session_id) = session_id {
        // Verify lock ownership when this is an interactive edit flow.
        let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, session_id)
            .await
            .unwrap_or(false);

        if !has_lock {
            warn!(
                "Upload dithered denied for {}: session {} does not own lock",
                filename, session_id
            );
            return Json(UploadDitheredResponse {
                success: false,
                message: "You do not have edit access to this image".to_string(),
                path: None,
            });
        }
    }

    // Save dithered image to dithered directory (always as PNG).
    let dithered_path = config::dithered_path(&filename);

    match form.file.copy_to(&dithered_path).await {
        Ok(()) => {
            // Store all settings in metadata.
            info!(
                "Saving metadata for {}: filter={}, fit={}, sat={}, bright={}, contrast={}, dither={}",
                filename, filter, fit_mode, saturation, brightness, contrast, dither_algorithm
            );
            metadata::save_dither_settings(
                &filename,
                &filter,
                &fit_mode,
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
            warn!(
                "Upload cache denied for {}: session {} does not own lock",
                filename, sid
            );
            return Json(UploadCacheResponse {
                success: false,
                message: "You do not have edit access to this image".to_string(),
                path: None,
            });
        }
    }

    // Save cache image to cache directory.
    let cache_path = config::cache_path(&filename);

    match form.file.copy_to(&cache_path).await {
        Ok(()) => {
            // Save settings if any are provided.
            if filter.is_some()
                || fit_mode.is_some()
                || saturation.is_some()
                || brightness.is_some()
                || contrast.is_some()
                || dither_algorithm.is_some()
            {
                // Load current metadata to preserve any settings not provided.
                let current = metadata::get_all_metadata(&filename);

                let final_filter = filter.as_deref().unwrap_or(&current.filter);
                let final_fit_mode = fit_mode.as_deref().unwrap_or(&current.fit_mode);
                let final_saturation = saturation.unwrap_or(current.saturation);
                let final_brightness = brightness.unwrap_or(current.brightness);
                let final_contrast = contrast.unwrap_or(current.contrast);
                let final_dither = dither_algorithm
                    .as_deref()
                    .unwrap_or(&current.dither_algorithm);

                info!(
                    "Saving metadata for {}: filter={}, fit={}, sat={}, bright={}, contrast={}, dither={}",
                    filename, final_filter, final_fit_mode, final_saturation, final_brightness, final_contrast, final_dither
                );

                metadata::save_all_settings(
                    &filename,
                    final_filter,
                    final_fit_mode,
                    final_saturation,
                    final_brightness,
                    final_contrast,
                    final_dither,
                );

                // Remove dithered file if it exists since cache changed.
                let dithered_path = config::dithered_path(&filename);
                if dithered_path.exists() {
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
            warn!(
                "Rejected invalid thumbnail upload filename: {}",
                form.filename
            );
            return Json(UploadThumbResponse {
                success: false,
                message: "Invalid filename".to_string(),
                path: None,
            });
        }
    };
    debug!("Saving gallery thumbnail: {}", filename);

    // Save thumbnail to thumbs directory.
    let thumb_path = config::thumb_path(&filename);

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

    Template::render(
        "index",
        &TemplateContext {
            images: get_gallery_images(),
            values: vec![
                "Upload images, then select them from the Gallery to Flash to the screen."
                    .to_string(),
            ],
            errors: vec![],
        },
    )
}

#[post("/delete", data = "<form>")]
async fn submit_delete_image<'r>(
    mut form: Form<Contextual<'r, SubmitDeleteImage>>,
) -> Result<Redirect, (Status, String)> {
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
        return Err((
            Status::InternalServerError,
            format!("Failed to delete image: {}", e),
        ));
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

    // Sanitize filename to prevent path traversal.
    let filename = match sanitize_filename(&submission.submission.filename) {
        Some(name) => name,
        None => {
            warn!(
                "Rejected invalid flash filename: {}",
                submission.submission.filename
            );
            return Err((Status::BadRequest, "Invalid filename".to_string()));
        }
    };

    // Get path from sanitized filename.
    let dithered_path = config::dithered_path(&filename);
    let flash_twice = submission.submission.flash_twice;
    let session_id = &submission.submission.session_id;

    info!(
        "Flash request received: {} (flash_twice: {}, session: {})",
        filename, flash_twice, session_id
    );

    // Verify lock ownership.
    let has_lock = image_locks::verify_lock_ownership(locks_state, &filename, session_id)
        .await
        .unwrap_or(false);

    if !has_lock {
        warn!(
            "Flash denied for {}: session {} does not own lock",
            filename, session_id
        );
        return Err((
            Status::Forbidden,
            "You do not have edit access to this image".to_string(),
        ));
    }

    // Require pre-dithered version to exist (uploaded from preview dialog).
    if !dithered_path.exists() {
        error!(
            "Flash failed for {}: pre-dithered image not found",
            filename
        );
        return Err((
            Status::NotFound,
            format!("Pre-dithered image not found: {}", filename),
        ));
    }

    // Add to queue.
    let rotation_degrees = get_display_config().rotation_degrees;
    let snapshot_path = create_flash_job_snapshot(&dithered_path).map_err(|e| {
        error!(
            "Failed to create flash snapshot for {} from {}: {}",
            filename,
            dithered_path.display(),
            e
        );
        (Status::InternalServerError, format!("Failed to queue flash job: {}", e))
    })?;
    let mut queue = queue_state.lock().await;
    let job_id = queue.enqueue(
        filename.clone(),
        snapshot_path.to_string_lossy().to_string(),
        flash_twice,
        rotation_degrees,
    );
    let queue_position = queue.get_position(job_id).unwrap_or(0);
    drop(queue);

    info!(
        "Flash job {} queued for {} at position {} (rotation: {})",
        job_id, filename, queue_position, rotation_degrees
    );

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
async fn flash_job_status(
    job_id: u64,
    queue_state: &State<FlashQueueState>,
) -> Result<Json<FlashJob>, Status> {
    let queue = queue_state.lock().await;

    if let Some(job) = queue.find_job(job_id) {
        return Ok(Json(job));
    }

    Err(Status::NotFound)
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>,
) -> Json<UploadResponse> {
    match form.value {
        Some(ref mut submission) => {
            let file = &mut submission.submission.file;

            // Get the full original filename including extension.
            // TempFile::name() strips extensions, so use raw_name() instead.
            let filename = file
                .raw_name()
                .and_then(|n| sanitize_filename(n.dangerous_unsafe_unsanitized_raw().as_str()))
                .unwrap_or_else(|| {
                    warn!("Upload has no filename, using fallback");
                    "unnamed_upload".to_string()
                });

            info!("Upload started: {}", filename);

            // Save as new image in gallery.
            let image_file_path = config::original_path(&filename);
            match file.copy_to(&image_file_path).await {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{LazyLock, Mutex as StdMutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{}_{}_{}", prefix, std::process::id(), nanos));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_update_display_rotation_rejects_invalid_values() {
        let response = update_display_rotation(Json(UpdateDisplayRotationRequest {
            rotation_degrees: 45,
        }));

        match response {
            Err((status, body)) => {
                assert_eq!(status, Status::BadRequest);
                assert!(!body.success);
                assert_eq!(
                    body.message,
                    "rotation_degrees must be one of 0, 90, 180, 270"
                );
            }
            Ok(_) => panic!("invalid rotation should return 400"),
        }
    }

    #[test]
    fn test_display_config_swaps_logical_dimensions_for_rotation_90() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_data_dir = std::env::var("INKY_SOUP_DATA_DIR").ok();
        let temp_data_dir = unique_temp_dir("inky_soup_display_config_test");
        std::env::set_var("INKY_SOUP_DATA_DIR", &temp_data_dir);

        display_settings::save_rotation_degrees(90).unwrap();
        let config = get_display_config();

        assert_eq!(config.rotation_degrees, 90);
        assert_eq!(config.width, config.physical_height);
        assert_eq!(config.height, config.physical_width);
        assert_eq!(config.thumb_width, config.physical_thumb_height);
        assert_eq!(config.thumb_height, config.physical_thumb_width);

        if let Some(value) = previous_data_dir {
            std::env::set_var("INKY_SOUP_DATA_DIR", value);
        } else {
            std::env::remove_var("INKY_SOUP_DATA_DIR");
        }
        fs::remove_dir_all(temp_data_dir).unwrap();
    }

    #[test]
    fn test_update_display_rotation_unchanged_returns_zero_removed_counts() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_data_dir = std::env::var("INKY_SOUP_DATA_DIR").ok();
        let temp_data_dir = unique_temp_dir("inky_soup_rotation_unchanged_test");
        std::env::set_var("INKY_SOUP_DATA_DIR", &temp_data_dir);

        display_settings::save_rotation_degrees(0).unwrap();
        let response = update_display_rotation(Json(UpdateDisplayRotationRequest { rotation_degrees: 0 }));
        match response {
            Ok(body) => {
                assert!(body.success);
                assert_eq!(body.rotation_degrees, 0);
                assert_eq!(body.removed_assets, DerivedAssetCounts::default());
                assert_eq!(body.regenerated_assets, DerivedAssetCounts::default());
            }
            Err(_) => panic!("unchanged rotation should succeed"),
        }

        if let Some(value) = previous_data_dir {
            std::env::set_var("INKY_SOUP_DATA_DIR", value);
        } else {
            std::env::remove_var("INKY_SOUP_DATA_DIR");
        }
        fs::remove_dir_all(temp_data_dir).unwrap();
    }

    #[test]
    fn test_create_flash_job_snapshot_copies_source_image() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_data_dir = std::env::var("INKY_SOUP_DATA_DIR").ok();
        let temp_data_dir = unique_temp_dir("inky_soup_flash_snapshot_test");
        std::env::set_var("INKY_SOUP_DATA_DIR", &temp_data_dir);

        let source_path = temp_data_dir.join("source-dithered.png");
        fs::write(&source_path, b"snapshot-test").unwrap();

        let snapshot_path = create_flash_job_snapshot(&source_path).unwrap();
        assert!(snapshot_path.exists());
        assert!(snapshot_path.starts_with(config::flash_jobs_dir()));
        assert_eq!(fs::read(&snapshot_path).unwrap(), fs::read(&source_path).unwrap());

        if let Some(value) = previous_data_dir {
            std::env::set_var("INKY_SOUP_DATA_DIR", value);
        } else {
            std::env::remove_var("INKY_SOUP_DATA_DIR");
        }
        fs::remove_dir_all(temp_data_dir).unwrap();
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

    // Run migration from legacy metadata format if needed.
    metadata::migrate_legacy_metadata();

    // Initialize flash queue state.
    let flash_queue_state: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));

    // Initialize image locks state.
    let image_locks_state: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));

    let mut rocket = rocket::build()
        .manage(flash_queue_state)
        .manage(image_locks_state)
        .mount(
            "/",
            routes![
                display_config,
                flash_job_status,
                flash_status,
                lock_image,
                submit_delete_image,
                submit_flash_image,
                submit_new_image,
                thumb_status,
                unlock_image,
                update_display_rotation,
                upload_cache,
                upload_dithered,
                upload_form,
                upload_thumb
            ],
        )
        // Use rank 10 (lower priority) for root static server so /images can take precedence.
        .mount("/", FileServer::from("static").rank(10));

    // Mount separate images FileServer only when images are outside of static/.
    let images_dir_str = config::IMAGES_DIR.to_string_lossy();
    if !images_dir_str.starts_with("static/") && !images_dir_str.starts_with("./static/") {
        info!(
            "Mounting images from external directory: {}",
            images_dir_str
        );
        // Use rank 1 (higher priority) for images.
        rocket = rocket.mount(
            "/images",
            FileServer::from(config::IMAGES_DIR.as_path()).rank(1),
        );
    }

    rocket
        .attach(Template::fairing())
        .attach(CleanupFairing)
        .attach(FlashQueueFairing)
}
