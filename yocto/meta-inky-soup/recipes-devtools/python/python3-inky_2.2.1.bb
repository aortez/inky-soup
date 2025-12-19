SUMMARY = "Python library for Pimoroni Inky e-ink displays"
HOMEPAGE = "https://github.com/pimoroni/inky"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Use pre-built wheel bundled with the layer.
SRC_URI = "file://inky-${PV}-py3-none-any.whl"

inherit python3-dir

DEPENDS = "unzip-native"
RDEPENDS:${PN} = " \
    python3-gpiodevice \
    python3-numpy \
    python3-pillow \
    python3-smbus2 \
    python3-spidev \
    python3-core \
"

# No compilation needed - just install the wheel.
do_configure[noexec] = "1"
do_compile[noexec] = "1"

do_install() {
    install -d ${D}${PYTHON_SITEPACKAGES_DIR}

    # Unzip the wheel and install only the Python package (not metadata files).
    unzip -q ${WORKDIR}/inky-${PV}-py3-none-any.whl -d ${WORKDIR}/wheel-contents
    cp -r ${WORKDIR}/wheel-contents/inky ${D}${PYTHON_SITEPACKAGES_DIR}/

    # Install dist-info for package metadata.
    cp -r ${WORKDIR}/wheel-contents/inky-${PV}.dist-info ${D}${PYTHON_SITEPACKAGES_DIR}/
}

FILES:${PN} += "${PYTHON_SITEPACKAGES_DIR}/*"
