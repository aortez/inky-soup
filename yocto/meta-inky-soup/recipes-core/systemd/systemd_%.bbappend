# Configure journald for persistent storage.

FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"

# Pull in our config file.
SRC_URI += "file://journald-persistent.conf"

# Install our journald drop-in configuration.
do_install:append() {
    install -d ${D}${sysconfdir}/systemd/journald.conf.d
    install -m 0644 ${WORKDIR}/journald-persistent.conf ${D}${sysconfdir}/systemd/journald.conf.d/
}

FILES:${PN} += "${sysconfdir}/systemd/journald.conf.d/journald-persistent.conf"
