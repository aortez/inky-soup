# Inky Impression 5.7-inch validation

Target: Pi Zero 2 W, original 5.7-inch seven-color panel, UC8159, 600 × 448.
Hardware validation passed on `inky-soup-small` on 2026-10-25; details below.

## Fresh-frame setup

Build `npm run build:zero2` from `yocto/`. New images identify the panel on first
boot. For an older image, use the current checkout's CLI before uploading photos:

```bash
./inky-cli --device smaller-frame.local display-setup impression-5.7
./inky-cli --device smaller-frame.local display --json
```

Expected: model `impression-5.7`, width 600, height 448, thumbnails 150 × 112.
The driver fallback and fixed-wait warning fixes also require the matching
`update-image.py` installed as `/usr/bin/inky-soup-update-display`. For a server
that already matches this checkout, the script can be updated separately:

```bash
scp update-image.py inky@smaller-frame.local:/tmp/inky-soup-update-display.py
ssh inky@smaller-frame.local 'sudo cp /tmp/inky-soup-update-display.py /usr/bin/inky-soup-update-display && sudo chmod 0755 /usr/bin/inky-soup-update-display'
```

The server and script both include mounting orientation support. Deploy them
together when updating an older server; do not replace a newer script with an
older one.

## Physical checks

1. Reconnect the phone app. Upload a photo and confirm its preview is 600 × 448.
2. Exercise contain/cover, saturation, brightness, contrast, and all three dithers.
3. Generate and upload the exact-color card using the CLI:

   ```bash
   python3 tools/make-display-test-card.py /tmp/inky-5.7-test.png
   ./inky-cli --device smaller-frame.local upload /tmp/inky-5.7-test.png --prepared --flash --wait
   ```

4. Confirm the job reports completion and the screen shows the border, TOP label,
   and seven distinct labeled bars. In particular check blue, green, and orange.
5. Flash a photograph from the phone app and compare its framing with the preview.
6. Reboot and verify the display API still reports the smaller panel. Verify a
   second refresh works after restart.

Record the firmware revision, display identification, job result, and a photo of
the physical output. A successful API response alone does not verify panel color
or refresh completion.

## Automated coverage

Local validation on 2026-10-25 passed 16 Python tests, 14 CLI tests, 10 server
tests on Rust 1.85.0, and 126 JavaScript tests. Lint passed with existing warnings.
The new browser test passed against both 600 × 448 and 1600 × 1200 server
profiles. The 5.7-inch browser-generated PNG and test card were also decoded
through `set_pre_dithered_image`, preserving all seven UC8159 ink codes.
The systemd units passed `systemd-analyze verify` with fixture dependencies.
The full Pi Zero 2 W Yocto image build subsequently passed all 5,551 tasks using
KAS 5.4 in Debian 12. The image includes the panel configuration helper and
updated display script.

- Python: EEPROM profiles, explicit setup, atomic writes and failure preservation,
  smaller-panel driver fallback, native ink decoding, and refresh warnings/timeouts.
- CLI: real helper execution over a stub SSH transport, older-image setup without
  HTTP, SSH errors, seven-color prepared images, dimensions, and opacity.
- JavaScript: both palettes and all dithers, including orange and exact ink output.
- Browser: real configured server, upload, canvas dimensions, all seven ink values,
  saved thumbnails/cache, and prepared PNG upload. Physical submission is intercepted.

Driver identification and fixed-wait behavior were checked against
[Pimoroni Inky 2.2.1 auto-detection](https://github.com/pimoroni/inky/blob/v2.2.1/inky/auto.py)
and its [UC8159 driver](https://github.com/pimoroni/inky/blob/v2.2.1/inky/inky_uc8159.py).

## Hardware results — 2026-10-25

Tested `support-inky-impression-5-7` at base revision `b5e13c2` with the changes
in this checkout, on Raspberry Pi Zero 2 W Rev 1.0, kernel `6.6.63-v7` and Inky
2.2.1. The reflashed SD card booted with all four expected partitions. WiFi and
USB Ethernet both worked; USB testing used the device's scoped IPv6 address
because a second attached frame also advertised IPv4 `10.55.0.1`.

Two image configuration issues were found and corrected on the device and in
the build configuration:

- Load `i2c-dev` through `modules-load.d`; enabling the I2C device tree alone
  did not create `/dev/i2c-1`, so first-boot EEPROM identification failed.
- Package and enable Raspberry Pi's `spi0-0cs` overlay. The standard SPI setup
  claimed GPIO 8 as `spi0 CS0`, blocking Inky's manual chip-select request.
  The overlay came from the image's pinned Raspberry Pi kernel revision
  `e442e5c1ab6bff5b5460b4fc949beb72aaf77970`.

After removing the generated display profile and rebooting, the device loaded
I2C automatically, re-detected `impression-5.7`, recreated the 600 × 448 profile
with 150 × 112 thumbnails, and started the server with no failed systemd units.
The CLI uploaded the seven-color test card and submitted a physical refresh.
Post-reboot job 1 completed in 46.2 seconds without an error. The owner confirmed
the TOP label, border, and all seven labeled colors looked correct.

The browser test then passed against the actual Pi over the USB SSH tunnel:
upload, native-size preview, all three dithers, seven exact ink colors, saved
cache and thumbnail dimensions, and display-ready PNG upload. The test waits
for app initialization after the upload dialog reloads the page; clicking before
that was the cause of an initial automation failure. The phone site's CORS
check for `https://allan.pizza` also passed over WiFi (204 preflight, 200 read).
An actual phone-driven photograph comparison remains a useful manual check;
the physical validation here used the native-color card.

The subsequent full image rebuild passed all 5,551 tasks. Artifact
`inky-soup-image-raspberrypi0-2w.rootfs-20261025202612.wic.gz` has SHA-256
`28cd9cc68205d511f532ccc697d6ab619a75f79fd8156d3615952c88b0212220`.
Its gzip integrity and four-partition table were checked. The boot partition
contains `dtoverlay=spi0-0cs` and the exact overlay tested on the Pi; packaged
scripts, service units, and the I2C module-loading file match this checkout.

## Integration with mounting orientation

The PR was rebased onto `6a61c86`, which includes mounting orientation support.
The combined code passed 18 Python, 15 CLI, 20 server, 126 JavaScript, and 7 USB
tests, plus lint with the existing 18 warnings. Browser tests passed with a
600 × 448 seven-color profile, its 448 × 600 portrait orientation, and the
1600 × 1200 six-color profile. A UC8159 regression checks native ink codes and
corner positions at all four rotations.

The combined Pi Zero 2 W image build also passed all 5,551 tasks. Artifact
`inky-soup-image-raspberrypi0-2w.rootfs-20261025204240.wic.gz` has SHA-256
`c2956ff5cb56a463bf04991da94324582ec2e2d5263a6616752211084376b768`.
Gzip integrity and packaged scripts, frontend, and service configuration were
verified. The combined application payload was subsequently installed and tested
on the device as described below.

## Final PR smoke test — 2026-10-25

The matching server, display script, templates, and static assets were extracted
from the combined image and installed on `inky-soup-small` with the guarded CLI
deployment command. The existing I2C module-loading file and SPI overlay matched
the image's boot fixes. This was an application deployment with a software backup,
not another SD-card flash. Both existing photos and their saved adjustments were
preserved.

After reboot, the normal service started with no failed systemd units. The API
reported the 600 × 448 physical panel, mounting angle 0°, and revision 0. Job 1
completed the seven-color card in 47.4 seconds without an error; the owner again
confirmed the TOP label, border, and all seven colors. A second refresh completed
while the browser test exercised a separate disposable image.

The browser test now waits for the new document's initial status response to
finish before interacting, on both initial navigation and upload-dialog reload.
It deliberately delays the real display-config responses to cover the startup
race. Waiting only for the outgoing status request exposed a second race during
an active refresh, because the late status response could overwrite editor state;
waiting for the response to finish resolved that test failure.

The final test passed against the real Pi both idle and during a refresh, plus
local 448 × 600 portrait and 1600 × 1200 profiles. The hosted app's CORS check
passed. Disposable test images were removed, and the final gallery and saved
adjustments matched the pre-deployment state.

The deployment CLI update (`fc81260`, PR #13) merged while finalizing this PR.
After incorporating it, all 17 CLI tests passed. That integration changed none
of the server, frontend, or display-script files used in the hardware smoke test.
