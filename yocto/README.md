# Inky Soup Yocto Build System

Yocto-based build system for Raspberry Pi Zero 2 W images with NetworkManager, SSH, and e-ink display support.

## Quick Start

```bash
# First time setup - clone Yocto layers
source init.sh

# Build image
npm run build

# Flash to SD card (interactive)
npm run flash
```

## Architecture

**Note**: This is currently a simplified Yocto setup using direct git clones (inspired by xyron). We plan to migrate back to KAS for better reproducibility and configuration management once the basic image is stable.

### Directory Structure

```
yocto/
├── src/                          # Yocto layer sources (git clones)
│   ├── poky/                    # Main Yocto framework
│   ├── meta-openembedded/       # OE layers (meta-oe, meta-networking, meta-python)
│   ├── meta-raspberrypi/        # Raspberry Pi BSP
│   ├── openembedded-core/       # Core build system
│   └── meta-inky-soup/          # Our custom layer
├── build/poky/                   # Persistent build directory
│   ├── conf/                    # Build configuration
│   │   ├── local.conf          # Machine, distro, cache paths
│   │   └── bblayers.conf       # Layer configuration
│   └── tmp/deploy/images/       # Built images
├── downloads/                    # Shared download cache
├── sstate-cache/                # Shared state cache
├── scripts/                      # Flash and deploy scripts
│   ├── flash.mjs               # Interactive SD card flasher
│   └── yolo-update.mjs         # A/B partition updater (future)
├── init.sh                       # Environment setup script
└── package.json                  # npm build shortcuts
```

### meta-inky-soup Layer

Our custom layer contains:

- **recipes-core/images/inky-soup-image.bb** - Main image recipe
- **recipes-connectivity/networkmanager/** - NetworkManager config (enables nmtui)
- **recipes-core/init-ifupdown/** - Minimal interfaces file (lets NM manage devices)
- **recipes-support/persistent-data/** - Persistent /data partition support
- **wic/sdimage-inky-soup.wks** - A/B partition layout

## Build Configuration

### Target Hardware

- **Machine**: `raspberrypi0-2w` (Raspberry Pi Zero 2 W)
- **Architecture**: ARMv8 (cortex-a53), compiled for ARMv6 compatibility
- **WiFi**: BCM43436 chip

### Image Format

- **Type**: `wic.gz` with `wic.bmap` for fast flashing
- **Root filesystem**: ext4

### Partition Layout (A/B)

The image uses an A/B partition scheme for safe updates:

| Partition | Size   | Label    | Purpose                                    |
|-----------|--------|----------|--------------------------------------------|
| 1         | 150 MB | boot     | Kernel, device tree, config.txt           |
| 2         | 800 MB | rootfs_a | Primary system (active on first boot)     |
| 3         | 800 MB | rootfs_b | Secondary system (for OTA updates)        |
| 4         | 100 MB | data     | Persistent storage (WiFi creds, logs)     |

The data partition survives all updates. WiFi credentials configured via `nmcli`/`nmtui` are stored in `/data/NetworkManager/system-connections/` and bind-mounted into place on boot.

### Included Packages

**Networking:**
- NetworkManager (nmcli, nmtui)
- WiFi firmware (linux-firmware-rpidistro-bcm43436)
- SSH server (openssh-sshd, openssh-sftp-server)
- avahi-daemon (mDNS for `hostname.local` discovery)

**System:**
- systemd (init system, required for persistent-data services)
- persistent-data (bind mounts WiFi credentials from /data)
- kbd (keyboard utilities)

**Security:**
- SSH key authentication (injected at flash time)
- Root with empty password (debug-tweaks enabled)

## Development Workflow

### Initial Setup

```bash
# Clone Yocto sources (one-time)
source init.sh
```

This creates `src/` with git clones of:
- poky (scarthgap branch)
- meta-raspberrypi (scarthgap)
- meta-openembedded (scarthgap)
- openembedded-core (scarthgap)

### Building

```bash
# Build the image (uses bitbake under the hood)
npm run build

# Or manually:
cd src/poky
source ./oe-init-build-env
bitbake inky-soup-image
```

Build output: `build/poky/tmp/deploy/images/raspberrypi0-2w/`

### Flashing

```bash
# Interactive device selection
npm run flash

# Direct device specification
npm run flash -- --device /dev/sdb

# Dry run (show what would happen)
npm run flash -- --dry-run
```

**Flash script features:**
- Detects and lists available SD cards/USB drives
- SSH key injection (uses your ~/.ssh/*.pub key)
- WiFi credential injection (prompts for SSID/password)
- Hostname configuration
- Data partition backup/restore (preserves WiFi credentials across reflashes)
- Uses bmaptool if available

**First-time flash script setup:**

On first run, the script prompts you to select which SSH key to use. Your choice is saved in `.flash-config.json`.

To reconfigure: `npm run flash -- --reconfigure`

### Accessing the Device

**Serial console** (if HDMI connected):
```
Login: root
Password: (just press Enter)
```

**SSH** (after connecting to network):
```bash
ssh root@<ip-address>
```

Your SSH key was injected during flash, so no password needed.

## Network Configuration

### WiFi Setup at Flash Time (Recommended)

**Option 1: Credentials file (recommended for repeated flashing)**

Create `wifi-creds.local` in the yocto directory:

```json
{
  "ssid": "MyNetworkName",
  "password": "MySecretPassword"
}
```

The flash script will automatically use these credentials. This file is gitignored.

**Option 2: Interactive prompt**

If no credentials file exists, the script prompts during flash:

```
WiFi Configuration

ℹ Configure WiFi now so the device can connect on first boot.
ℹ Press Enter to skip (you can configure later with nmtui).

WiFi network name (SSID): MyNetwork
WiFi password: ********
```

The credentials are written to the data partition and automatically used on boot.

### Manual WiFi Setup (Alternative)

If you skipped WiFi during flash, or need to connect to a different network:

```bash
# Login via serial console or HDMI
# Username: root, Password: (empty)

nmtui
# Select "Activate a connection"
# Choose your WiFi network
# Enter password
```

Credentials are stored in `/data/NetworkManager/system-connections/` and persist across reflashes.

### Credential Persistence

The `/data` partition is preserved during both:
- Full reflashes (the flash script backs up and restores)
- A/B updates (the partition is never touched)

This means WiFi credentials configured once will survive all updates.

## Package Management

This image uses **dnf** (RPM-based package manager).

**Common commands:**
```bash
# Update package list
dnf check-update

# Install package
dnf install <package>

# Search for packages
dnf search <keyword>
```

**Note**: Yocto images are typically immutable - package installation is for debugging only. Permanent changes should be added to the image recipe.

## Customization

### Adding Packages to Image

Edit `src/meta-inky-soup/recipes-core/images/inky-soup-image.bb`:

```bitbake
IMAGE_INSTALL:append = " \
    your-package-name \
"
```

Then rebuild: `npm run build`

### Modifying Machine Config

Edit `build/poky/conf/local.conf`:

```bitbake
# Example: Change image formats
IMAGE_FSTYPES = "wic.gz wic.bmap tar.xz"

# Example: Add extra features
IMAGE_FEATURES += "package-management"
```

### Adding a Custom Recipe

Create `src/meta-inky-soup/recipes-<category>/<package>/<package>.bb`:

```bitbake
SUMMARY = "Your package"
LICENSE = "MIT"

SRC_URI = "file://your-source.tar.gz"

do_install() {
    install -d ${D}${bindir}
    install -m 0755 your-binary ${D}${bindir}/
}
```

## Troubleshooting

### Build Fails with "Nothing RPROVIDES"

Package name is wrong. Find the correct name:

```bash
cd src/poky
source ./oe-init-build-env
bitbake-layers show-recipes | grep <keyword>
```

### "Layer depends on layer X but it's not enabled"

Check layer names in `src/meta-inky-soup/conf/layer.conf`:

```bash
# Find actual layer names
grep BBFILE_COLLECTIONS src/*/conf/layer.conf
```

### Image Too Large

Check what's taking space:

```bash
cd build/poky
bitbake -e inky-soup-image | grep ^IMAGE_INSTALL=
```

### NetworkManager Shows Devices as "unmanaged"

Check `/etc/network/interfaces` - if eth0/wlan0 are defined there, NM won't touch them.

Our bbappend should fix this, but if not:
```bash
# Temporarily fix on device
echo "auto lo
iface lo inet loopback" > /etc/network/interfaces
killall NetworkManager && NetworkManager &
```

### Build Cache Issues

```bash
# Clean everything (nuclear option)
cd build/poky
rm -rf cache tmp

# Clean specific recipe
bitbake -c cleansstate <recipe-name>
```

## Performance Notes

### Shared Caches

The `downloads/` and `sstate-cache/` directories are shared across builds and can grow large:

- **downloads/**: Source tarballs and git repos (~10-50 GB)
- **sstate-cache/**: Pre-built objects (~20-100 GB)

These are safe to delete if disk space is tight, but rebuilds will be slower.

### Build Parallelism

Configured in `build/poky/conf/local.conf`:

```bitbake
BB_NUMBER_THREADS ?= "12"     # Parallel bitbake tasks
PARALLEL_MAKE ?= "-j 16"      # Parallel make jobs per recipe
```

Adjust based on your CPU cores and RAM.

## Comparison to Previous Setup

**Old (KAS-based):**
- Used `kas-inky-soup.yml` for config
- Submodules for layers
- More complex, harder to debug

**New (xyron-style):**
- Simple `init.sh` clones repos
- Direct git clones in `src/`
- Easier to understand and modify
- Shared caches with other projects

## TODO

### Immediate
- [x] WiFi credential injection at flash time
- [x] Persistent `/data` partition for WiFi credentials across updates
- [x] A/B partition support for atomic updates
- [x] Hostname advertising (avahi/mDNS) - `<hostname>.local`
- [ ] Migrate back to KAS-based build system for better reproducibility

### Future
- [ ] A/B update script (yolo-update.mjs) for OTA updates
- [ ] Inky-soup server package and service
- [ ] Python display script integration
- [ ] Pre-dithered image pipeline
- [ ] Test on actual Pi Zero 2 W with e-ink display

## References

- [Yocto Project Documentation](https://docs.yoctoproject.org/)
- [meta-raspberrypi Layer](https://github.com/agherzan/meta-raspberrypi)
- [NetworkManager Documentation](https://networkmanager.dev/)
