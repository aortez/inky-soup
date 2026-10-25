use super::*;
use rocket::http::ContentType;
use rocket::local::asynchronous::Client;
use serde_json::{json, Value};

fn multipart(fields: &[(&str, String)], file: bool) -> (ContentType, String) {
    let mut body = String::new();
    for (name, value) in fields {
        body.push_str(&format!(
            "--boundary\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ));
    }
    if file {
        body.push_str("--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.png\"\r\nContent-Type: image/png\r\n\r\nprepared pixels\r\n");
    }
    body.push_str("--boundary--\r\n");
    (
        ContentType::parse_flexible("multipart/form-data; boundary=boundary").unwrap(),
        body,
    )
}

#[rocket::async_test]
async fn orientation_api_preserves_queued_pixels_and_rejects_old_uploads() {
    let root = std::env::temp_dir().join(format!("inky-orientation-api-{}", std::process::id()));
    std::env::set_var("INKY_SOUP_IMAGES_DIR", root.join("images"));
    std::env::set_var("INKY_SOUP_DATA_DIR", &root);
    for dir in config::required_dirs() {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(config::original_path("photo.png"), b"original").unwrap();
    metadata::save_all_settings("photo.png", "lanczos", "cover", 0.7, 25, -20, "atkinson");
    for path in [
        config::cache_path("photo.png"),
        config::thumb_path("photo.png"),
        config::dithered_path("photo.png"),
    ] {
        fs::write(path, b"old pixels").unwrap();
    }
    let locks: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));
    image_locks::try_acquire_lock(&locks, "photo.png", "editor", false)
        .await
        .unwrap();
    let queue: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));
    let client = Client::tracked(
        rocket::build()
            .manage(browser_access::BrowserAccess::from_env())
            .manage(orientation::OrientationState::default())
            .manage(locks)
            .manage(queue.clone())
            .mount(
                "/",
                routes![
                    display_config,
                    gallery_images,
                    orientation::update_display_rotation,
                    upload_cache,
                    upload_thumb,
                    upload_dithered,
                    submit_flash_image
                ],
            ),
    )
    .await
    .unwrap();

    let changed = client
        .post("/api/settings/display-rotation")
        .header(ContentType::JSON)
        .body(json!({"rotation_degrees":90,"expected_revision":0}).to_string())
        .dispatch()
        .await;
    assert_eq!(changed.status(), Status::Ok);
    let result = changed.into_json::<Value>().await.unwrap();
    assert_eq!(result["display"]["width"], 1200);
    assert_eq!(result["display"]["height"], 1600);
    assert_eq!(result["pending_images"], 1);
    assert_eq!(metadata::get_all_metadata("photo.png").brightness, 25);
    for revision in [0, 1] {
        for endpoint in ["cache", "thumb", "dithered"] {
            let (content_type, body) = multipart(
                &[
                    ("filename", "photo.png".into()),
                    ("session_id", "editor".into()),
                    ("rotation_revision", revision.to_string()),
                    ("filter", "lanczos".into()),
                    ("fit_mode", "cover".into()),
                    ("saturation", "0.7".into()),
                    ("brightness", "25".into()),
                    ("contrast", "-20".into()),
                    ("dither_algorithm", "atkinson".into()),
                ],
                true,
            );
            let response = client
                .post(format!("/api/upload-{endpoint}"))
                .header(content_type)
                .body(body)
                .dispatch()
                .await;
            assert_eq!(
                response.into_json::<Value>().await.unwrap()["success"],
                revision == 1
            );
        }
        if revision == 0 {
            assert!(!config::dithered_path("photo.png").exists());
        }
    }
    let (content_type, body) = multipart(
        &[
            ("submission.filename", "photo.png".into()),
            ("submission.image_file_path", "ignored".into()),
            ("submission.session_id", "editor".into()),
            ("submission.flash_twice", "false".into()),
            ("submission.rotation_revision", "1".into()),
        ],
        false,
    );
    assert_eq!(
        client
            .post("/flash")
            .header(content_type.clone())
            .body(body.clone())
            .dispatch()
            .await
            .status(),
        Status::Ok
    );
    let job = queue.lock().await.get_queued_jobs()[0].clone();
    assert_eq!(job.rotation_degrees, 90);
    assert_ne!(
        std::path::Path::new(&job.dithered_path),
        config::dithered_path("photo.png")
    );
    let changed = client
        .post("/api/settings/display-rotation")
        .header(ContentType::JSON)
        .body(json!({"rotation_degrees":180,"expected_revision":1}).to_string())
        .dispatch()
        .await;
    assert_eq!(changed.status(), Status::Ok);
    assert_eq!(fs::read(&job.dithered_path).unwrap(), b"prepared pixels");
    assert!(!config::dithered_path("photo.png").exists());
    assert_eq!(
        client
            .post("/flash")
            .header(content_type)
            .body(body)
            .dispatch()
            .await
            .status(),
        Status::Conflict
    );
    assert_eq!(
        display_settings::load_runtime_settings().rotation_degrees,
        180
    );
    assert_eq!(
        display_settings::load_runtime_settings().rotation_revision,
        2
    );
    fs::remove_dir_all(root).unwrap();
}
