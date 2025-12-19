SUMMARY = "Inky Soup Display Driver"
DESCRIPTION = "Python script and dependencies for driving Inky Impression e-ink displays."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Reference files from the project root via absolute path.
INKY_SOUP_ROOT = "${THISDIR}/../../../.."

SRC_URI = " \
    file://inky-soup-detect-display.sh \
    file://inky-soup-detect-display.service \
"

# Python dependencies - using Yocto-built packages instead of pip.
RDEPENDS:${PN} = " \
    python3 \
    python3-inky \
    python3-gpiod \
    python3-gpiodevice \
"

do_install() {
    # Install the display update script.
    install -d ${D}${bindir}
    install -m 0755 ${INKY_SOUP_ROOT}/update-image.py ${D}${bindir}/inky-soup-update-display

    # Install display detection script.
    install -m 0755 ${WORKDIR}/inky-soup-detect-display.sh ${D}${bindir}/inky-soup-detect-display

    # Install systemd service for display detection.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/inky-soup-detect-display.service ${D}${systemd_system_unitdir}/

    # Create config directory.
    install -d ${D}${sysconfdir}/inky-soup
}

# Enable the detection service.
inherit systemd
SYSTEMD_SERVICE:${PN} = "inky-soup-detect-display.service"
SYSTEMD_AUTO_ENABLE = "enable"

FILES:${PN} = " \
    ${bindir}/inky-soup-update-display \
    ${bindir}/inky-soup-detect-display \
    ${systemd_system_unitdir}/inky-soup-detect-display.service \
    ${sysconfdir}/inky-soup \
"
