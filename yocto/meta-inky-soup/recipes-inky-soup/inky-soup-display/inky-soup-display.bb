# Inky Soup Display Script - Flashes images to e-ink display.
# Called by inky-soup-server to send pre-dithered images to hardware.

SUMMARY = "Inky Soup display script"
DESCRIPTION = "Python script that flashes images to Pimoroni Inky Impression e-ink displays."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = " \
    file://update-image.py \
    file://configure-display.py \
    file://inky-soup-display-config.service \
    file://inky-soup-display-modules.conf \
"

inherit systemd

SYSTEMD_SERVICE:${PN} = "inky-soup-display-config.service"
SYSTEMD_AUTO_ENABLE = "enable"

# Runtime dependencies.
RDEPENDS:${PN} = " \
    python3 \
    python3-pillow \
    python3-numpy \
    python3-inky \
"

RRECOMMENDS:${PN} += "kernel-module-i2c-dev"

do_install() {
    install -d ${D}${bindir}
    install -m 0755 ${WORKDIR}/update-image.py ${D}${bindir}/inky-soup-update-display
    install -m 0755 ${WORKDIR}/configure-display.py ${D}${bindir}/inky-soup-configure-display
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/inky-soup-display-config.service ${D}${systemd_system_unitdir}/
    install -d ${D}${nonarch_libdir}/modules-load.d
    install -m 0644 ${WORKDIR}/inky-soup-display-modules.conf \
        ${D}${nonarch_libdir}/modules-load.d/inky-soup-display.conf
}

FILES:${PN} = " \
    ${bindir}/inky-soup-update-display \
    ${bindir}/inky-soup-configure-display \
    ${systemd_system_unitdir}/inky-soup-display-config.service \
    ${nonarch_libdir}/modules-load.d/inky-soup-display.conf \
"
