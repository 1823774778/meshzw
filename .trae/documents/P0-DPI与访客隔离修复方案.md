# P0：DPI 越界与访客隔离修复

## 背景与目标

基于 `main` 的 r50（`695c136`）。只修两项：移除不完整的 QUIC 解析；让访客隔离和转发在同一次防火墙加载中生效，规则缺失或应用失败时默认拒绝。保留已验证设备上主、子路由的访客上网、漫游和限速，不关闭主网加速。

## 实施步骤

1. **移除不安全的 QUIC 解析。** 在 [wifiroam-dpi.c](file:///tmp/meshzw-review-695c136.qMXRCe/wifiroam/src/wifiroam-dpi.c#L319-L411) 删除 `quic_varint`、`quic_sni` 及 UDP 调用，更新注释。不引入新的 QUIC 解析；保留 TCP TLS/SNI、DNS/IP 应用规则和现有非解析 UDP 判定，不把 P1 的策略调整混进这次修复。
2. **让隔离与放行不可分割。** 调整 [wifiroamd.uc](file:///tmp/meshzw-review-695c136.qMXRCe/wifiroam/files/wifiroamd.uc#L1761-L1869) 的 `guest_write_infra` 和 `guest_nft_apply`：删除旧版自动写入的宽泛 `guest → lan` 转发，改用已核验的 firewall4 模板及 nftables include，在同一个 fw4 事务中加载访客限制、必要的定向放行和 SNAT。访客检查放在全局已建立连接放行之前；缺少策略时默认拒绝，符合条件的流量仍经过原有 fw4 规则。只排除 `br-guest` 双向流量的 fw4 卸载，避免已有流或加速路径绕过隔离，不动全局开关。
3. **保留正常出口，验证失败时收紧。** 有独立 WAN 的主路由沿用 WAN 转发/NAT；桥接子路由使用 netifd 确认的 IPv4 出口和地址，只向符合隔离策略的目标转发，覆盖已识别的本机、直连和内网网段，不放开未经配置的 IPv6。仅显式开启 `allow_lan` 时允许访问内网。复用 [`guest_fw4_sync`](file:///tmp/meshzw-review-695c136.qMXRCe/wifiroam/files/wifiroamd.uc#L1424-L1509) 的模板校验、原子写入和完整重载：启动、升级迁移及出口切换先收紧旧转发；只有检查、重载和运行态核验通过才记录成功并恢复受影响的访客转发。失败不沿用已失效的放行，退避重试。无法验证的固件不开放隔离不明的访客出口，在 [settings.js](file:///tmp/meshzw-review-695c136.qMXRCe/luci-app-wifiroam/htdocs/luci-static/resources/view/wifiroam/settings.js#L350-L394) 显示暂停原因。保留访客 DHCP/DNS、定时开放和 HTB。

## 验证

- 编译检查 C、ucode 和 LuCI；用正常流量验证 TCP TLS/SNI 与原有非解析 UDP 判定不变。
- 在隔离 OpenWrt 25.12.6 环境验证：主路由 WAN 上网、子路由 SNAT 回程、默认无法访问受保护网段、显式开启内网访问、访客限速和主网仍可卸载。
- 覆盖旧配置迁移、重复重载、规则缺失、检查/重载失败、出口切换和已有连接：失败期间访客不能误入内网，配置恢复后可重新上网。将虚拟机的 fw4 软件路径结果与 IPQ807x 实机硬件验证区分，不承诺厂商私有快路径兼容。

本轮只改源码和必要的包版本，不自动提交、推送或触发 GitHub 构建。
