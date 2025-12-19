SUMMARY = "Python library for GPIO device abstraction"
HOMEPAGE = "https://github.com/pimoroni/gpiodevice-python"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Use pre-built wheel bundled with the layer.
SRC_URI = "file://gpiodevice-${PV}-py3-none-any.whl"

inherit python3-dir

DEPENDS = "unzip-native"
RDEPENDS:${PN} = "python3-gpiod python3-core"

# No compilation needed - just install the wheel.
do_configure[noexec] = "1"
do_compile[noexec] = "1"

do_install() {
    install -d ${D}${PYTHON_SITEPACKAGES_DIR}

    # Unzip the wheel and install only the Python package (not metadata files).
    unzip -q ${WORKDIR}/gpiodevice-${PV}-py3-none-any.whl -d ${WORKDIR}/wheel-contents
    cp -r ${WORKDIR}/wheel-contents/gpiodevice ${D}${PYTHON_SITEPACKAGES_DIR}/

    # Install dist-info for package metadata.
    cp -r ${WORKDIR}/wheel-contents/gpiodevice-${PV}.dist-info ${D}${PYTHON_SITEPACKAGES_DIR}/
}

FILES:${PN} += "${PYTHON_SITEPACKAGES_DIR}/*"
