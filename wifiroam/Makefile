include $(TOPDIR)/rules.mk

PKG_NAME:=wifiroam
PKG_VERSION:=0.1.0
PKG_RELEASE:=136
PKG_LICENSE:=GPL-2.0-or-later

include $(INCLUDE_DIR)/package.mk

# 守护进程已从 ucode 改写为 Node ESM（见 js/）。注意：目标机上必须有 node
# 运行时，feed 里的 lang/node 是 PKG_HOST_ONLY，不会自动装到目标机，所以这里
# 不能把 +node 写进 DEPENDS（否则没有该包的 feed 会直接构建失败）。
define Package/wifiroam
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Wireless
  TITLE:=WiFi seamless roaming orchestration daemon (802.11k/v/r)
  DEPENDS:=+libstdcpp +relayd +libnetfilter-queue +libmnl +libnfnetlink +conntrack +tc +kmod-sched-core +firewall4 +nftables +wpa-cli +hostapd-common +iw
endef

define Package/wifiroam/description
  Lightweight multi-AP controller/agent daemon for OpenWrt.
  Provides AP discovery, topology aggregation, client tracking and
  centralized 802.11k/v/r seamless roaming configuration with wired
  and wireless (relayd pseudo-bridge) backhaul support.
  Managed through luci-app-wifiroam.
  Requires a target node runtime (>= 22.23.4) on the device.
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
	$(INSTALL_DIR) $(1)/usr/share/wifiroam/daemon
	$(INSTALL_DIR) $(1)/usr/share/wifiroam/lib
	$(INSTALL_DATA) ./js/wifiroamd.mjs $(1)/usr/share/wifiroam/wifiroamd.mjs
	for f in ./js/daemon/*.mjs; do \
		$(INSTALL_DATA) $$f $(1)/usr/share/wifiroam/daemon/; done
	for f in ./js/lib/*.js; do \
		$(INSTALL_DATA) $$f $(1)/usr/share/wifiroam/lib/; done
	$(INSTALL_DATA) ./js/README.md $(1)/usr/share/wifiroam/README.md
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/wifiroam-dpi $(1)/usr/sbin/wifiroam-dpi
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/wifiroam.init $(1)/etc/init.d/wifiroam
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/wifiroam.config $(1)/etc/config/wifiroam
	$(INSTALL_DIR) $(1)/etc/wifiroam
	$(INSTALL_CONF) ./files/aliases.json $(1)/etc/wifiroam/aliases.json
	$(INSTALL_DIR) $(1)/etc/hotplug.d/net
	$(INSTALL_BIN) ./files/30-wifiroam-4addr $(1)/etc/hotplug.d/net/30-wifiroam-4addr
	$(INSTALL_DIR) $(1)/etc/udhcpc.user.d
	$(INSTALL_DATA) ./files/90-wifiroam-dhcp-lease $(1)/etc/udhcpc.user.d/90-wifiroam-dhcp-lease
endef

define Package/wifiroam/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/wifiroam enable 2>/dev/null
	# 升级场景进程已在跑，start 是空操作会导致旧代码常驻，必须 restart
	/etc/init.d/wifiroam restart 2>/dev/null
	if [ "$$(uci -q get wifiroam.core.enabled 2>/dev/null)" != "0" ]; then
		for attempt in 1 2 3 4 5; do
			/etc/init.d/wifiroam status >/dev/null 2>&1 && break
			sleep 1
		done
		if ! /etc/init.d/wifiroam status >/dev/null 2>&1; then
			logger -t wifiroam 'service failed to start after install (node runtime missing?)'
			exit 1
		fi
	fi
}
exit 0
endef

define Package/wifiroam/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ] && [ "$${PKG_UPGRADE}" != "1" ]; then
	/etc/init.d/wifiroam stop 2>/dev/null
	# 伪桥留下的 nft 规则/代理开关随进程一起清掉，否则 br-lan 会继续替上游应答
	killall relayd 2>/dev/null
	nft delete table inet wifiroam_usage 2>/dev/null
	nft delete table inet wifiroam_guest 2>/dev/null
	nft delete table inet wifiroam_acl 2>/dev/null
	nft delete table inet wifiroam_sched 2>/dev/null
	nft delete table inet wifiroam 2>/dev/null
	rm -rf /tmp/wifiroam /tmp/wifiroam-dpi.pid 2>/dev/null
fi
exit 0
endef

$(eval $(call BuildPackage,wifiroam))
