# Architecture and implementation notes

Read [AGENTS.md](AGENTS.md) for repository conventions,
[upload-server/README.md](upload-server/README.md) for development and tests, and
[yocto/README.md](yocto/README.md) for device builds and deployment. Those guides
are the command references; this file explains the implementation.

## Components

The modern shared UI and Android prototype live in `app/`. See `app/README.md`
for builds, platform adapters, source provenance, and website artifact consumption.
The Android app supports offline editing and direct native Pi networking (#21);
native Improv BLE setup is implemented in #22. Android remembers frames by a
persisted device identity and discovers changed addresses using NSD (#23). Signed
APK releases and the in-app updater are described in `docs/android-release.md`
(#24). The Pi frontend below remains until the Android experience passes hardware
acceptance (#25 / #26).

1. `upload-server/`: Rust/Rocket server, Tera templates, and browser JavaScript.
2. `update-image.py`: Python display driver entry point. The Yocto recipe packages
   a copy from `yocto/meta-inky-soup/recipes-inky-soup/inky-soup-display/files/` as
   `/usr/bin/inky-soup-update-display`. Keep both copies aligned when changing it.
3. `yocto/`: KAS image definitions and deployment helpers, with shared
   infrastructure in the `pi-base` submodule.

Images target Pi Zero W (ARMv6) and Zero 2 W (32-bit ARMv7 userspace). Display
support includes 5.7-inch Inky Impression (600 × 448) and the 13.3-inch 2025 model
(1600 × 1200). `GET /api/display-config` supplies display and thumbnail dimensions
from `/etc/inky-soup/display.conf`, with defaults when the file is absent.

## Image pipeline

1. The browser uploads the original image.
2. A browser filter worker resizes it to display dimensions and produces cache and
   thumbnail PNGs, which are uploaded to the server.
3. The detail view applies fit mode, filter, saturation, brightness, contrast, and
   dithering settings. Metadata is saved per image.
4. The browser selects the model's six-color (13.3-inch 2025) or seven-color
   (5.7-inch) palette and uploads a pre-dithered PNG before submitting a flash
   request. Saturation changes color matching; output pixels encode ink identities
   using fixed RGB colors so the device can decode them without quantization.
5. The server queues the request; its worker invokes the Python script with
   `--skip-dither`. The browser polls status while the display updates.

The `--skip-dither` path validates dimensions, opacity, and exact palette colors,
then writes native ink codes to the driver buffer. EL133UF1 blue/green use codes
5/6; UC8159 uses 3/2. Invalid or old blended-palette images must be regenerated in
the browser. Deploy the frontend and display script together.

Processing stays in the browser to reduce work on the Pi Zero. The server does
not provide a fallback for missing pre-dithered assets. The optional second flash
runs the display script twice to reduce ghosting.

The bundled Inky 2.2.1 driver backports [upstream PR #265](https://github.com/pimoroni/inky/pull/265): EL133UF1 must wait for
active-low BUSY to clear before sending power-off. Display wait timeouts fail the
flash job. If BUSY stays stuck, a full power removal may be needed; a software
reboot does not remove panel power. Test a patched driver without hardware using
`python3 yocto/scripts/test_inky_refresh.py /path/to/inky_el133uf1.py`.

## Rust modules

- `main.rs`: routes, forms, display configuration, application state, startup.
- `api_error.rs`: the JSON failure body, also for requests refused before a route runs.
- `config.rs`: image directories and path construction.
- `metadata.rs`: per-image settings, validation, migration, atomic JSON writes.
- `image_locks.rs`: editing sessions and lock expiry.
- `storage.rs`: the storage lock and the edit-lock check that photo writes take.
- `flash_queue.rs`: queue, job status/history, background display worker.
- `slideshow.rs`: persisted favorites scheduling, status, and completion tracking.
- `cache_worker.rs`: cache path helper.
- `cleanup.rs`: periodic cleanup of orphaned derived files, under the storage lock.

Server unit tests live in `flash_queue.rs` and `browser_access.rs`. The API tests run as one
sequence from `orientation_tests.rs`; `photo_write_tests.rs` sends every photo write route and
`/flash` a request with no session, another session's lock, an expired lock and a queued
photo, and checks the failure body of each refusal. The old `src/tests.rs` file is unused
Rocket example code, not an active integration suite.

## JavaScript architecture

Follow [JS_STYLE_GUIDE.md](JS_STYLE_GUIDE.md). Dependencies flow from `core/`
through `services/` and `ui/` to `main.js`.

- `core/state.js`: shared application state and settings.
- `core/dom.js`: cached DOM lookups.
- `core/constants.js`: initial display dimensions and processing constants.
- `services/`: API calls, image loading, upload queue, filtering, dithering,
  flashing.
- `ui/`: navigation, gallery/detail views, controls, upload/delete interactions.
- `utils/`: formatting, UUIDs, and image helpers.

The filter/dither libraries and worker scripts are currently directly under
`static/js/`, alongside the ES modules. Use the actual source layout when editing
imports; there is no `static/js/lib/` directory.

## Storage

`INKY_SOUP_IMAGES_DIR` selects the storage root. It defaults to `static/images`
for local runs and is `/data/inky-soup/images` in the image and Docker environment.

```text
images/
├── photo.jpg                 original
├── cache/photo.jpg.png       resized image
├── thumbs/photo.jpg.png      gallery thumbnail
├── dithered/photo.jpg.png    display-ready output
└── metadata/photo.jpg.json   per-image settings
```

Derived images are always PNGs named `{original}.png`. Metadata contains filter,
fit mode, saturation, brightness, contrast, dithering algorithm, and cache version.
The legacy shared metadata file is migrated to per-image files on startup.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Gallery page |
| GET | `/api/images` | Gallery metadata, including `favorite` and processing readiness |
| POST | `/api/settings/favorite` | Set a photo favorite with edit ownership |
| GET | `/api/slideshow` | Settings, next due time, and pause reason |
| POST | `/api/settings/slideshow` | Configure enabled state and interval in hours |
| GET | `/api/device` | Persisted device ID, process instance, name and capabilities |
| GET | `/api/display-config` | Display and thumbnail dimensions |
| POST | `/api/settings/display-rotation` | Persist mount orientation with an expected revision |
| POST | `/upload` | Store an original image |
| POST | `/api/delete-image` | Delete a photo with edit ownership and queue protection |
| POST | `/api/upload-cache` | Store resized output and settings with edit ownership |
| POST | `/api/upload-thumb` | Store thumbnail with edit ownership |
| POST | `/api/upload-dithered` | Store display-ready image and settings with edit ownership |
| GET | `/api/thumb-status/<filename>` | Thumbnail readiness |
| POST | `/api/lock-image` | Acquire an editing lock |
| POST | `/api/unlock-image` | Release an editing lock |
| POST | `/flash` | Enqueue a display update with edit ownership |
| GET | `/api/flash/status` | Current job and queue |
| GET | `/api/flash/status/<job_id>` | Individual job status |

Failures use an HTTP error status and the JSON body `{"success": false, "message": "…"}`
from `api_error.rs`, and clients show the message. Its catcher answers in the same shape
when Rocket refuses a request before a route runs: 400 for an unreadable body, 403 for a
foreign origin, 404 for an unknown path, 413 for an oversized upload and 422 for a missing
or invalid field. `/api/lock-image` is the exception: clients branch on its answer to a
refused lock, `200` with `locked: false` and a `reason`.

Photo writes take the storage lock in `storage.rs` before the flash queue and the
edit locks; so do orientation changes, rescue, the slideshow scheduler and the
cleanup worker. Derived uploads, photo rotation, favorites, flashing and deletion
require the caller's unexpired edit lock, and deletion also refuses a queued or
refreshing photo. A queued photo can still be saved, because its job displays a
snapshot. `/upload` has no session field: released Frame apps send a new original
without the session they hold, so checking it needs a client release first. The
locks coordinate cooperating editors; the API is unauthenticated.

Mount orientation is 0/90/180/270 degrees clockwise, viewed from the front.
`/api/display-config` returns logical editing dimensions in `width`/`height`,
native dimensions in `physical_width`/`physical_height`, plus `rotation_degrees`
and `rotation_revision`. Portrait mounting swaps the image and thumbnail axes.
POST `{rotation_degrees, expected_revision}` to change it; a stale revision fails
with 409. A no-op preserves the revision. Settings are stored at
`INKY_SOUP_DATA_DIR/settings/display-runtime.json`; the data directory defaults
to the parent of an images directory named `images`, otherwise the images directory.

Changes increment a persistent revision and remove cache/thumb/dithered PNGs.
Originals and their settings survive. The app rebuilds derived images client-side;
`/api/images` reports `needs_processing` until all three assets match the revision.
Derived upload forms carry `rotation_revision`, flash forms carry
`submission.rotation_revision`, and metadata records each asset's revision.
Omitting it means revision 0, compatible only before the first orientation change.
Settings changes, derived uploads, and flash snapshots share the storage lock.
Flash jobs copy their pixels into `flash-jobs/` and capture the mount angle at
submission. The driver receives the compensating rotation via `--rotation`;
completed/failed jobs remove their snapshots. Queues do not survive a restart;
startup removes abandoned snapshot PNGs before accepting new jobs. This cleanup
is confined to regular files directly inside `flash-jobs/`, preserving photo
storage, settings, symlinks, and subdirectories.

Deploy the server and both copies of the display script together. The temporary
`inky-cli preview` command replaces only the server, so it cannot by itself test
a release that also changes the driver. `INKY_SOUP_DISPLAY_COMMAND` can select a
matching executable for isolated testing.

## Runtime and deployment

The Yocto app unit is `inky-soup-server.service`, running as `inky` from
`/usr/share/inky-soup`. The image also installs the display script, Python
libraries, SSH, NetworkManager, and mDNS. The image recipe creates the `inky` user
with key-based SSH access and passwordless sudo.

Root filesystem slots A and B share the boot and `/data` partitions. The current
A/B updater replaces only the inactive rootfs; kernel/firmware/boot configuration
changes require a separate matching boot update. Do not describe it as automatic
rollback. Follow the prerequisites in the deployment guide.

The USB gadget uses `dwc2`/`g_ether`, a stable pair of board-derived MAC addresses,
and a packaged NetworkManager profile. Pi USB IPv4 is `10.55.0.1/24`; the host is
`10.55.0.2/24`. WiFi keeps the default route. USB profiles live under `/usr/lib`
so the persistent `/etc/NetworkManager/system-connections` bind mount cannot hide
them. A timer checks ARP/received traffic and reloads `g_ether` for a stalled link.

Use the explicit USB IP to verify the transport; mDNS can resolve to WiFi instead.
The USB setup and diagnostics are documented in the Yocto guide.

## Bluetooth provisioning

The shared `yocto/pi-base/wifi-provisioner` daemon implements Improv BLE. Its
recipe pins the daemon source separately from the submodule revision: update
both when taking provisioner changes. Inky's recipe append sets the success URL
port to 8000. The shared browser client lives in `app/setup/`, published at https://allan.pizza/setup/;
`/wifi/` redirects there. Android uses the same encoder/decoder through
`app/frame/services/native-setup.js` and its `FrameBle` Capacitor plugin. The native
Add frame dialog provisions WiFi and confirms the local API connection inside the app.

The setup window is closed when already connected, and bounded to five minutes
when opened. Use `wifi-provisioner --start|--stop|--status` over USB/SSH. The client
handles explicit notifications and polls older firmware as a compatibility path.

### Photo rotation and orientation cards

Photo source rotation (`photo_rotation_degrees`, 0/90/180/270 clockwise) is separate
from the frame mount. Clients rotate the original before fitting/resampling and
dithering; original bytes remain unchanged. The gallery includes the saved angle
and monotonic `photo_rotation_revision`. `POST /api/settings/photo-rotation`
requires filename, session_id, photo_rotation_degrees and expected_revision under
the existing edit lock. It persists metadata before invalidating that photo's
derived assets. Each derived upload carries `photo_rotation_revision` alongside
the mount's `rotation_revision`; `/flash` uses the `submission.` prefix for both.
Per-asset revision stamps keep failed invalidation and stale clients from making
old pixels valid. Old metadata defaults to angle/revision zero.

Clients may include an `operation_id` (1–128 ASCII letters, digits or hyphens).
The server persists the latest operation and its result with the photo metadata.
Repeating that ID with the same angle and expected revision returns the accepted
revision without invalidating pixels again, including after a restart. Edit
ownership is still required, and a superseded rotation fails the revision check.
The app checkpoints pending operations in its draft before sending them, so a
lost response can be retried without discarding unsaved photo adjustments.

`POST /api/flash-test-card` accepts a client-generated PNG (`file`) plus the saved
mount `rotation_revision`. It checks PNG dimensions and queues a private temporary
snapshot, with normal job status and cleanup, without touching the gallery.
Full PNG decoding/palette validation remains in the display script. The API's
`photo_rotation_supported` and `orientation_test_supported` config fields allow
clients to disable these controls on old servers. CLI commands are documented in
`cli/README.md`; its photo rotations are settings changes, with rebuilding in the
browser client, just as for mounting changes.


### Favorites and slideshow API

`POST /api/settings/favorite` takes JSON `{filename, session_id, favorite}` under
an unexpired edit lock. `GET /api/images` includes `favorite` (false for old
metadata). Saving other image settings preserves this flag.

`POST /api/settings/slideshow` takes either or both `rotation_enabled: bool` and
`rotation_interval_hours: integer` (1–168). It patches only supplied fields;
unknown/read-only fields and empty updates are rejected. All new write endpoints
use the existing browser-origin guard. `GET /api/slideshow` returns:

```json
{
  "settings": {
    "rotation_enabled": false,
    "rotation_interval_hours": 24,
    "rotation_anchor_at": 1792900000000,
    "last_rotated_filename": null,
    "last_flash_source": null
  },
  "next_due_at": 1792986400000,
  "paused_reason": "disabled",
  "last_flash_source": null,
  "next_filename": null,
  "favorite_count": 0,
  "ready_count": 0,
  "queued_job_id": null,
  "retry_not_before": 0,
  "storage_error": null
}
```

Timestamps are UTC Unix milliseconds. Settings, anchor and successful automatic
cursor are atomically persisted in `INKY_SOUP_DATA_DIR/settings/slideshow.json`.
New installations default to disabled/24 hours. Invalid or unreadable settings
fail startup rather than silently overwriting the user's schedule. Changing
settings or favorites preserves the anchor. `next_due_at` remains available when
paused, representing the deadline to resume from, not a promise to refresh then.

The scheduler checks once per second, using the same immutable snapshot/queue as
manual flashing. It serializes checks and enqueue with orientation changes, edit
locks, and queue operations. Only idle queues with no active edit locks can accept
an automatic job. Eligible favorites have all three current derived assets and no
incomplete upload; sort filenames lexically, choose after the successful cursor,
then wrap. Deleted/unfavorited cursor photos do not disrupt this order. Stale
favorites are skipped; with none ready, status reports `needs_processing`.
There is no server-side rendering. Stopping does not cancel an accepted job.

The queue worker resets the anchor on **successful completion**, before exposing
an idle queue, and records `source: manual|automatic` in job status. Automatic
success advances the cursor; manual success (including test cards/nonfavorites)
only resets the timer/source. Automatic failure leaves both untouched and backs
off for 60 seconds. The backoff is runtime-only; after restart an overdue schedule
may retry once. If completion persistence fails, `storage_error` pauses automatic
work until storage is repaired and a save/settings write succeeds. A successful
physical refresh is retained in memory even if its completion cannot be written;
the next successful save/settings write persists that completion before rotation
resumes. Rejected settings writes do not replace the retained completion. An
unpersisted completion cannot survive a process restart.

Clients save in cache -> thumbnail -> dithered order. The bundled web UI's Save
button also rebuilds all three assets from the original using captured settings,
via the shared generation pipeline; it does not queue a display refresh. It
reports success only after the final upload succeeds. The final dithered
upload resets the anchor only after metadata saves and all assets are current.
Original/cache/dithered uploads mark `processing_pending` before writing, so an
interrupted write cannot make a photo eligible. Original replacement invalidates
old assets. An incomplete photo cannot be manually flashed until saved. Standalone
angle changes invalidate pixels but are not a complete rendered save. Failures,
partial uploads and intermediate settings do not reset the timer.

For hardware-free testing, debug binaries accept
`INKY_SOUP_TEST_ROTATION_HOUR_MS=2000` (one logical hour = two seconds). Release
binaries ignore it; API/CLI intervals remain 1–168 hours. Combine with disposable
`INKY_SOUP_DATA_DIR`/`INKY_SOUP_IMAGES_DIR` and `INKY_SOUP_DISPLAY_COMMAND=/bin/true`.
The API fixture in `slideshow_tests.rs` shares the orientation test's image root,
exercises the real worker with successful/failing commands, and injects time into
scheduler checks without waiting for real hours. CLI commands are in `cli/README.md`.
Android/web controls and physical acceptance remain follow-ups to issue #4.
