include $(TOPDIR)/rules.mk

PKG_NAME:=wifiroam
PKG_VERSION:=0.1.0
PKG_RELEASE:=85
PKG_LICENSE:=GPL-2.0-or-later
PKGARCH:=all

include $(INCLUDE_DIR)/package.mk

define Package/wifiroam
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Wireless
  TITLE:=WiFi seamless roaming orchestration daemon (802.11k/v/r)
  DEPENDS:=+ucode +ucode-mod-ubus +ucode-mod-uloop +ucode-mod-socket +ucode-mod-fs +ucode-mod-uci +ucode-mod-digest +tc +kmod-sched-core +firewall4 +nftables
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

# 纯脚本包：覆盖默认的 make -C $(PKG_BUILD_DIR) 编译步骤
define Build/Compile
endef

define Package/wifiroam/install
	$(INSTALL_DIR) $(1)/usr/share/wifiroam
	$(INSTALL_BIN) ./files/wifiroamd.uc $(1)/usr/share/wifiroam/wifiroamd.uc
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/wifiroam.init $(1)/etc/init.d/wifiroam
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/wifiroam.config $(1)/etc/config/wifiroam
	$(INSTALL_DIR) $(1)/etc/wifiroam
	$(INSTALL_CONF) ./files/aliases.json $(1)/etc/wifiroam/aliases.json
endef

define Package/wifiroam/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	# 应用识别/统计功能已移除：清理旧版 DPI、nft 表、dnsmasq ipset 段与统计文件
	for pid in $$(pidof wifiroam-dpi 2>/dev/null); do
		kill "$$pid" 2>/dev/null
	done
	nft delete table inet wifiroam 2>/dev/null
	rm -f /usr/sbin/wifiroam-dpi /etc/wifiroam/appstats.json \
		/etc/wifiroam/nft_schema /tmp/wifiroam-appctl.nft \
		/tmp/wifiroam-dpi.pid /tmp/wifiroam/dpi_blocklist

	for sid in $$(uci -q show dhcp 2>/dev/null | sed -n 's/^dhcp\.\(wifiroam_[A-Za-z0-9_]*\)=.*/\1/p'); do
		uci -q delete "dhcp.$$sid"
	done
	old_nftset="$$(uci -q get dhcp.@dnsmasq[0].nftset 2>/dev/null)"
	if [ -n "$$old_nftset" ]; then
		uci -q delete dhcp.@dnsmasq[0].nftset
		for v in $$old_nftset; do
			case "$$v" in *"#wifiroam#"*) continue;; esac
			uci -q add_list dhcp.@dnsmasq[0].nftset="$$v"
		done
	fi
	uci -q commit dhcp 2>/dev/null

	# 旧的加速开关位于 appctl 段，迁移到 core 后删除废弃段
	old_off="$$(uci -q get wifiroam.appctl.offload 2>/dev/null)"
	[ -n "$$old_off" ] && uci -q set wifiroam.core.offload="$$old_off"
	uci -q delete wifiroam.appctl 2>/dev/null
	while uci -q get wifiroam.@appdev[0] >/dev/null 2>&1; do
		uci -q delete wifiroam.@appdev[0]
	done
	uci -q commit wifiroam 2>/dev/null

	/etc/init.d/wifiroam enable 2>/dev/null
	# 升级场景进程已在跑，start 是空操作会导致旧代码常驻，必须 restart
	/etc/init.d/wifiroam restart 2>/dev/null
	if [ "$$(uci -q get wifiroam.core.enabled 2>/dev/null)" != "0" ]; then
		for attempt in 1 2 3 4 5; do
			/etc/init.d/wifiroam status >/dev/null 2>&1 && break
			sleep 1
		done
		if ! /etc/init.d/wifiroam status >/dev/null 2>&1; then
			logger -t wifiroam 'service failed to start after install'
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
	nft delete table inet wifiroam_usage 2>/dev/null
	nft delete table inet wifiroam_guest 2>/dev/null
	nft delete table inet wifiroam 2>/dev/null
	/usr/bin/ucode -- /usr/share/wifiroam/wifiroamd.uc --restore-guest-fw4 || \
		logger -t wifiroam 'Could not restore firewall4 template'
fi
exit 0
endef

$(eval $(call BuildPackage,wifiroam))
