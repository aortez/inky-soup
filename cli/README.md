# Local frame client

`inky-cli` controls the frame through the same HTTP API as the browser, over USB
Ethernet or local WiFi. It does not need SSH or a browser. The host client is a
separate crate, tested with Rust 1.94.1; the device server remains on Rust 1.85.0.

From the repository root:

```bash
./inky-cli status
./inky-cli display --json
./inky-cli browser-check --json
./inky-cli --device http://inky-soup.local:8000 images
```

The wrapper builds on first use. To install a standalone executable:

```bash
cargo install --locked --path cli
inky-cli --help
```

`--device` or `INKY_SOUP_URL` selects the device. The default is
`http://10.55.0.1:8000` (USB Ethernet). Hostnames without a port use 8000.
WiFi uses `http://inky-soup.local:8000` or the Pi’s local IP address.

## Bluetooth WiFi setup window

```bash
./inky-cli wifi-setup status --json
./inky-cli wifi-setup start
./inky-cli wifi-setup stop
```

These commands call the existing `wifi-provisioner` helper over SSH on the selected
frame’s hostname, using the `inky` account by default (`--ssh-user` overrides it).
They require OpenSSH, existing key access and noninteractive sudo. Start opens the
bounded Bluetooth setup window; stop closes it. WiFi credentials are still entered
in the Bluetooth browser setup UI, never passed through this CLI. The device URL’s
port applies to HTTP; SSH uses port 22 or your SSH config.

## Browser connectivity diagnostics

```bash
./inky-cli browser-check --json
./inky-cli browser-check --origin http://localhost:4173 --json
```

This checks a read and a JSON POST preflight against the real frame, including
origin, method, and content-type permissions. It does not submit a write. It exits
nonzero when the server does not grant browser access. Browser/Android local-network
permissions and mixed-content rules still need validation on the actual phone.

## Temporary browser preview

```bash
# Copy a compatible PR server binary to the Pi if its API has also changed.
scp upload-server/target/arm-unknown-linux-gnueabihf/release/upload-server inky@10.55.0.1:/tmp/inky-preview-server
./inky-cli preview start --origin http://localhost:4175 --server-binary /tmp/inky-preview-server
./inky-cli browser-check --origin http://localhost:4175 --json
./inky-cli preview status
./inky-cli preview stop
```

`preview start` uses SSH to install a runtime-only systemd override for the normal
server. It copies the supplied executable into `/run`, allows the exact preview
origin alongside `https://allan.pizza`, and restarts the service. The default
binary is the installed server, useful when only the website has changed.
Use a binary built for the target Pi (ARMv6/VFPv2 for the original Zero W).
The same photo library is used, and edits/deletions made during preview persist.
Avoid sending display jobs while changing servers; the CLI checks the current
queue and refuses a restart if it observes pending work.

`preview stop` removes only this CLI's override and restarts the normal server.
It works over SSH even if the preview HTTP API has failed. Reboot also removes
the runtime override. Both commands require key access and noninteractive sudo;
`--ssh-user` selects a different account. The installed binary is not replaced.

## Install an application release

`deploy` installs the server, matching display script, and bundled UI together on
the normal Yocto service (port 8000). Build the server for the target Pi first;
the original Zero W requires ARMv6/VFPv2, including the linker's startup objects.
Stage a directory on the Pi with this layout:

```text
release/
  server             # target-native upload-server executable
  display            # update-image.py from the same revision
  discovery.service  # Yocto recipe files/inky-soup.service
  revision.txt       # source commit
  Rocket.toml        # upload-server/Rocket.toml
  templates/         # upload-server/templates
  static/js/         # upload-server/static/js
  static/chota.min.css
  static/favicon.ico
  provisioner        # optional target-native wifi-provisioner executable
  provisioner-revision.txt # required with provisioner: shared source commit
```

```bash
scp -r /tmp/inky-release inky@10.55.0.1:/tmp/
./inky-cli deploy --bundle /tmp/inky-release --json
./inky-cli status --json
./inky-cli browser-check --json
```

Include `provisioner` when a release also changes Bluetooth/Wi-Fi setup. Build it
from the pinned `yocto/pi-base/wifi-provisioner` source for the target CPU and
installed libdbus ABI; write that source commit to `provisioner-revision.txt`.
Its existing systemd unit and configuration stay in place. The CLI checks the
staged executable on the Pi, requires the normal provisioner service and a closed
setup window, and rechecks the window immediately before stopping services.
Wait for any phone's setup session to finish before deploying.

The optional daemon is backed up and installed in the same transaction. Its
control endpoint must return valid status before the server starts and again
after the server health check. The systemd invocation must remain unchanged;
a daemon restart during validation is a failure even if its endpoint recovers.
The JSON result includes its source revision and the final status.
Omitting the optional files preserves server-only deployment
behavior. This does not install changed systemd units or new library dependencies;
those require a matching system image. For larger bundles, stage under `/data`
rather than the Pi's small RAM-backed `/tmp`.

The CLI uses SSH and noninteractive sudo. A device-wide kernel lock covers
validation, staging, installation, health checks, cleanup, and rollback; another
deployment fails immediately with a retry message. The lock is released when the
installer exits, including after a failure. The file at
`/run/lock/inky-soup-deploy.lock` remains in place and must not be deleted to bypass
a running deployment. An interrupted SSH client can leave its installer running;
wait for it to finish before retrying.

The CLI checks the display queue before staging and stopping the service, then
verifies the orientation API, status endpoint, and gallery. It refuses an active
preview. Once the server restarts, newly accepted display jobs do not count as a
health-check failure. Failed copies remove partial staged files and directories.
Failed installation or health checks restore the previous software.
Recovery attempts each service independently, so a provisioner stop, file-restore,
or restart failure does not prevent server recovery. Incomplete recovery reports
the original failure, recovery errors, and the software backup path; files that
could not be restored remain available for manual recovery. A service whose
files could not all be restored is left stopped. If the server passed its health
check and accepted a display job before the final provisioner check failed,
recovery leaves that server running and restores only the provisioner. The same
precaution applies if the healthy server's queue cannot be checked. This returns
an error, not deployment success; retry after the queue is idle and the reported
failure is addressed.
The JSON result records the deployed revision and a software-only backup
under `/var/lib/inky-soup/deployments/`. Photo storage and orientation settings are
not copied or changed. No display refresh is submitted. A power loss during
installation still requires manual recovery; this is not an A/B firmware update.

## Mounting orientation

```bash
./inky-cli orientation --json       # Current mount, revision, and logical dimensions
./inky-cli orientation 90           # Frame turned clockwise, viewed from the front
./inky-cli orientation 0            # Normal landscape position
```

Supported positions are 0°, 90°, 180°, and 270°. This requires the orientation
server update and matching display script. The setting survives restart. Changing
it invalidates derived images while preserving originals and their adjustments;
it does not refresh the screen. Open/reconnect the phone app to rebuild the
library on that client, or upload new prepared images with the CLI.

The preview and prepared PNGs remain upright. `display` reports logical dimensions:
the 13.3-inch panel uses 1200 × 1600 at 90°/270°, and 1600 × 1200 at 0°/180°.
The server counter-rotates the captured pixels only when flashing. Uploads carry
the orientation revision used to prepare them; stale uploads are rejected even
after an orientation is changed back. A queued job retains its original pixels
and mounting orientation.

## Set up the physical display

New images detect a supported panel before starting the server. To configure a
fresh frame built with older firmware, or explicitly select a panel:

```bash
./inky-cli --device smaller-frame.local display-setup impression-5.7
./inky-cli --device smaller-frame.local display --json
# Or read the panel's identification EEPROM:
./inky-cli --device smaller-frame.local display-setup auto
```

The 5.7-inch profile reports `impression-5.7`, 600 × 448, and seven colors.
The other supported profile is `impression-13.3-2025`, 1600 × 1200, six colors.
`display-setup` sends the configuration helper over SSH, so it also works when
the helper is not installed on the Pi or the web server is stopped. It needs
key access and noninteractive sudo (`--ssh-user` selects the account). It writes
`/etc/inky-soup/display.conf` atomically without refreshing the screen.

Run setup before uploading photos, then reconnect/reload the app. Existing
derived images must be regenerated if you change the physical panel model.
This selects hardware; mounting orientation is a separate setting. If first-boot
detection prevented startup, start the server after manual setup with
`sudo systemctl restart inky-soup-server.service` on the Pi.

## Orientation test card and photo rotation

```bash
./inky-cli orientation-test --wait          # Display TOP / BOTTOM / LEFT / RIGHT
./inky-cli orientation-test --output /tmp/orientation.png  # Preview without flashing
./inky-cli upload holiday.jpg --rotate 90   # Preserve original; save clockwise rotation
./inky-cli rotate <filename>                # Inspect saved photo rotation and settings
./inky-cli rotate <filename> 270            # Set an absolute clockwise angle
```

The orientation card uses the **saved frame mounting orientation**, exact logical
panel dimensions, and black/white pixels supported by both the 13.3-inch and
5.7-inch displays. It replaces the picture on the panel but creates no gallery
photo. Its temporary PNG is removed after the job finishes (or at server restart).
An unsaved app orientation choice must be saved before testing it.

Photo rotation is independent of mounting orientation. The allowed angles are
0, 90, 180, and 270 degrees clockwise relative to the original photo. Rotation
never rewrites the original or changes its other adjustments. Like mounting
changes, CLI photo rotation saves settings and marks derived images for rebuilding:
**open/reconnect the frame app to generate the new previews on that client**,
then display the photo from the app or use `inky-cli flash <filename> --wait`.
The CLI does not resize/dither arbitrary originals. `--rotate` cannot be combined
with `--prepared`, whose input is already fitted and dithered.

After uploading an original, `upload --rotate` renews edit ownership before saving
the angle, since a slow transfer can outlast the lock. If another editor takes
over, the command stops and reports the saved filename. Use `rotate <filename>`
to inspect or finish that upload rather than uploading another copy.

Rotation changes require edit ownership and the current photo revision. Old
uploads/flash requests are rejected after a change, even after rotating back to
0 degrees. Already queued jobs keep their captured pixels. Both commands require
the updated frame server; `orientation-test --output` can also render a card for
an older supported server without sending it to the display.

## Photos and display jobs

```bash
# Store an original; prepare and send it using the browser editor afterward.
./inky-cli upload photo.jpg

# Upload an already processed PNG, generate a thumbnail, and refresh the display.
./inky-cli upload screen.png --prepared --flash --wait

# Use the exact filename returned by `images` for an existing prepared image.
./inky-cli flash 01234567-example.png --wait --timeout 180

# Delete an original and all saved versions (this removes it from the gallery).
./inky-cli delete 01234567-example.png

# Recover after an interrupted connection without submitting another refresh.
./inky-cli status --json
./inky-cli job 7 --wait --json
```

Prepared PNGs must be opaque and match the device’s exact width and height. Native
colors are black, white, yellow, red, blue, and green; the 5.7-inch display also
supports orange (255, 140, 0). The CLI validates these properties before uploading.
It does not resize or dither ordinary photos. Prepared uploads save the supplied
PNG as the original, cache, and dithered image, plus a generated thumbnail.
Uploads receive a unique filename and use the device’s image locks for derived
files and flash submission.

`delete` requires the new `/api/delete-image` endpoint. It acquires edit access and
refuses deletion while another editor owns the photo or it is queued/refreshing.
The image already on the physical display is unchanged.

`--wait` polls an existing job and exits nonzero on a reported failure or timeout.
The wait deadline also bounds stalled status requests. A timeout does not cancel the device job. An interrupted flash submission may have
reached the frame: inspect `status` before deciding to submit again. Job IDs reset
when the server restarts; active waits also check the filename and creation time.
A fresh `job` command cannot identify a job from a previous server lifetime.

`--json` writes one JSON result to stdout and progress to stderr. Operational
errors produce an `error` object and exit status 1; argument errors use Clap’s
normal help/error output. Without `--json`, results are pretty-printed JSON.

The device API is intended for a trusted local network; it has no client
authentication. `images` requires the new `/api/images` endpoint. Other commands
use existing endpoints. `deploy` updates application files, not the kernel or
firmware; the CLI never submits WiFi credentials.

## Checks

```bash
cargo fmt --manifest-path cli/Cargo.toml --check
cargo test --locked --manifest-path cli/Cargo.toml
```

Tests cover URL validation, native-palette validation, multipart filenames,
structured output, failed jobs, and polling without resubmission. The client has
also been exercised against the original Pi Zero W over USB and WiFi.

## Favorites and automatic rotation

```bash
./inky-cli favorite holiday.jpg on
./inky-cli favorite holiday.jpg off
./inky-cli favorites --json
./inky-cli slideshow start --hours 6
./inky-cli slideshow status --json   # bare `slideshow` also shows status
./inky-cli slideshow interval 24
./inky-cli slideshow stop
```

Requires a server with the favorites/slideshow API. Favorites are persisted per
photo and survive saved edits. Favorite changes acquire/release the normal edit
lock. The slideshow starts disabled with a 24-hour interval; valid intervals are
whole hours from 1 through 168. `start` without `--hours` preserves the interval;
`interval` preserves whether rotation is enabled. Settings changes preserve the
timer anchor, so enabling an overdue slideshow can display a photo immediately.

The frame cycles through ready favorites in filename order, wrapping at the end.
Photos that need processing are skipped: use the app to save them, or upload a
prepared image with `upload --prepared`. Processing remains on the client. An
active edit lock on **any** photo pauses automatic submission, as does a busy
flash queue. Stop prevents future automatic jobs; a job already queued finishes.
Manual `flash` works for nonfavorites and postpones the next automatic refresh.

Status includes persisted `settings`, `next_due_at`, `next_filename`, favorite
and ready counts, `last_flash_source` (`manual`/`automatic`/null), and a
`paused_reason`: `disabled`, `editing`, `display_busy`, `no_favorites`,
`needs_processing`, `retry_backoff`, `storage_error`, or null. Times are UTC Unix
milliseconds, matching display job timestamps. Failed automatic jobs retry after
at least 60 seconds and do not advance the cursor or timer. A storage error pauses
automatic work; repair storage and retry the failed save/settings request. A
successful refresh's timestamp and cursor are retained in memory during recovery,
then included in the next successful save/settings write. They cannot survive a
restart until that write succeeds.

The interval starts again after a successful display job or a complete saved
photo (cache, thumbnail, then dithered upload). Uploading just an original,
changing a photo's angle without saving its rebuilt pixels, partial uploads,
favorite changes, and failed jobs do not reset it. The scheduler's anchor and
last successfully rotated filename survive server restarts. Android/web controls
for these settings are separate follow-up work under issue #4.

## Identity and local discovery

`./inky-cli --device http://FRAME_IP:8000 identity --json` reads `/api/device`:
`id` is a random 128-bit device identifier persisted at
`/data/inky-soup/settings/device-id`; `instance_id` changes whenever the server
starts, because display-job numbers are process-local. Identity survives reboot
and A/B application updates. Preserve this file when backing up a frame, but do
not clone it onto another frame or bake it into a distributable image. Corrupt
identity storage fails startup instead of silently creating a different device.

`./inky-cli discover --json` uses the host's `avahi-browse` (install `avahi-utils`
and run `avahi-daemon`) to browse `_inky-soup._tcp`, then reads each private IPv4
address's identity API. It reports unreachable advertisements alongside verified
responses. Multiple network interfaces can advertise the same device; compare
`identity.id`, not hostnames. USB addresses can overlap when two Pis are attached;
use their distinct WiFi addresses for subsequent commands.

Current release bundles also require `discovery.service`, copied from
`yocto/meta-inky-soup/recipes-inky-soup/inky-soup-server/files/inky-soup.service`.
`deploy` installs it at `/etc/avahi/services/inky-soup.service`, including on older
images, and restores/removes it if deployment rolls back. Avahi watches that
directory automatically. Full Yocto images package the same service definition.
It advertises IPv4 port 8000; change the service file if changing the server port.
Advertisements are hints, and device IDs prevent accidental address reuse; they
are not cryptographic device authentication.

## Offline recovery

`./inky-cli rescue` reports local connectivity, the five-minute outage timer,
recovery-card state, restoration availability, and probe/storage errors.
`./inky-cli rescue show --wait` displays the packaged recovery card without
adding a gallery photo; `./inky-cli rescue restore --wait` restores the last
successful ordinary display. These explicit operations wait for no other work:
they reject a busy queue or active photo editor. Add `--json` for scripting.
An explicitly shown card stays until you restore it or display another image.
See [offline rescue mode](../docs/offline-rescue.md) for automatic behavior,
network detection, configuration, and hardware validation.
