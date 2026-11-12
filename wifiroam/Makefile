include $(TOPDIR)/rules.mk

PKG_NAME:=wifiroam
PKG_VERSION:=0.1.0
PKG_RELEASE:=51
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
	/etc/init.d/wifiroam stop 2>/dev/null
	/usr/bin/ucode -- /usr/share/wifiroam/wifiroamd.uc --pause-guest-fw4 || \
		logger -t wifiroam 'Could not pause guest forwarding for migration'
	# DPI 不受主进程的 restart 管理，不能让旧可执行文件继续处理报文。
	if pidof wifiroam-dpi >/dev/null; then
		nft delete table inet wifiroam 2>/dev/null
		for pid in $$(pidof wifiroam-dpi); do
			kill "$$pid" 2>/dev/null
		done
		for attempt in 1 2 3 4 5; do
			pidof wifiroam-dpi >/dev/null || break
			sleep 1
		done
		if pidof wifiroam-dpi >/dev/null; then
			logger -t wifiroam 'Old DPI process did not stop; wifiroam was not restarted'
			exit 1
		fi
	fi
	/etc/init.d/wifiroam enable 2>/dev/null
	/etc/init.d/wifiroam start 2>/dev/null
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
