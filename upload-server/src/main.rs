#[macro_use] extern crate rocket;

mod cache_worker;
mod cleanup;
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
use rocket::Rocket;

use std::fs;
use std::path::Path;
use tokio::process::Command;


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

                images.push(GalleryImage {
                    path: image_path,
                    filename,
                    thumb_ready,
                    filter,
                });
            },
            Err(e) => warn!("Error reading gallery entry: {:?}", e),
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
        values: vec!["Welcome!".to_string()],
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

#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(mut form: Form<Contextual<'r, SubmitFlashImage>>) -> Result<Redirect, (Status, String)> {
    let submission = match form.value {
        Some(ref mut s) => s,
        None => {
            warn!("Flash form validation failed");
            return Err((Status::BadRequest, "Invalid form submission".to_string()));
        }
    };

    // Get filename for dithered image lookup.
    let original_path = format!("static/{}", submission.submission.image_file_path.clone());
    let filename = Path::new(&original_path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("unknown");
    let flash_twice = submission.submission.flash_twice;

    info!("Flash started: {} (flash_twice: {})", filename, flash_twice);

    // Require pre-dithered version to exist (uploaded from preview dialog).
    let dithered_path = format!("static/images/dithered/{}.png", filename);
    if !Path::new(&dithered_path).exists() {
        error!("Flash failed for {}: pre-dithered image not found", filename);
        return Err((Status::NotFound, format!("Pre-dithered image not found: {}", filename)));
    }

    // Run image update script to flash pre-dithered image to display.
    debug!("Executing flash script for {}", filename);
    let output = Command::new("python3")
        .arg("./update-image.py")
        .arg(&dithered_path)
        .arg("--skip-dither")
        .output()
        .await;

    match output {
        Ok(result) => {
            if !result.status.success() {
                let exit_code = result.status.code().unwrap_or(-1);
                let stderr = String::from_utf8_lossy(&result.stderr);
                error!("Flash failed for {}: exit code {} - {}", filename, exit_code, stderr.trim());
                return Err((Status::InternalServerError, format!("Flash failed (exit code {})", exit_code)));
            }
        }
        Err(e) => {
            error!("Flash failed for {}: could not execute script - {}", filename, e);
            return Err((Status::InternalServerError, format!("Failed to run flash script: {}", e)));
        }
    }

    // Maybe do it a second time.
    if flash_twice {
        debug!("Executing second flash for {}", filename);
        let output2 = Command::new("python3")
            .arg("./update-image.py")
            .arg(&dithered_path)
            .arg("--skip-dither")
            .output()
            .await;

        match output2 {
            Ok(result) => {
                if !result.status.success() {
                    let exit_code = result.status.code().unwrap_or(-1);
                    let stderr = String::from_utf8_lossy(&result.stderr);
                    error!("Second flash failed for {}: exit code {} - {}", filename, exit_code, stderr.trim());
                    return Err((Status::InternalServerError, format!("Second flash failed (exit code {})", exit_code)));
                }
            }
            Err(e) => {
                error!("Second flash failed for {}: could not execute script - {}", filename, e);
                return Err((Status::InternalServerError, format!("Failed to run second flash: {}", e)));
            }
        }
    }

    info!("Flash completed: {}", filename);
    Ok(Redirect::to(uri!(upload_form)))
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>
) -> Redirect {
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
                }
                Err(e) => {
                    error!("Upload failed for {}: {}", filename, e);
                }
            }

            // Cache is now generated client-side and uploaded separately via /api/upload-cache.
        }
        None => {
            warn!("Upload form validation failed");
        }
    };

    Redirect::to(uri!(upload_form))
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

#[launch]
fn rocket() -> _ {
    // Ensure image directories exist.
    for dir in &["static/images", "static/images/cache", "static/images/dithered", "static/images/thumbs"] {
        if let Err(e) = fs::create_dir_all(dir) {
            error!("Failed to create directory {}: {}", dir, e);
        }
    }

    rocket::build()
        .mount("/", routes![
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
}
