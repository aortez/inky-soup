SUMMARY = "Persistent data partition support"
DESCRIPTION = "Mounts and initializes the persistent /data partition for WiFi credentials, logs, and config that survive A/B updates."
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = " \
    file://data.mount \
    file://persistent-data-init \
    file://persistent-data-init.service \
    file://persistent-data-bind.service \
"

S = "${WORKDIR}"

inherit systemd

SYSTEMD_SERVICE:${PN} = " \
    data.mount \
    persistent-data-init.service \
    persistent-data-bind.service \
"
SYSTEMD_AUTO_ENABLE = "enable"

do_install() {
    # Install the init script.
    install -d ${D}${sbindir}
    install -m 0755 ${WORKDIR}/persistent-data-init ${D}${sbindir}/persistent-data-init

    # Install systemd units.
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/data.mount ${D}${systemd_system_unitdir}/data.mount
    install -m 0644 ${WORKDIR}/persistent-data-init.service ${D}${systemd_system_unitdir}/persistent-data-init.service
    install -m 0644 ${WORKDIR}/persistent-data-bind.service ${D}${systemd_system_unitdir}/persistent-data-bind.service

    # Create the mount point.
    install -d ${D}/data

    # Ensure the NetworkManager system-connections directory exists in rootfs.
    # This is the bind mount target.
    install -d ${D}${sysconfdir}/NetworkManager/system-connections
}

FILES:${PN} = " \
    ${sbindir}/persistent-data-init \
    ${systemd_system_unitdir}/data.mount \
    ${systemd_system_unitdir}/persistent-data-init.service \
    ${systemd_system_unitdir}/persistent-data-bind.service \
    /data \
    ${sysconfdir}/NetworkManager/system-connections \
"
