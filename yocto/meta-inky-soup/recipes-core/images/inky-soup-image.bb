SUMMARY = "Inky Soup base image for Raspberry Pi"
DESCRIPTION = "A minimal console image with NetworkManager, SSH, and \
development tools for the Inky Soup e-ink display project."
LICENSE = "MIT"

inherit core-image

# ============================================================================
# Image Features
# ============================================================================
# ssh-server-openssh: OpenSSH server for remote access.
# NOTE: debug-tweaks removed for security - we use SSH keys instead.
IMAGE_FEATURES += " \
    ssh-server-openssh \
"

# ============================================================================
# User Configuration
# ============================================================================
# Create 'inky' user with sudo access.  SSH key is injected at flash time.
inherit extrausers

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

    # Inky Soup application directory (logs, config, etc.).
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup/logs
    install -d -m 755 ${IMAGE_ROOTFS}/home/inky/inky-soup/config

    # Fix ownership of entire home directory (including .profile from base-files).
    chown -R 1000:1000 ${IMAGE_ROOTFS}/home/inky
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_inky_home;"

# ============================================================================
# A/B Boot Initialization
# ============================================================================
# On first boot, mark that we're running from slot A.
setup_ab_boot() {
    # Create initial boot_slot marker (will be on boot partition after flash).
    # This gets copied to /boot when the boot partition is mounted.
    install -d ${IMAGE_ROOTFS}/boot
    echo "a" > ${IMAGE_ROOTFS}/boot/boot_slot
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_ab_boot;"

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
    nmon \
    rsync \
    screen \
    strace \
    tree \
    util-linux-agetty \
    vim-tiny \
"

# ============================================================================
# WiFi Support
# ============================================================================
# Firmware for Pi Zero W and Zero 2 W onboard WiFi.
# Zero W uses BCM43430, Zero 2 W uses BCM43436.
IMAGE_INSTALL:append = " \
    linux-firmware-rpidistro-bcm43430 \
    linux-firmware-rpidistro-bcm43436 \
    linux-firmware-rpidistro-bcm43436s \
"

# ============================================================================
# Inky Soup Server
# ============================================================================
# Rocket-based web server for image upload and display control.
IMAGE_INSTALL:append = " \
    inky-soup-server \
"

# ============================================================================
# Inky Soup Display
# ============================================================================
# Python script for controlling the Inky Impression e-ink display.
IMAGE_INSTALL:append = " \
    inky-soup-display \
"
