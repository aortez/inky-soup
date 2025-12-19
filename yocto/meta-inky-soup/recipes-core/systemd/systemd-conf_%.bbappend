# Enable getty on tty1 for HDMI console login.

# Install a symlink to enable getty@tty1.service.
do_install:append() {
    # Enable getty on tty1 (HDMI framebuffer console).
    install -d ${D}${sysconfdir}/systemd/system/getty.target.wants
    ln -sf ${systemd_system_unitdir}/getty@.service \
        ${D}${sysconfdir}/systemd/system/getty.target.wants/getty@tty1.service
}

FILES:${PN} += "${sysconfdir}/systemd/system/getty.target.wants/getty@tty1.service"
