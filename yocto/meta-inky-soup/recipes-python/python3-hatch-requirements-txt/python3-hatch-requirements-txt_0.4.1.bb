# Hatchling plugin to read dependencies from requirements.txt files.

SUMMARY = "Hatchling plugin for requirements.txt"
HOMEPAGE = "https://github.com/repo-helper/hatch-requirements-txt"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI[sha256sum] = "2c686e5758fd05bb55fa7d0c198fdd481f8d3aaa3c693260f5c0d74ce3547d20"

inherit pypi python_hatchling

PYPI_PACKAGE = "hatch_requirements_txt"

RDEPENDS:${PN} = " \
    python3-hatchling \
    python3-packaging \
"

BBCLASSEXTEND = "native nativesdk"
