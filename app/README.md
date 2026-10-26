# Frame app

The shared modern Frame UI and Android shell live here. The editor is imported
from the published `aortez.github.io` master revision recorded in `source.json`,
including its merged photo-rotation and interrupted-save recovery changes. The
Android platform adaptations remain in this shared source. Source and worker license
notices are retained in `LICENSE` and `public/frame/vendor/`.

## Android prototype (#20 / #21 / #22)

The Android APK bundles the editor, photo picker, image-processing workers, and
IndexedDB draft storage. It can preview both panels in landscape or portrait
without internet or a connected frame. Settings selects the preview display.
Android Back returns from Settings to Create, then saves the draft and minimizes
the app. Cancelling the system photo picker preserves the existing draft.

Photo rotation supports 0°, 90°, 180°, and 270° clockwise before fitting and
dithering on both platforms. Android's offline preview supports the same control
for either panel/layout and retains the angle in its draft. Connected frames also
support mounting orientation and test-card submission when their firmware
advertises those capabilities.

Both builds include the Settings orientation test card and revision-checked
photo saves. Pending rotation operations survive reopening, allowing a lost
response to be retried without duplicating the original or discarding adjustments.
Copying a draft to another frame or resaving after deletion resets its revision;
subsequent rotations by another editor still produce a conflict. The imported
regression suite covers these cases alongside exact rotated pixels and palettes.

Use **Add frame over Bluetooth** to discover a frame in setup mode, give it WiFi
settings, and connect inside Android. An existing frame can also be reached by
entering its WiFi IPv4 address or `.local` hostname. The app reads the gallery, edits/saves photos, and submits display jobs
using native HTTP. The frame’s display profile replaces the offline preview profile
while connected. Remembered-frame discovery and reconnection shipped in #23, and
[signed releases with in-app updates](#signed-releases-and-in-app-updates) cover #24.
The web build keeps its browser transport. The Pi-hosted legacy UI remains until #26.

## Build and install

Prerequisites:

- Node.js 22.12+ (Node 24 recommended) and npm.
- A full **JDK 21**, including `javac`; a Java runtime alone cannot build the APK.
- Android SDK platform 36, build-tools 36.0.0, platform-tools, and accepted SDK
  licenses. Android Studio can install them, or use `sdkmanager`.
- Set `JAVA_HOME` and `ANDROID_HOME`, or configure the SDK using Android Studio's
  ignored `android/local.properties`.

```sh
cd app
npm ci
sdkmanager 'platforms;android-36' 'build-tools;36.0.0' 'platform-tools'
npm run build:android
adb -s YOUR_DEVICE_SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s YOUR_DEVICE_SERIAL shell am start -n pizza.allan.frame/.MainActivity
```

`build:android` builds the bundled assets, synchronizes Capacitor, and invokes
the checked-in Gradle wrapper. No Vite server, ADB reverse tunnel, or hosted
website is used by the installed app. The app's `https://localhost` origin is
served internally by Capacitor from APK assets; it is not a LAN HTTPS server.

The package is `pizza.allan.frame`, with minimum SDK 24 (Android 7), compile/target
SDK 36 (Android 16), and Capacitor 8.5.3. The SDK minimum is not a claim that all
old Android/WebView combinations have been physically validated: use a maintained
WebView with workers, OffscreenCanvas, IndexedDB, and Web Locks support. Validation
records identify the actual phone/WebView tested.

This is a debug-signed development APK. The signing key comes from the builder's
Android debug keystore, so APKs from another machine/CI may not update this local
installation. Do not uninstall an app with a draft merely to bypass a signature
mismatch. Public builds are signed by the release workflow; see
[Android releases and in-app updates](../docs/android-release.md).

## Web and Android boundaries

- `frame/core/platform.js` selects the build target.
- `frame/services/native-app.js` handles Android back/lifecycle events.
- `frame/core/preview-profile.js` supplies persisted offline preview profiles.
- Both targets use the same editor, worker, and draft-store modules.
- Web output is `dist/`; Android output is `dist-android/` with a root entry.
- Only the web build generates/registers `/frame/sw.js`. Android UI and worker
  code advance together through APK installation.
- `services/transport.js` selects browser fetch or the native `FrameTransport` plugin.
- Native API requests never pass through browser fetch, a proxy, or a cloud relay.
  The Pi’s browser CORS settings remain unchanged. `FrameBle` supplies Android GATT
  discovery and operations; the shared Improv encoder/decoder keeps the wire protocol unchanged.

## Verification

```sh
npm run test:unit
npx playwright install chromium
npm test                    # Modern web editor and existing browser BLE setup.
npm run test:pwa            # Built web app, cached launch, and update lifecycle.
npm run test:android:web    # Bundled Android assets, both palettes and orientations.
npm run build:android
(cd android && ./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug)
```

Browser suites use separate output directories and ports 8080, 4173, and 4174.
Android-target browser tests exercise the built assets, not Android native APIs.
Real-device validation must also cover the system photo picker, Back, process
restart, and launch with phone networking disabled. Use a debug APK for WebView
inspection; never enable debugging in a public release just for these checks.

After installing the APK and selecting a disposable photo through Android's
system picker, run the repeatable device check:

```sh
node tools/android-shell-check.mjs --serial YOUR_DEVICE_SERIAL --output /tmp/frame-check.json
```

It changes preview settings, exercises picker cancellation and Back, force-stops
the app, and temporarily disables Wi-Fi/mobile data to test offline recovery.
Network and stay-awake settings are restored in a `finally` block. The script
writes a JSON record and screenshot and does not contact or refresh a Pi.

## Publishing the same frontend on allan.pizza

This repository owns the frontend source. The website should consume a built
artifact or a pinned revision of this directory, rather than copy and edit
`frame/` and its workers. The Frame app CI workflow publishes `frame-web` and
`frame-android-debug` artifacts for review.

For a website release, build the website's unrelated pages first, then overlay
the complete output of `npm ci && npm run build` from this directory into the
website's Pages artifact:

```sh
# From the inky-soup checkout, after both builds have completed.
cp -a app/dist/. /path/to/aortez.github.io/dist/
```

This supplies `/frame/`, `/setup/`, `/wifi/`, and their hashed `/assets/` files.
Preserve unrelated website files, including its CNAME and Go demo assets. Remove
those three old entries from the website Vite build and retire their copied
sources when its CI is switched to consuming this artifact. Pin the inky-soup
revision used for each website deployment, and overlay the entire build so HTML,
workers, and service-worker cache hashes always agree.

The website checkout and live Pages deployment are not modified by building the
Android prototype. Photo rotation and its retry fixes are synchronized through
website commit `a44aedb2317d26de24e71be8623ded4ea0ff0e1f`; `source.json` records
that source revision and the original import. Switching website CI to consume
this shared build remains a separate migration.

## Direct Pi transport

Connect using the Pi’s **WiFi** address, for example `192.168.1.149:8000`. Multiple
USB-connected Pis can each advertise `10.55.0.1`; that address is ambiguous on a
host with two USB interfaces and is not reachable from the phone over WiFi.
Configuration must include mount revision and physical dimensions; older firmware
gets an explicit update message. Optional photo rotation capabilities are checked
before sending rotated photos. Existing photo angles and both revision stamps are
preserved, including interrupted idempotent rotation saves.

Android currently targets SDK 36. Per [Android local-network guidance](https://developer.android.com/privacy-and-security/local-network-permission),
`INTERNET` provides implicit LAN access on this target, including Android 17;
do not request `ACCESS_LOCAL_NETWORK` until targeting SDK 37. Permission denial,
timeouts, and inaccessible devices produce recoverable connection messages. A
future target-SDK upgrade must implement the corresponding permission flow.

Cleartext HTTP is enabled because existing frames have dynamic local addresses
and no trusted TLS certificate. The native plugin accepts only the selected
RFC1918 IPv4 / `.local` origin, resolves `.local` to private IPv4 before connecting,
and permits only enumerated API/image routes. It rejects redirects and proxies,
retains normal certificate validation for HTTPS, and makes one on-wire attempt
per request, including HTTP retry responses. Android’s bundled page has a CSP
limiting browser connections and scripts to itself; external pages are not added
to Capacitor’s allowed navigation/origins. Bridge payload logging is disabled.

Multipart encoding remains standard FormData, including filenames and revision
fields. Uploads cross the bridge in 64 KiB chunks into app-private temporary files;
OkHttp streams those files. Binary responses stream to private files and return
through the same bounded chunks. The transfer cap is 24 MiB (20 MiB photo plus
multipart overhead), JSON/error responses are capped at 2 MiB, and at most 12 files
and 8 requests can be live. Requests have a 60-second total network deadline;
staging/download cancellation releases files. Orphans expire after 10 minutes on
the next allocation and are removed at process start. Normal completion leaves no
transfer files. This bounds bridge/native transfer memory; image decoding and
processing still need memory proportional to the selected image.

A repeated display submission is never automatic. If a submission response is
lost, check the frame before deliberately retrying; job polling only reads status.
Use `inky-cli --device http://WIFI_IP:8000 job JOB_ID` to independently inspect it.

To run the repeatable phone/Pi test with disposable data:

```sh
node tools/android-pi-check.mjs --serial PHONE_SERIAL \
  --device http://WIFI_IP:8000 --photo /path/to/test.jpg \
  --flash --output /tmp/android-pi.json
```

This adds one gallery photo; `--flash` also refreshes the small physical panel.
Without `--flash`, it saves without changing the display. It exercises the installed
APK’s editor/file input, native uploads/downloads, gallery, edit lock, and status.
It checks temporary-file cleanup and captures a JSON record and screenshot.

## Android Bluetooth setup

Open a frame’s bounded setup window, then choose **Add frame over Bluetooth** in
its connection card. A fresh, unconfigured Pi advertises setup automatically;
for an already configured test Pi, use the existing CLI:

```sh
./inky-cli --device http://WIFI_IP:8000 wifi-setup start
./inky-cli --device http://WIFI_IP:8000 wifi-setup status
```

Tap **Scan for frames**, grant Bluetooth permissions when prompted, and explicitly
select a device by its advertised name and address suffix. Improv devices from
other projects can also appear; choose the intended Inky. Enter the phone’s WiFi
network name and password (2.4 GHz for Pi Zero), and keep the app open. The app
validates the provisioner’s returned local address and reads its display config
and gallery through native HTTP before reporting success. **Open editor** completes
the flow without opening a browser or entering an address manually.

Bluetooth setup uses the existing Improv service, not Android OS bonding or
persistent ownership. Native BLE permissions are requested only when scanning:
Nearby devices on Android 12+, Location on Android 11 and earlier. Older Android
versions also require Location services for scanning. The recovery UI links to
Bluetooth, app-permission, and Location settings; return to the app and scan again.
The manifest follows [Android’s BLE permission guidance](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)
and asserts that scans are not used to derive location.

Scans last 15 seconds and show multiple devices without automatically choosing
one. Each attempt owns a distinct native session and GATT object. GATT operations
are serialized and bounded (25 seconds to connect/subscribe, 10 seconds per read
or write); WiFi completion is bounded to 65 seconds. Notifications are supplemented
by serialized reads for older firmware. Cancellation, backgrounding, disconnect,
permission revocation, timeout, and the five-minute local session limit close GATT
and discard pending operations. Late callbacks from an old session cannot resolve
new calls. The firmware’s own setup deadline remains authoritative; the app never
extends it automatically. Cancelling the app stops its Bluetooth operation but
cannot undo credentials already accepted by the provisioner.

WiFi input is limited to 1–32 UTF-8 bytes for SSID and 0–64 for password. Native GATT
negotiates MTU >= 104 and sends one acknowledged packet (at most 101 bytes), using
[Android’s MTU and write APIs](https://developer.android.com/reference/android/bluetooth/BluetoothGatt).
It rejects inadequate packet sizes instead of inventing chunk framing. Credentials
are transient, never persisted or logged, and the form is cleared on completion,
error, or cancellation. A failed WiFi attempt requires a fresh BLE selection; a
successful BLE operation with an unreachable API offers **Retry frame connection**
without resending credentials.

The repeatable hardware check selects a specific small frame, cancels/reconnects,
checks the firmware closing its setup window, then sends maximum-length Unicode credentials for a nonexistent network, verifies the
failure, and retries with the supplied real credentials. It opens the setup window
through `inky-cli` and changes that frame’s WiFi configuration. Supply JSON
`{"ssid":"...","password":"..."}` on stdin using an existing private file or a
secret provider; do not place passwords in command arguments. Approve a visible
Android permission prompt on the phone if needed.

```sh
node app/tools/android-ble-check.mjs --serial PHONE_SERIAL \
  --device http://WIFI_IP:8000 --ble-id XX:XX:XX:XX:XX:XX \
  --output /tmp/android-ble.json < /private/path/wifi-test.json
```

The script records outcomes/screenshots without credentials and restores the
phone’s keep-awake setting. After it passes, use `android-pi-check.mjs --connected --flash` to send a disposable
photo through that existing connection. `--device` still identifies the Pi for the
independent CLI check; `--connected` preserves the app’s BLE-returned address. See the recorded
[Pixel / small-Pi validation](../docs/validation/android-ble.md). Tests on one recent
phone do not establish hardware compatibility for every supported Android version.

## Remembered Android frames

Android remembers multiple frames by the Pi's `/api/device` identity. The local
registry stores the device ID, display name/configuration, last verified address,
and explicit selection. Android commits changes to the `sparkle-frame-registry`
IndexedDB database with strict durability before completing connect, select or
forget. On launch it restores the `sparkle-frames-v1` localStorage working copy
from that committed record, so an immediate force-stop cannot revert a completed
selection. Existing localStorage records migrate on the next verified connection. It survives app restarts and APK
updates; uninstalling or clearing app data removes it. Forget removes only that
phone's association, never the Pi's photos. Names can repeat: the picker includes
the panel size and an ID suffix, sorted by name then ID. Typing a different
address identifies and adds the frame at that address without needing discovery
or forgetting the current frame. Unreadable registry data shows recovery guidance
and is replaced only after a verified connection; photos, drafts, and job receipts
are preserved.

On launch/resume, the app verifies the last address. If it is unavailable or
belongs to a different device, Android NSD browses `_inky-soup._tcp` and probes
candidate identity APIs before selecting a transport. A foreground health check
retries every 15 seconds while idle. Discovery is bounded to 6.5-second scans,
16 candidate addresses and four concurrent probes; it stops when backgrounded.
Only private IPv4 addresses are supported, as in the existing native transport.
This uses Android's [NSD APIs](https://developer.android.com/develop/connectivity/wifi/use-nsd);
the current target SDK remains 36. A future SDK 37 migration must add its local
network permission or system service picker flow.

A connected draft follows its source device ID, including pending rotation
receipts. Legacy drafts with only an address become independent copies on first
identity-aware connection; an address cannot prove ownership of an old original.
Saved display jobs carry both device ID and server instance. Receipts are kept
independently for each frame, so using another frame cannot discard an unavailable
frame’s pending refresh. Finishing a refresh restores the draft’s edit lease
before enabling controls. Reconnect only reads
status, never resubmits a refresh. If reconnect fails during a job, its receipt
stays saved and Check again becomes available while automatic retries continue.
A restarted server invalidates the old job and
the app asks the user to check the screen before sending again.

Find frames on WiFi adds an existing frame without provisioning. Add frame over
Bluetooth remains the setup/recovery path. If WiFi has changed, reboot the offline
Pi to open its five-minute setup window and follow its screen instructions when
available. Issue #17 owns those offline instructions and photo restoration;
#23 does not add a second rescue controller. Same-network/local-network permission
failures and networks that block mDNS retain manual address entry as a fallback.
Device IDs protect against accidental address reuse, not malicious impersonation.

See [identity/discovery CLI commands](../cli/README.md#identity-and-local-discovery)
and [hardware validation](../docs/validation/android-reconnect.md).

## Signed releases and in-app updates

Public APKs are built and signed by the `Frame app release` workflow from an
`app-v<version>` tag, where the version comes from `package.json` and Gradle derives
the Android version code from it. Each release publishes `frame.apk`, its SHA-256,
and `frame-release.json`; the rolling `frame-app` GitHub release keeps stable
first-install and metadata links. Signing keys, secrets, versioning, first
installation, and the release checklist are documented in
[docs/android-release.md](../docs/android-release.md).

Settings shows the installed version under **This app**. The native `FrameUpdate`
plugin reads the release metadata over HTTPS, offers a release only when it is
newer, is signed with the installed app's certificate, and supports the phone's
Android version, then streams the APK from the manifest's host into private
storage with size and SHA-256 verification. Before Android's package installer
opens, the package is parsed and must be this app's own newer build signed with the
installed key. Installation needs the app's **Install unknown apps** permission
and the user's confirmation. It is
deferred while photos are processing or importing and while a display refresh is
tracked; the draft is saved first. Automatic checks run at launch and resume at
most every six hours and never block local frame use. `tests/android-update.spec.js`
covers the flow with a simulated plugin; the Java tests cover metadata validation,
download verification, and cancellation. The first hardware pass, updating 0.2.0 to
0.2.1 on a Pixel, is recorded in
[docs/validation/android-update.md](../docs/validation/android-update.md).
