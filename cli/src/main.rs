use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use image::{DynamicImage, ImageFormat};
use reqwest::blocking::{multipart, Client, Response};
use reqwest::Url;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

mod deploy;
mod discovery;
mod display_setup;
mod preview;
mod ssh;
mod test_card;

#[derive(Parser)]
#[command(
    version,
    about = "Control an Inky Soup frame over USB Ethernet or local WiFi"
)]
struct Args {
    /// Device origin; USB defaults to 10.55.0.1. No credentials or path.
    #[arg(
        long,
        global = true,
        env = "INKY_SOUP_URL",
        default_value = "http://10.55.0.1:8000"
    )]
    device: String,
    /// Emit a single JSON result on stdout. Progress stays on stderr.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Display configuration and current queue.
    Status,
    /// Stable device identity, server instance, and supported capabilities.
    Identity,
    /// Find local frames via Avahi and verify their identity API.
    Discover,
    /// Open, close, or inspect the Bluetooth WiFi setup window over SSH.
    WifiSetup {
        #[arg(value_enum)]
        action: SetupAction,
        #[arg(long, default_value = "inky")]
        ssh_user: String,
    },
    /// Check whether the device permits a browser app origin.
    BrowserCheck {
        #[arg(long, default_value = "https://allan.pizza")]
        origin: String,
    },
    /// Temporarily run a preview server/origin; stop or reboot restores normal service.
    Preview {
        #[arg(value_enum)]
        action: SetupAction,
        #[arg(long, default_value = "http://localhost:4175")]
        origin: String,
        /// Executable already copied to this absolute path on the Pi.
        #[arg(long, default_value = "/usr/bin/inky-soup-server")]
        server_binary: String,
        #[arg(long, default_value = "inky")]
        ssh_user: String,
    },
    /// Install a staged server, display script, and UI bundle over SSH.
    Deploy {
        /// Absolute directory already copied to the Pi; see cli/README.md.
        #[arg(long)]
        bundle: String,
        #[arg(long, default_value = "inky")]
        ssh_user: String,
    },
    /// Display model and exact pixel dimensions.
    Display,
    /// Read or set the clockwise mounting orientation (0, 90, 180, 270).
    Orientation {
        #[arg(value_parser = parse_orientation)]
        degrees: Option<u16>,
    },
    /// Configure a new frame's physical panel over SSH, before uploading photos.
    DisplaySetup {
        #[arg(value_enum, default_value = "auto")]
        model: display_setup::DisplayModel,
        #[arg(long, default_value = "inky")]
        ssh_user: String,
    },
    /// Display an edge-labeled orientation card without adding it to the gallery.
    OrientationTest {
        /// Save the PNG locally instead of refreshing the frame.
        #[arg(long)]
        output: Option<PathBuf>,
        #[arg(long, conflicts_with = "output")]
        wait: bool,
        #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..))]
        timeout: u64,
    },
    /// Read or set a photo's clockwise rotation; the app rebuilds its saved previews.
    Rotate {
        filename: String,
        #[arg(value_parser = parse_orientation)]
        degrees: Option<u16>,
    },
    /// Mark or unmark a photo as a slideshow favorite.
    Favorite {
        filename: String,
        #[arg(value_enum)]
        value: FavoriteValue,
    },
    /// List favorite photos, including whether they need processing.
    Favorites,
    /// Inspect or configure automatic rotation through favorite photos.
    Slideshow {
        #[command(subcommand)]
        action: Option<SlideshowCommand>,
    },
    /// Inspect offline recovery or explicitly show/restore its instruction card.
    Rescue {
        #[arg(value_enum, default_value = "status")]
        action: RescueAction,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..))]
        timeout: u64,
    },
    /// List images and their saved settings.
    Images,
    /// Delete an original and its saved versions; refuses locked or pending photos.
    Delete { filename: String },
    /// Upload an original, or a validated display-ready PNG with --prepared.
    Upload {
        file: PathBuf,
        /// Input is an opaque PNG with exact display dimensions and native palette colors.
        #[arg(long)]
        prepared: bool,
        /// Save a clockwise source rotation. Open the app to generate display pixels.
        #[arg(long, value_parser = parse_orientation, conflicts_with = "prepared")]
        rotate: Option<u16>,
        /// Queue the prepared image after uploading it.
        #[arg(long, requires = "prepared")]
        flash: bool,
        /// Wait for the queued display job to complete.
        #[arg(long, requires = "flash")]
        wait: bool,
        #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..))]
        timeout: u64,
    },
    /// Flash an existing image that already has a prepared dithered PNG.
    Flash {
        filename: String,
        #[arg(long)]
        twice: bool,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..))]
        timeout: u64,
    },
    /// Inspect or wait for a display job. Does not resubmit it.
    Job {
        id: u64,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 180, value_parser = clap::value_parser!(u64).range(1..))]
        timeout: u64,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum RescueAction {
    Status,
    Show,
    Restore,
}

#[derive(Clone, Copy, ValueEnum)]
enum FavoriteValue {
    On,
    Off,
}

#[derive(Subcommand)]
enum SlideshowCommand {
    /// Show settings, next due time, next photo, and any pause reason.
    Status,
    /// Enable automatic rotation; optionally change the interval.
    Start {
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=168))]
        hours: Option<u16>,
    },
    /// Stop automatic rotation (an already queued refresh will finish).
    Stop,
    /// Change the interval without enabling or disabling rotation.
    Interval {
        #[arg(value_parser = clap::value_parser!(u16).range(1..=168))]
        hours: u16,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum SetupAction {
    Start,
    Stop,
    Status,
}

struct Frame {
    client: Client,
    base: Url,
}

fn device_url(input: &str) -> Result<Url> {
    let input = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{input}")
    };
    let mut url = Url::parse(&input).context("Invalid device address")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Use an HTTP(S) device origin without credentials, path, query, or fragment");
    }
    let authority = input
        .split_once("://")
        .unwrap()
        .1
        .split('/')
        .next()
        .unwrap();
    let explicit_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok());
    if url.port().is_none() && !explicit_port {
        url.set_port(Some(8000))
            .map_err(|_| anyhow::anyhow!("Invalid port"))?;
    }
    Ok(url)
}

fn parse_orientation(input: &str) -> std::result::Result<u16, String> {
    match input.parse::<u16>() {
        Ok(value @ (0 | 90 | 180 | 270)) => Ok(value),
        _ => Err("Choose 0, 90, 180, or 270 degrees".into()),
    }
}

fn decoded(response: Response) -> Result<Value> {
    let status = response.status();
    let bytes = response.bytes()?;
    let value: Value = serde_json::from_slice(&bytes)
        .context(format!("Device returned non-JSON HTTP {status}"))?;
    if !status.is_success() || value.get("success") == Some(&Value::Bool(false)) {
        bail!(
            "Device request failed ({status}): {}",
            value.get("message").unwrap_or(&value)
        );
    }
    Ok(value)
}

impl Frame {
    fn new(device: &str) -> Result<Self> {
        Ok(Self {
            base: device_url(device)?,
            client: Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    fn get(&self, path: &str) -> Result<Value> {
        self.get_with_timeout(path, Duration::from_secs(60))
    }
    fn get_with_timeout(&self, path: &str, timeout: Duration) -> Result<Value> {
        decoded(
            self.client
                .get(self.base.join(path)?)
                .timeout(timeout)
                .send()
                .context("Cannot reach frame")?,
        )
    }
    fn json_post(&self, path: &str, body: &Value) -> Result<Value> {
        decoded(self.client.post(self.base.join(path)?).json(body).send()?)
    }
    fn multipart(&self, path: &str, form: multipart::Form) -> Result<Value> {
        decoded(
            self.client
                .post(self.base.join(path)?)
                .multipart(form)
                .send()?,
        )
    }
    fn lock(&self, filename: &str, session: &str) -> Result<()> {
        let value = self.json_post(
            "api/lock-image",
            &json!({"filename":filename,"session_id":session}),
        )?;
        if value["locked"] != true {
            bail!("Image is locked: {}", value["reason"]);
        }
        Ok(())
    }
    fn unlock(&self, filename: &str, session: &str) {
        if let Err(error) = self.json_post(
            "api/unlock-image",
            &json!({"filename":filename,"session_id":session}),
        ) {
            eprintln!("Could not release image lock; it will expire: {error}");
        }
    }
    fn queue(&self, filename: &str, session: &str, twice: bool) -> Result<Value> {
        let config = self.get("api/display-config")?;
        let photo_revision = if config["photo_rotation_supported"] == true {
            let images = self.get("api/images")?;
            images
                .as_array()
                .context("Invalid gallery")?
                .iter()
                .find(|photo| photo["filename"] == filename)
                .context("Photo not found")?["photo_rotation_revision"]
                .as_u64()
                .context("Missing photo revision")?
        } else {
            0
        };
        self.multipart("flash", multipart::Form::new()
            .text("submission.photo_rotation_revision", photo_revision.to_string())
            .text("submission.rotation_revision", config["rotation_revision"].as_u64().unwrap_or(0).to_string())
            .text("submission.filename", filename.to_owned())
            .text("submission.image_file_path", format!("images/dithered/{filename}.png"))
            .text("submission.session_id", session.to_owned())
            .text("submission.flash_twice", twice.to_string()))
            .context("Flash submission failed; check status before retrying because the request may have arrived")
    }
    fn wait(&self, id: u64, timeout: u64, filename: Option<&str>) -> Result<Value> {
        let started = Instant::now();
        let limit = Duration::from_secs(timeout);
        let timed_out = || {
            anyhow::anyhow!("Timed out waiting for job {id}; it may still be running. Inspect with `inky-cli job {id}`")
        };
        let mut identity = None;
        let mut previous = String::new();
        loop {
            let remaining = limit.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(timed_out());
            }
            let job = self
                .get_with_timeout(
                    &format!("api/flash/status/{id}"),
                    remaining.min(Duration::from_secs(60)),
                )
                .map_err(|error| {
                    if started.elapsed() >= limit {
                        timed_out()
                    } else {
                        error
                    }
                })?;
            let current = (job["filename"].clone(), job["created_at"].clone());
            if filename.is_some_and(|name| job["filename"] != name)
                || identity.as_ref().is_some_and(|old| old != &current)
            {
                bail!("Job identity changed; the frame may have restarted. Check the display before retrying");
            }
            identity = Some(current);
            let status = job["status"].as_str().context("Job has no status")?;
            if status != previous {
                eprintln!("Job {id}: {status}");
                previous = status.to_owned();
            }
            match status {
                "Completed" => return Ok(job),
                "Failed" => bail!("Job {id} failed: {}", job["error_message"]),
                "Queued" | "Flashing" => {}
                _ => bail!("Unknown job status: {status}"),
            }
            thread::sleep(Duration::from_secs(1).min(limit.saturating_sub(started.elapsed())));
        }
    }
}

fn valid_filename(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\']) {
        bail!("Use a gallery filename, not a path");
    }
    Ok(())
}

fn validate_prepared(bytes: &[u8], config: &Value) -> Result<DynamicImage> {
    if image::guess_format(bytes)? != ImageFormat::Png {
        bail!("Prepared images must be PNG");
    }
    let image = image::load_from_memory_with_format(bytes, ImageFormat::Png)?;
    if Some(image.width() as u64) != config["width"].as_u64()
        || Some(image.height() as u64) != config["height"].as_u64()
    {
        bail!(
            "Prepared image must match the display's {} × {} pixels",
            config["width"],
            config["height"]
        );
    }
    let mut palette = vec![
        [0, 0, 0],
        [255, 255, 255],
        [255, 255, 0],
        [255, 0, 0],
        [0, 0, 255],
        [0, 255, 0],
    ];
    match config["model"].as_str() {
        Some("impression-5.7") => palette.push([255, 140, 0]),
        Some("impression-13.3-2025") => {}
        _ => bail!("Unsupported display model"),
    }
    for pixel in image.to_rgba8().pixels() {
        if pixel[3] != 255 || !palette.contains(&[pixel[0], pixel[1], pixel[2]]) {
            bail!("Prepared image contains transparency or colors outside the display palette");
        }
    }
    Ok(image)
}

fn run(args: &Args) -> Result<Value> {
    let frame = Frame::new(&args.device)?;
    match &args.command {
        Command::Identity => frame.get("api/device"),
        Command::Discover => discovery::run(),
        Command::Status => Ok(
            json!({"device":frame.base.as_str(),"display":frame.get("api/display-config")?,"flash":frame.get("api/flash/status")?}),
        ),
        Command::Deploy { bundle, ssh_user } => deploy::run(
            frame.base.host_str().context("Missing device host")?,
            ssh_user,
            bundle,
        ),
        Command::Preview {
            action,
            origin,
            server_binary,
            ssh_user,
        } => {
            if !matches!(action, SetupAction::Status) {
                match frame.get("api/flash/status") {
                    Ok(queue) => {
                        let active = queue["current_job"]["status"].as_str();
                        if matches!(active, Some("Queued" | "Flashing"))
                            || queue["queue_length"].as_u64().unwrap_or(0) > 0
                        {
                            bail!("Wait for queued display jobs to finish before changing the preview server");
                        }
                    }
                    Err(error) if matches!(action, SetupAction::Start) => return Err(error),
                    // A broken preview must still be recoverable over SSH.
                    Err(_) => {}
                }
            }
            preview::run(
                frame.base.host_str().context("Missing device host")?,
                ssh_user,
                *action,
                origin,
                server_binary,
            )
        }
        Command::WifiSetup { action, ssh_user } => {
            if ssh_user.is_empty()
                || !ssh_user
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            {
                bail!("SSH user must contain only letters, digits, underscores, or hyphens");
            }
            let host = frame
                .base
                .host_str()
                .context("Missing device host")?
                .trim_matches(['[', ']']);
            let target = format!("{ssh_user}@{host}");
            let flag = match action {
                SetupAction::Start => "--start",
                SetupAction::Stop => "--stop",
                SetupAction::Status => "--status",
            };
            let output = std::process::Command::new("ssh")
                .args([
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=5",
                    "-o",
                    "ServerAliveInterval=5",
                    "-o",
                    "ServerAliveCountMax=2",
                    "--",
                    &target,
                    "sudo",
                    "-n",
                    "wifi-provisioner",
                    flag,
                ])
                .output()
                .context("Could not run ssh; install OpenSSH and configure device key access")?;
            if !output.status.success() {
                bail!(
                    "WiFi setup SSH command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            let status: Value = serde_json::from_slice(&output.stdout)
                .context("Provisioner returned invalid JSON")?;
            if status["ok"] != true {
                bail!("WiFi setup command failed: {status}");
            }
            Ok(status)
        }
        Command::BrowserCheck { origin } => {
            let url = Url::parse(origin).context("Use a complete HTTP(S) browser origin")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                bail!(
                    "Use an HTTP(S) browser origin without credentials, path, query, or fragment"
                );
            }
            let origin = url.origin().ascii_serialization();
            let read = frame
                .client
                .get(frame.base.join("api/display-config")?)
                .header("Origin", &origin)
                .send()
                .context("Cannot reach frame")?;
            let preflight = frame
                .client
                .request(reqwest::Method::OPTIONS, frame.base.join("api/lock-image")?)
                .header("Origin", &origin)
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type")
                .send()?;
            let allowed = |response: &Response| {
                response.status().is_success()
                    && response
                        .headers()
                        .get("Access-Control-Allow-Origin")
                        .and_then(|v| v.to_str().ok())
                        == Some(origin.as_str())
            };
            let allows_header_token = |name: &str, token: &str| {
                preflight
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|value| {
                        value
                            .split(',')
                            .any(|part| part.trim().eq_ignore_ascii_case(token))
                    })
            };
            if !allowed(&read)
                || !allowed(&preflight)
                || !allows_header_token("Access-Control-Allow-Methods", "POST")
                || !allows_header_token("Access-Control-Allow-Headers", "content-type")
            {
                bail!("Browser origin {origin} is not allowed: read HTTP {}, preflight HTTP {}. Check INKY_SOUP_CLIENT_ORIGINS on the frame", read.status(), preflight.status());
            }
            Ok(
                json!({"device":frame.base.as_str(),"origin":origin,"read_status":read.status().as_u16(),"preflight_status":preflight.status().as_u16(),"allowed":true}),
            )
        }
        Command::Display => frame.get("api/display-config"),
        Command::Orientation { degrees } => {
            let config = frame.get("api/display-config")?;
            match degrees {
                None => Ok(config),
                Some(degrees) => {
                    let revision = config["rotation_revision"]
                        .as_u64()
                        .context("Update the frame server to support orientation")?;
                    frame.json_post(
                        "api/settings/display-rotation",
                        &json!({"rotation_degrees":degrees,"expected_revision":revision}),
                    )
                }
            }
        }
        Command::DisplaySetup { model, ssh_user } => display_setup::run(
            frame.base.host_str().context("Missing device host")?,
            ssh_user,
            *model,
        ),
        Command::OrientationTest {
            output,
            wait,
            timeout,
        } => {
            let config = frame.get("api/display-config")?;
            let png = test_card::render(&config)?;
            if let Some(path) = output {
                std::fs::write(path, png)?;
                return Ok(
                    json!({"output":path,"width":config["width"],"height":config["height"]}),
                );
            }
            if config["orientation_test_supported"] != true {
                bail!("Update the frame server to support orientation test cards");
            }
            let queued = frame.multipart(
                "api/flash-test-card",
                multipart::Form::new()
                    .text(
                        "rotation_revision",
                        config["rotation_revision"]
                            .as_u64()
                            .context("Missing orientation revision")?
                            .to_string(),
                    )
                    .part(
                        "file",
                        multipart::Part::bytes(png)
                            .file_name("orientation-test-card.png")
                            .mime_str("image/png")?,
                    ),
            )?;
            if *wait {
                frame.wait(
                    queued["job_id"].as_u64().context("Missing job ID")?,
                    *timeout,
                    Some("orientation-test-card.png"),
                )
            } else {
                Ok(queued)
            }
        }
        Command::Rotate { filename, degrees } => {
            valid_filename(filename)?;
            let session = uuid::Uuid::new_v4().to_string();
            if degrees.is_some() {
                frame.lock(filename, &session)?;
            }
            let result = (|| -> Result<Value> {
                let images = frame.get("api/images")?;
                let photo = images
                    .as_array()
                    .context("Invalid gallery")?
                    .iter()
                    .find(|photo| photo["filename"] == *filename)
                    .context("Photo not found")?;
                let revision = photo["photo_rotation_revision"]
                    .as_u64()
                    .context("Update the frame server to support photo rotation")?;
                match degrees {
                    None => Ok(photo.clone()),
                    Some(degrees) => frame.json_post(
                        "api/settings/photo-rotation",
                        &json!({"filename":filename,"session_id":session,
                        "photo_rotation_degrees":degrees,"expected_revision":revision}),
                    ),
                }
            })();
            if degrees.is_some() {
                frame.unlock(filename, &session);
            }
            result
        }
        Command::Favorite { filename, value } => {
            valid_filename(filename)?;
            let session = uuid::Uuid::new_v4().to_string();
            frame.lock(filename, &session)?;
            let result = frame.json_post("api/settings/favorite",
                &json!({"filename":filename,"session_id":session,"favorite":matches!(value, FavoriteValue::On)}));
            frame.unlock(filename, &session);
            result
        }
        Command::Favorites => {
            let gallery = frame.get("api/images")?;
            let images = gallery.as_array().context("Invalid gallery")?;
            if images.iter().any(|image| !image["favorite"].is_boolean()) {
                bail!("Update the frame server to support favorites");
            }
            Ok(json!(images
                .iter()
                .filter(|image| image["favorite"] == true)
                .collect::<Vec<_>>()))
        }
        Command::Slideshow { action } => match action {
            None | Some(SlideshowCommand::Status) => frame.get("api/slideshow"),
            Some(SlideshowCommand::Start { hours }) => {
                let mut settings = json!({"rotation_enabled":true});
                if let Some(hours) = hours {
                    settings["rotation_interval_hours"] = json!(hours);
                }
                frame.json_post("api/settings/slideshow", &settings)
            }
            Some(SlideshowCommand::Stop) => {
                frame.json_post("api/settings/slideshow", &json!({"rotation_enabled":false}))
            }
            Some(SlideshowCommand::Interval { hours }) => frame.json_post(
                "api/settings/slideshow",
                &json!({"rotation_interval_hours":hours}),
            ),
        },
        Command::Rescue {
            action,
            wait,
            timeout,
        } => {
            let endpoint = match action {
                RescueAction::Status => return frame.get("api/rescue"),
                RescueAction::Show => "api/rescue/show",
                RescueAction::Restore => "api/rescue/restore",
            };
            let queued = frame.json_post(endpoint, &json!({}))?;
            if *wait {
                frame.wait(
                    queued["job_id"].as_u64().context("Missing job ID")?,
                    *timeout,
                    None,
                )
            } else {
                Ok(queued)
            }
        }
        Command::Images => frame.get("api/images"),
        Command::Delete { filename } => {
            valid_filename(filename)?;
            let session = uuid::Uuid::new_v4().to_string();
            frame.lock(filename, &session)?;
            let result = frame.json_post(
                "api/delete-image",
                &json!({"filename":filename,"session_id":session}),
            );
            frame.unlock(filename, &session);
            result
        }
        Command::Job { id, wait, timeout } => {
            if *wait {
                frame.wait(*id, *timeout, None)
            } else {
                frame.get(&format!("api/flash/status/{id}"))
            }
        }
        Command::Flash {
            filename,
            twice,
            wait,
            timeout,
        } => {
            valid_filename(filename)?;
            let session = uuid::Uuid::new_v4().to_string();
            frame.lock(filename, &session)?;
            let queued = frame.queue(filename, &session, *twice);
            frame.unlock(filename, &session);
            let queued = queued?;
            if *wait {
                frame.wait(
                    queued["job_id"].as_u64().context("Missing job ID")?,
                    *timeout,
                    Some(filename),
                )
            } else {
                Ok(queued)
            }
        }
        Command::Upload {
            file,
            prepared,
            rotate,
            flash,
            wait,
            timeout,
        } => {
            let bytes = std::fs::read(file).context("Cannot read image")?;
            if bytes.len() > 20 * 1024 * 1024 {
                bail!("Images must be at most 20 MiB");
            }
            let config = if *prepared || rotate.is_some() {
                Some(frame.get("api/display-config")?)
            } else {
                None
            };
            if rotate.is_some() && config.as_ref().unwrap()["photo_rotation_supported"] != true {
                bail!("Update the frame server to support photo rotation");
            }
            let ready = config
                .as_ref()
                .filter(|_| *prepared)
                .map(|c| validate_prepared(&bytes, c))
                .transpose()?;
            let extension = if *prepared {
                "png"
            } else {
                file.extension().and_then(|s| s.to_str()).unwrap_or("jpg")
            };
            let filename = format!("{}.{}", uuid::Uuid::new_v4(), extension);
            valid_filename(&filename)?;
            let session = uuid::Uuid::new_v4().to_string();
            if *prepared || rotate.is_some() {
                // Reserve the name before the original becomes visible to
                // clients that rebuild missing derived images automatically.
                frame.lock(&filename, &session)?;
            }
            let upload = frame.multipart(
                "upload",
                multipart::Form::new().part(
                    "submission.file",
                    multipart::Part::bytes(bytes.clone())
                        .file_name(filename.clone())
                        .mime_str(match extension.to_ascii_lowercase().as_str() {
                            "png" => "image/png",
                            "webp" => "image/webp",
                            "gif" => "image/gif",
                            _ => "image/jpeg",
                        })?,
                ),
            );
            let upload = match upload {
                Ok(upload) if upload["filename"] == filename => upload,
                result => {
                    if *prepared || rotate.is_some() {
                        frame.unlock(&filename, &session);
                    }
                    result?;
                    bail!("Device returned an unexpected filename");
                }
            };
            if let Some(degrees) = rotate {
                let result = (|| -> Result<Value> {
                    // Uploading can outlast the edit lease. Reacquire it before
                    // changing metadata, and respect any editor who took over.
                    frame.lock(&filename, &session)?;
                    frame.json_post(
                        "api/settings/photo-rotation",
                        &json!({"filename":filename,"session_id":session,
                        "photo_rotation_degrees":degrees,"expected_revision":0}),
                    )
                })();
                frame.unlock(&filename, &session);
                return result.with_context(|| {
                    format!("Original saved as {filename}; rotation was not confirmed")
                });
            }
            if let (Some(image), Some(config)) = (ready, config) {
                let result = (|| -> Result<Value> {
                    let mut thumb = Cursor::new(Vec::new());
                    image
                        .thumbnail(
                            config["thumb_width"]
                                .as_u64()
                                .context("Missing thumbnail width")?
                                as u32,
                            config["thumb_height"]
                                .as_u64()
                                .context("Missing thumbnail height")?
                                as u32,
                        )
                        .write_to(&mut thumb, ImageFormat::Png)?;
                    for (path, data) in [
                        ("api/upload-cache", bytes.clone()),
                        ("api/upload-thumb", thumb.into_inner()),
                        ("api/upload-dithered", bytes),
                    ] {
                        frame.lock(&filename, &session)?;
                        frame.multipart(
                            path,
                            multipart::Form::new()
                                .text(
                                    "rotation_revision",
                                    config["rotation_revision"]
                                        .as_u64()
                                        .unwrap_or(0)
                                        .to_string(),
                                )
                                .text("filename", filename.clone())
                                .text("session_id", session.clone())
                                .text("filter", "bicubic")
                                .text("fit_mode", "contain")
                                .text("saturation", "0")
                                .text("brightness", "0")
                                .text("contrast", "0")
                                .text("dither_algorithm", "floyd-steinberg")
                                .part(
                                    "file",
                                    multipart::Part::bytes(data)
                                        .file_name(format!("{filename}.png"))
                                        .mime_str("image/png")?,
                                ),
                        )?;
                    }
                    if *flash {
                        frame.queue(&filename, &session, false)
                    } else {
                        Ok(upload.clone())
                    }
                })();
                frame.unlock(&filename, &session);
                let result = result?;
                if *wait {
                    frame.wait(
                        result["job_id"].as_u64().context("Missing job ID")?,
                        *timeout,
                        Some(&filename),
                    )
                } else {
                    Ok(json!({"filename":filename,"prepared":true,"result":result}))
                }
            } else {
                Ok(upload)
            }
        }
    }
}

fn main() {
    let args = Args::parse();
    match run(&args) {
        Ok(value) => {
            if args.json {
                println!("{value}");
            } else {
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
            }
        }
        Err(error) => {
            if args.json {
                println!("{}", json!({"error":format!("{error:#}")}));
            } else {
                eprintln!("Error: {error:#}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_origins_reject_credentials_and_paths() {
        assert_eq!(
            device_url("10.55.0.1").unwrap().as_str(),
            "http://10.55.0.1:8000/"
        );
        assert_eq!(
            device_url("http://frame.local:80").unwrap().as_str(),
            "http://frame.local/"
        );
        assert_eq!(
            device_url("https://frame.local:443").unwrap().as_str(),
            "https://frame.local/"
        );
        for value in [
            "ftp://host",
            "http://user:pass@host",
            "http://host/path",
            "http://host/?q=x",
        ] {
            assert!(device_url(value).is_err());
        }
    }
    #[test]
    fn prepared_images_enforce_palette_dimensions_and_opacity() {
        let config = json!({"width":2,"height":1,"model":"impression-13.3-2025"});
        for (color, valid) in [
            ([0, 0, 255, 255], true),
            ([255, 140, 0, 255], false),
            ([0, 0, 0, 0], false),
        ] {
            let image = image::RgbaImage::from_pixel(2, 1, image::Rgba(color));
            let mut png = Cursor::new(Vec::new());
            image.write_to(&mut png, ImageFormat::Png).unwrap();
            assert_eq!(validate_prepared(png.get_ref(), &config).is_ok(), valid);
        }
    }

    #[test]
    fn smaller_panel_accepts_seven_inks_at_its_native_size() {
        let config = json!({"width":600,"height":448,"model":"impression-5.7"});
        let inks = [
            [0, 0, 0, 255],
            [255, 255, 255, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 0, 0, 255],
            [255, 255, 0, 255],
            [255, 140, 0, 255],
        ];
        let image =
            image::RgbaImage::from_fn(600, 448, |x, _| image::Rgba(inks[(x as usize * 7) / 600]));
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, ImageFormat::Png).unwrap();
        assert!(validate_prepared(png.get_ref(), &config).is_ok());
        let wrong_size = json!({"width":1600,"height":1200,"model":"impression-5.7"});
        assert!(validate_prepared(png.get_ref(), &wrong_size).is_err());
        let wrong_inks = json!({"width":600,"height":448,"model":"impression-13.3-2025"});
        assert!(validate_prepared(png.get_ref(), &wrong_inks).is_err());
    }
}
