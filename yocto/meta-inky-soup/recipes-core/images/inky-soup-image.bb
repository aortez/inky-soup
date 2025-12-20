# Inky Soup image for Raspberry Pi Zero 2 W.
DESCRIPTION = "Minimal image with NetworkManager, SSH, and e-ink display support."

inherit core-image extrausers

# Create 'inky' user for SSH access.
# - Password is locked ('*') so only SSH key auth works.
# - Added to sudo group for administrative tasks.
EXTRA_USERS_PARAMS = " \
    useradd -m -s /bin/sh -G sudo inky; \
    usermod -p '*' inky; \
"

# Set up SSH directory for inky user.
setup_inky_ssh() {
    install -d -m 700 ${IMAGE_ROOTFS}/home/inky/.ssh
    touch ${IMAGE_ROOTFS}/home/inky/.ssh/authorized_keys
    chmod 600 ${IMAGE_ROOTFS}/home/inky/.ssh/authorized_keys
    chown -R 1000:1000 ${IMAGE_ROOTFS}/home/inky/.ssh
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_inky_ssh;"

# Enable passwordless sudo for inky user.
setup_inky_sudo() {
    install -d -m 755 ${IMAGE_ROOTFS}/etc/sudoers.d
    echo "inky ALL=(ALL) NOPASSWD: ALL" > ${IMAGE_ROOTFS}/etc/sudoers.d/inky
    chmod 440 ${IMAGE_ROOTFS}/etc/sudoers.d/inky
}
ROOTFS_POSTPROCESS_COMMAND:append = " setup_inky_sudo;"

# WiFi firmware for Pi Zero 2 W (BCM43436 chip).
IMAGE_INSTALL:append = " linux-firmware-rpidistro-bcm43436"

# NetworkManager for network configuration (nmtui/nmcli).
IMAGE_INSTALL:append = " \
    networkmanager \
    networkmanager-nmtui \
    networkmanager-nmcli \
    networkmanager-wifi \
"

# SSH access.
IMAGE_INSTALL:append = " openssh-sshd openssh-sftp-server"

# mDNS/DNS-SD for hostname.local discovery.
IMAGE_INSTALL:append = " avahi-daemon"

# Console/terminal utilities.
IMAGE_INSTALL:append = " kbd"

# Sudo for administrative tasks.
IMAGE_INSTALL:append = " sudo"

# Shared infrastructure from pi-base layer.
# - persistent-data: Mounts /data, bind-mounts WiFi credentials.
# - hostname-setup: Sets hostname from /boot/hostname.txt.
# - ab-boot-manager: A/B boot slot management for safe updates.
IMAGE_INSTALL:append = " \
    persistent-data \
    hostname-setup \
    ab-boot-manager \
"
