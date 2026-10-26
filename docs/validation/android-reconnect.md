# Android remembered-frame validation (#23)

Validated 2026-10-25 on a Pixel 9 Pro XL (Android 17) and a Pi Zero 2 W with
5.7-inch Inky Impression, 600 × 448, mount 0°. The large Pi was reserved for the
other checkout's #17 work and was not deployed to or rebooted.

## Automated checks

- App unit tests: 46 passed, including persistent registry/selection/forget,
  mismatched identities, discovery changes/cancellation, draft rotation receipts,
  and device/server-instance job reconciliation.
- Android bundle tests: 21 passed. New coverage includes same-name frames with
  different panels, IP reuse, identity changes during connection, app resume,
  read-only job reconciliation, unavailable/denied discovery, and reacquiring a
  draft edit lease at the verified new address.
- Web: 51 passed. PWA: 8 passed.
- Server: 27 passed, including concurrent identity initialization, restart
  persistence, corrupt-file refusal, and the real Rocket identity route.
- CLI: 26 Rust tests passed, including HTTP identity diagnostics and its Python
  deployment regression suite (11 tests). Deployment adds the Avahi service on
  older images and removes it when rolling back a failed first installation.
- Debug APK build, 8 Java tests, Android lint (0 errors; 12 existing warnings),
  CLI formatting and `git diff --check` passed.
- ARMv6-compatible server cross-build completed. Full Yocto image build was not
  repeated for this change; the Avahi recipe asset was exercised on the small Pi.

## Physical results

1. Installed the new APK as an update, preserving the existing draft. The old
   address-only frame association migrated after reading `/api/device`.
2. Find frames on WiFi discovered `inky-soup-small` with native Android NSD.
3. Temporarily cloned the Pi's WiFi profile and changed its DHCP client ID. Its
   lease changed from `192.168.1.149` to `192.168.1.101`. On resume, the phone found
   the new address without entering an address or opening Bluetooth setup. The
   persisted device ID remained `72d38d6af1b56f99ae0fb4407f44f621`.
4. Force-stopped and restarted the Android app; it reconnected to `.101` using
   the saved registry.
5. Rebooted the Pi. Its normal profile restored `.149`; the phone rediscovered
   it, retained the same ID, and observed a new server instance. Deleted the
   temporary WiFi profile afterward.
6. Submitted one orientation card through the Android UI, backgrounded the app,
   and resumed while it was refreshing. It reconciled job #1 through Completed;
   independent CLI reads confirmed that job and an empty queue. No second
   refresh was submitted. This checks job reconciliation, not a new visual panel
   acceptance; no fresh user confirmation of the physical card was requested.
7. Updated to the final APK, reopened a real gallery original, backgrounded and
   resumed, and confirmed its editing lease and enabled controls were restored.
   Final APK SHA-256:
   `d97cd94c9a633d7c12df5459af6c68e1cf3251b7e891e15ef38c2c57c00e066e`.

An initial lease-change experiment using a random WiFi MAC received `.104` but
was unreachable from the host/phone, despite reaching the gateway from the Pi.
The successful test kept the permanent MAC and changed only the DHCP client ID.
USB IPv6 access was retained throughout. The Pi is back on its original profile
at `.149`. Phone Bluetooth remains off and keep-awake is restored to its initial
value of 0.

![Saved-frame picker on the physical Android phone](android-reconnect.png)

## Remaining acceptance

- Both physical Pis selected from the same registry, once the large Pi is free.
  The two-panel/same-name case is covered by Android bundle tests meanwhile.
- End-to-end offline rescue card, five-minute BLE setup and photo restoration
  with #17 after that work lands. App recovery instructions use the existing
  reboot-while-offline setup window and defer rescue ownership to #17.
- A real Android local-network permission-denial scenario on an OS/target that
  enforces it; denied discovery and recovery UI are covered with the native
  bridge fixture. SDK 37 permission migration remains a separate follow-up.

Keep #23 open and the implementation PR in draft until the reserved-device and
#17 integration acceptance can be completed.
