# Android hardware acceptance audit

Audit date: 2026-11-01. Tracks [#25](https://github.com/aortez/inky-soup/issues/25).

The implementation has substantial focused hardware coverage, but the complete
signed-release experience has not passed acceptance on both panels. Keep #25
open and retain the legacy Pi UI. Favorites and slideshow controls (#33) are
being handled separately and are outside this acceptance pass.

The [November 1 hardware follow-up](android-acceptance-2026-11-01.md) supersedes
the availability inventory below: both frames and the Pixel are reachable, and
the Pixel completed a signed 0.2.1 → 0.2.2 update with both remembered frames and
the observed draft fields preserved. Installer cancellation worked but exposed
a stale handoff message. The other hardware criteria remain open.

The [November 11 follow-up](android-acceptance-2026-11-11.md) updated both servers
to `a422fcf` over Wi-Fi SSH. A separate test APK passed import, editing, source
rotation and refresh recovery on both panels, with owner-confirmed physical
output and exact restoration of the previous pictures. It also exposed and
validated a fix for discarded Add photos selections during Android resume. That
fix still needs a signed release; these results do not certify public 0.2.2.

## Acceptance evidence and gaps

“Prior pass” means the linked record establishes that behavior on its stated
hardware and build. It does not certify a later release. None of the rows below
is a new hardware pass from this audit.

| Acceptance criterion | Existing evidence | Remaining check |
| --- | --- | --- |
| Clean install through setup, editing, upload and physical refresh | [Native BLE and photo flow](android-ble.md) passed on the small frame with a debug APK. [Signed installation](android-update.md) used ADB. | Install from the phone browser in a fresh test profile/device; complete the entire flow using a signed release. |
| Correct palettes, borders, labels and orientation on both panels | [Small-panel card](inky-impression-5-7.md) has owner confirmation of all seven colors, border and TOP. [Large-panel orientation](frame-orientation-pi-zero-w.json) has physical orientation confirmation through desktop Chromium. | Signed Android submission on both panels, recording visual confirmation of six/seven colors, edge labels and orientation. Preview pixels and completed jobs alone do not establish this. |
| Gallery, edits and mount orientation on both models | [Native transport](android-pi.md) covers small-frame saves/reads and large-frame gallery reads. Large-frame mount changes are recorded in the orientation evidence above. | Exercise create, reopen, edit, photo rotation, mount change and deletion through the signed app on each real API. Restore mounts and regenerate affected assets. |
| Offline editor and local use without internet | [Shell](android-shell.md) and [rotation](android-rotation-sync.md) passed offline force-stop/relaunch with a preserved draft. | Keep phone-to-Pi Wi-Fi available while internet access is absent; read gallery, save and physically refresh. Recheck cold launch with the signed build. |
| Background, termination and relaunch | [Reconnect](android-reconnect.md) passed small-frame refresh reconciliation after background/force-stop, with one completed job and restored edit ownership. | Repeat a short lifecycle check on the acceptance build; explicitly check recovery during an interrupted save. |
| Interrupted upload and lost submission/status responses cause no duplicate refresh | Reconnect evidence establishes single-job reconciliation after process termination. [Transport tests](android-pi.md) cover native timeout/cancellation; rotation-response tests concern rotation writes, not display submission. | Deliberately interrupt upload and separately drop a display-submission response and a job-status response on hardware. Count submissions/jobs independently, including after relaunch. |
| Permissions, Bluetooth interruption, bad credentials and expiry recover | [BLE hardware record](android-ble.md) covers permission denial/grant, Bluetooth off, cancellation/reconnect, explicit setup-window closure, and wrong credentials/retry. | Recheck on signed build; distinguish explicit closure from natural expiry and deliberately exercise an in-flight disconnect. SDK 37 local-network runtime denial remains outside the current target-SDK-36 claim. |
| Reboot, address change and multiple frames | [Reconnect](android-reconnect.md) passed both remembered frames, address changes, reboot, persistent selection and stable identity. | Short regression with the selected signed build and both frames available. |
| Wi-Fi recovery without developer tools in the user flow | Reconnect evidence covers small-Pi offline reboot, native BLE reprovisioning, readable rescue card and automatic photo restoration. [Large-frame rescue](offline-rescue-zero-w.md) covers outage/card/restore. | Physical power-cycle and phone-only recovery flow on both models; record physical results. Developer tools may observe but must not perform the user's setup steps. |
| Signed update preserves frames, settings and drafts | [Update record](android-update.md) passed 0.2.0 → 0.2.1, preserving one remembered frame and a brightness-adjusted draft. | Verify both remembered frames and preview settings. Complete the carried-over updater cases below. |
| Preserve user photos and settings | Reconnect and deployment records document preserved galleries, photo hashes and restored network state. | Capture a baseline for this run and compare after cleanup. Delete only identified disposable fixtures; restore mounts, connections and phone settings. |

## Updater cases carried into #25

The issue's comment explicitly carries these unfinished cases from #24:

1. First install from the phone browser, including its install-source permission.
2. Cancel Android's installer dialog itself: exercised in the November 1
   follow-up; retry and retained download passed, with stale banner wording to fix.
3. Interrupt a download and retry. Use controlled throttling because the APK is small.
4. Reject wrong-checksum and wrong-signing-digest metadata using a test build and
   test server. Keep this fixture separate from the public update channel.
5. Defer installation during a real display refresh and prove there is no second job.

An already installed latest APK cannot exercise a forward update. Use two
increasing signed versions in a disposable profile/device, or retain the phone's
older release until the newer acceptance candidate is ready. Do not uninstall a
user installation or downgrade it merely to manufacture this test.

## Read-only inventory on the audit date

- Checkout: clean at the start, `frame-main-split` at `32de3d8`; its content
  matched merged `main` at `a422fcf` (#58).
- Latest published app: `app-v0.2.2`, source commit `51463bf`, version code 2002.
  It predates the Frame feature-module refactor and recent server changes.
- `adb devices -l`: no attached phone. Installed APK version, signer and retained
  user state therefore remain unverified.
- `inky-soup.local`: reachable, 13.3-inch 2025 panel, 1600 × 1200, mount 0°,
  rotation revision 4; display queue empty. Identity:
  `aa3cdd6af7762024fb2812013228463c`.
- The large frame's server and provisioner services were active. Server
  `ExecStart` uses `/usr/bin/inky-soup-server`, with no systemd drop-ins.
  Latest deployment directory `c2567680dfe84cd2a9719fd42e1a4a88` records source
  `ac70c96f416c9487c9e8e82938cb32e3cd839af7`. This is deployment provenance,
  not a version reported by the running API.
- Installed server SHA-256:
  `7ee197951b51c52a1256fa432c7bb110c632dea4b9ee2028c76fd038bb827a1f`.
- Installed display-script SHA-256 matches this checkout's `update-image.py`:
  `a7c4b199ad495524d34b9238f78b9ea7747a2b557ed9cb147c1e3963be2e19a0`.
- Provisioner SHA-256 matches the previously validated rescue deployment:
  `05ef2c5ab8db6401f178a0129cca080fe49a4e9764f63ae916d95154338a2d2d`.
- `inky-soup-small.local`: status request timed out. CLI discovery returned only
  the large frame, over USB and Wi-Fi; these are two addresses for one identity.
  Small-frame firmware and availability remain unverified.

No deployment, display refresh, gallery write or network reconfiguration was
performed during this audit.

## Version requirements

Pin an exact signed APK and firmware revision for the acceptance run. The
available public baseline is 0.2.2. To certify the newer shared UI, first produce
a higher-version signed candidate from the chosen commit using the existing
[release workflow](../android-release.md); a debug APK does not establish the
signed install/update flow. Record whether concurrent favorites work is included.

Use a matching server/display payload containing identity/discovery, native BLE
support, photo and mount rotation, test cards, and offline rescue. For acceptance
of current main, include the photo-write guards (#54) and JSON failures (#55).
The large frame's recorded deployment predates those changes. Verify deployed
hashes against the selected bundle before attributing results to it. Preserve
the working provisioner unless the chosen firmware requires a change.

Build the server for each CPU: ARMv6/VFPv2 for the original Zero W, and the
appropriate ARMv7 target for Zero 2 W. Use the guarded CLI deployment with matching
display script and assets. An application deployment does not update boot files
or establish acceptance of a freshly built Yocto image.

## Order for the next hardware session

1. Connect the Pixel and make the small frame reachable. Record phone Android,
   WebView, APK version/signer, both device identities, installed software hashes,
   display profiles, gallery originals/settings and current mounts. Confirm the
   selected release and update path before changing software.
2. Prepare deterministic upload/submission/status interruption tests and the
   updater test-server fixture. Log request counts and individual job IDs; poll
   promptly because completed jobs are retained only briefly. Keep real photo
   storage and the public release channel out of these fixtures.
3. Run clean browser installation and the complete signed-app small-panel flow.
   A fresh test profile/device avoids clearing the existing user's app data.
   Capture CLI completion and the owner's physical color/orientation confirmation.
4. Repeat the gallery/edit/orientation/display checks on the large panel. Restore
   each original mount and prepared gallery assets after orientation testing.
5. Run local Wi-Fi without internet, lifecycle/interruption cases and phone-only
   Wi-Fi recovery. Use a bounded restoration safeguard for deliberate outages.
6. Run update cancellation, interrupted download, invalid metadata, active-job
   deferral and forward installation. Verify both remembered frames, draft,
   preview settings and job reconciliation afterwards.
7. Compare the original photo/settings baseline, remove only test fixtures and
   restore device/phone settings. Save screenshots, request/job records, firmware
   hashes and physical confirmations alongside the existing validation records.

Close #25 only after its criteria and the carried-over updater cases have
evidence for the selected builds. Retiring the legacy UI remains separate work
under #26, including the non-Android client decision in #42.
