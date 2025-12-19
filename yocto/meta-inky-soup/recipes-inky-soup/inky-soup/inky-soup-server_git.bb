# Inky Soup Server - Rocket-based web server for image upload and display control.
#
# Built from local source using Cargo/Rust.
# Uses externalsrc to reference the upload-server directory.

SUMMARY = "Inky Soup web server"
DESCRIPTION = "Rocket-based web server for the Inky Soup e-ink display project."
HOMEPAGE = "https://github.com/user/inky-soup"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit cargo systemd externalsrc

# Point at the upload-server source tree.
EXTERNALSRC = "${THISDIR}/../../../../upload-server"

# Set EXTERNALSRC_BUILD to enable out-of-tree builds (cargo needs Cargo.toml here).
EXTERNALSRC_BUILD = "${EXTERNALSRC}"

# Explicit dependency on cargo-native since externalsrc can interfere.
DEPENDS += "cargo-native"

# Service file from our files/ directory.
SRC_URI = "file://inky-soup-server.service"

# Allow network access during compile to fetch crates.
# For production, you'd pin all crates in SRC_URI instead.
do_compile[network] = "1"

# Build in release mode.
CARGO_BUILD_FLAGS = "--release"

# The binary name from Cargo.toml.
CARGO_BIN_NAME = "upload-server"

do_install() {
    # Install the server binary (built by cargo class).
    install -d ${D}${bindir}
    install -m 0755 ${B}/target/${CARGO_TARGET_SUBDIR}/upload-server ${D}${bindir}/inky-soup-server

    # Install assets to /usr/share/inky-soup/.
    install -d ${D}${datadir}/inky-soup
    cp -r ${EXTERNALSRC}/static ${D}${datadir}/inky-soup/
    cp -r ${EXTERNALSRC}/templates ${D}${datadir}/inky-soup/
    install -m 0644 ${EXTERNALSRC}/Rocket.toml ${D}${datadir}/inky-soup/

    # Create working directory for runtime data.
    install -d ${D}/home/inky/inky-soup

    # Install systemd service.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/inky-soup-server.service ${D}${systemd_system_unitdir}/
}

# Enable the systemd service.
SYSTEMD_SERVICE:${PN} = "inky-soup-server.service"
SYSTEMD_AUTO_ENABLE = "enable"

# Package contents.
FILES:${PN} = " \
    ${bindir}/inky-soup-server \
    ${datadir}/inky-soup \
    /home/inky/inky-soup \
    ${systemd_system_unitdir}/inky-soup-server.service \
"

# Runtime dependencies.
RDEPENDS:${PN} = " \
    avahi-daemon \
"
