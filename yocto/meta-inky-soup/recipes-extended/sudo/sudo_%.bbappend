# Add passwordless sudo for inky user.

FILESEXTRAPATHS:prepend := "${THISDIR}/sudo:"

SRC_URI:append = " file://inky-sudoers"

do_install:append() {
    install -d ${D}${sysconfdir}/sudoers.d
    install -m 0440 ${WORKDIR}/inky-sudoers ${D}${sysconfdir}/sudoers.d/inky
}
