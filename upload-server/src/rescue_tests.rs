//! Runs inside the existing fixture which owns process-global config paths.
use crate::*;
use rocket::{
    http::{ContentType, Header},
    local::asynchronous::Client,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub(crate) async fn check_rescue() {
    let queue: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));
    let directory = config::data_dir().join("rescue-test");
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    let slideshow: slideshow::SlideshowState = Arc::new(Mutex::new(
        slideshow::Slideshow::load(config::settings_dir().join("rescue-slideshow.json"), 100)
            .unwrap(),
    ));
    let storage = StorageLock::default();
    let locks: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));
    let client = Client::tracked(
        rocket::build()
            .manage(browser_access::BrowserAccess::from_env())
            .manage(queue.clone())
            .manage(slideshow.clone())
            .manage(storage.clone())
            .manage(locks.clone())
            .mount(
                "/",
                routes![
                    rescue::status,
                    rescue::control,
                    slideshow::status,
                    slideshow::configure,
                    flash_job_status
                ],
            ),
    )
    .await
    .unwrap();
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    let status = || client.get("/api/rescue").dispatch();
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["restore_available"],
        false
    );
    assert_eq!(
        client.post("/api/rescue/restore").dispatch().await.status(),
        Status::Conflict
    );
    assert_eq!(
        client
            .post("/api/rescue/show")
            .header(Header::new("Origin", "https://evil.example"))
            .dispatch()
            .await
            .status(),
        Status::Forbidden
    );
    assert_eq!(
        client.post("/api/rescue/unknown").dispatch().await.status(),
        Status::BadRequest
    );

    // Ordinary refreshes save immutable pixels outside the gallery.
    let (snapshot, _) = orientation::reserve_snapshot().unwrap();
    fs::write(&snapshot, b"the previous displayed pixels").unwrap();
    let degrees = display_settings::load_runtime_settings().rotation_degrees;
    queue.lock().await.enqueue(
        "photo.png".into(),
        snapshot.to_string_lossy().into(),
        false,
        degrees,
    );
    assert_eq!(
        client.post("/api/rescue/show").dispatch().await.status(),
        Status::Conflict
    );
    flash_queue::process_next(&queue, &slideshow).await;
    assert!(!snapshot.exists());
    let before = client
        .get("/api/slideshow")
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["restore_available"],
        true
    );
    client
        .post("/api/settings/slideshow")
        .header(ContentType::JSON)
        .body(json!({"rotation_enabled":true}).to_string())
        .dispatch()
        .await;

    // Debounce, editing, and busy jobs all defer automatic rescue.
    let start = Instant::now() - Duration::from_secs(400);
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(true), false, start);
        rescue::tick(&mut q, Ok(false), false, start);
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(299));
        assert!(q.is_idle());
        rescue::tick(&mut q, Ok(false), true, start + Duration::from_secs(300));
        assert!(q.is_idle());
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(301));
        assert_eq!(q.get_queued_jobs().len(), 1);
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(302));
        assert_eq!(q.get_queued_jobs().len(), 1);
    }
    assert_eq!(
        client
            .get("/api/slideshow")
            .dispatch()
            .await
            .into_json::<Value>()
            .await
            .unwrap()["paused_reason"],
        "rescue"
    );
    flash_queue::process_next(&queue, &slideshow).await;
    let after = client
        .get("/api/slideshow")
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        before["settings"]["rotation_anchor_at"],
        after["settings"]["rotation_anchor_at"]
    );
    assert_eq!(before["last_flash_source"], after["last_flash_source"]);
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        true
    );

    // Reboot while showing rescue remembers the image and waits for stable recovery.
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        true
    );
    let online = Instant::now();
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(true), false, online);
        assert!(q.is_idle());
        rescue::tick(&mut q, Ok(true), false, online + Duration::from_secs(29));
        assert!(q.is_idle());
        rescue::tick(&mut q, Ok(true), false, online + Duration::from_secs(30));
        let job = &q.get_queued_jobs()[0];
        assert_eq!(job.source, slideshow::FlashSource::Restore);
        assert_eq!(
            fs::read(&job.dithered_path).unwrap(),
            b"the previous displayed pixels"
        );
    }
    // Losing connectivity again cancels a restore that has not started.
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(false), false, online + Duration::from_secs(31));
        assert!(q.is_idle());
        rescue::tick(&mut q, Ok(true), false, online + Duration::from_secs(32));
        rescue::tick(&mut q, Ok(true), false, online + Duration::from_secs(62));
        assert!(!q.is_idle());
    }
    flash_queue::process_next(&queue, &slideshow).await;
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        false
    );
    assert_eq!(
        client
            .get("/api/slideshow")
            .dispatch()
            .await
            .into_json::<Value>()
            .await
            .unwrap()["settings"]["rotation_anchor_at"],
        before["settings"]["rotation_anchor_at"]
    );

    // Recovery cancels an unstarted card; manual work cancels a pending restore.
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(false), false, start);
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(301));
        assert!(!q.is_idle());
        rescue::tick(&mut q, Ok(true), false, Instant::now());
        assert!(q.is_idle());
    }
    client.post("/api/rescue/restore").dispatch().await;
    let (snapshot, _) = orientation::reserve_snapshot().unwrap();
    fs::write(&snapshot, b"newer photo").unwrap();
    queue.lock().await.enqueue(
        "new.png".into(),
        snapshot.to_string_lossy().into(),
        false,
        degrees,
    );
    assert_eq!(queue.lock().await.get_queued_jobs().len(), 1);
    flash_queue::process_next(&queue, &slideshow).await;
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        false
    );

    // Explicit diagnostics also respect editing locks.
    image_locks::try_acquire_lock(&locks, "editor.png", "editor", false)
        .await
        .unwrap();
    assert_eq!(
        client.post("/api/rescue/show").dispatch().await.status(),
        Status::Conflict
    );
    locks.lock().await.clear();
    // A mounting revision change invalidates restoration even if dimensions match.
    let saved_orientation = display_settings::load_runtime_settings();
    let mut changed = saved_orientation.clone();
    changed.rotation_revision += 1;
    display_settings::save_runtime_settings_to_path(
        &config::display_runtime_settings_path(),
        &changed,
    )
    .unwrap();
    assert_eq!(
        client.post("/api/rescue/restore").dispatch().await.status(),
        Status::Conflict
    );
    display_settings::save_runtime_settings_to_path(
        &config::display_runtime_settings_path(),
        &saved_orientation,
    )
    .unwrap();

    // Failed cards neither reset slideshow timing nor keep retrying every poll.
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/false");
    client.post("/api/rescue/show").dispatch().await;
    flash_queue::process_next(&queue, &slideshow).await;
    let state = status().await.into_json::<Value>().await.unwrap();
    assert_eq!(state["card_active"], false);
    assert!(state["error"].is_string());
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(false), false, start);
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(400));
        assert!(q.is_idle());
    }
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    client.post("/api/rescue/show").dispatch().await;
    flash_queue::process_next(&queue, &slideshow).await;
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        true
    );

    // A failed attempt to redraw an existing card preserves its active state.
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/false");
    client.post("/api/rescue/show").dispatch().await;
    flash_queue::process_next(&queue, &slideshow).await;
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        true
    );
    std::env::set_var("INKY_SOUP_DISPLAY_COMMAND", "/bin/true");
    client.post("/api/rescue/show").dispatch().await;
    flash_queue::process_next(&queue, &slideshow).await;

    // Explicit show remains visible while online; it does not race the monitor.
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(true), false, start);
        rescue::tick(&mut q, Ok(true), false, start + Duration::from_secs(400));
        assert!(q.is_idle());
    }
    // A successful manual photo takes over from the card and survives a restart.
    let (snapshot, _) = orientation::reserve_snapshot().unwrap();
    fs::write(&snapshot, b"manual replacement").unwrap();
    queue.lock().await.enqueue(
        "replacement.png".into(),
        snapshot.to_string_lossy().into(),
        false,
        degrees,
    );
    flash_queue::process_next(&queue, &slideshow).await;
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        false
    );
    client.post("/api/rescue/restore").dispatch().await;
    assert_eq!(
        fs::read(&queue.lock().await.get_queued_jobs()[0].dithered_path).unwrap(),
        b"manual replacement"
    );
    flash_queue::process_next(&queue, &slideshow).await;

    // Persistence failure prevents the rescue refresh before touching the panel.
    fs::remove_file(directory.join("state.json")).unwrap();
    fs::create_dir(directory.join("state.json")).unwrap();
    let queued = client
        .post("/api/rescue/show")
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    flash_queue::process_next(&queue, &slideshow).await;
    let failed = client
        .get(format!("/api/flash/status/{}", queued["job_id"]))
        .dispatch()
        .await
        .into_json::<Value>()
        .await
        .unwrap();
    assert_eq!(failed["status"], "Failed");
    assert!(status().await.into_json::<Value>().await.unwrap()["error"].is_string());
    fs::remove_dir(directory.join("state.json")).unwrap();
    client.post("/api/rescue/show").dispatch().await;
    flash_queue::process_next(&queue, &slideshow).await;

    // Interrupted ordinary refresh invalidates old restoration across restarts.
    fs::write(directory.join("normal-in-progress"), b"1").unwrap();
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["restore_available"],
        false
    );
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    assert_eq!(
        status().await.into_json::<Value>().await.unwrap()["card_active"],
        false
    );

    // Corrupt state disables automatic recovery, but leaves HTTP status usable.
    fs::write(directory.join("state.json"), b"broken").unwrap();
    queue.lock().await.rescue = Some(rescue::Rescue::load(directory.clone(), true));
    assert!(status().await.into_json::<Value>().await.unwrap()["error"].is_string());
    {
        let mut q = queue.lock().await;
        rescue::tick(&mut q, Ok(false), false, start);
        rescue::tick(&mut q, Ok(false), false, start + Duration::from_secs(400));
        assert!(q.is_idle());
    }
    std::env::remove_var("INKY_SOUP_DISPLAY_COMMAND");
}
