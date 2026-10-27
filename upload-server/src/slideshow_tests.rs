// Reuses the server API fixture: image paths are process-wide LazyLocks.
use super::*;
use crate::orientation_tests::multipart;
use rocket::{http::ContentType, local::asynchronous::Client};
use serde_json::{json, Value};
use std::path::Path;

async fn slideshow_status(client: &Client) -> Value {
    client
        .get("/api/slideshow")
        .dispatch()
        .await
        .into_json()
        .await
        .unwrap()
}

/// Whether a scheduler tick at `now` returns while the test holds the storage
/// lock. Ticks read the gallery under that lock, so one that returns has read no
/// photo metadata.
async fn tick_skips_gallery(client: &Client, now: u64) -> bool {
    let rocket = client.rocket();
    let storage = rocket.state::<StorageLock>().unwrap();
    let _held = storage.lock().await;
    let tick = slideshow::tick(
        rocket.state::<slideshow::SlideshowState>().unwrap(),
        storage,
        rocket.state::<FlashQueueState>().unwrap(),
        rocket.state::<ImageLocksState>().unwrap(),
        now,
    );
    tokio::time::timeout(std::time::Duration::from_millis(100), tick)
        .await
        .is_ok()
}

pub(crate) async fn check_slideshow_api_and_worker(client: &Client) {
    use slideshow::{inspect_or_tick, tick, FlashSource, SlideshowState};
    let state = client.rocket().state::<SlideshowState>().unwrap();
    let storage = client.rocket().state::<StorageLock>().unwrap();
    let queue = client.rocket().state::<FlashQueueState>().unwrap();
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    locks.lock().await.clear();
    let initial = slideshow_status(client).await;
    assert_eq!(initial["paused_reason"], "disabled");
    // While disabled, not even a tick at the due time reads the gallery.
    assert!(tick_skips_gallery(client, initial["next_due_at"].as_u64().unwrap()).await);
    for hours in [0, 169] {
        api_error::expect_failure(
            client
                .post("/api/settings/slideshow")
                .header(ContentType::JSON)
                .body(json!({"rotation_enabled":true,"rotation_interval_hours":hours}).to_string())
                .dispatch()
                .await,
            Status::BadRequest,
        )
        .await;
    }
    // The completion fields are read-only, including to clients on the local LAN.
    api_error::expect_failure(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .body(r#"{"rotation_anchor_at":0}"#)
            .dispatch()
            .await,
        Status::UnprocessableEntity,
    )
    .await;
    api_error::expect_failure(
        client
            .post("/api/settings/slideshow")
            .header(ContentType::JSON)
            .header(rocket::http::Header::new("Origin", "https://evil.example"))
            .body(r#"{"rotation_enabled":true}"#)
            .dispatch()
            .await,
        Status::Forbidden,
    )
    .await;
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
    // Restart the timer at the real time, so that the server's own scheduler
    // isn't due while these ticks run at times either side of `due`.
    state
        .lock()
        .await
        .content_completed(flash_queue::current_time_millis())
        .unwrap();
    let due = slideshow_status(client).await["next_due_at"]
        .as_u64()
        .unwrap();
    assert!(tick_skips_gallery(client, due - 1).await);
    // A due tick waits for the storage lock to read the gallery.
    assert!(!tick_skips_gallery(client, due).await);
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
    let paused = tick(state, storage, queue, locks, now).await.unwrap();
    assert_eq!(paused["paused_reason"], "editing");
    assert!(queue.lock().await.is_idle());
    // Expired locks do not pause the scheduler, even before cleanup removes them.
    locks
        .lock()
        .await
        .get_mut("unrelated.png")
        .unwrap()
        .expires_at = std::time::Instant::now();
    let (first, concurrent) = tokio::join!(
        tick(state, storage, queue, locks, now),
        tick(state, storage, queue, locks, now)
    );
    assert_eq!(first.unwrap()["ready_count"], 2);
    assert_eq!(concurrent.unwrap()["paused_reason"], "display_busy");
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
    assert!(tick(state, storage, queue, locks, now).await.is_none());
    // Failed automatic work neither moves the cursor nor resets the timer.
    let due = completed["next_due_at"].as_u64().unwrap();
    tick(state, storage, queue, locks, due).await;
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
    tick(state, storage, queue, locks, due).await;
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
    let (content_type, empty) = multipart(&[], false);
    api_error::expect_failure(
        client
            .post("/upload")
            .header(content_type)
            .body(empty)
            .dispatch()
            .await,
        Status::UnprocessableEntity,
    )
    .await;
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
        inspect_or_tick(&reloaded, storage, queue, locks, now, false).await["settings"],
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
    use slideshow::{tick, SlideshowState};
    let state = client.rocket().state::<SlideshowState>().unwrap();
    let storage = client.rocket().state::<StorageLock>().unwrap();
    let queue = client.rocket().state::<FlashQueueState>().unwrap();
    let locks = client.rocket().state::<ImageLocksState>().unwrap();
    locks.lock().await.clear();
    state.lock().await.content_completed(0).unwrap();
    tick(
        state,
        storage,
        queue,
        locks,
        flash_queue::current_time_millis(),
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
    assert!(tick(state, storage, queue, locks, anchor + 3_600_000)
        .await
        .unwrap()["queued_job_id"]
        .is_null());
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
    assert!(tick(state, storage, queue, locks, anchor + 3_600_000 - 1)
        .await
        .is_none());
    tick(state, storage, queue, locks, anchor + 3_600_000).await;
    let next = queue.lock().await.get_queued_jobs()[0].clone();
    assert_ne!(next.filename, first.filename);
    assert!(flash_queue::process_next(queue, state).await);
    std::env::remove_var("INKY_SOUP_DISPLAY_COMMAND");
}
