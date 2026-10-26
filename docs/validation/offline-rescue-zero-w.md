# Offline rescue deployment: Pi Zero W

Device run: 2026-10-26 UTC (2026-10-25 local), original Pi Zero W with the
13.3-inch six-color display, 1600×1200, mounting 180°, orientation revision 3.

## Software

- Server: `cf6b5641597d9bb220d7be636af37fbb6ea50add` (merged PR #34).
- Provisioner: shared checkout `2751dc863af2d2019976ee9087a0589d15811973`;
  daemon source matches recipe pin `24b076557865b514c6e658bd87bd86a9dd59de65`.
- Server SHA-256: `3cb513772b09d10d37bbeb3c0d8ceb251558de20b919674e320d99dc3800cd9b`.
- Provisioner SHA-256: `05ef2c5ab8db6401f178a0129cca080fe49a4e9764f63ae916d95154338a2d2d`.
- Both built using Rust 1.85.0 for ARMv6/VFPv2 (`arm1176jzf-s`), linked with Zig.
  The provisioner links against the installed Pi libdbus ABI; no system library
  was replaced. Both installed through the extended `inky-cli deploy` transaction.
- Software rollback copy: `/var/lib/inky-soup/deployments/4979179614e947ddb3972b72688c5bd6`.

The optional provisioner bundle was staged under `/data/inky-releases/` because
this Pi has little free RAM-backed `/tmp` space. Existing service configuration,
network profiles, gallery originals, and per-photo settings were preserved.

## Checks

The CLI suite passed (25 Rust tests, including 15 deployment subprocess tests).
Deployment tests cover a healthy paired install, both health-check failure paths,
a partial provisioner replacement, invalid bundles/status, startup retries,
Bluetooth activity during preflight/staging, and unchanged server-only behavior.
Both services were active after deployment. Provisioner reported Wi-Fi connected,
setup idle, and zero automatic restarts; browser-origin checks passed.

The hardware display driver completed a refresh of existing `1422.jpg`, creating
its restoration snapshot, then completed the explicit rescue-card refresh and
explicit photo restoration. The owner confirmed readable, correctly oriented
text and a QR code that opens the setup page.
The snapshot's SHA-256 matches the prepared photo exactly:
`79d0fb936f260f92dfca316efe9c2b7f473fa15fb612e98e4b9463a359aec530`.

## Controlled outage

The on-device acceptance script armed a separate nine-minute systemd network
restore timer before disconnecting both Wi-Fi and USB networking. It temporarily
stopped the USB recovery timer, recorded local API samples every ten seconds, and
restored the original connection profiles and USB timer afterward.

- Offline daemon restart opened Bluetooth advertising with a 300-second window
  and `wifi_connected: false`.
- The photo stayed in place during the grace period. Automatic card job 4 started
  at 03:28:14 UTC, about 315 seconds after disconnect, and completed at 03:28:57.
  No network probe or display errors were reported.
- Networking was restored at 03:30:07. Automatic photo-restore job 5 started at
  03:30:38, after the 30-second stable-connection period, and completed successfully.
- Final status: connected, card inactive, restoration snapshot available, no
  errors, Bluetooth idle/Wi-Fi connected. Both services and the USB recovery timer
  were active; the temporary restore timer was stopped. All 15 gallery images
  remained, and the saved photo/snapshot hashes still matched.

The temporary harness mistakenly waited for a completed job in `current_job`,
which clears when a job finishes. It reported a timeout and took its network
cleanup path even though the card had completed. The server journal confirms
successful card job 4; the CLI then observed automatic restore job 5 complete.
The script was corrected to poll individual job IDs, but the full outage was not
repeated. [Recorded evidence](offline-rescue-zero-w.json) distinguishes this
harness failure from the verified device behavior.

A physical power cycle followed by phone provisioning, and Pi Zero 2 W /
5.7-inch panel acceptance remain separate checks.
