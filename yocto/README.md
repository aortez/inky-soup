# Inky Soup Yocto images

This directory builds complete Linux images for the Raspberry Pi Zero W and Zero
2 W. Images include the web app, display driver, NetworkManager, SSH, USB
Ethernet, and persistent photo storage.

## Prepare the checkout

From the repository root:

```bash
git submodule update --init --recursive
cd yocto
npm ci
```

The `pi-base` submodule supplies shared recipes and JavaScript helpers. KAS
fetches the other Yocto layers. User preferences in `.flash-config.json`, WiFi
credentials in `wifi-creds.local`, and build/cache directories are ignored by Git.

Builds use Yocto Scarthgap and KAS. The validated Pi Zero W image was built with
KAS 5.4 in a Debian 12 container; use a compatible Yocto build environment rather
than assuming any host distribution's Python and system tools will work. See the
[KAS container guide](https://kas.readthedocs.io/en/5.4/userguide/kas-container.html)
for container setup.

## Select hardware and build

| Target | Architecture | KAS configuration | Output directory under `build/tmp/deploy/images/` |
| --- | --- | --- | --- |
| Pi Zero W | ARMv6, ARM1176JZF-S | `kas-inky-soup-zero1.yml` | `raspberrypi0-wifi/` |
| Pi Zero 2 W | ARMv7 userspace, Cortex-A53 | `kas-inky-soup-zero2.yml` | `raspberrypi0-2w/` |

Both configurations include `kas-base.yml`. The Pi Zero W has been tested on
hardware with kernel 6.6.63; the Zero 2 W target still needs a current hardware
validation pass.

From `yocto/`, with `kas` installed in the build environment:

```bash
npm run build:zero1
# Or:
npm run build:zero2
```

`npm run build` uses a saved target preference or prompts. Direct KAS equivalents:

```bash
kas build kas-inky-soup-zero1.yml
kas build kas-inky-soup-zero2.yml
```

Outputs include `inky-soup-image-<machine>.rootfs.wic.gz` for SD card flashing,
its `.wic.bmap` map, and `.rootfs.tar.gz` for root filesystem updates. The helpers
look under `yocto/build/tmp/deploy/images/<machine>/`; if you build with an
external `KAS_BUILD_DIR`, account for that path before using the helpers.

Build sources and settings live in:

- `kas-base.yml`: shared layers, boot configuration, image format, partition
  sizes, parallelism, and Rust toolchain version.
- `kas-inky-soup-zero1.yml` / `kas-inky-soup-zero2.yml`: machine selection.
- `meta-inky-soup/`: application, display, USB, and image recipes.
- `pi-base/yocto/meta-pi-base/`: persistent storage and A/B boot infrastructure.

Generated `build/**/conf/` files are local build output. Change the KAS files or
recipes to make configuration changes reproducible.

## Flash an SD card

Optionally create WiFi credentials before flashing:

```bash
cp pi-base/scripts/wifi-creds.local.example wifi-creds.local
# Edit wifi-creds.local with your SSID and password.
npm run flash:zero1
# For a Zero 2 W, use npm run flash:zero2.
```

The flash helper selects a disk, confirms before overwriting it, injects your
public SSH key for the `inky` user, sets the hostname, and optionally configures
WiFi. It remembers preferences in `.flash-config.json`.

```bash
npm run flash -- --zero1 --dry-run
npm run flash -- --zero1 --device /dev/sdX
npm run flash -- --reconfigure
```

Replace `/dev/sdX` with the intended SD card device. Use `--help` for options.
If an existing data partition is found, the helper offers a backup and restore;
photo and WiFi data survive a full reflash only if that succeeds.

### Partition layout

Sizes below come from `kas-base.yml`:

| Partition | Initial size | Purpose |
| --- | --- | --- |
| 1 | 150 MiB | Shared FAT boot partition: firmware, kernel, device trees, configuration |
| 2 | 1800 MiB | Root filesystem slot A |
| 3 | 1800 MiB | Root filesystem slot B, initially empty |
| 4 | 100 MiB | Persistent `/data`: photos, metadata, WiFi profiles |

A/B updates replace the inactive root filesystem and leave `/data` intact. The
100 MiB data partition in a freshly flashed image may need expanding for a photo
library; automatic expansion in the flash helper is part of the parked settings
branch, not this branch. An existing device's data partition may already be larger.

## Bluetooth WiFi setup

Scan the [printable 70 × 85 mm label](../docs/inky-soup-setup-label.svg), or open
[allan.pizza/setup/](https://allan.pizza/setup/) in a supported Chrome/Edge browser.
An unconnected frame opens setup for five minutes after startup. A frame already
connected to WiFi stays closed. Setup closes on success, timeout, or Stop.

From a USB/SSH console, use:

```sh
wifi-provisioner --start   # Open a five-minute setup window.
wifi-provisioner --status
wifi-provisioner --stop
```

The existing loopback WebSocket API also accepts a `start` timeout of 1–300
seconds. It rejects browser Origins. This is a bounded provisioning window, not a
Bluetooth ownership/bonding system. Stopping cancels the pending command, but does
not roll back a network change NetworkManager has already accepted.

Inky Soup packages `/etc/default/wifi-provisioner` with
`WIFI_PROVISIONER_WEB_PORT=8000`; the successful setup link uses the device hostname
and this port. Credentials remain on the phone and device, with no website upload.

Regenerate the label with `python3 tools/make-setup-label.py` from the repository
root (requires `qrcode`). The QR contains only the stable setup URL, no secrets.

## Access and WiFi

```bash
ssh inky@inky-soup.local
# Web app: http://inky-soup.local:8000
```

SSH uses the public key injected during flashing. The `inky` user has passwordless
sudo. To configure WiFi from a USB SSH session, run `sudo nmtui` on the Pi.
WiFi profiles live in `/data/NetworkManager/system-connections`, bind-mounted at
`/etc/NetworkManager/system-connections` during boot.

## USB access

### USB Ethernet (Pi Zero W / Zero 2 W)

Images built from this configuration enable Ethernet over the micro-USB socket
labeled **USB**. Connect it to the computer with a data-capable cable. The Pi uses
`10.55.0.1/24`; configure the computer's USB network interface as `10.55.0.2/24`,
with no gateway or DNS server. WiFi remains available and keeps its default route.

On a Linux computer using NetworkManager, find the new Ethernet interface with
`nmcli device status`, then create a persistent profile:

```bash
# Replace this with the USB interface shown on your computer.
INKY_USB_IFACE=enx0600f41b6883
nmcli connection add type ethernet ifname "$INKY_USB_IFACE" \
  con-name "Inky Soup USB" \
  ipv4.method manual ipv4.addresses 10.55.0.2/24 ipv4.never-default yes \
  ipv6.method link-local ipv6.never-default yes
nmcli connection up "Inky Soup USB"

ssh inky@10.55.0.1
# Web app: http://10.55.0.1:8000
```

Use the USB IP explicitly when testing: `inky-soup.local` can also resolve to the
WiFi address. SSH uses the same injected key and `inky` user on both interfaces.
This static subnet supports one attached Inky Soup unit at a time; additional
units need separate subnets.

The `inky-soup-usb-gadget` package loads `dwc2` and `g_ether` at boot, derives stable
MAC addresses from the board serial number, and installs the NetworkManager
profile under `/usr/lib/NetworkManager/system-connections`. Keeping the profile
there prevents the persistent `/data` bind mount from hiding it. A NetworkManager
configuration override explicitly manages `usb0`, which its default udev rules
otherwise leave unmanaged.

A recovery timer checks the connected gadget starting 45 seconds after boot and
at most once a minute afterward. It sends an ARP probe to the configured host at
`10.55.0.2` and reloads `g_ether` only if the host does not answer and no other
packets arrive during the probe. ARP works even when the host blocks ICMP echo.
This also detects a link that stalls after receiving its first packets, rather
than treating any past traffic as proof of a healthy link. It mitigates
the [reported dwc2 startup stall](https://github.com/raspberrypi/rpi-usb-gadget/pull/31)
that was also observed on the attached Pi Zero W with kernel 6.6.63. It does not
reset a healthy idle link whose host answers ARP. Check recovery activity with
`journalctl -u inky-soup-usb-recover.service`.

Run `npm run test:usb` from `yocto/` for the recovery script's regression checks.

For an existing image, installing the package alone is insufficient: the shared
boot partition's `config.txt` also needs `dtoverlay=dwc2,dr_mode=peripheral` in the
`[all]` section, followed by a reboot. The A/B rootfs updater does not install this
boot configuration change. New SD card images include it through
`ENABLE_DWC2_PERIPHERAL` in `kas-base.yml`.

To diagnose a connection, check `systemctl status inky-soup-usb-gadget`,
`ip addr show usb0`, and `ls /sys/class/udc` on the Pi, and `lsusb` / `nmcli device
status` on the host. The Pi should have `10.55.0.1` on `usb0` and the host should
show an Ethernet gadget. This setup uses the kernel's
[USB Ethernet gadget](https://github.com/raspberrypi/rpi-usb-gadget) support.

## Update an existing device

The `yolo` helper builds a rootfs tarball, streams it to the inactive slot,
injects the configured SSH key, switches slots, and reboots. It targets
`inky@inky-soup.local`; use the explicit machine flag to match the attached Pi.
Ensure `.flash-config.json` contains a valid `ssh_key_path` and the real FAT boot
partition is mounted at `/boot` before changing slots.

```bash
npm run yolo:zero1 -- --skip-build --dry-run
npm run yolo:zero1
# Or deploy an already-built image:
npm run yolo:zero1 -- --skip-build
```

The dry-run form still reads device state over SSH; include `--skip-build` to
avoid a build. The updater replaces only the root filesystem. It does not deploy
kernel, firmware, device-tree, or `config.txt` changes to the shared boot
partition. Those changes need a matching boot update or a full SD card flash.
A/B slots do not provide automatic rollback or independent boot firmware.

The current helper does not preserve SSH host keys from the running rootfs;
verify the device's identity if SSH reports a changed host key after an update.
The `--fast` deployment mode and additional update checks are in
[PR #5](https://github.com/aortez/inky-soup/pull/5), not on this branch.

## Validation and diagnostics

USB script tests need Python 3 and no connected device:

```bash
npm run test:usb
```

On the Pi:

```bash
systemctl --failed
systemctl status inky-soup-server.service
journalctl -u inky-soup-server.service -n 50
systemctl status persistent-data-init.service persistent-data-bind.service
ab-boot-manager current
df -h / /data
nmcli device status
```

The app stores images in `/data/inky-soup/images` and serves HTTP on port 8000.
The USB recovery log is `journalctl -u inky-soup-usb-recover.service`.

## Build maintenance

Add packages in `meta-inky-soup/recipes-core/images/inky-soup-image.bb` and rebuild
for persistent system changes. This repository does not configure a package feed
for installing arbitrary packages on a running Pi.

```bash
# Clean the image, then rebuild (substitute --zero2 when appropriate).
npm run build -- --zero1 --clean

# Clean server and image before rebuilding.
npm run build -- --zero1 --clean-all

# Inspect recipes inside the configured build environment.
kas shell kas-inky-soup-zero1.yml -c 'bitbake-layers show-recipes'
```

`downloads/` and `sstate-cache/` can be shared between builds. They and `build/`
can consume tens of gigabytes; select storage with enough space. Set
`BB_NUMBER_THREADS` and `PARALLEL_MAKE` in `kas-base.yml` for the build host.

## References

- [Yocto Scarthgap documentation](https://docs.yoctoproject.org/5.0/)
- [KAS documentation](https://kas.readthedocs.io/)
- [meta-raspberrypi](https://github.com/agherzan/meta-raspberrypi)
- [Shared pi-base infrastructure](https://github.com/aortez/sparkle-duck-shared)
