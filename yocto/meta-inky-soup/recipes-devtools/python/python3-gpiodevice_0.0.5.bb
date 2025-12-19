# Python library for GPIO device access on Raspberry Pi.
# Used by the inky library for display communication.

SUMMARY = "Python library for GPIO device access"
HOMEPAGE = "https://github.com/pimoroni/gpiodevice"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://PKG-INFO;beginline=9;endline=9;md5=a53cbc7cb75660694e138ba973c148df"

inherit pypi python_hatchling

PYPI_PACKAGE = "gpiodevice"

SRC_URI[sha256sum] = "cca01ff4319e0ba906ff46dcb8113d8d532b3f5ee03d683d8a11037c8e89140c"

# Build dependencies for hatchling.
DEPENDS += "python3-hatch-fancy-pypi-readme-native"

# Runtime dependencies.
RDEPENDS:${PN} += " \
    python3-ctypes \
"

BBCLASSEXTEND = "native nativesdk"
