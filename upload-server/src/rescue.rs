//! Offline recovery uses prepared cards and the normal flash queue. All mutable
//! state lives under the queue lock; callers acquire orientation -> queue -> edits.
use crate::{
    browser_access::BrowserWrite,
    config,
    flash_queue::{FlashJob, FlashQueue, FlashQueueState},
    image_locks::ImageLocksState,
    orientation::{self, OrientationState},
    slideshow::FlashSource,
};
use rocket::{
    http::Status,
    serde::json::{json, Json, Value},
    State,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const GRACE: Duration = Duration::from_secs(300);
const RECOVERY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplayStamp {
    model: String,
    width: u32,
    height: u32,
    rotation: u16,
    revision: u64,
}
impl DisplayStamp {
    pub fn current() -> Self {
        let c = crate::get_display_config();
        Self {
            model: c.model,
            width: c.width,
            height: c.height,
            rotation: c.rotation_degrees,
            revision: c.rotation_revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Previous {
    file: String,
    display: DisplayStamp,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Saved {
    active: bool,
    #[serde(default)]
    manual: bool,
    previous: Option<Previous>,
}
#[derive(Debug)]
pub struct Rescue {
    directory: PathBuf,
    enabled: bool,
    saved: Saved,
    connected: Option<bool>,
    offline_since: Option<Instant>,
    online_since: Option<Instant>,
    handled: bool,
    pub error: Option<String>,
    probe_error: Option<String>,
    card_before_flash: Option<(bool, bool)>,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    fs::File::open(path.parent().unwrap())?.sync_all()
}

impl Rescue {
    pub fn from_env() -> Self {
        let enabled = match std::env::var("INKY_SOUP_RESCUE") {
            Ok(value) => value == "1",
            Err(_) => Path::new("/usr/bin/inky-soup-update-display").is_file(),
        };
        Self::load(config::data_dir().join("rescue"), enabled)
    }

    pub(crate) fn load(directory: PathBuf, enabled: bool) -> Self {
        let result = (|| -> io::Result<Saved> {
            fs::create_dir_all(&directory)?;
            let saved = match fs::read(directory.join("state.json")) {
                Ok(bytes) => serde_json::from_slice::<Saved>(&bytes)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => Saved::default(),
                Err(e) => return Err(e),
            };
            if let Some(previous) = &saved.previous {
                if !previous.file.starts_with("image-")
                    || !previous.file.ends_with(".png")
                    || previous.file.contains(['/', '\\'])
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Invalid rescue snapshot",
                    ));
                }
            }
            // A crash during a normal refresh leaves physical state unknown.
            // Never restore an older image over its possible replacement.
            if directory.join("normal-in-progress").exists() {
                let empty = Saved::default();
                write_atomic(&directory.join("state.json"), &serde_json::to_vec(&empty)?)?;
                fs::remove_file(directory.join("normal-in-progress"))?;
                return Ok(empty);
            }
            Ok(saved)
        })();
        let (saved, error) = match result {
            Ok(saved) => {
                // Discard crash leftovers, keeping only the manifest's snapshot.
                if let Ok(entries) = fs::read_dir(&directory) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name.starts_with("image-")
                            && name.ends_with(".png")
                            && !saved.previous.as_ref().is_some_and(|p| p.file == name)
                        {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
                (saved, None)
            }
            Err(e) => (Saved::default(), Some(e.to_string())),
        };
        Self {
            directory,
            enabled,
            saved,
            connected: None,
            offline_since: None,
            online_since: None,
            handled: false,
            error,
            probe_error: None,
            card_before_flash: None,
        }
    }

    fn persist(&self) -> io::Result<()> {
        write_atomic(
            &self.directory.join("state.json"),
            &serde_json::to_vec(&self.saved)?,
        )
    }

    /// Clear the crash marker only after the latest known display state is durable.
    /// The marker may belong to an earlier refresh whose backup or manifest failed.
    fn commit_display_state(&self) -> io::Result<()> {
        self.persist()?;
        match fs::remove_file(self.directory.join("normal-in-progress")) {
            Ok(()) => fs::File::open(&self.directory)?.sync_all(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn blocks_slideshow(&self) -> bool {
        self.saved.active
            || (self.enabled && self.offline_since.is_some_and(|t| t.elapsed() >= GRACE))
    }

    fn observe(&mut self, sample: Result<bool, String>, now: Instant) {
        match sample {
            Ok(connected) => {
                if !connected && self.connected == Some(true) {
                    self.handled = false;
                }
                self.connected = Some(connected);
                self.probe_error = None;
                if connected {
                    self.offline_since = None;
                    self.online_since.get_or_insert(now);
                    self.handled = false;
                } else {
                    self.online_since = None;
                    self.offline_since.get_or_insert(now);
                }
            }
            Err(error) => {
                self.connected = None;
                self.probe_error = Some(error);
                // Only continuous confirmed observations count toward a timeout.
                self.offline_since = None;
                self.online_since = None;
            }
        }
    }

    pub fn status(&self) -> Value {
        json!({"enabled":self.enabled, "connected":self.connected,
            "offline_seconds":self.offline_since.map(|t| t.elapsed().as_secs()),
            "grace_seconds":GRACE.as_secs(), "recovery_seconds":RECOVERY.as_secs(),
            "card_active":self.saved.active, "manual_card":self.saved.manual, "outage_handled":self.handled,
            "restore_available":self.saved.previous.as_ref().is_some_and(|p|
                p.display == DisplayStamp::current() && self.directory.join(&p.file).is_file()),
            "error":self.error, "probe_error":self.probe_error})
    }

    pub fn manual_requested(&mut self) {
        self.handled = true;
    }

    pub fn before_flash(&mut self, job: &FlashJob) -> Result<(), String> {
        match job.source {
            FlashSource::Rescue => {
                self.card_before_flash = Some((self.saved.active, self.saved.manual));
                self.saved.active = true;
                self.saved.manual = !job.automatic_recovery;
                self.persist().map_err(|e| e.to_string())?;
            }
            FlashSource::Manual | FlashSource::Automatic => {
                // Record intent before touching the panel so a crash cannot make
                // a later restart restore an obsolete image.
                if let Err(e) = write_atomic(&self.directory.join("normal-in-progress"), b"1") {
                    self.error = Some(e.to_string());
                    return Err(format!("Cannot record display intent: {e}"));
                }
            }
            FlashSource::Restore => {}
        }
        Ok(())
    }

    pub fn finished(&mut self, job: &FlashJob, success: bool) {
        let result = (|| -> io::Result<()> {
            if !success {
                if job.source == FlashSource::Rescue {
                    let (active, manual) = self.card_before_flash.take().unwrap_or((false, false));
                    self.saved.active = active;
                    self.saved.manual = manual;
                    self.persist()?;
                }
                if matches!(job.source, FlashSource::Manual | FlashSource::Automatic) {
                    self.commit_display_state()?;
                }
                return Ok(());
            }
            match job.source {
                FlashSource::Rescue => {
                    self.card_before_flash = None;
                    self.commit_display_state()?;
                }
                FlashSource::Restore => {
                    self.saved.active = false;
                    self.saved.manual = false;
                    self.commit_display_state()?;
                }
                FlashSource::Manual | FlashSource::Automatic => {
                    let old = self.saved.previous.clone();
                    // Invalidate the in-memory reference before any fallible write.
                    self.saved = Saved::default();
                    let display = job
                        .rescue_display
                        .clone()
                        .ok_or_else(|| io::Error::other("Missing display stamp"))?;
                    let file = format!("image-{}-{}.png", job.created_at, job.job_id);
                    write_atomic(&self.directory.join(&file), &fs::read(&job.dithered_path)?)?;
                    self.saved.previous = Some(Previous {
                        file: file.clone(),
                        display,
                    });
                    self.commit_display_state()?;
                    if let Some(old) = old {
                        if old.file != file {
                            let _ = fs::remove_file(self.directory.join(old.file));
                        }
                    }
                }
            }
            Ok(())
        })();
        if result.is_ok() && success {
            self.error = None;
        }
        if let Err(error) = result {
            self.error = Some(error.to_string());
            log::error!("Rescue persistence: {error}");
        }
        if !success {
            self.error = Some("Display refresh failed; inspect the flash job".into());
        }
    }
}

fn card(display: &DisplayStamp) -> Result<&'static [u8], String> {
    match (display.model.as_str(), display.width, display.height) {
        ("impression-5.7", 600, 448) => Ok(include_bytes!("../rescue-cards/600x448.png")),
        ("impression-5.7", 448, 600) => Ok(include_bytes!("../rescue-cards/448x600.png")),
        ("impression-13.3-2025", 1600, 1200) => Ok(include_bytes!("../rescue-cards/1600x1200.png")),
        ("impression-13.3-2025", 1200, 1600) => Ok(include_bytes!("../rescue-cards/1200x1600.png")),
        _ => Err("Unsupported display for rescue card".into()),
    }
}

fn enqueue(
    queue: &mut FlashQueue,
    state: &mut Rescue,
    restore: bool,
    automatic: bool,
) -> Result<u64, String> {
    let display = DisplayStamp::current();
    let snapshot = if restore {
        let previous = state
            .saved
            .previous
            .as_ref()
            .ok_or("No previous display to restore")?;
        if previous.display != display {
            return Err("Mounting or panel changed; display a new photo in the app".into());
        }
        orientation::snapshot_image(&state.directory.join(&previous.file))?
    } else {
        let bytes = card(&display)?;
        let (path, mut file) = orientation::reserve_snapshot().map_err(|e| e.to_string())?;
        if let Err(e) = file.write_all(bytes) {
            let _ = fs::remove_file(&path);
            return Err(e.to_string());
        }
        path
    };
    let (filename, source) = if restore {
        ("rescue-restore.png", FlashSource::Restore)
    } else {
        ("offline-rescue.png", FlashSource::Rescue)
    };
    let id = queue.enqueue_with_source(
        filename.into(),
        snapshot.to_string_lossy().into(),
        false,
        display.rotation,
        source,
    );
    if automatic {
        queue.mark_automatic_recovery(id);
    }
    if !restore {
        state.handled = true;
    }
    Ok(id)
}

pub(crate) fn tick(
    queue: &mut FlashQueue,
    sample: Result<bool, String>,
    editing: bool,
    now: Instant,
) {
    let Some(mut state) = queue.rescue.take() else {
        return;
    };
    state.observe(sample, now);
    match state.connected {
        Some(true) => queue.cancel_recovery_jobs(Some(FlashSource::Rescue), true),
        Some(false) | None => queue.cancel_recovery_jobs(Some(FlashSource::Restore), true),
    }
    if state.enabled && queue.is_idle() && !editing && state.error.is_none() {
        let offline_due = state
            .offline_since
            .is_some_and(|t| now.duration_since(t) >= GRACE);
        let online_due = state
            .online_since
            .is_some_and(|t| now.duration_since(t) >= RECOVERY);
        let restore = online_due && state.saved.active && !state.saved.manual;
        if restore || (offline_due && !state.saved.active && !state.handled) {
            if let Err(error) = enqueue(queue, &mut state, restore, true) {
                state.error = Some(error);
            }
        }
    }
    queue.rescue = Some(state);
}

/// NetworkManager reports DHCP/static addresses; carrier rules out a USB gadget
/// profile that remains activated with no host. No DNS or internet probes.
fn classify_network(
    output: &str,
    mut carrier: impl FnMut(&str) -> Result<bool, String>,
) -> Result<bool, String> {
    let mut saw_device = false;
    let mut uncertainty = None;
    for block in output.trim().split("\n\n") {
        let fields: Vec<_> = block
            .lines()
            .filter_map(|line| line.split_once(':'))
            .collect();
        let get = |key| fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
        let Some(device) = get("GENERAL.DEVICE") else {
            return Err("Malformed NetworkManager output".into());
        };
        saw_device = true;
        let kind = get("GENERAL.TYPE").ok_or("Missing NetworkManager device type")?;
        if !matches!(kind, "wifi" | "ethernet") {
            continue;
        }
        let state = get("GENERAL.STATE").ok_or("Missing NetworkManager state")?;
        let number = state
            .split_whitespace()
            .next()
            .ok_or("Missing state code")?
            .parse::<u16>()
            .map_err(|e| e.to_string())?;
        if number != 100 {
            continue;
        }
        let has_address = fields.iter().any(|(key, value)| {
            if !key.starts_with("IP4.ADDRESS[") && !key.starts_with("IP6.ADDRESS[") {
                return false;
            }
            let address = value.split('/').next().unwrap_or("").replace("\\:", ":");
            match address.parse::<IpAddr>() {
                Ok(IpAddr::V4(ip)) => {
                    !ip.is_loopback()
                        && !ip.is_link_local()
                        && !ip.is_unspecified()
                        && !ip.is_multicast()
                }
                Ok(IpAddr::V6(ip)) => {
                    !ip.is_loopback()
                        && !ip.is_unspecified()
                        && !ip.is_unicast_link_local()
                        && !ip.is_multicast()
                }
                Err(_) => {
                    uncertainty = Some("Invalid NetworkManager address".into());
                    false
                }
            }
        });
        if has_address {
            match carrier(device) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(e) => uncertainty = Some(e),
            }
        }
    }
    if !saw_device {
        return Err("No NetworkManager device status".into());
    }
    match uncertainty {
        Some(e) => Err(e),
        None => Ok(false),
    }
}

async fn probe() -> Result<bool, String> {
    let mut command = tokio::process::Command::new("nmcli");
    command
        .env("LC_ALL", "C")
        .args([
            "-t",
            "-f",
            "GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,IP4.ADDRESS,IP6.ADDRESS",
            "device",
            "show",
        ])
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "Network probe timed out")?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("NetworkManager status failed".into());
    }
    let output = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    classify_network(&output, |device| {
        if device.contains('/') || device == "." || device == ".." {
            return Err("Invalid interface name".into());
        }
        fs::read_to_string(format!("/sys/class/net/{device}/carrier"))
            .map_err(|e| e.to_string())
            .and_then(|value| match value.trim() {
                "1" => Ok(true),
                "0" => Ok(false),
                _ => Err("Invalid carrier status".into()),
            })
    })
}

pub fn spawn(
    queue: FlashQueueState,
    orientation: OrientationState,
    locks: ImageLocksState,
    mut shutdown: rocket::Shutdown,
) {
    tokio::spawn(async move {
        loop {
            if queue
                .lock()
                .await
                .rescue
                .as_ref()
                .is_some_and(|r| r.enabled)
            {
                let sample = probe().await;
                let _orientation = orientation.lock().await;
                let mut queue = queue.lock().await;
                let locks = locks.lock().await;
                let now = Instant::now();
                tick(
                    &mut queue,
                    sample,
                    locks.values().any(|l| l.expires_at > now),
                    now,
                );
            }
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(10)) => {}, _ = &mut shutdown => break }
        }
    });
}

#[get("/api/rescue")]
pub async fn status(queue: &State<FlashQueueState>) -> Json<Value> {
    Json(
        queue
            .lock()
            .await
            .rescue
            .as_ref()
            .map(|r| r.status())
            .unwrap_or(json!({"enabled":false})),
    )
}

#[post("/api/rescue/<action>")]
pub async fn control(
    _origin: BrowserWrite,
    action: &str,
    queue: &State<FlashQueueState>,
    orientation: &State<OrientationState>,
    locks: &State<ImageLocksState>,
) -> Result<Json<Value>, (Status, Json<Value>)> {
    let fail = |status, message: &str| (status, Json(json!({"success":false,"message":message})));
    if !matches!(action, "show" | "restore") {
        return Err(fail(Status::BadRequest, "Choose show or restore"));
    }
    let _orientation = orientation.lock().await;
    let mut queue = queue.lock().await;
    let locks = locks.lock().await;
    if !queue.is_idle() || locks.values().any(|l| l.expires_at > Instant::now()) {
        return Err(fail(
            Status::Conflict,
            "Wait for the display and photo editors to finish",
        ));
    }
    let Some(mut state) = queue.rescue.take() else {
        return Err(fail(Status::ServiceUnavailable, "Rescue is unavailable"));
    };
    let result = enqueue(&mut queue, &mut state, action == "restore", false);
    if result.is_ok() {
        state.error = None;
    }
    queue.rescue = Some(state);
    result
        .map(|id| Json(json!({"success":true,"job_id":id})))
        .map_err(|e| fail(Status::Conflict, &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(kind: &str, state: &str, addresses: &str) -> String {
        format!("GENERAL.DEVICE:usb0\nGENERAL.TYPE:{kind}\nGENERAL.STATE:{state}\n{addresses}\n")
    }
    #[test]
    fn network_requires_carrier_and_routable_local_address_not_internet() {
        let usb = device("ethernet", "100 (connected)", "IP4.ADDRESS[1]:10.55.0.1/24");
        assert_eq!(classify_network(&usb, |_| Ok(true)), Ok(true));
        assert_eq!(classify_network(&usb, |_| Ok(false)), Ok(false));
        assert!(classify_network(&usb, |_| Err("unknown carrier".into())).is_err());
        for kind in ["wifi", "ethernet"] {
            for address in ["192.168.1.109/24", "10.55.0.1/24", "fd12::123/64"] {
                assert_eq!(
                    classify_network(
                        &device(
                            kind,
                            "100 (connected)",
                            &format!("IP4.ADDRESS[1]:{address}")
                        ),
                        |_| Ok(true)
                    ),
                    Ok(true)
                );
            }
            for address in [
                "169.254.1.2/16",
                "127.0.0.1/8",
                "0.0.0.0/0",
                "fe80::123/64",
                "::1/128",
            ] {
                assert_eq!(
                    classify_network(
                        &device(
                            kind,
                            "100 (connected)",
                            &format!("IP4.ADDRESS[1]:{address}")
                        ),
                        |_| Ok(true)
                    ),
                    Ok(false)
                );
            }
        }
        assert_eq!(
            classify_network(
                &device("wifi", "30 (disconnected)", "IP4.ADDRESS[1]:192.168.1.2/24"),
                |_| Ok(true)
            ),
            Ok(false)
        );
        assert_eq!(
            classify_network(
                &device("loopback", "100 (connected)", "IP4.ADDRESS[1]:10.1.2.3/24"),
                |_| Ok(true)
            ),
            Ok(false)
        );
        assert!(classify_network(
            &device("wifi", "100 (connected)", "IP4.ADDRESS[1]:garbage"),
            |_| Ok(true)
        )
        .is_err());
        assert!(classify_network("", |_| Ok(true)).is_err());
        assert!(classify_network("unexpected output", |_| Ok(true)).is_err());
        assert!(classify_network(&device("wifi", "bad", ""), |_| Ok(true)).is_err());
        // A failed carrier read on one interface cannot hide another live interface.
        let joined = format!(
            "{usb}\n{}",
            device("wifi", "100 (connected)", "IP4.ADDRESS[1]:192.168.1.1/24")
                .replace("usb0", "wlan0")
        );
        assert_eq!(
            classify_network(&joined, |dev| if dev == "wlan0" {
                Ok(true)
            } else {
                Err("missing".into())
            }),
            Ok(true)
        );
    }
    #[test]
    fn network_detection_agrees_with_provisioning_fixtures() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../yocto/pi-base/wifi-provisioner/tests/fixtures/connectivity.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let connected = classify_network(case["output"].as_str().unwrap(), |device| {
                case["carrier"][device]
                    .as_bool()
                    .ok_or_else(|| "carrier unavailable".into())
            });
            if case["rescue_connected"].is_null() {
                assert!(connected.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    connected.unwrap(),
                    case["rescue_connected"].as_bool().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn transient_and_unknown_samples_restart_the_grace_period() {
        let directory =
            std::env::temp_dir().join(format!("inky-rescue-observe-{}", std::process::id()));
        let mut state = Rescue::load(directory.clone(), true);
        let start = Instant::now();
        state.observe(Ok(false), start);
        state.observe(Ok(false), start + Duration::from_secs(200));
        assert_eq!(state.offline_since, Some(start));
        state.observe(Err("timeout".into()), start + Duration::from_secs(290));
        assert_eq!(state.offline_since, None);
        assert_eq!(state.connected, None);
        state.observe(Ok(false), start + GRACE);
        assert_eq!(state.offline_since, Some(start + GRACE));
        state.observe(Ok(true), start + GRACE + Duration::from_secs(1));
        assert_eq!(state.offline_since, None);
        assert!(state.online_since.is_some());
        fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::flash_queue::FlashJobStatus;

    fn fixture() -> (Rescue, FlashJob) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "inky-rescue-persistence-{}-{unique}",
            std::process::id()
        ));
        let state = Rescue::load(directory.clone(), false);
        let job = FlashJob {
            automatic_recovery: false,
            rescue_display: Some(DisplayStamp {
                model: "impression-13.3-2025".into(),
                width: 1600,
                height: 1200,
                rotation: 0,
                revision: 0,
            }),
            source: FlashSource::Manual,
            job_id: 1,
            filename: "photo.png".into(),
            dithered_path: directory.join("source.png").to_string_lossy().into(),
            flash_twice: false,
            rotation_degrees: 0,
            status: FlashJobStatus::Flashing,
            created_at: 100,
            started_at: None,
            finished_at: None,
            error_message: None,
        };
        (state, job)
    }

    fn complete(state: &mut Rescue, job: &FlashJob, pixels: &[u8]) {
        fs::write(&job.dithered_path, pixels).unwrap();
        state.before_flash(job).unwrap();
        state.finished(job, true);
    }

    fn previous(state: &Rescue) -> Option<Vec<u8>> {
        state
            .saved
            .previous
            .as_ref()
            .map(|p| fs::read(state.directory.join(&p.file)).unwrap())
    }

    #[test]
    fn failed_refresh_cannot_bless_a_stale_manifest_after_backup_failure() {
        for backup_failure in ["manifest", "snapshot"] {
            for later_failure in ["display", "intent", "manifest"] {
                let (mut state, mut job) = fixture();
                let directory = state.directory.clone();
                complete(&mut state, &job, b"photo A");
                assert!(state.error.is_none());

                // B physically succeeds, but cannot save either its PNG or manifest.
                job.job_id = 2;
                let obstruction = directory.join(if backup_failure == "manifest" {
                    "state.tmp"
                } else {
                    "image-100-2.tmp"
                });
                fs::create_dir(&obstruction).unwrap();
                complete(&mut state, &job, b"photo B");
                assert!(state.error.is_some());
                assert!(directory.join("normal-in-progress").exists());
                fs::remove_dir(obstruction).unwrap();

                // C fails. It must not clear B's marker while A is still on disk.
                job.job_id = 3;
                let obstruction = directory.join(match later_failure {
                    "intent" => "normal-in-progress.tmp",
                    _ => "state.tmp",
                });
                if later_failure != "display" {
                    fs::create_dir(&obstruction).unwrap();
                }
                let prepared = state.before_flash(&job);
                assert_eq!(prepared.is_err(), later_failure == "intent");
                state.finished(&job, false);
                if later_failure == "manifest" {
                    assert!(directory.join("normal-in-progress").exists());
                }
                if later_failure != "display" {
                    fs::remove_dir(obstruction).unwrap();
                }

                let restarted = Rescue::load(directory.clone(), false);
                let expected = if backup_failure == "manifest" && later_failure != "manifest" {
                    Some(b"photo B".to_vec())
                } else {
                    None
                };
                assert_eq!(
                    previous(&restarted),
                    expected,
                    "{backup_failure}/{later_failure}"
                );
                // The invalidation must itself survive another restart.
                let restarted = Rescue::load(directory.clone(), false);
                assert_eq!(previous(&restarted), expected);
                fs::remove_dir_all(directory).unwrap();
            }
        }
    }

    #[test]
    fn a_failed_refresh_preserves_a_committed_previous_image() {
        let (mut state, mut job) = fixture();
        complete(&mut state, &job, b"photo A");
        job.job_id = 2;
        state.before_flash(&job).unwrap();
        state.finished(&job, false);
        assert!(!state.directory.join("normal-in-progress").exists());
        let restarted = Rescue::load(state.directory.clone(), false);
        assert_eq!(previous(&restarted), Some(b"photo A".to_vec()));
        fs::remove_dir_all(state.directory).unwrap();
    }

    #[test]
    fn successful_refresh_or_rescue_commits_the_latest_state_before_clearing_marker() {
        for source in [
            FlashSource::Manual,
            FlashSource::Rescue,
            FlashSource::Restore,
        ] {
            let (mut state, mut job) = fixture();
            complete(&mut state, &job, b"photo A");
            fs::create_dir(state.directory.join("state.tmp")).unwrap();
            job.job_id = 2;
            complete(&mut state, &job, b"photo B");
            assert!(state.directory.join("normal-in-progress").exists());
            fs::remove_dir(state.directory.join("state.tmp")).unwrap();
            job.job_id = 3;
            job.source = source;
            complete(&mut state, &job, b"photo C");
            assert!(state.error.is_none());
            assert!(!state.directory.join("normal-in-progress").exists());
            let restarted = Rescue::load(state.directory.clone(), false);
            assert_eq!(
                previous(&restarted),
                Some(
                    if source == FlashSource::Manual {
                        b"photo C"
                    } else {
                        b"photo B"
                    }
                    .to_vec()
                )
            );
            assert_eq!(restarted.saved.active, source == FlashSource::Rescue);
            fs::remove_dir_all(state.directory).unwrap();
        }
    }
}
