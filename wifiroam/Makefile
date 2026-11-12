include $(TOPDIR)/rules.mk

PKG_NAME:=wifiroam
PKG_VERSION:=0.1.0
PKG_RELEASE:=49
PKG_LICENSE:=GPL-2.0-or-later

include $(INCLUDE_DIR)/package.mk

define Package/wifiroam
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Wireless
  TITLE:=WiFi seamless roaming orchestration daemon (802.11k/v/r)
  DEPENDS:=+ucode +ucode-mod-ubus +ucode-mod-uloop +ucode-mod-socket +ucode-mod-fs +ucode-mod-uci +ucode-mod-digest +libnetfilter-queue +libmnl +libnfnetlink +tc +kmod-sched-core
endef

define Package/wifiroam/description
  Lightweight multi-AP controller/agent daemon for OpenWrt.
  Provides AP discovery, topology aggregation, client tracking and
  centralized 802.11k/v/r seamless roaming configuration with wired
  backhaul support. Managed through luci-app-wifiroam.
endef

define Package/wifiroam/conffiles
/etc/config/wifiroam
/etc/wifiroam/aliases.json
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) -I$(STAGING_DIR)/usr/include \
		-o $(PKG_BUILD_DIR)/wifiroam-dpi ./src/wifiroam-dpi.c \
		-L$(STAGING_DIR)/usr/lib -lnetfilter_queue -lmnl -lnfnetlink
endef

define Package/wifiroam/install
	$(INSTALL_DIR) $(1)/usr/share/wifiroam
	$(INSTALL_BIN) ./files/wifiroamd.uc $(1)/usr/share/wifiroam/wifiroamd.uc
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/wifiroam-dpi $(1)/usr/sbin/wifiroam-dpi
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/wifiroam.init $(1)/etc/init.d/wifiroam
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/wifiroam.config $(1)/etc/config/wifiroam
	$(INSTALL_DIR) $(1)/etc/wifiroam
endef

define Package/wifiroam/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/wifiroam enable 2>/dev/null
	# 升级场景进程已在跑，start 是空操作会导致旧代码常驻，必须 restart
	/etc/init.d/wifiroam restart 2>/dev/null
}
exit 0
endef

define Package/wifiroam/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ] && [ "$${PKG_UPGRADE}" != "1" ]; then
	/usr/bin/ucode -- /usr/share/wifiroam/wifiroamd.uc --restore-guest-fw4 || \
		logger -t wifiroam 'Could not restore firewall4 template'
fi
exit 0
endef

$(eval $(call BuildPackage,wifiroam))
