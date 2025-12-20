# Inky Soup image for Raspberry Pi Zero 2 W.
DESCRIPTION = "Minimal image with NetworkManager, SSH, and USB keyboard support."

inherit core-image

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

# Console/terminal utilities.
IMAGE_INSTALL:append = " kbd"
