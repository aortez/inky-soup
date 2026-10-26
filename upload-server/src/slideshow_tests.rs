// Reuses the server API fixture: image paths are process-wide LazyLocks.
use super::*;
use crate::orientation_tests::multipart;
use rocket::{http::ContentType, local::asynchronous::Client};
use serde_json::{json, Value};

async fn slideshow_status(client: &Client) -> Value {
    client
        .get("/api/slideshow")
        .dispatch()
        .await
        .into_json()
        .await
        .unwrap()
}

pub(crate) async fn check_slideshow_api_and_worker(client: &Client) {
    use slideshow::{inspect_or_tick, FlashSource, SlideshowState};
    let state = client.rocket().state::<SlideshowState>().unwrap();
    let orientation = client
        .rocket()
        .state::<orientation::OrientationState>()
        .unwrap();
    let queue = client.rocket().state::<FlashQueueState>().unwrap();
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    locks.lock().await.clear();
    let initial = slideshow_status(client).await;
    assert_eq!(initial["paused_reason"], "disabled");
    for hours in [0, 169] {
        assert_eq!(
            client
                .post("/api/settings/slideshow")
                .header(ContentType::JSON)
                .body(json!({"rotation_enabled":true,"rotation_interval_hours":hours}).to_string())
                .dispatch()
                .await
                .status(),
            Status::BadRequest
        );
    }
    // The completion fields are read-only, including to clients on the local LAN.
    assert_eq!(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .body(r#"{"rotation_anchor_at":0}"#)
            .dispatch()
            .await
            .status(),
        Status::UnprocessableEntity
    );
    assert_eq!(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .header(rocket::http::Header::new("Origin", "https://evil.example"))
            .body(r#"{"rotation_enabled":true}"#)
            .dispatch()
            .await
            .status(),
        Status::Forbidden
    );
    assert_eq!(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .body(r#"{"rotation_enabled":true,"rotation_interval_hours":1}"#)
            .dispatch()
            .await
            .status(),
        Status::Ok
    );
    assert_eq!(
        slideshow_status(client).await["paused_reason"],
        "no_favorites"
    );
    let revision = display_settings::load_runtime_settings().rotation_revision;
    for filename in ["slideshow-a.png", "slideshow-b.png", "slideshow-c.png"] {
        fs::write(config::original_path(filename), b"original").unwrap();
        assert!(!metadata::get_all_metadata(filename).favorite);
        image_locks::try_acquire_lock(locks, filename, "favorites", false)
            .await
            .unwrap();
        for (session, expected) in [("wrong", Status::Forbidden), ("favorites", Status::Ok)] {
            let result = client
                .post("/api/settings/favorite")
                .header(ContentType::JSON)
                .body(json!({"filename":filename,"session_id":session,"favorite":true}).to_string())
                .dispatch()
                .await;
            assert_eq!(result.status(), expected);
        }
        let mut meta = metadata::get_all_metadata(filename);
        assert!(meta.favorite);
        meta.cache_rotation_revision = revision;
        meta.thumb_rotation_revision = revision;
        meta.dither_rotation_revision = revision;
        metadata::try_save_metadata(filename, &meta).unwrap();
        for path in [
            config::cache_path(filename),
            config::thumb_path(filename),
            config::dithered_path(filename),
        ] {
            fs::write(path, filename.as_bytes()).unwrap();
        }
        image_locks::release_lock(locks, filename, "favorites")
            .await
            .unwrap();
    }
    // A stale favorite is skipped; all other favorites remain eligible.
    let mut stale = metadata::get_all_metadata("slideshow-b.png");
    stale.dither_photo_revision = 99;
    metadata::try_save_metadata("slideshow-b.png", &stale).unwrap();
    let gallery = client
        .get("/api/images")
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert!(gallery
        .as_array()
        .unwrap()
        .iter()
        .any(|image| image["filename"] == "slideshow-a.png" && image["favorite"] == true));
    state.lock().await.content_completed(0).unwrap();
    let now = flash_queue::current_time_millis();
    image_locks::try_acquire_lock(locks, "unrelated.png", "editor", false)
        .await
        .unwrap();
    let tick = inspect_or_tick(state, orientation, queue, locks, now, true).await;
    assert_eq!(tick["paused_reason"], "editing");
    assert!(queue.lock().await.is_idle());
    // Expired locks do not pause the scheduler, even before cleanup removes them.
    locks
        .lock()
        .await
        .get_mut("unrelated.png")
        .unwrap()
        .expires_at = std::time::Instant::now();
    let (first, concurrent) = tokio::join!(
        inspect_or_tick(state, orientation, queue, locks, now, true),
        inspect_or_tick(state, orientation, queue, locks, now, true)
    );
    assert_eq!(first["ready_count"], 2);
    assert_eq!(concurrent["paused_reason"], "display_busy");
    assert_eq!(queue.lock().await.get_queued_jobs().len(), 1);
    let first_job = queue.lock().await.get_queued_jobs()[0].clone();
    assert_eq!(first_job.filename, "slideshow-a.png");
    assert_eq!(first_job.source, FlashSource::Automatic);
    assert_eq!(first_job.rotation_degrees, 180);
    assert_eq!(
        fs::read(&first_job.dithered_path).unwrap(),
        b"slideshow-a.png"
    );
    assert_eq!(
        slideshow_status(client).await["settings"]["rotation_anchor_at"],
        0
    );
    // Use the real worker path with a disposable command; no panel is touched.
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    assert!(flash_queue::process_next(queue, state).await);
    assert!(!Path::new(&first_job.dithered_path).exists());
    let completed = slideshow_status(client).await;
    assert_eq!(completed["last_flash_source"], "automatic");
    assert_eq!(
        completed["settings"]["last_rotated_filename"],
        "slideshow-a.png"
    );
    assert!(
        completed["settings"]["rotation_anchor_at"]
            .as_u64()
            .unwrap()
            >= now
    );
    assert_eq!(completed["next_filename"], "slideshow-c.png");
    assert!(
        inspect_or_tick(state, orientation, queue, locks, now, true).await["queued_job_id"]
            .is_null()
    );
    // Failed automatic work neither moves the cursor nor resets the timer.
    let due = completed["next_due_at"].as_u64().unwrap();
    inspect_or_tick(state, orientation, queue, locks, due, true).await;
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/false");
    assert!(flash_queue::process_next(queue, state).await);
    let failed = slideshow_status(client).await;
    assert_eq!(failed["settings"], completed["settings"]);
    assert_eq!(failed["paused_reason"], "retry_backoff");
    assert_eq!(
        queue.lock().await.get_current_job().unwrap().status,
        flash_queue::FlashJobStatus::Failed
    );
    // A successful nonfavorite manual display resets the timer but not the cursor.
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    queue
        .lock()
        .await
        .enqueue("nonfavorite.png".into(), first_job.dithered_path, false, 0);
    assert!(flash_queue::process_next(queue, state).await);
    let manual = slideshow_status(client).await;
    assert_eq!(manual["last_flash_source"], "manual");
    assert_eq!(
        manual["settings"]["last_rotated_filename"],
        "slideshow-a.png"
    );
    assert!(manual["paused_reason"].is_null());
    let due = manual["next_due_at"].as_u64().unwrap();
    inspect_or_tick(state, orientation, queue, locks, due, true).await;
    assert_eq!(
        queue.lock().await.get_queued_jobs()[0].filename,
        "slideshow-c.png"
    );
    assert!(flash_queue::process_next(queue, state).await);
    assert_eq!(
        slideshow_status(client).await["next_filename"],
        "slideshow-a.png"
    );
    std::env::remove_var("INKY_SOUP_DISPLAY_COMMAND");

    // Original/cache/thumb uploads and rejected final uploads cannot reset the timer.
    state.lock().await.content_completed(123).unwrap();
    let filename = "slideshow-a.png";
    let (content_type, body) = multipart(&[], true);
    let body = body
        .replace("name=\"file\"", "name=\"submission.file\"")
        .replace("filename=\"photo.png\"", "filename=\"slideshow-a.png\"");
    let upload = client
        .post("/upload")
        .header(content_type)
        .body(body)
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(upload["success"], true);
    assert_eq!(
        slideshow_status(client).await["settings"]["rotation_anchor_at"],
        123
    );
    assert!(metadata::get_all_metadata(filename).processing_pending);
    assert!(metadata::get_all_metadata(filename).favorite);
    assert!(!config::dithered_path(filename).exists());
    image_locks::try_acquire_lock(locks, filename, "save", false)
        .await
        .unwrap();
    for (endpoint, session, success, anchor_changed) in [
        ("cache", "save", true, false),
        ("thumb", "save", true, false),
        ("dithered", "wrong", false, false),
        ("dithered", "save", true, true),
    ] {
        let (content_type, body) = multipart(
            &[
                ("filename", filename.into()),
                ("session_id", session.into()),
                ("rotation_revision", revision.to_string()),
                ("filter", "lanczos".into()),
                ("fit_mode", "contain".into()),
                ("saturation", "0.5".into()),
                ("brightness", "10".into()),
                ("contrast", "0".into()),
                ("dither_algorithm", "floyd-steinberg".into()),
            ],
            true,
        );
        let response = client
            .post(format!("/api/upload-{endpoint}"))
            .header(content_type)
            .body(body)
            .dispatch()
            .await
            .into_json::<Value>()
            .await
            .unwrap();
        assert_eq!(response["success"], success);
        let status = slideshow_status(client).await;
        assert_eq!(
            status["settings"]["rotation_anchor_at"] != 123,
            anchor_changed
        );
        assert!(metadata::get_all_metadata(filename).favorite);
        assert_eq!(
            metadata::get_all_metadata(filename).processing_pending,
            !anchor_changed
        );
    }
    // Metadata persistence failure is a failed save, including on the final upload.
    state.lock().await.content_completed(456).unwrap();
    let metadata_path = config::metadata_dir().join(format!("{filename}.json"));
    let saved = fs::read(&metadata_path).unwrap();
    fs::remove_file(&metadata_path).unwrap();
    fs::create_dir(&metadata_path).unwrap();
    let (content_type, body) = multipart(
        &[
            ("filename", filename.into()),
            ("session_id", "save".into()),
            ("rotation_revision", revision.to_string()),
            ("filter", "bicubic".into()),
            ("saturation", "0.5".into()),
            ("brightness", "0".into()),
            ("contrast", "0".into()),
            ("dither_algorithm", "atkinson".into()),
        ],
        true,
    );
    let response = client
        .post("/api/upload-dithered")
        .header(content_type)
        .body(body)
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(response["success"], false);
    assert_eq!(
        slideshow_status(client).await["settings"]["rotation_anchor_at"],
        456
    );
    fs::remove_dir(&metadata_path).unwrap();
    fs::write(&metadata_path, saved).unwrap();
    // Reload the persisted scheduler state, rather than recreating an anchor at boot.
    let reloaded = Arc::new(Mutex::new(
        slideshow::Slideshow::load(config::settings_dir().join("slideshow.json"), 999).unwrap(),
    ));
    assert_eq!(
        inspect_or_tick(&reloaded, orientation, queue, locks, now, false).await["settings"],
        slideshow_status(client).await["settings"]
    );
    check_flash_completion_storage_recovery(client).await;
    assert_eq!(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .body(r#"{"rotation_enabled":false}"#)
            .dispatch()
            .await
            .status(),
        Status::Ok
    );
}

async fn check_flash_completion_storage_recovery(client: &Client) {
    use slideshow::{inspect_or_tick, SlideshowState};
    let state = client.rocket().state::<SlideshowState>().unwrap();
    let orientation = client
        .rocket()
        .state::<orientation::OrientationState>()
        .unwrap();
    let queue = client.rocket().state::<FlashQueueState>().unwrap();
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    locks.lock().await.clear();
    state.lock().await.content_completed(0).unwrap();
    inspect_or_tick(
        state,
        orientation,
        queue,
        locks,
        flash_queue::current_time_millis(),
        true,
    )
    .await;
    let first = queue.lock().await.get_queued_jobs()[0].clone();
    let blocker = config::settings_dir().join("slideshow.json.tmp");
    fs::create_dir(&blocker).unwrap();
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    assert!(flash_queue::process_next(queue, state).await);
    let completed = slideshow_status(client).await;
    assert_eq!(completed["paused_reason"], "storage_error");
    assert_eq!(
        completed["settings"]["last_rotated_filename"],
        first.filename
    );
    assert_eq!(
        queue.lock().await.find_job(first.job_id).unwrap().status,
        flash_queue::FlashJobStatus::Completed
    );
    let anchor = completed["settings"]["rotation_anchor_at"]
        .as_u64()
        .unwrap();
    assert!(anchor > 0);
    // Even overdue, no further display is allowed until completion is persisted.
    assert!(
        inspect_or_tick(state, orientation, queue, locks, anchor + 3_600_000, true).await
            ["queued_job_id"]
            .is_null()
    );
    fs::remove_dir(blocker).unwrap();
    assert_eq!(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .body(r#"{"rotation_interval_hours":1}"#)
            .dispatch()
            .await
            .status(),
        Status::Ok
    );
    let recovered = slideshow_status(client).await;
    assert_eq!(recovered["settings"], completed["settings"]);
    assert!(recovered["storage_error"].is_null());
    // Recovery must not repeat A immediately or lose its round-robin position.
    assert!(inspect_or_tick(
        state,
        orientation,
        queue,
        locks,
        anchor + 3_600_000 - 1,
        true
    )
    .await["queued_job_id"]
        .is_null());
    inspect_or_tick(state, orientation, queue, locks, anchor + 3_600_000, true).await;
    let next = queue.lock().await.get_queued_jobs()[0].clone();
    assert_ne!(next.filename, first.filename);
    assert!(flash_queue::process_next(queue, state).await);
    std::env::remove_var("INKY_SOUP_DISPLAY_COMMAND");
}
