# Python library for Pimoroni Inky e-ink displays.
# Provides drivers for Inky Impression and other Inky displays.

SUMMARY = "Python library for Pimoroni Inky e-ink displays"
HOMEPAGE = "https://github.com/pimoroni/inky"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://PKG-INFO;beginline=9;endline=9;md5=a53cbc7cb75660694e138ba973c148df"

inherit pypi python_hatchling

PYPI_PACKAGE = "inky"

SRC_URI[sha256sum] = "4333f1e9bacf0f5d087cbfd21d74b082dd9434b7c8540d625076c8f6750599dc"

# Build dependencies for hatchling.
DEPENDS += " \
    python3-hatch-fancy-pypi-readme-native \
    python3-hatch-requirements-txt-native \
"

# Runtime dependencies.
RDEPENDS:${PN} += " \
    python3-gpiodevice \
    python3-numpy \
    python3-pillow \
    python3-smbus \
    python3-spidev \
"

BBCLASSEXTEND = "native nativesdk"
