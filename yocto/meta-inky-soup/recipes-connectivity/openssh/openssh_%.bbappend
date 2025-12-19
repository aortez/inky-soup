# Harden SSH configuration for Inky Soup.
# Disables password auth, requires SSH keys, no root login.

FILESEXTRAPATHS:prepend := "${THISDIR}/openssh:"

SRC_URI:append = " file://sshd_config_inky"

do_install:append() {
    # Install drop-in config for SSH hardening.
    install -d ${D}${sysconfdir}/ssh/sshd_config.d
    install -m 0644 ${WORKDIR}/sshd_config_inky ${D}${sysconfdir}/ssh/sshd_config.d/10-inky.conf
}

FILES:${PN}-sshd += "${sysconfdir}/ssh/sshd_config.d/10-inky.conf"
