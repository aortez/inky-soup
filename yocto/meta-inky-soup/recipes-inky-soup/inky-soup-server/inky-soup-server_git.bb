# Inky Soup Server - Web-based image upload and e-ink display server.
# Provides HTTP interface on port 8000 for image upload, gallery, and display control.

SUMMARY = "Inky Soup web server"
DESCRIPTION = "Rocket-based web server for uploading images and controlling an e-ink display."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Build from local source (externalsrc).
# Use cargo_bin from meta-rust-bin for prebuilt Rust toolchain.
inherit externalsrc cargo_bin systemd

EXTERNALSRC = "${THISDIR}/../../../../upload-server"

# Allow network access during compile for cargo to fetch dependencies.
# This is needed when using externalsrc with a local Cargo.toml.
do_compile[network] = "1"

do_install() {
    # Install the binary (cargo_bin builds to ${CARGO_BINDIR}).
    install -d ${D}${bindir}
    install -m 0755 ${CARGO_BINDIR}/upload-server ${D}${bindir}/inky-soup-server

    # Install static files (preserve directory structure).
    install -d ${D}${datadir}/inky-soup/static
    cp -r ${S}/static/* ${D}${datadir}/inky-soup/static/
    chmod -R a+rX ${D}${datadir}/inky-soup/static/

    # Install templates (ensure readable).
    install -d ${D}${datadir}/inky-soup/templates
    install -m 0644 ${S}/templates/*.tera ${D}${datadir}/inky-soup/templates/

    # Create directories for runtime data (owned by inky user).
    install -d ${D}/data/inky-soup/images
    install -d ${D}/data/inky-soup/images/cache
    install -d ${D}/data/inky-soup/images/thumbs
    install -d ${D}/data/inky-soup/images/dithered
    install -d ${D}/data/inky-soup/images/metadata

    # Install systemd service.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${THISDIR}/files/inky-soup-server.service ${D}${systemd_system_unitdir}/
}

# Enable the systemd service.
SYSTEMD_SERVICE:${PN} = "inky-soup-server.service"
SYSTEMD_AUTO_ENABLE = "enable"

# Set ownership of data directories on first boot.
pkg_postinst:${PN}() {
    chown -R inky:inky /data/inky-soup
}

# Package files.
FILES:${PN} = " \
    ${bindir}/inky-soup-server \
    ${datadir}/inky-soup \
    /data/inky-soup \
    ${systemd_system_unitdir}/inky-soup-server.service \
"
