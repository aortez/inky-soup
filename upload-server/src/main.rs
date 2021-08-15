#[macro_use] extern crate rocket;

use glob::glob;

use rocket_dyn_templates::Template;
use rocket::form::{Form, Contextual};
use rocket::fs::{FileServer, TempFile};
use rocket::http::{ContentType, Status};
use rocket::serde::Serialize;

use std::env;
use std::fs;
use std::process::Command;

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
    #[field(validate = ext(ContentType::PNG))]
    file: TempFile<'v>,

    saturation: f32,

    flash_twice: bool,
}

#[derive(Debug, FromForm)]
struct SubmitNewImage<'v> {
    submission: UploadSubmission<'v>,
}

#[derive(Debug, FromForm)]
struct SubmitFlashImage {
    submission: FlashSubmission,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct TemplateContext<'r> {
    title: &'r str,
    images: Vec<String>,
    values: Vec<&'r str>,
    errors: Vec<&'r str>
}

fn get_gallery_image_paths() -> Vec<String> {
    let mut images: Vec<String> = Vec::new();
    for entry in glob("static/images/*").expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                let file_name = format!("images/{}", path.file_name().unwrap().to_str().unwrap().to_string());
                println!("found image file {}", file_name);
                images.push(file_name);
            },
            Err(e) => println!("{:?}", e),
        }
    }
    images
}

#[get("/")]
fn upload_form() -> Template {

    println!("populating list of images in gallery...");

    Template::render("index", &TemplateContext {
        title: "hideho",
        images: get_gallery_image_paths(),
        values: vec!["One", "Two", "Three"],
        errors: vec![],
    })
}

#[post("/flash", data = "<form>")]
async fn submit_flash_image<'r>(mut form: Form<Contextual<'r, SubmitFlashImage>>) -> (Status, Template) {
    println!("form: {:#?}", form);
    let template = match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            // Saturation param.
            let saturation = &submission.submission.saturation;

            // Run image update script to flash image to display!
            let mut flash_command = Command::new("python3");
            let image_file = format!("static/{}", submission.submission.image_file_path.clone());
            flash_command.arg("./update-image.py")
                .arg(image_file)
                .arg(saturation.to_string());
            flash_command.status()
                .expect("process failed to execute");

            // Maybe do it a second time.
            let flash_twice = submission.submission.flash_twice;
            if flash_twice {
                println!("flashing a second time...");
                flash_command.status()
                    .expect("process failed to execute");
            }

            // TODO: check success of flashing, as it isn't always a success.
            Template::render("success", &form.context)
        }
        None => Template::render("index", &form.context),
    };

    (form.context.status(), template)
}

#[post("/upload", data = "<form>")]
async fn submit_new_image<'r>(mut form: Form<Contextual<'r, SubmitNewImage<'r>>>) -> (Status, Template) {
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

            Template::render("success", &form.context)
        }
        None => Template::render("index", &form.context),
    };

    (form.context.status(), template)
}

#[launch]
fn rocket() -> _ {
    let create_result = fs::create_dir_all("static/images/");
    println!("created images directory: {:#?}", create_result);

    rocket::build()
        .mount("/", routes![submit_flash_image, submit_new_image, upload_form])
        .mount("/", FileServer::from("static"))
        .attach(Template::fairing())
}
