#[macro_use] extern crate rocket;

mod cache_worker;
mod metadata;

use glob::glob;

use rocket_dyn_templates::Template;
use rocket::form::{Form, Contextual};
use rocket::fs::{FileServer, TempFile};
use rocket::http::{ContentType, Status};
use rocket::serde::json::Json;
use rocket::serde::Serialize;
use rocket::State;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use cache_worker::{CacheSender, CacheRequest, CacheWorkerFairing};

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

/// Response for apply filter endpoint.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ApplyFilterResponse {
    success: bool,
    message: String,
}

/// API endpoint to apply a filter to an image and regenerate its cache.
#[post("/api/apply-filter", data = "<form>")]
fn apply_filter(form: Form<ApplyFilterForm>) -> Json<ApplyFilterResponse> {
    let filename = &form.filename;
    let filter_name = &form.filter;

    let original_path = format!("static/images/{}", filename);
    if !Path::new(&original_path).exists() {
        return Json(ApplyFilterResponse {
            success: false,
            message: format!("Image not found: {}", filename),
        });
    }

    // Save filter preference.
    metadata::set_filter_for_image(filename, filter_name);

    // Regenerate cache with new filter.
    let filter_type = metadata::parse_filter(filter_name);
    match cache_worker::create_cached_image(Path::new(&original_path), filter_type) {
        Ok(()) => Json(ApplyFilterResponse {
            success: true,
            message: format!("Cache regenerated with {} filter", filter_name),
        }),
        Err(e) => Json(ApplyFilterResponse {
            success: false,
            message: format!("Failed to create cache: {}", e),
        }),
    }
}

#[derive(FromForm)]
struct ApplyFilterForm {
    filename: String,
    filter: String,
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
async fn submit_delete_image<'r>(mut form: Form<Contextual<'r, SubmitDeleteImage>>) -> (Status, Template) {

    let mut errors: Vec<String> = Vec::new();
    let mut messages: Vec<String> = Vec::new();

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
                    messages.push(format!("Successfully removed image: {}", submission.submission.image_file_path.clone()));
                },
                Err(e) => {
                    println!("{:#?}", e);
                    errors.push(format!("A very sad error: {}", e));
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
            errors.push("it is broke".to_string());
        }
    };

    let template = Template::render("index", &TemplateContext {
            images: get_gallery_images(),
            values: messages,
            errors: errors,
    });

    (form.context.status(), template)
}

#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(mut form: Form<Contextual<'r, SubmitFlashImage>>) -> (Status, Template) {
    println!("form: {:#?}", form);
    let template = match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            // Saturation param.
            let saturation = &submission.submission.saturation;

            // Use cached image if available, otherwise create it first.
            let original_path = format!("static/{}", submission.submission.image_file_path.clone());
            let cache_path = cache_worker::get_cache_path(&original_path);

            // Get the filter preference for this image.
            let filename = Path::new(&original_path)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("unknown");
            let filter_name = metadata::get_filter_for_image(filename);
            let filter_type = metadata::parse_filter(&filter_name);

            let image_file = if Path::new(&cache_path).exists() {
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

            // Run image update script to flash image to display.
            let mut flash_command = Command::new("python3");
            flash_command.arg("./update-image.py")
                .arg(&image_file)
                .arg(saturation.to_string());

            let status = flash_command.status()
                .expect("failed to execute flash command");

            if !status.success() {
                let exit_code = status.code().unwrap_or(-1);
                println!("flash command failed with exit code: {}", exit_code);
                return (Status::InternalServerError, Template::render("index", &TemplateContext {
                    images: get_gallery_images(),
                    values: vec![],
                    errors: vec![format!("Flash failed with exit code: {}", exit_code)],
                }));
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
                    return (Status::InternalServerError, Template::render("index", &TemplateContext {
                        images: get_gallery_images(),
                        values: vec![],
                        errors: vec![format!("Second flash failed with exit code: {}", exit_code)],
                    }));
                }
            }

            Template::render("success", &form.context)
        }
        None => {
            let errors: Vec<String> = form.context.errors()
                .map(|e| e.to_string())
                .collect();
            Template::render("index", &TemplateContext {
                images: get_gallery_images(),
                values: vec![],
                errors,
            })
        }
    };

    (form.context.status(), template)
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(
    cache_sender: &State<CacheSender>,
    mut form: Form<Contextual<'r, SubmitNewImage<'r>>>
) -> (Status, Template) {
    let template = match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            let file = &mut submission.submission.file;
            println!("file name: {:#?}", file.raw_name());

            // Save as new image in gallery.
            let image_file_path = format!("static/images/{}", file.raw_name().unwrap().dangerous_unsafe_unsanitized_raw());
            println!("image_file_path: {}", image_file_path);
            let gallery_result = file.copy_to(image_file_path.clone()).await;
            println!("image_file_path: {}, gallery_result: {:#?}", image_file_path, gallery_result);

            // Queue cached 600x448 version creation in background.
            let messages = vec![format!("Upload successful! Uploaded: {:#?}", file.raw_name().unwrap().dangerous_unsafe_unsanitized_raw())];
            let errors = vec![];

            // Send to background worker - don't block on cache creation.
            let default_filter = metadata::default_filter_name().to_string();
            if let Err(e) = cache_sender.send(CacheRequest::CreateCache(PathBuf::from(&image_file_path), default_filter)).await {
                println!("Failed to queue cache creation: {}", e);
            } else {
                println!("Queued background cache creation for: {}", image_file_path);
            }

            Template::render("index", &TemplateContext {
                images: get_gallery_images(),
                values: messages,
                errors,
            })
        }
        None => {
            let errors: Vec<String> = form.context.errors()
                .map(|e| e.to_string())
                .collect();
            Template::render("index", &TemplateContext {
                images: get_gallery_images(),
                values: vec![],
                errors,
            })
        }
    };

    (form.context.status(), template)
}

#[launch]
fn rocket() -> _ {
    let create_result = fs::create_dir_all("static/images/");
    println!("Created images directory: {:#?}", create_result);

    let cache_result = fs::create_dir_all("static/images/cache/");
    println!("Created cache directory: {:#?}", cache_result);

    rocket::build()
        .attach(CacheWorkerFairing)
        .mount("/", routes![
            apply_filter,
            cache_status,
            preview_image,
            submit_delete_image,
            submit_flash_image,
            submit_new_image,
            upload_form
        ])
        .mount("/", FileServer::from("static"))
        .attach(Template::fairing())
}
