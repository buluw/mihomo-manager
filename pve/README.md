# PVE 安装

适用于 amd64 架构，已在 PVE 8.4 验证。在 PVE 宿主机的 Shell 中，以 root 运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/install.sh)
```

选择 **1 安装**，按提示设置容器编号、名称、资源和存储，再通过编号菜单分别选择两张网卡的网桥。回车采用提示中的默认值，确认页可选择 **2 修改参数**，保留已输入内容和网桥选择。

## 默认参数

| 参数 | 默认值 |
| --- | --- |
| 容器名称 | mihomo |
| CPU | 1 核 |
| 内存 | 1024 MiB |
| 磁盘 | 4 GiB |
| 管理网卡 | DHCP |
| 内部网卡 | 稍后配置 |
| DNS | 跟随 PVE 宿主机 |

菜单列出宿主机当前启用的 Linux／OVS 网桥，并显示实际网桥名称、宿主地址、网关、端口和备注（有值时）。输入对应编号选择：

- **管理网卡 eth0**：用于访问后台及默认出口。默认选取有宿主网关的候选网桥，否则使用列表第一项；请根据实际管理网络确认。管理地址可选 DHCP 或手动静态 /24。
- **内部网卡 eth1**：连接内部网络或路由设备。默认选取另一候选网桥；仅有一个候选时使用该网桥。内部 IPv4 可稍后配置，也可填写静态 /24。

确认页显示两张网卡的用途、网桥和 IP 模式。默认网关只设置在管理网卡，DNS 跟随 PVE 宿主机。

## 安装完成

容器预装 Mihomo Manager 及运行依赖。安装器为 Core 服务账号准备 TUN 设备权限，并在容器内开启 IPv4 转发。Core 的 TUN 开关由应用的配置决定，初始配置关闭；进入后台导入自己的配置并应用。

包含公共 GEO 预置的模板提供 geoip.metadb 和 GeoSite.dat，首次使用对应 GEO 规则时从本地读取；配置中的在线集合仍按各自来源获取。当前发布附件的信息以安装清单为准。

安装完成后显示后台地址。

DHCP 地址可随时重新运行脚本，选择 **3 查看容器信息** 查询。

安装脚本会自动下载 [CT 模板](https://github.com/buluw/mihomo-manager/releases/download/pve-v0.2.3/mihomo-manager-pve-debian12-amd64-v0.2.3.tar.zst)，也可在 [PVE v0.2.3 发布页](https://github.com/buluw/mihomo-manager/releases/tag/pve-v0.2.3) 找到附件。
