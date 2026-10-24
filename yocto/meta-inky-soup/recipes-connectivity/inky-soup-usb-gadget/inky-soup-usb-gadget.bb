SUMMARY = "USB Ethernet access for Inky Soup"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = " \
    file://inky-soup-usb-gadget \
    file://inky-soup-usb-gadget.service \
    file://inky-soup-usb-recover \
    file://inky-soup-usb-recover.service \
    file://inky-soup-usb-recover.timer \
    file://inky-soup-usb.nmconnection \
    file://90-inky-soup-usb.conf \
"

inherit systemd

RDEPENDS:${PN} = "kernel-module-dwc2 kernel-module-g-ether kmod networkmanager iputils-ping"
SYSTEMD_SERVICE:${PN} = "inky-soup-usb-gadget.service inky-soup-usb-recover.timer"
SYSTEMD_AUTO_ENABLE = "enable"

do_install() {
    install -d ${D}${sbindir}
    install -m 0755 ${WORKDIR}/inky-soup-usb-gadget ${D}${sbindir}/
    install -m 0755 ${WORKDIR}/inky-soup-usb-recover ${D}${sbindir}/

    install -d ${D}${systemd_system_unitdir}
    for unit in inky-soup-usb-gadget.service inky-soup-usb-recover.service; do
        sed 's|@SBINDIR@|${sbindir}|g' ${WORKDIR}/$unit \
            > ${D}${systemd_system_unitdir}/$unit
        chmod 0644 ${D}${systemd_system_unitdir}/$unit
    done
    install -m 0644 ${WORKDIR}/inky-soup-usb-recover.timer ${D}${systemd_system_unitdir}/

    # /etc profiles are bind-mounted from /data; keep this image default in /usr.
    install -d ${D}${nonarch_libdir}/NetworkManager/system-connections
    install -m 0600 ${WORKDIR}/inky-soup-usb.nmconnection \
        ${D}${nonarch_libdir}/NetworkManager/system-connections/

    install -d ${D}${nonarch_libdir}/NetworkManager/conf.d
    install -m 0644 ${WORKDIR}/90-inky-soup-usb.conf \
        ${D}${nonarch_libdir}/NetworkManager/conf.d/
}

FILES:${PN} += " \
    ${nonarch_libdir}/NetworkManager/system-connections \
    ${nonarch_libdir}/NetworkManager/conf.d \
    ${systemd_system_unitdir}/inky-soup-usb-recover.service \
"
