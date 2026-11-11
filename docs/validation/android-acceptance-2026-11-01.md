# Android acceptance on November 1 2026

The Pixel passed a signed in-app update from 0.2.1 to 0.2.2 with its observed
draft settings and both remembered frames intact. Cancelling Android's installer
also preserved the old installation and the verified download, but exposed a
stale instruction in the update banner. This is a partial pass toward
[#25](https://github.com/aortez/inky-soup/issues/25), not completion of the
[full acceptance audit](android-acceptance-audit.md).

## Hardware and installed software

- Pixel 9 Pro XL, Android 17/API 37, build `CP2A.260605.016`, WebView
  `155.0.8059.39`. The app targets SDK 36 and is a release build.
- Large frame: Pi Zero W, 13.3-inch 2025 panel, 1600 × 1200, mount 0°,
  rotation revision 4, Wi-Fi `192.168.1.109`.
- Small frame: Pi Zero 2 W, 5.7-inch panel, 600 × 448, mount 0°,
  rotation revision 0, Wi-Fi `192.168.1.149`.
- Both frames' latest deployment records name
  `ac70c96f416c9487c9e8e82938cb32e3cd839af7`. Their server and provisioner services
  were active, with no server systemd drop-ins. Recorded deployment revisions
  are provenance rather than an API-reported running build version.
- Both installed display scripts match this checkout. Both provisioner hashes
  match the previously validated rescue build. Exact identities and executable
  hashes are in the [machine-readable record](android-acceptance-2026-11-01.json).

## Checks completed

1. Read status and identities through `inky-cli`; verified the small frame's SSH
   connection over Wi-Fi. Discovery returned both device identities. USB and
   Wi-Fi addresses for the large frame identify the same device.
2. Pulled the installed 0.2.1 APK and verified its signature using `apksigner`.
   Its certificate digest matched the published update metadata and the
   previously recorded release key.
3. Opened the actual signed app. It restored its existing photo draft and
   reconnected to the large frame. Captured filename, dimensions, source rotation,
   composition, saturation, brightness and contrast before further interaction.
4. Downloaded 0.2.2 through the app. The banner reported the package ready to
   install. Opened Android's package installer, selected **Just once** in the
   chooser, and pressed **Cancel** at **Update this app?**. Package-manager
   inspection confirmed that 0.2.1 remained installed. After preview processing,
   **Install** was enabled again without another download.
5. Used **Find frames on WiFi**. Both identities appeared. The picker initially
   remembered only the large frame; selected and added the small frame, which
   connected with the correct 600 × 448 profile. Returned to the large frame.
6. Force-stopped and relaunched the app. All seven observed draft fields matched
   the baseline; the large frame reconnected and the verified update remained
   available. The stale cancellation notice described below cleared on relaunch.
7. Retried installation through the app and Android's installer. Play Protect
   requested a scan and subsequently reported that installation could continue.
   Package-manager inspection then confirmed version 0.2.2/build 2002.
8. Pulled the installed 0.2.2 APK. Its SHA-256 was
   `c303df80e01da67071d8d0e11451c844ed704af0cbc603432578f3f2381e24e8`, exactly
   matching the published release metadata. `apksigner` verified the same release
   certificate, `323dc7c2a994fa3217530c2fa8e7beffc1fc9ed4b4c6c43e92e29baebc7ea605`.
9. Both remembered frames remained in the updated app's picker. Connected to the
   small frame at 600 × 448, then restored the large-frame selection at
   1600 × 1200. The existing draft's seven observed fields still matched and its
   preview regenerated to Ready.
10. Compared SHA-256 hashes of every original and per-photo metadata file before
    and after: 15 originals plus 15 metadata files on the large frame, and three
    originals plus three metadata files on the small frame. All 36 matched.
    Both mount configurations were unchanged and both display queues were idle.

The initial cold-launch and final frame-switch captures occurred before the UI
finished loading/processing. Rechecking the settled UI passed the assertions;
those early captures were timing errors in this manual automation, not evidence
of lost draft state.

## Installer cancellation wording

After returning from **Cancel**, the app remained usable and retained the
verified package, but its banner eventually said:

> Confirm the update in the Android installer. The app reopens as the new version.

The installer had already closed. Preview/connection busy messages temporarily
covered that notice; once idle it returned. Force-stop/relaunch replaced it with
the correct ready-to-install message. Retry and the subsequent update worked.

The current checkout still assigns this notice in
`app/frame/ui/updates.js:startInstall`; automatic checks within the six-hour
interval retain the existing update object. Follow-up: reconcile the installer
handoff on app resume and show a ready-to-install state after cancellation,
while preserving the separate install-permission recovery guidance. Add a
regression that simulates the actual background/resume sequence after handoff.

## Scope and remaining checks

The phone now has signed 0.2.2 and remembers both frames, with the large frame
selected and its original draft visible. Firmware and physical displays were
not changed. No photo upload, deletion, mount change or physical refresh was
requested. The records contain hardware observations; no software test suite was
run in this pass.

Still open: clean browser installation; interrupted update download; invalid
update metadata; installation deferral during a physical refresh; explicit
preview-profile and job-receipt preservation; the remaining two-panel physical,
BLE, network-outage and lost-response cases in the audit. The current Pixel is
now on the latest public release, so another forward-update test needs a newer
signed candidate or a disposable test profile/device with an older release.

These results cover released 0.2.1/0.2.2 and the installed firmware. They do not
validate current-main changes or concurrent favorites work. Before testing the
current server's behavior, deploy a pinned matching application bundle containing
the photo-write guards and unified API errors, then record its hashes.
