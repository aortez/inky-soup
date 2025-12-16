#[macro_use] extern crate rocket;

mod cache_worker;
mod cleanup;
mod flash_queue;
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
use rocket::serde::Serialize;
use rocket::{Rocket, State};

use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

use flash_queue::{FlashJob, FlashQueue, FlashQueueState};


#[derive(Debug, FromForm)]
struct DeleteSubmission {
    image_file_path: String
}

#[derive(Debug, FromForm)]
struct FlashSubmission {
    image_file_path: String,

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
    saturation: Option<f32>,
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
    let mut existing_filenames: Vec<String> = Vec::new();

    for entry in glob("static/images/*").expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                // Skip the cache directory and metadata file.
                if path.is_dir() || path.extension().map(|e| e == "json").unwrap_or(false) {
                    continue;
                }

                let filename = path.file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("unknown")
                    .to_string();

                let image_path = format!("images/{}", filename);
                let thumb_path = format!("static/images/thumbs/{}.png", filename);
                let thumb_ready = Path::new(&thumb_path).exists();
                let filter = metadata::get_filter_for_image(&filename);
                let saturation = metadata::get_saturation_for_image(&filename);

                existing_filenames.push(filename.clone());

                images.push(GalleryImage {
                    path: image_path,
                    filename,
                    thumb_ready,
                    filter,
                    saturation,
                });
            },
            Err(e) => warn!("Error reading gallery entry: {:?}", e),
        }
    }

    // Clean up metadata for images that no longer exist.
    let metadata_filenames = metadata::get_all_filenames();
    let orphaned: Vec<String> = metadata_filenames
        .into_iter()
        .filter(|f| !existing_filenames.contains(f))
        .collect();

    if !orphaned.is_empty() {
        let removed = metadata::remove_entries(&orphaned);
        if removed > 0 {
            info!("Removed {} orphaned metadata entries", removed);
        }
    }

    debug!("Found {} images in gallery", images.len());
    images
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
    saturation: f32,
    file: TempFile<'v>,
}

/// Form data for cache image upload.
#[derive(Debug, FromForm)]
struct CacheUpload<'v> {
    filename: String,
    filter: Option<String>,
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
async fn upload_dithered(mut form: Form<DitheredUpload<'_>>) -> Json<UploadDitheredResponse> {
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
    let saturation = form.saturation;
    debug!("Saving dithered image: {} (saturation: {})", filename, saturation);

    // Save dithered image to dithered directory (always as PNG).
    let dithered_path = format!("static/images/dithered/{}.png", filename);

    match form.file.copy_to(&dithered_path).await {
        Ok(()) => {
            // Store saturation metadata.
            metadata::set_dithered_saturation(&filename, saturation);
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
async fn upload_cache(mut form: Form<CacheUpload<'_>>) -> Json<UploadCacheResponse> {
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
    let filter = form.filter.clone();
    debug!("Saving cache image: {} (filter: {:?})", filename, filter);

    // Save cache image to cache directory.
    let cache_path = format!("static/images/cache/{}.png", filename);

    match form.file.copy_to(&cache_path).await {
        Ok(()) => {
            // If filter was specified, save preference and clear dithered cache.
            if let Some(ref filter_name) = filter {
                metadata::set_filter_for_image(&filename, filter_name);
                metadata::clear_dithered_saturation(&filename);

                // Remove dithered file if it exists.
                let dithered_path = format!("static/images/dithered/{}.png", filename);
                if Path::new(&dithered_path).exists() {
                    let _ = fs::remove_file(&dithered_path);
                    debug!("Removed dithered cache due to filter change: {}", filename);
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
    metadata::remove_image_metadata(filename);

    info!("Delete completed: {}", filename);
    Ok(Redirect::to(uri!(upload_form)))
}

/// Queue a flash job (returns immediately).
#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(
    mut form: Form<Contextual<'r, SubmitFlashImage>>,
    queue_state: &State<FlashQueueState>
) -> Result<Json<FlashResponse>, (Status, String)> {
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Flash form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Get the full path to the dithered image.
    let dithered_path = format!("static/{}", submission.submission.image_file_path.clone());
    let filename = Path::new(&dithered_path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("unknown")
        .to_string();
    let flash_twice = submission.submission.flash_twice;

    info!("Flash request received: {} (flash_twice: {})", filename, flash_twice);

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
    for dir in &["static/images", "static/images/cache", "static/images/dithered", "static/images/thumbs"] {
        if let Err(e) = fs::create_dir_all(dir) {
            error!("Failed to create directory {}: {}", dir, e);
        }
    }

    // Initialize flash queue state.
    let flash_queue_state: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));

    rocket::build()
        .manage(flash_queue_state)
        .mount("/", routes![
            flash_job_status,
            flash_status,
            submit_delete_image,
            submit_flash_image,
            submit_new_image,
            thumb_status,
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
