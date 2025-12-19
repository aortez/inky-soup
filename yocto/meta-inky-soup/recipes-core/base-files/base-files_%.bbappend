# Make /var/log persistent (not a tmpfs symlink).
# This allows journald to store logs across reboots.
VOLATILE_LOG_DIR = "no"

# Custom fstab for USB boot (uses /dev/sda1 for /boot instead of mmcblk0p1).
FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"
SRC_URI += "file://fstab"
SRC_URI += "file://profile.append"

do_install:append() {
    install -m 0644 ${WORKDIR}/fstab ${D}${sysconfdir}/fstab

    # Create inky's .profile with TERM fix for vim/nmon over SSH.
    # Busybox sh doesn't source /etc/profile reliably, but ~/.profile works.
    # Note: Ownership will be fixed by image recipe postprocess after user exists.
    install -d ${D}/home/inky
    install -m 0644 ${WORKDIR}/profile.append ${D}/home/inky/.profile
}
