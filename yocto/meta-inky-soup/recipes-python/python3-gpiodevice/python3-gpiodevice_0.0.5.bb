# Pimoroni GPIO device library.
# Provides unified GPIO access for Raspberry Pi.

SUMMARY = "Pimoroni GPIO device library"
HOMEPAGE = "https://github.com/pimoroni/gpiodevice"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI[sha256sum] = "cca01ff4319e0ba906ff46dcb8113d8d532b3f5ee03d683d8a11037c8e89140c"

inherit pypi python_hatchling

PYPI_PACKAGE = "gpiodevice"

# Build-time dependencies for hatchling plugins.
DEPENDS += "python3-hatch-fancy-pypi-readme-native"

RDEPENDS:${PN} = " \
    python3-gpiod \
"

# Exclude doc files that conflict with other Pimoroni packages.
do_install:append() {
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/README.md
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/LICENSE
    rm -f ${D}${PYTHON_SITEPACKAGES_DIR}/CHANGELOG.md
}
