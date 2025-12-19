SUMMARY = "A/B Boot Slot Manager"
DESCRIPTION = "Manages A/B boot partitions for safe remote updates"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = "file://ab-boot-manager \
           file://ab-update \
          "

S = "${WORKDIR}"

RDEPENDS:${PN} = "e2fsprogs-e2fsck"

do_install() {
    install -d ${D}${sbindir}
    install -m 0755 ${WORKDIR}/ab-boot-manager ${D}${sbindir}/ab-boot-manager
    install -m 0755 ${WORKDIR}/ab-update ${D}${sbindir}/ab-update
}

FILES:${PN} = "${sbindir}/ab-boot-manager ${sbindir}/ab-update"
