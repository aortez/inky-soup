# Android → Pi transport (#21)

Validated 2026-10-25 on a Pixel 9 Pro XL, Android 17 / WebView 155.0.8059.39,
using the installed debug APK. Target hardware: Pi Zero 2 W with 5.7-inch Inky
Impression, 600 × 448, at `192.168.1.149:8000` over WiFi.

## Results

- Configuration, gallery, native thumbnail download, original selection, preview,
  multipart original/cache/thumb/dithered upload, edit locks, and job polling pass.
- A synthetic 4000 × 3000 JPEG (color bars plus high-entropy detail) transfers
  **18,992,047 bytes**. The final upload + display completion takes 47.8 seconds,
  including about 36 seconds of physical refresh. It then downloads and reopens
  the original through the native binary transport.
- Final job **5** is `Completed`, independently queried with `inky-cli` immediately
  after the phone reports completion. The firmware keeps finished status for only
  30 seconds. The earlier job 3 was also independently confirmed, and the user
  visually confirmed TOP, all seven bars, and the detailed lower half.
- The JPEG returned by the Pi after the preceding run exactly matches its source:
  SHA-256 `e204ab873faad8ad13ff4c12e2a7863a3cb34b0173fb2d667bccd1d29f2745be`.
- Native temporary transfer directory is empty after the round trip. Bridge chunks
  are capped at 64 KiB; no whole-photo base64 message is used. This is a transfer
  bounds check, not a measurement of peak image-processing memory.
- No external WebView HTTP requests or page errors occurred. Native HTTP connects
  directly to the selected Pi; Pi CORS settings and firmware were not changed.
- The same native adapter reads the 13.3-inch frame's 1600 × 1200 configuration and
  15-photo gallery at `192.168.1.109:8000`. Its display was not refreshed.
- A public destination is rejected. Native timeout and in-flight cancellation
  against an unavailable private address recover to a successful config request.
- Both panels in both orientations still pass the bundled-worker palette tests.

The phone retains the final disposable photo and app installation for further
work. Two superseded large test originals were deleted with `inky-cli`; existing
photos were preserved. Network, permission, and stay-awake settings were restored.

## Permission coverage

This APK targets SDK 36. Android's documented implicit local-network access applies
on Android 17, so it does not request the SDK 37 runtime permission. Revoking the
implicit permission via ADB still allowed a config request on this phone; the
permission was explicitly restored afterward. Real runtime-denial UX therefore
has **not** been validated for SDK 37. Simulated permission failures verify error
propagation, cleanup, and no retry. See the SDK upgrade note in `app/README.md`.

## Automated checks

- 15 Node unit tests: multipart bytes/Unicode names/metadata, multi-chunk binary
  downloads, cancellation, errors, no retries, and interrupted rotation recovery.
- 4 Java tests: private-address/API policy, traversal rejection, no redirect or
  HTTP 503 retry, total deadline, and native cancellation using MockWebServer.
- 37 web editor/setup browser tests, 8 built-PWA tests, and 4 Android-bundle tests.
- Gradle debug APK and Java tests pass. APK SHA-256:
  `bae17861696b010b06261f55bc6f6ca95088177faeb55ecfcfc4fd66d8a9155e`.

The initial device helper waited for lazy thumbnails while their panel was hidden;
opening the gallery fixes that test issue. Its screenshot capture also exceeded
Node's default 1 MiB child-process output limit; the helper now allows 8 MiB. The
final recorded run passes every stage, including screenshot and CLI capture.

## Evidence and repeat command

- [Final phone run, including independent CLI job](android-pi-pixel9.json)
- [Phone screenshot](android-pi-pixel9.png)
- [Native timeout/cancellation/recovery](android-pi-recovery.json)
- [13.3-inch read-only check](android-pi-large-display.json)

```sh
cd app
node tools/android-pi-check.mjs --serial PHONE_SERIAL \
  --device http://WIFI_IP:8000 --photo /path/to/disposable.jpg \
  --flash --output /tmp/android-pi.json
```

The helper explicitly submits one new photo. Omit `--flash` to save only. Bluetooth
setup, discovery, and public release signing remain #22–#24. This change preserves
saved photo rotations and their revision operations; the website's additional
rotation controls/test-card UI remain separate work recorded in `app/source.json`.
