#[macro_use] extern crate rocket;

use glob::glob;

use rocket_dyn_templates::Template;
use rocket::form::{Form, Contextual};
use rocket::fs::{FileServer, TempFile};
use rocket::http::{ContentType, Status};
use rocket::serde::Serialize;

use std::env;
use std::process::Command;

const UPDATE_TEMP_FILE: &str = "inky-soup-update-image";

#[derive(Debug, FromForm)]
struct Submission<'v> {
    // TODO: validator for any image type that seems to work with the
    // flashing script.
    // #[field(validate = ext(ContentType::PNG))]
    file: TempFile<'v>,

    saturation: f32,

    flash_twice: bool,
}

#[derive(Debug, FromForm)]
struct Submit<'v> {
    submission: Submission<'v>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct TemplateContext<'r> {
    title: &'r str,
    images: Vec<String>,
    values: Vec<&'r str>,
    errors: Vec<&'r str>
}

#[get("/")]
fn upload_form() -> Template {
    let mut images: Vec<String> = Vec::new();
    for entry in glob("static/image-*").expect("Failed to read glob pattern") {
        match entry {
            Ok(path) => {
                println!("found image file {:?}", path.file_name().unwrap());
                images.push(path.file_name().unwrap().to_str().unwrap().to_string());
            },
            Err(e) => println!("{:?}", e),
        }
    }

    Template::render("index", &TemplateContext {
        title: "hideho",
        images: images,
        values: vec!["One", "Two", "Three"],
        errors: vec!["One", "Two", "Three"],
    })
}

#[post("/", data = "<form>")]
async fn submit<'r>(mut form: Form<Contextual<'r, Submit<'r>>>) -> (Status, Template) {
    let template = match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            let file = &mut submission.submission.file;
            println!("file name: {:#?}", file.raw_name());

            // Save a copy to show as the most recently uploaded image.
            let result2 = file.copy_to("static/dinosaur").await;
            println!("result2: {:#?}", result2);

            // Save file to feed to update script.
            let result = file.persist_to(env::temp_dir().join(UPDATE_TEMP_FILE)).await;
            println!("result: {:#?}", result);
            println!("wrote {} bytes at {}", file.len(), file.path().unwrap().display());

            // Saturation param.
            let saturation = &submission.submission.saturation;
            println!("saturation: {}", saturation);

            // Run image update script to flash new image to display!
            let mut flash_command = Command::new("python3");
            flash_command.arg("./update-image.py")
                .arg(env::temp_dir().join(UPDATE_TEMP_FILE))
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

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![submit, upload_form])
        .mount("/", FileServer::from("static"))
        .attach(Template::fairing())
}
