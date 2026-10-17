# PVE 安装

适用于 amd64 架构，已在 PVE 8.4 验证。在 PVE 宿主机的 Shell 中，以 root 运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/install.sh)
```

选择 **1 安装**，按提示设置容器编号、名称、资源、存储和网桥。回车采用提示中的默认值，确认页可选择 **2 修改参数**。

## 默认参数

| 参数 | 默认值 |
| --- | --- |
| 容器名称 | mihomo |
| CPU | 1 核 |
| 内存 | 1 GiB |
| 磁盘 | 4 GiB |
| 管理网卡 | DHCP |
| 内部网卡 | 稍后配置 |
| DNS | 跟随 PVE 宿主机 |

两张网卡均可选择宿主机已有网桥。手动填写 IPv4 时使用 /24，默认网关只设置在管理网卡。

## 安装完成

容器预装 Mihomo Manager 及运行依赖，自动配置 TUN 权限和 IPv4 转发。安装完成后显示后台地址；进入后台导入自己的配置并应用。

DHCP 地址可随时重新运行脚本，选择 **3 查看容器信息** 查询。

安装脚本会自动下载 [CT 模板](https://github.com/buluw/mihomo-manager/releases/download/pve-v0.2.3/mihomo-manager-pve-debian12-amd64-v0.2.3.tar.zst)，也可在 [PVE v0.2.3 发布页](https://github.com/buluw/mihomo-manager/releases/tag/pve-v0.2.3) 找到附件。
