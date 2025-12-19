# Inky Soup Display - Python script for controlling the Inky Impression e-ink display.
#
# Copies scripts directly from the source tree without using externalsrc.

SUMMARY = "Inky Soup display controller"
DESCRIPTION = "Python script for controlling the Inky Impression e-ink display."
HOMEPAGE = "https://github.com/user/inky-soup"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit systemd

# Source files from our files/ directory.
SRC_URI = " \
    file://inky-soup-detect-display.service \
    file://inky-soup-detect-display.sh \
    file://inky-soup-set-hostname.service \
    file://inky-soup-set-hostname.sh \
"

# Path to the main source tree (for update-image.py).
INKY_SOUP_SRC = "${THISDIR}/../../../../"

# Skip fetch/unpack/patch/configure/compile - we just install files.
do_fetch[noexec] = "1"
do_unpack[noexec] = "1"
do_patch[noexec] = "1"
do_configure[noexec] = "1"
do_compile[noexec] = "1"

# Manually unpack our local files since we disabled do_unpack.
do_install[prefuncs] += "unpack_local_files"
python unpack_local_files() {
    import shutil
    import os

    workdir = d.getVar('WORKDIR')
    thisdir = d.getVar('THISDIR')
    filesdir = os.path.join(thisdir, 'files')

    # Copy local files to WORKDIR.
    for f in ['inky-soup-detect-display.service', 'inky-soup-detect-display.sh',
              'inky-soup-set-hostname.service', 'inky-soup-set-hostname.sh']:
        src = os.path.join(filesdir, f)
        dst = os.path.join(workdir, f)
        if os.path.exists(src):
            shutil.copy2(src, dst)
}

do_install() {
    # Install the display update script from the source tree.
    install -d ${D}${bindir}
    install -m 0755 ${INKY_SOUP_SRC}/update-image.py ${D}${bindir}/inky-soup-update-display

    # Install system configuration scripts.
    install -m 0755 ${WORKDIR}/inky-soup-detect-display.sh ${D}${bindir}/
    install -m 0755 ${WORKDIR}/inky-soup-set-hostname.sh ${D}${bindir}/

    # Create config directory.
    install -d ${D}${sysconfdir}/inky-soup

    # Install systemd services.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/inky-soup-detect-display.service ${D}${systemd_system_unitdir}/
    install -m 0644 ${WORKDIR}/inky-soup-set-hostname.service ${D}${systemd_system_unitdir}/
}

# Enable the systemd services.
SYSTEMD_SERVICE:${PN} = "inky-soup-detect-display.service inky-soup-set-hostname.service"
SYSTEMD_AUTO_ENABLE = "enable"

# Package the scripts and services.
FILES:${PN} = " \
    ${bindir}/inky-soup-update-display \
    ${bindir}/inky-soup-detect-display.sh \
    ${bindir}/inky-soup-set-hostname.sh \
    ${sysconfdir}/inky-soup \
    ${systemd_system_unitdir}/inky-soup-detect-display.service \
    ${systemd_system_unitdir}/inky-soup-set-hostname.service \
"

# Runtime Python dependencies.
RDEPENDS:${PN} = " \
    python3 \
    python3-pillow \
    python3-inky \
    python3-gpiodevice \
"
