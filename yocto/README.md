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

## Build Configuration

### Target Hardware

- **Machine**: `raspberrypi0-2w` (Raspberry Pi Zero 2 W)
- **Architecture**: ARMv8 (cortex-a53), compiled for ARMv6 compatibility
- **WiFi**: BCM43436 chip

### Image Format

- **Type**: `wic.gz` with `wic.bmap` for fast flashing
- **Partitions**: Standard Raspberry Pi layout (boot + rootfs)
- **Root filesystem**: ext4

### Included Packages

**Networking:**
- NetworkManager (nmcli, nmtui)
- WiFi firmware (linux-firmware-rpidistro-bcm43436)
- SSH server (openssh-sshd, openssh-sftp-server)

**Console:**
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

**Build times:**
- First build: ~1-2 hours (downloads and compiles everything)
- Incremental: ~5-15 minutes (with sstate-cache)

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
- Hostname configuration
- Data partition backup/restore (preserves WiFi credentials across reflashes)
- Uses bmaptool if available (much faster)

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

### Current State (Manual Setup Required)

After first boot:

1. Login as root (empty password)
2. Edit `/etc/network/interfaces` to remove eth0/wlan0 (or we fix this in the image)
3. Restart NetworkManager: `killall NetworkManager && NetworkManager &`
4. Configure WiFi with nmtui:
   ```bash
   nmtui
   # Select "Activate a connection"
   # Choose your WiFi network
   # Enter password
   ```

### Planned: WiFi Injection at Flash Time

**TODO**: Flash script should inject NetworkManager connection file:
- Prompt for SSID/password during flash
- Write to `/etc/NetworkManager/system-connections/`
- Or use persistent `/data` partition (like sparkle-duck)

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
- [ ] WiFi credential injection at flash time
- [ ] Hostname advertising (avahi/mDNS) - `<hostname>.local`
- [ ] Migrate back to KAS-based build system for better reproducibility

### Future
- [ ] Persistent `/data` partition for WiFi credentials across updates
- [ ] A/B partition support for atomic updates
- [ ] Inky-soup server package and service
- [ ] Python display script integration
- [ ] Pre-dithered image pipeline
- [ ] Test on actual Pi Zero 2 W with e-ink display

## References

- [Yocto Project Documentation](https://docs.yoctoproject.org/)
- [meta-raspberrypi Layer](https://github.com/agherzan/meta-raspberrypi)
- [NetworkManager Documentation](https://networkmanager.dev/)
