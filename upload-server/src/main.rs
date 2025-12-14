#[macro_use] extern crate rocket;

mod cache_worker;
mod metadata;

use glob::glob;

use rocket_dyn_templates::Template;
use rocket::form::{Form, Contextual};
use rocket::fs::{FileServer, TempFile};
use rocket::http::{ContentType, Status};
use rocket::response::Redirect;
use rocket::serde::json::Json;
use rocket::serde::Serialize;

use std::fs;
use std::path::Path;
use std::process::Command;


#[derive(Debug, FromForm)]
struct DeleteSubmission {
    image_file_path: String
}

#[derive(Debug, FromForm)]
struct FlashSubmission {
    image_file_path: String,

    saturation: f32,

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
    cache_ready: bool,
    filter: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct TemplateContext {
    images: Vec<GalleryImage>,
    values: Vec<String>,
    errors: Vec<String>
}

/// Response for cache status API endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct CacheStatus {
    ready: bool,
    cache_path: String,
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
                let cache_path = format!("static/images/cache/{}.png", filename);
                let cache_ready = Path::new(&cache_path).exists();
                let filter = metadata::get_filter_for_image(&filename);

                println!("found image file {} (cache_ready: {}, filter: {})", image_path, cache_ready, filter);

                images.push(GalleryImage {
                    path: image_path,
                    filename,
                    cache_ready,
                    filter,
                });
            },
            Err(e) => println!("{:?}", e),
        }
    }
    images
}

/// API endpoint to check if a cache file exists.
#[get("/api/cache-status/<filename>")]
fn cache_status(filename: &str) -> Json<CacheStatus> {
    let cache_path = format!("static/images/cache/{}.png", filename);
    let ready = Path::new(&cache_path).exists();

    Json(CacheStatus {
        ready,
        cache_path: format!("images/cache/{}.png", filename),
    })
}

/// API endpoint to preview an image with a specific filter (without saving).
#[get("/api/preview/<filename>?<filter>")]
fn preview_image(filename: &str, filter: Option<&str>) -> Result<(ContentType, Vec<u8>), Status> {
    let filter_name = filter.unwrap_or(metadata::default_filter_name());
    let original_path = format!("static/images/{}", filename);

    if !Path::new(&original_path).exists() {
        return Err(Status::NotFound);
    }

    let filter_type = metadata::parse_filter(filter_name);

    match cache_worker::resize_image_to_bytes(Path::new(&original_path), filter_type) {
        Ok(bytes) => Ok((ContentType::PNG, bytes)),
        Err(e) => {
            println!("Preview failed: {}", e);
            Err(Status::InternalServerError)
        }
    }
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

/// API endpoint to upload a pre-dithered image.
#[post("/api/upload-dithered", data = "<form>")]
async fn upload_dithered(mut form: Form<DitheredUpload<'_>>) -> Json<UploadDitheredResponse> {
    let filename = form.filename.clone();
    let saturation = form.saturation;

    // Save dithered image to dithered directory.
    let dithered_path = format!("static/images/dithered/{}", filename);

    match form.file.copy_to(&dithered_path).await {
        Ok(()) => {
            println!("Saved dithered image: {}", dithered_path);

            // Store saturation metadata.
            metadata::set_dithered_saturation(&filename, saturation);

            Json(UploadDitheredResponse {
                success: true,
                message: format!("Dithered image uploaded successfully"),
                path: Some(format!("images/dithered/{}", filename)),
            })
        }
        Err(e) => {
            println!("Failed to save dithered image: {}", e);
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
    let filename = form.filename.clone();
    let filter = form.filter.clone();

    // Save cache image to cache directory.
    let cache_path = format!("static/images/cache/{}.png", filename);

    match form.file.copy_to(&cache_path).await {
        Ok(()) => {
            println!("Saved cache image: {}", cache_path);

            // If filter was specified, save preference and clear dithered cache.
            if let Some(ref filter_name) = filter {
                metadata::set_filter_for_image(&filename, filter_name);
                metadata::clear_dithered_cache(&filename);

                // Remove dithered file if it exists.
                let dithered_path = format!("static/images/dithered/{}", filename);
                if Path::new(&dithered_path).exists() {
                    let _ = fs::remove_file(&dithered_path);
                    println!("Removed dithered cache due to filter change: {}", dithered_path);
                }
            }

            Json(UploadCacheResponse {
                success: true,
                message: "Cache image uploaded successfully".to_string(),
                path: Some(format!("images/cache/{}.png", filename)),
            })
        }
        Err(e) => {
            println!("Failed to save cache image: {}", e);
            Json(UploadCacheResponse {
                success: false,
                message: format!("Failed to save cache image: {}", e),
                path: None,
            })
        }
    }
}

#[get("/")]
fn upload_form() -> Template {
    println!("populating list of images in gallery...");

    Template::render("index", &TemplateContext {
        images: get_gallery_images(),
        values: vec!["Welcome!".to_string()],
        errors: vec![],
    })
}

#[post("/delete", data = "<form>")]
async fn submit_delete_image<'r>(mut form: Form<Contextual<'r, SubmitDeleteImage>>) -> Redirect {

    match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            let image_file = format!("static/{}", submission.submission.image_file_path.clone());
            println!("image_file: {}", image_file);

            // Delete original.
            let remove_result = fs::remove_file(image_file.clone());
            println!("remove_result: {:#?}", remove_result);

            match remove_result {
                Ok(_e) => {
                    println!("Successfully removed image: {}", submission.submission.image_file_path.clone());
                },
                Err(e) => {
                    println!("{:#?}", e);
                    println!("A very sad error: {}", e);
                }
            }

            // Also delete cached version if it exists.
            let cache_path = cache_worker::get_cache_path(&image_file);
            if Path::new(&cache_path).exists() {
                match fs::remove_file(&cache_path) {
                    Ok(_) => println!("Removed cached image: {}", cache_path),
                    Err(e) => println!("Failed to remove cached image: {}", e),
                }
            }

            // Clean up metadata.
            let filename = Path::new(&image_file)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("");
            metadata::remove_image_metadata(filename);
        }
        None => {
            println!("Delete form validation failed");
        }
    };

    Redirect::to(uri!(upload_form))
}

#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(mut form: Form<Contextual<'r, SubmitFlashImage>>) -> Redirect {
    println!("form: {:#?}", form);
    match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            // Saturation param.
            let saturation = &submission.submission.saturation;

            // Get filename for metadata lookup.
            let original_path = format!("static/{}", submission.submission.image_file_path.clone());
            let filename = Path::new(&original_path)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("unknown");

            // Check if pre-dithered version exists.
            let dithered_path = format!("static/images/dithered/{}", filename);
            let (image_file, skip_dither) = if Path::new(&dithered_path).exists() {
                println!("Using pre-dithered image: {}", dithered_path);
                (dithered_path, true)
            } else {
                // Use cached image if available, otherwise create it first.
                let cache_path = cache_worker::get_cache_path(&original_path);

                // Get the filter preference for this image.
                let filter_name = metadata::get_filter_for_image(filename);
                let filter_type = metadata::parse_filter(&filter_name);

                let image = if Path::new(&cache_path).exists() {
                    println!("Using cached image: {}", cache_path);
                    cache_path
                } else {
                    // Synchronously create cache since we need it for flashing.
                    println!("Cache not found, creating from original: {}", original_path);
                    match cache_worker::create_cached_image(Path::new(&original_path), filter_type) {
                        Ok(()) => {
                            println!("Cache created, using: {}", cache_path);
                            cache_path
                        }
                        Err(e) => {
                            println!("Failed to create cache ({}), using original: {}", e, original_path);
                            original_path
                        }
                    }
                };

                (image, false)
            };

            // Run image update script to flash image to display.
            let mut flash_command = Command::new("python3");
            flash_command.arg("./update-image.py")
                .arg(&image_file);

            if skip_dither {
                flash_command.arg("--skip-dither");
            } else {
                flash_command.arg(saturation.to_string());
            }

            let status = flash_command.status()
                .expect("failed to execute flash command");

            if !status.success() {
                let exit_code = status.code().unwrap_or(-1);
                println!("flash command failed with exit code: {}", exit_code);
            }

            // Maybe do it a second time.
            let flash_twice = submission.submission.flash_twice;
            if flash_twice {
                println!("flashing a second time...");
                let status2 = flash_command.status()
                    .expect("failed to execute flash command");
                if !status2.success() {
                    let exit_code = status2.code().unwrap_or(-1);
                    println!("second flash command failed with exit code: {}", exit_code);
                }
            }
        }
        None => {
            let errors: Vec<String> = form.context.errors()
                .map(|e| e.to_string())
                .collect();
            println!("Flash form validation failed: {:?}", errors);
        }
    };

    Redirect::to(uri!(upload_form))
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>
) -> Redirect {
    match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            let file = &mut submission.submission.file;
            println!("file name: {:#?}", file.raw_name());

            // Save as new image in gallery.
            let image_file_path = format!("static/images/{}", file.raw_name().unwrap().dangerous_unsafe_unsanitized_raw());
            println!("image_file_path: {}", image_file_path);
            let gallery_result = file.copy_to(image_file_path.clone()).await;
            println!("image_file_path: {}, gallery_result: {:#?}", image_file_path, gallery_result);

            // Cache is now generated client-side and uploaded separately via /api/upload-cache.
        }
        None => {
            let errors: Vec<String> = form.context.errors()
                .map(|e| e.to_string())
                .collect();
            println!("Upload form validation failed: {:?}", errors);
        }
    };

    Redirect::to(uri!(upload_form))
}

#[launch]
fn rocket() -> _ {
    let create_result = fs::create_dir_all("static/images/");
    println!("Created images directory: {:#?}", create_result);

    let cache_result = fs::create_dir_all("static/images/cache/");
    println!("Created cache directory: {:#?}", cache_result);

    let dithered_result = fs::create_dir_all("static/images/dithered/");
    println!("Created dithered directory: {:#?}", dithered_result);

    rocket::build()
        .mount("/", routes![
            cache_status,
            preview_image,
            submit_delete_image,
            submit_flash_image,
            submit_new_image,
            upload_cache,
            upload_dithered,
            upload_form
        ])
        .mount("/", FileServer::from("static"))
        .attach(Template::fairing())
}
