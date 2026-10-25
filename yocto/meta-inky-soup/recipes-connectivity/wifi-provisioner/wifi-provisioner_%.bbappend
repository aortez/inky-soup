# The shared daemon defaults to DirtSim's port; Inky Soup serves its app on 8000.
FILESEXTRAPATHS:prepend := "${THISDIR}/files:"
SRC_URI:append = " file://wifi-provisioner.conf"

do_install:append() {
    install -d ${D}${sysconfdir}/default
    install -m 0644 ${WORKDIR}/wifi-provisioner.conf ${D}${sysconfdir}/default/wifi-provisioner
}

CONFFILES:${PN} += "${sysconfdir}/default/wifi-provisioner"
