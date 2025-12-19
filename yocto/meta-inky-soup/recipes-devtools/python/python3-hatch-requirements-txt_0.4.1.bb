# Hatchling plugin to read project dependencies from requirements.txt.
# Required by some packages that use hatchling build backend.

SUMMARY = "Hatchling plugin to read dependencies from requirements.txt"
HOMEPAGE = "https://github.com/repo-helper/hatch-requirements-txt"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://LICENSE;md5=58206c261591d2c13b00ab61cec32abe"

inherit pypi python_hatchling

PYPI_PACKAGE = "hatch_requirements_txt"

SRC_URI[sha256sum] = "2c686e5758fd05bb55fa7d0c198fdd481f8d3aaa3c693260f5c0d74ce3547d20"

BBCLASSEXTEND = "native nativesdk"
