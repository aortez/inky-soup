#[macro_use] extern crate rocket;

use rocket_dyn_templates::Template;
use rocket::form::{Form, Contextual, Context};
use rocket::fs::{FileServer, TempFile};
use rocket::http::{ContentType, Status};

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

#[get("/")]
fn upload_form() -> Template {
    Template::render("index", &Context::default())
}

#[post("/", data = "<form>")]
async fn submit<'r>(mut form: Form<Contextual<'r, Submit<'r>>>) -> (Status, Template) {
    let template = match form.value {
        Some(ref mut submission) => {
            println!("submission: {:#?}", submission);

            let file = &mut submission.submission.file;
            println!("file name: {:#?}", file.raw_name());

            // Save file to disk.
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
