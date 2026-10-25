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
async fn orientation_api_preserves_jobs_and_recovers_after_restart() {
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
                    submit_flash_image,
                    photo_rotation::update_photo_rotation,
                    test_card::flash_test_card
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
    drop(changed);
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
    check_photo_rotation_and_cards(&client, &queue).await;
    prepare_rotation_retry(&client).await;
    // Restart with the real startup path: the old in-memory queue is gone,
    // so its immutable snapshots must not accumulate on persistent storage.
    let metadata_before = fs::read(config::metadata_dir().join("photo.png.json")).unwrap();
    drop(client);
    drop(queue);
    assert!(Path::new(&job.dithered_path).exists());
    let restarted = Client::tracked(rocket()).await.unwrap();
    let status = restarted
        .get("/api/flash/status")
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(status["queue_length"], 0);
    assert!(status["current_job"].is_null());
    assert!(!Path::new(&job.dithered_path).exists());
    assert_eq!(
        fs::read(config::original_path("photo.png")).unwrap(),
        b"original"
    );
    assert_eq!(
        fs::read(config::metadata_dir().join("photo.png.json")).unwrap(),
        metadata_before
    );
    assert_eq!(
        display_settings::load_runtime_settings().rotation_revision,
        2
    );
    check_rotation_retry_after_restart(&restarted).await;
    drop(restarted);
    fs::remove_dir_all(root).unwrap();
}

async fn check_photo_rotation_and_cards(client: &Client, queue: &FlashQueueState) {
    let rotate = |degrees, revision, session: &str| {
        json!({"filename":"photo.png", "session_id":session,
        "photo_rotation_degrees":degrees,"expected_revision":revision})
        .to_string()
    };
    for (degrees, revision, session, status) in [
        (45, 0, "editor", Status::BadRequest),
        (90, 0, "other", Status::Forbidden),
        (90, 0, "editor", Status::Ok),
        (180, 0, "editor", Status::Conflict),
    ] {
        assert_eq!(
            client
                .post("/api/settings/photo-rotation")
                .header(ContentType::JSON)
                .body(rotate(degrees, revision, session))
                .dispatch()
                .await
                .status(),
            status
        );
    }
    let meta = metadata::get_all_metadata("photo.png");
    assert_eq!(meta.photo_rotation_degrees, 90);
    assert_eq!(meta.photo_rotation_revision, 1);
    assert_eq!(meta.filter, "lanczos");
    assert_eq!(meta.brightness, 25);
    assert_eq!(
        fs::read(config::original_path("photo.png")).unwrap(),
        b"original"
    );
    for revision in [0, 1] {
        for endpoint in ["cache", "thumb", "dithered"] {
            let (kind, body) = multipart(
                &[
                    ("filename", "photo.png".into()),
                    ("session_id", "editor".into()),
                    ("rotation_revision", "2".into()),
                    ("photo_rotation_revision", revision.to_string()),
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
                .header(kind)
                .body(body)
                .dispatch()
                .await;
            assert_eq!(
                response.into_json::<Value>().await.unwrap()["success"],
                revision == 1
            );
        }
        let gallery = client
            .get("/api/images")
            .dispatch()
            .await
            .into_json::<Value>()
            .await
            .unwrap();
        assert_eq!(gallery[0]["needs_processing"], revision == 0);
        assert_eq!(gallery[0]["photo_rotation_degrees"], 90);
    }
    for revision in [0, 1] {
        let (kind, body) = multipart(
            &[
                ("submission.filename", "photo.png".into()),
                ("submission.image_file_path", "ignored".into()),
                ("submission.session_id", "editor".into()),
                ("submission.flash_twice", "false".into()),
                ("submission.rotation_revision", "2".into()),
                ("submission.photo_rotation_revision", revision.to_string()),
            ],
            false,
        );
        assert_eq!(
            client
                .post("/flash")
                .header(kind)
                .body(body)
                .dispatch()
                .await
                .status(),
            if revision == 0 {
                Status::Conflict
            } else {
                Status::Ok
            }
        );
    }
    let photo_job = queue.lock().await.get_queued_jobs().last().unwrap().clone();
    // Returning to the original angle still invalidates every previous render.
    assert_eq!(
        client
            .post("/api/settings/photo-rotation")
            .header(ContentType::JSON)
            .body(rotate(0, 1, "editor"))
            .dispatch()
            .await
            .status(),
        Status::Ok
    );
    assert_eq!(
        metadata::get_all_metadata("photo.png").photo_rotation_revision,
        2
    );
    assert_eq!(
        fs::read(&photo_job.dithered_path).unwrap(),
        b"prepared pixels"
    );
    for path in [
        config::cache_path("photo.png"),
        config::thumb_path("photo.png"),
        config::dithered_path("photo.png"),
    ] {
        assert!(!path.exists());
    }
    let before = get_gallery_images().len();
    let snapshots = || fs::read_dir(config::flash_jobs_dir()).unwrap().count();
    let count = snapshots();
    // The route checks PNG type/dimensions; pixel decoding stays in the display driver.
    let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    header.extend(1600u32.to_be_bytes());
    header.extend(1200u32.to_be_bytes());
    for (revision, valid, status) in [
        (1, true, Status::Conflict),
        (2, false, Status::BadRequest),
        (2, true, Status::Ok),
    ] {
        let (kind, body) = multipart(&[("rotation_revision", revision.to_string())], true);
        let mut body = body.into_bytes();
        let start = body
            .windows(b"prepared pixels".len())
            .position(|window| window == b"prepared pixels")
            .unwrap();
        if valid {
            body.splice(start..start + b"prepared pixels".len(), header.clone());
        }
        assert_eq!(
            client
                .post("/api/flash-test-card")
                .header(kind)
                .body(body)
                .dispatch()
                .await
                .status(),
            status
        );
        assert_eq!(snapshots(), count + usize::from(status == Status::Ok));
    }
    assert_eq!(get_gallery_images().len(), before);
    let card = queue.lock().await.get_queued_jobs().last().unwrap().clone();
    assert_eq!(card.filename, "orientation-test-card.png");
    assert_eq!(card.rotation_degrees, 180);
    assert!(!card.flash_twice);
    assert_eq!(fs::read(&card.dithered_path).unwrap(), header);
}

async fn rotation_operation(
    client: &Client,
    id: Option<&str>,
    degrees: u16,
    revision: u64,
    session: &str,
) -> (Status, Value) {
    let response = client
        .post("/api/settings/photo-rotation")
        .header(ContentType::JSON)
        .body(
            json!({"filename":"retry.png","session_id":session,"operation_id":id,
            "photo_rotation_degrees":degrees,"expected_revision":revision})
            .to_string(),
        )
        .dispatch()
        .await;
    let status = response.status();
    (status, response.into_json::<Value>().await.unwrap())
}

async fn prepare_rotation_retry(client: &Client) {
    fs::write(config::original_path("retry.png"), b"retry original").unwrap();
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    image_locks::try_acquire_lock(locks, "retry.png", "before-restart", false)
        .await
        .unwrap();
    assert_eq!(
        rotation_operation(client, Some("op-1"), 90, 0, "before-restart")
            .await
            .0,
        Status::Ok
    );
    // Simulate lost acknowledgement; preserve saved pixels across a repeated request.
    fs::write(config::dithered_path("retry.png"), b"already prepared").unwrap();
}

async fn check_rotation_retry_after_restart(client: &Client) {
    assert_eq!(
        rotation_operation(client, Some("op-1"), 90, 0, "after-restart")
            .await
            .0,
        Status::Forbidden
    );
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    image_locks::try_acquire_lock(locks, "retry.png", "after-restart", false)
        .await
        .unwrap();
    let (status, replayed) = rotation_operation(client, Some("op-1"), 90, 0, "after-restart").await;
    assert_eq!(status, Status::Ok);
    assert_eq!(replayed["photo_rotation_revision"], 1);
    assert_eq!(replayed["replayed"], true);
    assert_eq!(
        fs::read(config::dithered_path("retry.png")).unwrap(),
        b"already prepared"
    );
    for (id, degrees, revision) in [
        (Some("op-1"), 180, 0),
        (Some("op-1"), 90, 1),
        (Some("different"), 90, 0),
        (None, 90, 0),
    ] {
        assert_eq!(
            rotation_operation(client, id, degrees, revision, "after-restart")
                .await
                .0,
            Status::Conflict
        );
    }
    assert_eq!(
        rotation_operation(client, Some(""), 90, 1, "after-restart")
            .await
            .0,
        Status::BadRequest
    );
    // A later accepted operation, even a no-op, supersedes the recovery receipt.
    assert_eq!(
        rotation_operation(client, Some("op-2"), 90, 1, "after-restart")
            .await
            .0,
        Status::Ok
    );
    assert_eq!(
        rotation_operation(client, Some("op-1"), 90, 0, "after-restart")
            .await
            .0,
        Status::Conflict
    );
    assert_eq!(
        rotation_operation(client, Some("op-3"), 180, 1, "after-restart")
            .await
            .0,
        Status::Ok
    );
    assert_eq!(
        rotation_operation(client, Some("op-2"), 90, 1, "after-restart")
            .await
            .0,
        Status::Conflict
    );
    // Requests from older clients cannot leave behind a replayable stale receipt.
    assert_eq!(
        rotation_operation(client, None, 180, 2, "after-restart")
            .await
            .0,
        Status::Ok
    );
    assert!(metadata::get_all_metadata("retry.png")
        .photo_rotation_operation
        .is_none());
    assert_eq!(
        rotation_operation(client, Some("op-3"), 180, 1, "after-restart")
            .await
            .0,
        Status::Conflict
    );
    assert_eq!(
        fs::read(config::original_path("retry.png")).unwrap(),
        b"retry original"
    );
}
