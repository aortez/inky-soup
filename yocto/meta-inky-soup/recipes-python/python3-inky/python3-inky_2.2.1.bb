# Pimoroni Inky e-ink display library.
# Supports Inky Impression 5.7" and 13.3" displays.

SUMMARY = "Pimoroni Inky e-ink display library"
HOMEPAGE = "https://github.com/pimoroni/inky"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI[sha256sum] = "4333f1e9bacf0f5d087cbfd21d74b082dd9434b7c8540d625076c8f6750599dc"

inherit pypi python_hatchling

PYPI_PACKAGE = "inky"

# Build-time dependencies for hatchling plugins.
DEPENDS += " \
    python3-hatch-fancy-pypi-readme-native \
    python3-hatch-requirements-txt-native \
"

RDEPENDS:${PN} = " \
    python3-gpiodevice \
    python3-numpy \
    python3-pillow \
    python3-smbus2 \
    python3-spidev \
"

# Exclude doc files that conflict with other Pimoroni packages.
do_install:append() {
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/README.md
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/LICENSE
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/CHANGELOG.md
}
