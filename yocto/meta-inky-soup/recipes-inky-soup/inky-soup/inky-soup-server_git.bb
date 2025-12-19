SUMMARY = "Inky Soup Web Server"
DESCRIPTION = "Rocket-based web server for uploading and managing images on Inky Impression e-ink displays."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Use externalsrc to build from the local source tree.
inherit externalsrc systemd

# Point to the upload-server directory relative to this layer.
# Assumes the yocto directory is at inky-soup/yocto/.
EXTERNALSRC = "${THISDIR}/../../../../upload-server"

# Build directory (out-of-tree builds).
EXTERNALSRC_BUILD = "${WORKDIR}/build"

SRC_URI = " \
    file://inky-soup-server.service \
"

# Runtime dependencies.
RDEPENDS:${PN} = " \
    inky-soup-display \
"

# Systemd service.
SYSTEMD_SERVICE:${PN} = "inky-soup-server.service"
SYSTEMD_AUTO_ENABLE = "enable"

# For now, we use a pre-built binary approach.
# TODO: Integrate with meta-rust for native Yocto cargo builds.
# The deploy.sh script builds using 'cross' which provides proper ARMv6 support.

do_compile() {
    # Build using cargo with cross-compilation.
    # This requires the Rust toolchain to be set up in the Yocto build.
    # For initial setup, we use the existing cross-compiled binary.
    bbnote "Building Rust server with cargo..."

    cd ${EXTERNALSRC}

    # If cargo is available, build. Otherwise, expect pre-built binary.
    if command -v cargo > /dev/null 2>&1; then
        cargo build --release --target arm-unknown-linux-gnueabihf
    else
        bbwarn "Cargo not available - expecting pre-built binary"
    fi
}

do_install() {
    # Install the binary.
    install -d ${D}${bindir}

    # Try to find the binary in expected locations.
    if [ -f "${EXTERNALSRC}/target/arm-unknown-linux-gnueabihf/release/upload-server" ]; then
        install -m 0755 ${EXTERNALSRC}/target/arm-unknown-linux-gnueabihf/release/upload-server \
            ${D}${bindir}/inky-soup-server
    else
        bbfatal "upload-server binary not found. Run './deploy.sh' first to build it."
    fi

    # Install static files.
    install -d ${D}/home/inky/inky-soup/static
    cp -r ${EXTERNALSRC}/static/* ${D}/home/inky/inky-soup/static/

    # Install templates.
    install -d ${D}/home/inky/inky-soup/templates
    cp -r ${EXTERNALSRC}/templates/* ${D}/home/inky/inky-soup/templates/

    # Install Rocket configuration.
    install -m 0644 ${EXTERNALSRC}/Rocket.toml ${D}/home/inky/inky-soup/

    # Install systemd service.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/inky-soup-server.service ${D}${systemd_system_unitdir}/
}

FILES:${PN} = " \
    ${bindir}/inky-soup-server \
    /home/inky/inky-soup \
    ${systemd_system_unitdir}/inky-soup-server.service \
"

# The home directory should be owned by the inky user.
pkg_postinst:${PN}() {
    chown -R 1000:1000 $D/home/inky/inky-soup
}

# Suppress 32-bit time API warnings - acceptable for this embedded application.
INSANE_SKIP:${PN} = "32bit-time"
