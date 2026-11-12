// Runs inside the orientation API test: image paths are process-wide LazyLocks.
use super::*;
use crate::image_locks::ImageLock;
use crate::orientation_tests::multipart;
use rocket::{http::ContentType, local::asynchronous::Client};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const PHOTO: &str = "guarded.png";

/// Every route that changes a photo or queues it for display, except tag
/// changes, which need no edit lock of their own.
#[derive(Clone, Copy, Debug)]
enum Write {
    Cache,
    Thumb,
    Dithered,
    Rotation,
    Flash,
    Delete,
}

const WRITES: [Write; 6] = [
    Write::Cache,
    Write::Thumb,
    Write::Dithered,
    Write::Rotation,
    Write::Flash,
    Write::Delete,
];

/// Returns the response status and whether the write was accepted. A refused
/// write must explain itself in the API's failure body.
async fn send(
    client: &Client,
    write: Write,
    session: Option<&str>,
    revision: u64,
) -> (Status, bool) {
    let request = match write {
        Write::Cache | Write::Thumb | Write::Dithered => {
            let mut fields = vec![
                ("filename", PHOTO.to_string()),
                ("rotation_revision", revision.to_string()),
                ("photo_rotation_revision", "0".into()),
                ("filter", "lanczos".into()),
                ("fit_mode", "cover".into()),
                ("saturation", "0.7".into()),
                ("brightness", "25".into()),
                ("contrast", "-20".into()),
                ("dither_algorithm", "atkinson".into()),
            ];
            fields.extend(session.map(|session| ("session_id", session.to_string())));
            let (kind, body) = multipart(&fields, true);
            let endpoint = match write {
                Write::Cache => "cache",
                Write::Thumb => "thumb",
                _ => "dithered",
            };
            client
                .post(format!("/api/upload-{endpoint}"))
                .header(kind)
                .body(body)
        }
        Write::Flash => {
            let mut fields = vec![
                ("submission.filename", PHOTO.to_string()),
                (
                    "submission.image_file_path",
                    format!("images/dithered/{PHOTO}.png"),
                ),
                ("submission.flash_twice", "false".into()),
                ("submission.rotation_revision", revision.to_string()),
                ("submission.photo_rotation_revision", "0".into()),
            ];
            fields.extend(session.map(|session| ("submission.session_id", session.to_string())));
            let (kind, body) = multipart(&fields, false);
            client.post("/flash").header(kind).body(body)
        }
        Write::Rotation | Write::Delete => {
            let (path, mut body) = match write {
                Write::Rotation => (
                    "/api/settings/photo-rotation",
                    json!({"photo_rotation_degrees": 0, "expected_revision": 0}),
                ),
                _ => ("/api/delete-image", json!({})),
            };
            body["filename"] = json!(PHOTO);
            if let Some(session) = session {
                body["session_id"] = json!(session);
            }
            client
                .post(path)
                .header(ContentType::JSON)
                .body(body.to_string())
        }
    };
    let response = request.dispatch().await;
    let status = response.status();
    if status != Status::Ok {
        api_error::expect_failure(response, status).await;
        return (status, false);
    }
    (
        status,
        response.into_json::<Value>().await.unwrap()["success"] == true,
    )
}

/// Adds a tag to the photo and returns the response status. A refused change
/// must explain itself in the API's failure body.
async fn add_tag(client: &Client, session: Option<&str>, tag: &str) -> Status {
    let mut body = json!({"filename": PHOTO, "add": [tag]});
    if let Some(session) = session {
        body["session_id"] = json!(session);
    }
    let response = client
        .post("/api/settings/tags")
        .header(ContentType::JSON)
        .body(body.to_string())
        .dispatch()
        .await;
    let status = response.status();
    if status != Status::Ok {
        api_error::expect_failure(response, status).await;
    }
    status
}

async fn hold_lock(locks: &ImageLocksState, session: &str, expires_at: Instant) {
    locks.lock().await.insert(
        PHOTO.into(),
        ImageLock {
            session_id: session.into(),
            expires_at,
        },
    );
}

pub(crate) async fn check_photo_write_guards() {
    let locks: ImageLocksState = Arc::new(Mutex::new(HashMap::new()));
    let queue: FlashQueueState = Arc::new(Mutex::new(FlashQueue::new()));
    // Without the liftoff workers, a queued job stays queued.
    let client = Client::tracked(
        rocket::build()
            .manage(browser_access::BrowserAccess::from_env())
            .manage(StorageLock::default())
            .manage(Arc::new(Mutex::new(
                slideshow::Slideshow::load(config::settings_dir().join("slideshow.json"), 100)
                    .unwrap(),
            )) as slideshow::SlideshowState)
            .manage(locks.clone())
            .manage(queue.clone())
            .mount(
                "/",
                routes![
                    upload_cache,
                    upload_thumb,
                    upload_dithered,
                    photo_rotation::update_photo_rotation,
                    tags::update_tags,
                    submit_flash_image,
                    photo_management::delete_image
                ],
            )
            .register("/", catchers![api_error::catcher]),
    )
    .await
    .unwrap();
    let revision = display_settings::load_runtime_settings().rotation_revision;
    // Save the photo as its editor would, so that only the edit lock stands
    // between each later request and a change or a display.
    fs::write(config::original_path(PHOTO), b"original").unwrap();
    hold_lock(&locks, "editor", Instant::now() + Duration::from_secs(30)).await;
    for write in [Write::Cache, Write::Thumb, Write::Dithered] {
        assert_eq!(
            send(&client, write, Some("editor"), revision).await,
            (Status::Ok, true)
        );
    }
    locks.lock().await.clear();
    assert!(
        !get_gallery_images()
            .iter()
            .find(|image| image.filename == PHOTO)
            .unwrap()
            .needs_processing
    );
    let derived = [
        config::cache_path(PHOTO),
        config::thumb_path(PHOTO),
        config::dithered_path(PHOTO),
    ];
    // Tell these pixels apart from the ones that later uploads send.
    for path in &derived {
        fs::write(path, b"saved pixels").unwrap();
    }
    let metadata_path = config::metadata_dir().join(format!("{PHOTO}.json"));
    let saved_metadata = fs::read(&metadata_path).unwrap();
    // A refused write must not touch the photo, including the cache upload's
    // removal of the display image, or queue a display.
    let unchanged = |case: &str| {
        assert_eq!(
            fs::read(config::original_path(PHOTO)).unwrap(),
            b"original",
            "{case}"
        );
        for path in &derived {
            assert_eq!(
                fs::read(path).unwrap(),
                b"saved pixels",
                "{case}: {}",
                path.display()
            );
        }
        assert_eq!(fs::read(&metadata_path).unwrap(), saved_metadata, "{case}");
        assert!(queue.try_lock().unwrap().is_idle(), "{case}");
    };

    for write in WRITES {
        let case = format!("{write:?} without a session");
        assert_eq!(
            send(&client, write, None, revision).await,
            (Status::UnprocessableEntity, false),
            "{case}"
        );
        unchanged(&case);
    }
    for (holder, expires_at, lock) in [
        (
            "other",
            Instant::now() + Duration::from_secs(30),
            "another session's lock",
        ),
        ("editor", Instant::now(), "an expired lock"),
    ] {
        hold_lock(&locks, holder, expires_at).await;
        for write in WRITES {
            let case = format!("{write:?} under {lock}");
            assert_eq!(
                send(&client, write, Some("editor"), revision).await,
                (Status::Forbidden, false),
                "{case}"
            );
            unchanged(&case);
        }
    }

    // A tag change needs no edit lock of its own, but waits while another
    // session holds one.
    hold_lock(&locks, "other", Instant::now() + Duration::from_secs(30)).await;
    for session in [None, Some("editor")] {
        assert_eq!(add_tag(&client, session, "Kitchen").await, Status::Conflict);
        unchanged(&format!(
            "Tag change by {session:?} under another session's lock"
        ));
    }
    hold_lock(&locks, "other", Instant::now()).await;
    assert_eq!(add_tag(&client, None, "Kitchen").await, Status::Ok);
    hold_lock(&locks, "editor", Instant::now() + Duration::from_secs(30)).await;
    assert_eq!(add_tag(&client, Some("editor"), "hall").await, Status::Ok);
    assert_eq!(
        metadata::get_all_metadata(PHOTO).tags(),
        ["hall", "kitchen"]
    );

    // A display job shows its own snapshot, so the editor of a queued photo can
    // still save it and queue it again, but cannot delete it until the display
    // finishes.
    hold_lock(&locks, "editor", Instant::now() + Duration::from_secs(30)).await;
    let snapshot = orientation::snapshot_image(&config::dithered_path(PHOTO)).unwrap();
    queue
        .lock()
        .await
        .enqueue(PHOTO.into(), snapshot.to_string_lossy().into(), false, 0);
    for write in WRITES {
        let expected = match write {
            Write::Delete => (Status::Conflict, false),
            _ => (Status::Ok, true),
        };
        assert_eq!(
            send(&client, write, Some("editor"), revision).await,
            expected,
            "{write:?} while queued"
        );
    }
    for path in &derived {
        assert_eq!(fs::read(path).unwrap(), b"prepared pixels");
    }
    // Saving keeps the photo's tags.
    assert_eq!(
        metadata::get_all_metadata(PHOTO).tags(),
        ["hall", "kitchen"]
    );
    let jobs = queue.lock().await.get_queued_jobs();
    let shown: Vec<_> = jobs
        .iter()
        .map(|job| fs::read(&job.dithered_path).unwrap())
        .collect();
    assert_eq!(
        shown,
        [b"saved pixels".to_vec(), b"prepared pixels".to_vec()]
    );

    *queue.lock().await = FlashQueue::new();
    for job in jobs {
        fs::remove_file(job.dithered_path).unwrap();
    }
    assert_eq!(
        send(&client, Write::Delete, Some("editor"), revision).await,
        (Status::Ok, true)
    );
    assert!(!config::original_path(PHOTO).exists());
    assert!(!metadata_path.exists());
    assert!(!locks.lock().await.contains_key(PHOTO));
}
