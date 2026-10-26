# Offline rescue mode

A frame without a usable local network for five continuous minutes displays a
reconnection card. The card is a prepared black/white PNG with a QR code for
<https://allan.pizza/setup/>. It tells the owner to reconnect power, then open
Android Chrome and connect over Bluetooth within five minutes. That reuses the
existing bounded provisioning window; rescue does not keep Bluetooth setup open
or depend on the native Android provisioning work in #22.

## Network detection

The server polls NetworkManager every ten seconds, with a five-second command
timeout. Wi-Fi and Ethernet (including USB gadget Ethernet) count as connected
when NetworkManager reports an activated interface with a non-loopback,
non-link-local address and sysfs reports carrier. The default USB address
`10.55.0.1` counts only while the cable has a live data connection. A captive
portal or an internet outage does not trigger rescue: there is no internet,
DNS, or gateway probe. This checks link/address availability, not end-to-end
reachability from a particular phone.

An unsuccessful/unknown probe resets the grace timer and reports `probe_error`;
it is not evidence of an outage. Startup starts a fresh grace period. Once
connectivity is continuously confirmed for 30 seconds, an automatically shown
card is replaced with the previous display. Connection flaps cancel recovery
jobs that have not begun. An in-progress physical refresh finishes normally.

## Display and persistence

Cards for 600×448 and 1600×1200, in both landscape and portrait, are compiled
into the server binary. Mounting compensation uses the existing display worker.
No fonts, QR generator, network service, or photo renderer runs on the Pi.
Regenerate the committed assets with `tools/generate-rescue-cards.py` on a
workstation (Pillow 13.0.0, qrcode 8.2, DejaVu Sans).

Rescue uses the normal serialized flash queue and waits for all active photo
edit leases and queued refreshes. Slideshow rotation pauses during the confirmed
outage and while the card is active. Rescue/restore jobs do not reset slideshow
anchors or advance its cursor. A manual photo cancels pending recovery jobs and,
on success, takes over from the card. It suppresses another automatic card for
the same outage. There is at most one automatic card attempt per outage; errors
are visible through the status API and do not cause repeated panel refreshes.
After a display or persistence error, explicitly retry, display a new photo, or
restart the server after fixing the cause.

Every successful ordinary refresh saves its immutable prepared pixels and
captured panel/mounting revision under `/data/inky-soup/rescue/` (or
`INKY_SOUP_DATA_DIR/rescue/`). This is one private last-display snapshot, not a
gallery photo. Replacement removes the previous snapshot; startup removes
orphaned snapshots. A crash marker prevents restoring an older image over an
interrupted manual refresh. State/snapshot writes use atomic rename and fsync.
A failure to record intent fails the refresh before the display is touched;
backup errors after a successful physical refresh appear in rescue status.

The first image displayed **after upgrading** establishes the restoration
snapshot. If none exists, or the panel/mounting revision changed, recovery leaves
the card in place and reports why it cannot restore; display a photo from the
app or CLI. Gallery edits/deletion cannot change an already captured snapshot.
The snapshot is removed when replaced, even if its original was deleted earlier.

## API and CLI

```sh
./inky-cli rescue                    # status; --json for scripts
./inky-cli rescue show --wait        # explicit card test; no gallery upload
./inky-cli rescue restore --wait     # restore last successful ordinary refresh
./inky-cli wifi-setup status         # inspect the separate Bluetooth window
./inky-cli wifi-setup start          # open its existing five-minute window over SSH
```

An explicit `show` remains visible until `restore` or a successful ordinary
refresh. It is not automatically canceled or restored by network observations.
Both operations return a normal flash job ID, accept `--wait --timeout SECONDS`,
and reject a busy display or active photo editor. Status is `GET /api/rescue`;
actions are `POST /api/rescue/show` and `POST /api/rescue/restore`, protected by
the same browser-origin guard as other write routes.

Status includes `enabled`, `connected` (null when unknown), `offline_seconds`,
`grace_seconds`, `recovery_seconds`, `card_active`, `manual_card`,
`outage_handled`, `restore_available`, `error`, and `probe_error`.
Flash job sources now also include `rescue` and `restore`.

Monitoring defaults on when `/usr/bin/inky-soup-update-display` is installed,
and off on a development workstation. `INKY_SOUP_RESCUE=1` forces it on;
`INKY_SOUP_RESCUE=0` disables automatic monitoring. Explicit CLI operations and
snapshot tracking still work with monitoring off. Set this through a systemd
service environment override if needed. Existing CLI server deployment carries
the embedded cards with the binary; no separate asset installation is needed.
The Yocto recipe declares the NetworkManager CLI dependency.

## Validation

Automated tests cover network/address/carrier classification, transient and
unknown observations, grace/recovery timers, queue and editor conflicts,
manual priority, reconnect cancellation, restart restoration, mounting changes,
failed refreshes and persistence, origin protection, CLI routes/waiting, and
native black/white decoding at all four mounting angles on both panel types.

Before merging/deploying, physical acceptance should cover both target setups:
Pi Zero W + 13.3-inch six-color panel, and Pi Zero 2 W + 5.7-inch seven-color panel.

1. Display a photo to seed restoration; record `rescue` status.
2. Run `rescue show --wait`, check text/orientation, and scan the QR code with a
   phone. Run `rescue restore --wait` and verify the original pixels return.
3. For a deliberate offline test, keep a way to restore Wi-Fi/power. A connected
   USB data cable suppresses rescue, so it must not remain connected as a usable
   network. Brief loss should leave the photo; sustained loss should show one card.
4. Reconnect power while offline and follow the card within five minutes; confirm
   Bluetooth provisioning remains bounded and local network recovery restores
   the prior image after 30 seconds. Check restart recovery and slideshow resumption.

Do not disconnect the shared test frame's network while another Android hardware
session is using it. Automated tests use a fake display command and synthetic
network observations; they do not claim physical acceptance.
