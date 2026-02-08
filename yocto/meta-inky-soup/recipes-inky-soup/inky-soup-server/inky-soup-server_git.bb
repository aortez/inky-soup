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

    # Install Rocket configuration.
    install -m 0644 ${S}/Rocket.toml ${D}${datadir}/inky-soup/

    # Install systemd services.
    # Note: /data/inky-soup directories are created at runtime by the init service
    # and subdirectories (images/, cache/, etc.) are created by the server itself.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${THISDIR}/files/inky-soup-data-init.service ${D}${systemd_system_unitdir}/
    install -m 0644 ${THISDIR}/files/inky-soup-server.service ${D}${systemd_system_unitdir}/
}

# Enable systemd services.
SYSTEMD_SERVICE:${PN} = "inky-soup-data-init.service inky-soup-server.service"
SYSTEMD_AUTO_ENABLE = "enable"

# Package files.
FILES:${PN} = " \
    ${bindir}/inky-soup-server \
    ${datadir}/inky-soup \
    ${systemd_system_unitdir}/inky-soup-data-init.service \
    ${systemd_system_unitdir}/inky-soup-server.service \
"
