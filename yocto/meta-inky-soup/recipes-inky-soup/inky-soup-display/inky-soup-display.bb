# Inky Soup Display Script - Flashes images to e-ink display.
# Called by inky-soup-server to send pre-dithered images to hardware.

SUMMARY = "Inky Soup display script"
DESCRIPTION = "Python script that flashes images to Pimoroni Inky Impression e-ink displays."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = "file://update-image.py"

# Runtime dependencies.
RDEPENDS:${PN} = " \
    python3 \
    python3-pillow \
    python3-inky \
"

do_install() {
    install -d ${D}${bindir}
    install -m 0755 ${WORKDIR}/update-image.py ${D}${bindir}/inky-soup-update-display
}

FILES:${PN} = "${bindir}/inky-soup-update-display"
