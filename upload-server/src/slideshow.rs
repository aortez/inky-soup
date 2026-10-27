//! Favorites and a persistent, hours-based slideshow over client-prepared images.
//! Lock order: storage -> queue -> image locks -> slideshow state.
use crate::{
    browser_access::BrowserWrite,
    config, display_settings,
    flash_queue::{current_time_millis, FlashJob, FlashQueueState},
    image_locks::ImageLocksState,
    metadata, orientation,
    storage::{self, StorageLock},
};
use rocket::{
    http::Status,
    serde::json::{json, Json, Value},
    State,
};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub type SlideshowState = Arc<Mutex<Slideshow>>;
const HOUR_MS: u64 = 3_600_000;
const RETRY_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlashSource {
    Manual,
    Automatic,
    Rescue,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub rotation_enabled: bool,
    pub rotation_interval_hours: u16,
    /// UTC Unix timestamps in milliseconds, matching flash job timestamps.
    pub rotation_anchor_at: u64,
    pub last_rotated_filename: Option<String>,
    pub last_flash_source: Option<FlashSource>,
}

pub struct Slideshow {
    settings: Settings,
    path: PathBuf,
    hour_ms: u64,
    retry_not_before: u64,
    storage_error: Option<String>,
}

impl Slideshow {
    pub fn load(path: PathBuf, now: u64) -> io::Result<Self> {
        let settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Settings>(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings {
                rotation_enabled: false,
                rotation_interval_hours: 24,
                rotation_anchor_at: now,
                last_rotated_filename: None,
                last_flash_source: None,
            },
            Err(error) => return Err(error),
        };
        if !(1..=168).contains(&settings.rotation_interval_hours) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid slideshow interval",
            ));
        }
        let mut state = Self {
            settings,
            path,
            hour_ms: HOUR_MS,
            retry_not_before: 0,
            storage_error: None,
        };
        // Only debug/test binaries accept acceleration; production always uses hours.
        #[cfg(debug_assertions)]
        if let Some(ms) = std::env::var("INKY_SOUP_TEST_ROTATION_HOUR_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|ms| *ms > 0 && *ms <= HOUR_MS)
        {
            state.hour_ms = ms;
        }
        if !state.path.exists() {
            state.commit(state.settings.clone())?;
        }
        Ok(state)
    }

    fn commit(&mut self, settings: Settings) -> io::Result<()> {
        let result = (|| {
            fs::create_dir_all(self.path.parent().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Missing settings directory")
            })?)?;
            let temporary = self.path.with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_vec_pretty(&settings)?)?;
            fs::rename(temporary, &self.path)
        })();
        match result {
            Ok(()) => {
                self.settings = settings;
                self.storage_error = None;
                Ok(())
            }
            Err(error) => {
                self.storage_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    fn configure(&mut self, request: &Configure) -> io::Result<()> {
        let mut settings = self.settings.clone();
        if let Some(enabled) = request.rotation_enabled {
            settings.rotation_enabled = enabled;
        }
        if let Some(hours) = request.rotation_interval_hours {
            if !(1..=168).contains(&hours) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Interval must be 1–168 hours",
                ));
            }
            settings.rotation_interval_hours = hours;
        }
        // Enabling/changing the interval does not manufacture a completion event.
        self.commit(settings)
    }

    pub fn content_completed(&mut self, now: u64) -> io::Result<()> {
        let mut settings = self.settings.clone();
        settings.rotation_anchor_at = now;
        self.commit(settings)?;
        self.retry_not_before = 0;
        Ok(())
    }

    pub fn flash_finished(&mut self, job: &FlashJob, success: bool, now: u64) {
        if matches!(job.source, FlashSource::Rescue | FlashSource::Restore) {
            return;
        }
        if !success {
            if job.source == FlashSource::Automatic {
                self.retry_not_before = now.saturating_add(RETRY_MS);
            }
            return;
        }
        let mut settings = self.settings.clone();
        settings.rotation_anchor_at = now;
        settings.last_flash_source = Some(job.source);
        if job.source == FlashSource::Automatic {
            settings.last_rotated_filename = Some(job.filename.clone());
        }
        if let Err(error) = self.commit(settings.clone()) {
            // The panel has already changed: unlike a rejected settings write,
            // this completion cannot be rolled back. Keep it for the next save
            // or configuration retry; storage_error blocks automatic work until
            // that retry persists the completion together with any new settings.
            self.settings = settings;
            log::error!("Display succeeded but slideshow completion could not be saved: {error}");
        }
        self.retry_not_before = 0;
    }

    fn next_due_at(&self) -> u64 {
        self.settings
            .rotation_anchor_at
            .saturating_add(u64::from(self.settings.rotation_interval_hours) * self.hour_ms)
    }

    fn paused_reason(
        &self,
        now: u64,
        editing: bool,
        idle: bool,
        favorites: usize,
        ready: usize,
    ) -> Option<&'static str> {
        if !self.settings.rotation_enabled {
            Some("disabled")
        } else if self.storage_error.is_some() {
            Some("storage_error")
        } else if editing {
            Some("editing")
        } else if !idle {
            Some("display_busy")
        } else if favorites == 0 {
            Some("no_favorites")
        } else if ready == 0 {
            Some("needs_processing")
        } else if now < self.retry_not_before {
            Some("retry_backoff")
        } else {
            None
        }
    }
}

fn next_filename<'a>(ready: &'a [String], cursor: Option<&str>) -> Option<&'a str> {
    // The input is sorted; deletion/unfavoriting the cursor still advances lexically.
    ready
        .iter()
        .find(|name| cursor.is_none_or(|cursor| name.as_str() > cursor))
        .or_else(|| ready.first())
        .map(String::as_str)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    rotation_enabled: Option<bool>,
    rotation_interval_hours: Option<u16>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Favorite {
    filename: String,
    favorite: bool,
    session_id: String,
}

type ApiResult = Result<Json<Value>, (Status, Json<Value>)>;
fn failure(status: Status, message: impl ToString) -> (Status, Json<Value>) {
    (
        status,
        Json(json!({"success": false, "message": message.to_string()})),
    )
}

#[post("/api/settings/favorite", format = "json", data = "<request>")]
pub async fn set_favorite(
    _origin: BrowserWrite,
    request: Json<Favorite>,
    storage: &State<StorageLock>,
    locks: &State<ImageLocksState>,
) -> ApiResult {
    let filename = &request.filename;
    if crate::sanitize_filename(filename).as_ref() != Some(filename) || filename.contains('\0') {
        return Err(failure(Status::BadRequest, "Invalid filename"));
    }
    let Some(_storage) =
        storage::lock_for_editor(storage, locks, filename, &request.session_id).await
    else {
        return Err(failure(
            Status::Forbidden,
            "Acquire edit access before changing favorites",
        ));
    };
    if !config::original_path(filename).is_file() {
        return Err(failure(Status::NotFound, "Photo not found"));
    }
    let mut meta = metadata::get_all_metadata(filename);
    meta.favorite = request.favorite;
    metadata::try_save_metadata(filename, &meta)
        .map_err(|error| failure(Status::InternalServerError, error))?;
    Ok(Json(
        json!({"success": true, "filename": filename, "favorite": meta.favorite}),
    ))
}

#[post("/api/settings/slideshow", format = "json", data = "<request>")]
pub async fn configure(
    _origin: BrowserWrite,
    request: Json<Configure>,
    state: &State<SlideshowState>,
) -> ApiResult {
    if request.rotation_enabled.is_none() && request.rotation_interval_hours.is_none() {
        return Err(failure(
            Status::BadRequest,
            "Provide rotation_enabled or rotation_interval_hours",
        ));
    }
    let mut state = state.lock().await;
    state.configure(&request).map_err(|error| {
        failure(
            if error.kind() == io::ErrorKind::InvalidInput {
                Status::BadRequest
            } else {
                Status::InternalServerError
            },
            error,
        )
    })?;
    Ok(Json(json!({"success": true, "settings": state.settings})))
}

#[get("/api/slideshow")]
pub async fn status(
    state: &State<SlideshowState>,
    storage: &State<StorageLock>,
    queue: &State<FlashQueueState>,
    locks: &State<ImageLocksState>,
) -> Json<Value> {
    Json(inspect_or_tick(state, storage, queue, locks, current_time_millis(), false).await)
}

/// Hold all guards through snapshot creation/enqueue so no editor, deletion,
/// orientation change or manual job can slip between the check and the enqueue.
pub(crate) async fn inspect_or_tick(
    state: &SlideshowState,
    storage: &StorageLock,
    queue: &FlashQueueState,
    locks: &ImageLocksState,
    now: u64,
    enqueue: bool,
) -> Value {
    let _storage = storage.lock().await;
    let mut queue = queue.lock().await;
    let locks = locks.lock().await;
    let mut state = state.lock().await;
    let favorites: Vec<_> = crate::get_gallery_images()
        .into_iter()
        .filter(|image| image.favorite)
        .collect();
    let mut ready: Vec<_> = favorites
        .iter()
        .filter(|image| !image.needs_processing)
        .map(|image| image.filename.clone())
        .collect();
    ready.sort();
    let editing = locks.values().any(|lock| lock.expires_at > Instant::now());
    let paused = if queue.rescue.as_ref().is_some_and(|r| r.blocks_slideshow()) {
        Some("rescue")
    } else {
        state.paused_reason(now, editing, queue.is_idle(), favorites.len(), ready.len())
    };
    let next = next_filename(&ready, state.settings.last_rotated_filename.as_deref());
    let mut job_id = None;
    if enqueue && paused.is_none() && now >= state.next_due_at() {
        if let Some(filename) = next {
            match orientation::snapshot_image(&config::dithered_path(filename)) {
                Ok(path) => {
                    job_id = Some(queue.enqueue_with_source(
                        filename.into(),
                        path.to_string_lossy().into_owned(),
                        false,
                        display_settings::load_runtime_settings().rotation_degrees,
                        FlashSource::Automatic,
                    ));
                }
                Err(error) => {
                    log::error!("Could not queue automatic display job: {error}");
                    state.retry_not_before = now.saturating_add(RETRY_MS);
                }
            }
        }
    }
    json!({"settings": state.settings, "next_due_at": state.next_due_at(),
        "paused_reason": if queue.rescue.as_ref().is_some_and(|r| r.blocks_slideshow()) {
            Some("rescue")
        } else { state.paused_reason(now, editing, queue.is_idle(), favorites.len(), ready.len()) },
        "last_flash_source": state.settings.last_flash_source, "next_filename": next,
        "favorite_count": favorites.len(), "ready_count": ready.len(), "queued_job_id": job_id,
        "retry_not_before": state.retry_not_before, "storage_error": state.storage_error})
}

pub fn spawn(
    state: SlideshowState,
    storage: StorageLock,
    queue: FlashQueueState,
    locks: ImageLocksState,
    mut shutdown: rocket::Shutdown,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    inspect_or_tick(&state, &storage, &queue, &locks, current_time_millis(), true).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash_queue::FlashQueue;

    fn fixture(name: &str) -> (PathBuf, Slideshow) {
        let root =
            std::env::temp_dir().join(format!("inky-slideshow-{name}-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let mut state = Slideshow::load(root.join("settings.json"), 100).unwrap();
        state.hour_ms = HOUR_MS;
        (root, state)
    }

    #[test]
    fn settings_bounds_persistence_and_completion_events() {
        let (root, mut state) = fixture("settings");
        assert!(!state.settings.rotation_enabled);
        assert_eq!(state.settings.rotation_interval_hours, 24);
        for hours in [0, 169, u16::MAX] {
            assert!(state
                .configure(&Configure {
                    rotation_enabled: Some(true),
                    rotation_interval_hours: Some(hours)
                })
                .is_err());
            assert!(!state.settings.rotation_enabled);
        }
        for hours in [168, 1] {
            state
                .configure(&Configure {
                    rotation_enabled: Some(true),
                    rotation_interval_hours: Some(hours),
                })
                .unwrap();
            assert_eq!(state.settings.rotation_interval_hours, hours);
        }
        assert_eq!(state.settings.rotation_anchor_at, 100);
        assert_eq!(state.next_due_at(), 100 + HOUR_MS);
        let mut queue = FlashQueue::new();
        queue.enqueue_with_source(
            "b.jpg".into(),
            "unused".into(),
            false,
            90,
            FlashSource::Automatic,
        );
        let automatic = queue.get_queued_jobs()[0].clone();
        state.flash_finished(&automatic, false, 200);
        assert_eq!(state.settings.rotation_anchor_at, 100);
        assert_eq!(state.settings.last_rotated_filename, None);
        assert_eq!(
            state.paused_reason(201, false, true, 1, 1),
            Some("retry_backoff")
        );
        assert_eq!(state.paused_reason(200 + RETRY_MS, false, true, 1, 1), None);
        state.flash_finished(&automatic, true, 300);
        assert_eq!(state.settings.rotation_anchor_at, 300);
        assert_eq!(
            state.settings.last_flash_source,
            Some(FlashSource::Automatic)
        );
        assert_eq!(
            state.settings.last_rotated_filename.as_deref(),
            Some("b.jpg")
        );
        queue.enqueue("nonfavorite.jpg".into(), "unused".into(), false, 0);
        let manual = queue.get_queued_jobs()[1].clone();
        state.flash_finished(&manual, false, 400);
        assert_eq!(state.settings.rotation_anchor_at, 300);
        state.flash_finished(&manual, true, 500);
        assert_eq!(state.settings.last_flash_source, Some(FlashSource::Manual));
        assert_eq!(
            state.settings.last_rotated_filename.as_deref(),
            Some("b.jpg")
        );
        state.content_completed(600).unwrap();
        assert_eq!(state.next_due_at(), 600 + HOUR_MS);
        assert_eq!(
            Slideshow::load(state.path.clone(), 999).unwrap().settings,
            state.settings
        );
        state
            .configure(&Configure {
                rotation_enabled: Some(false),
                rotation_interval_hours: None,
            })
            .unwrap();
        assert_eq!(state.settings.rotation_anchor_at, 600);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_persistence_keeps_anchor_and_pauses_until_repaired() {
        let (root, mut state) = fixture("storage");
        state
            .configure(&Configure {
                rotation_enabled: Some(true),
                rotation_interval_hours: None,
            })
            .unwrap();
        let before = state.settings.clone();
        fs::remove_file(&state.path).unwrap();
        fs::create_dir(&state.path).unwrap();
        assert!(state.content_completed(900).is_err());
        assert_eq!(state.settings, before);
        assert_eq!(
            state.paused_reason(1000, false, true, 1, 1),
            Some("storage_error")
        );
        fs::remove_dir(&state.path).unwrap();
        state.content_completed(1100).unwrap();
        assert_eq!(state.paused_reason(1100, false, true, 1, 1), None);
        fs::write(&state.path, b"broken settings").unwrap();
        assert!(Slideshow::load(state.path.clone(), 1200).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_flash_completion_survives_failed_retries_and_settings_recovery() {
        for source in [FlashSource::Automatic, FlashSource::Manual] {
            let (root, mut state) = fixture(&format!("completion-{source:?}"));
            state
                .configure(&Configure {
                    rotation_enabled: Some(true),
                    rotation_interval_hours: Some(1),
                })
                .unwrap();
            let mut queue = FlashQueue::new();
            queue.enqueue_with_source(
                "previous.png".into(),
                "unused".into(),
                false,
                0,
                FlashSource::Automatic,
            );
            state.flash_finished(&queue.get_queued_jobs()[0], true, 200);
            queue.enqueue_with_source("new.png".into(), "unused".into(), false, 0, source);
            let blocker = state.path.with_extension("json.tmp");
            fs::create_dir(&blocker).unwrap();

            state.flash_finished(&queue.get_queued_jobs()[1], true, 900);
            let completion = state.settings.clone();
            assert_eq!(completion.rotation_anchor_at, 900);
            assert_eq!(completion.last_flash_source, Some(source));
            assert_eq!(
                completion.last_rotated_filename.as_deref(),
                Some(if source == FlashSource::Automatic {
                    "new.png"
                } else {
                    "previous.png"
                })
            );
            assert_eq!(
                state.paused_reason(1000, false, true, 2, 2),
                Some("storage_error")
            );
            // A failed content/settings write must not lose the physical completion
            // or claim that the rejected write changed the interval or timer.
            assert!(state.content_completed(1000).is_err());
            assert!(state
                .configure(&Configure {
                    rotation_enabled: Some(false),
                    rotation_interval_hours: Some(2),
                })
                .is_err());
            assert_eq!(state.settings, completion);
            let persisted: Settings =
                serde_json::from_slice(&fs::read(&state.path).unwrap()).unwrap();
            assert_eq!(persisted.rotation_anchor_at, 200);

            fs::remove_dir(blocker).unwrap();
            state
                .configure(&Configure {
                    rotation_enabled: None,
                    rotation_interval_hours: Some(2),
                })
                .unwrap();
            assert_eq!(state.settings.rotation_anchor_at, 900);
            assert_eq!(
                state.settings.last_rotated_filename,
                completion.last_rotated_filename
            );
            assert_eq!(state.next_due_at(), 900 + 2 * HOUR_MS);
            assert_eq!(state.paused_reason(1000, false, true, 2, 2), None);
            assert_eq!(
                Slideshow::load(state.path.clone(), 1000).unwrap().settings,
                state.settings
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn pause_reasons_and_round_robin_survive_a_removed_cursor() {
        let (root, mut state) = fixture("pauses");
        assert_eq!(
            state.paused_reason(100, false, true, 1, 1),
            Some("disabled")
        );
        state
            .configure(&Configure {
                rotation_enabled: Some(true),
                rotation_interval_hours: None,
            })
            .unwrap();
        assert_eq!(state.paused_reason(100, true, true, 1, 1), Some("editing"));
        assert_eq!(
            state.paused_reason(100, false, false, 1, 1),
            Some("display_busy")
        );
        assert_eq!(
            state.paused_reason(100, false, true, 0, 0),
            Some("no_favorites")
        );
        assert_eq!(
            state.paused_reason(100, false, true, 1, 0),
            Some("needs_processing")
        );
        let ready = vec!["a.jpg".into(), "c.jpg".into()];
        for (cursor, expected) in [
            (None, "a.jpg"),
            (Some("a.jpg"), "c.jpg"),
            (Some("b.jpg"), "c.jpg"),
            (Some("c.jpg"), "a.jpg"),
        ] {
            assert_eq!(next_filename(&ready, cursor), Some(expected));
        }
        assert_eq!(next_filename(&[], Some("a.jpg")), None);
        fs::remove_dir_all(root).unwrap();
    }
}
