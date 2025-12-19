SUMMARY = "Inky Soup image for Raspberry Pi Zero"
DESCRIPTION = "A minimal console image with NetworkManager, SSH, web server, \
and e-ink display support for the Inky Soup image display project."
LICENSE = "MIT"

inherit core-image

# ============================================================================
# Image Features
# ============================================================================
# ssh-server-openssh: OpenSSH server for remote access.
# debug-tweaks: Enables passwordless root login for debugging.
# TODO: Remove debug-tweaks for production images.
IMAGE_FEATURES += " \
    ssh-server-openssh \
    debug-tweaks \
"

# ============================================================================
# User Configuration
# ============================================================================
# Create 'inky' user with sudo access. SSH key is injected at flash time.
inherit extrausers

# Note: spi/gpio/video groups don't exist by default. User has sudo anyway.
EXTRA_USERS_PARAMS = " \
    useradd -m -s /bin/bash -G sudo inky; \
    usermod -p '*' inky; \
"

# Ensure sudo is installed.
IMAGE_INSTALL:append = " sudo"

# Set up inky home directory with correct ownership and permissions.
setup_inky_home() {
    # .ssh directory (key injected at flash time).
    install -d -m 700 ${IMAGE_ROOTFS}/home/inky/.ssh
    touch ${IMAGE_ROOTFS}/home/inky/.ssh/authorized_keys
    chmod 600 ${IMAGE_ROOTFS}/home/inky/.ssh/authorized_keys

    # Inky Soup application directory.
    # Note: static/images/ is bind-mounted from /data/inky-soup/images by persistent-data.
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup/static
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup/static/images
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup/templates

    # Fix ownership of entire home directory.
    chown -R 1000:1000 ${IMAGE_ROOTFS}/home/inky
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_inky_home;"

# ============================================================================
# A/B Boot Initialization
# ============================================================================
# On first boot, mark that we're running from slot A.
setup_ab_boot() {
    # Create initial boot_slot marker.
    install -d ${IMAGE_ROOTFS}/boot
    echo "a" > ${IMAGE_ROOTFS}/boot/boot_slot
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_ab_boot;"

# ============================================================================
# Display Configuration Directory
# ============================================================================
# Create directory for display configuration (populated at runtime).
setup_display_config() {
    install -d ${IMAGE_ROOTFS}/etc/inky-soup
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_display_config;"

# ============================================================================
# Network Management
# ============================================================================
# NetworkManager provides nmcli/nmtui for network configuration.
IMAGE_INSTALL:append = " \
    networkmanager \
    networkmanager-nmtui \
    networkmanager-nmcli \
"

# ============================================================================
# Persistent Data
# ============================================================================
# Mounts /data partition which survives A/B updates.
# WiFi credentials, logs, and config are stored here.
IMAGE_INSTALL:append = " \
    persistent-data \
"

# ============================================================================
# Service Discovery
# ============================================================================
# Avahi for mDNS - find the Pi as "inky-soup.local" on the network.
IMAGE_INSTALL:append = " \
    avahi-daemon \
    avahi-utils \
"

# ============================================================================
# Development & Debug Tools
# ============================================================================
# Useful tools for poking around on the device.
IMAGE_INSTALL:append = " \
    ab-boot-manager \
    curl \
    file \
    htop \
    jq \
    less \
    nano \
    rsync \
    screen \
    strace \
    tree \
    util-linux-agetty \
    vim \
"

# ============================================================================
# Python Support
# ============================================================================
# Python packages are now pulled in as dependencies of inky-soup-display.
# No need to list them here explicitly.

# ============================================================================
# SPI and GPIO Access
# ============================================================================
# Tools for hardware access (Inky Impression uses SPI).
IMAGE_INSTALL:append = " \
    rpi-gpio \
    spidev-test \
"

# ============================================================================
# WiFi Support
# ============================================================================
# Firmware for the Pi Zero's onboard WiFi.
IMAGE_INSTALL:append = " \
    linux-firmware-rpidistro-bcm43430 \
    linux-firmware-rpidistro-bcm43436 \
"

# ============================================================================
# Inky Soup Application
# ============================================================================
# Web server and display driver for e-ink display.
IMAGE_INSTALL:append = " \
    inky-soup-server \
    inky-soup-display \
"
