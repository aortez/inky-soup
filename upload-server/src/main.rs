#[macro_use] extern crate rocket;

use rocket_dyn_templates::Template;
use rocket::form::{Context};
use rocket::fs::{FileServer, relative};

#[get("/")]
fn hello() -> &'static str {
    "Hello, world!"
}

#[get("/upload")]
fn upload() -> Template {
    Template::render("index", &Context::default())
}

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![hello, upload])
        .attach(Template::fairing())
        .mount("/", FileServer::from(relative!("/static")))
}
