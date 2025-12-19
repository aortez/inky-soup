# Inky Soup Server - Rocket-based web server for image upload and display control.
#
# Built from local source using Cargo/Rust.
# Uses externalsrc to reference the upload-server directory.

SUMMARY = "Inky Soup web server"
DESCRIPTION = "Rocket-based web server for the Inky Soup e-ink display project."
HOMEPAGE = "https://github.com/user/inky-soup"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

inherit cargo_bin systemd externalsrc

# Point at the upload-server source tree.
EXTERNALSRC = "${THISDIR}/../../../../upload-server"

# Set EXTERNALSRC_BUILD to enable out-of-tree builds (cargo needs Cargo.toml here).
EXTERNALSRC_BUILD = "${EXTERNALSRC}"

# Point cargo_bin to the manifest in the external source.
CARGO_MANIFEST_PATH = "${EXTERNALSRC}/Cargo.toml"

# Allow network access during compile to fetch crates.
# For production, you'd pin all crates in SRC_URI instead.
do_compile[network] = "1"

# Build in release mode (cargo_bin default).
CARGO_BUILD_PROFILE = "release"

do_install() {
    # Install the server binary (built by cargo_bin class).
    install -d ${D}${bindir}
    install -m 0755 ${CARGO_BINDIR}/upload-server ${D}${bindir}/inky-soup-server

    # Install assets to /usr/share/inky-soup/.
    install -d ${D}${datadir}/inky-soup
    cp -r ${EXTERNALSRC}/static ${D}${datadir}/inky-soup/
    cp -r ${EXTERNALSRC}/templates ${D}${datadir}/inky-soup/
    install -m 0644 ${EXTERNALSRC}/Rocket.toml ${D}${datadir}/inky-soup/

    # Create working directory for runtime data.
    install -d ${D}/home/inky/inky-soup

    # Install systemd service (from recipe's files/ directory).
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${THISDIR}/files/inky-soup-server.service ${D}${systemd_system_unitdir}/
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
