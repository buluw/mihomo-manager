<div align="center">

# Mihomo Manager

**在浏览器里管理 Mihomo，从配置编辑到订阅整合。**

面向 Linux · 适配桌面与手机 · 可信局域网单用户使用

[快速安装](#快速安装) · [使用指南](docs/user/usage.md) · [下载与更新](https://github.com/buluw/mihomo-manager/releases)

</div>

---

## 快速安装

### PVE：一行命令创建容器

在 **PVE 宿主机**的 Shell 中，以 **root** 运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/install.sh)
```

选择 **1 安装**，按提示填写容器编号，确认参数即可。安装完成后会显示后台地址。

| 默认资源 | 默认网络 | 容器名称 |
| --- | --- | --- |
| 1 核 CPU · 1 GiB 内存 · 4 GiB 磁盘 | 管理网卡 DHCP · DNS 跟随宿主机 | `mihomo` |

参数可在安装时修改。支持 amd64，已在 PVE 8.4 验证。→ [完整安装说明](pve/README.md)

### 已有 Linux 主机

已在 **Debian 12 x86_64** 验证。安装步骤与环境要求见 [Linux 安装指南](docs/user/installation.md)。

## 可以做什么

| 功能 | 主要能力 |
| --- | --- |
| **配置编辑** | 多配置管理，YAML 编辑、格式化，查看当前运行配置 |
| **订阅整合** | 导入、定时更新订阅，提取代理集合，筛选节点并组合使用 |
| **代理管理** | 切换节点、测试延迟、查看节点信息，合并重复节点的显示 |
| **规则管理** | 编辑规则、调整顺序与策略，管理代理集合和规则集合 |
| **运行监控** | 实时流量、连接和日志，查看服务状态及内存、磁盘占用 |
| **运行设置** | 管理 DNS、TUN、出口网卡和嗅探等选项 |
| **访问与更新** | 独立访问密码，Core / Web UI 更新与回退，Web UI 后台检查与定时安装 |

## 开始使用

1. **导入配置**：上传配置文件或添加订阅。
2. **应用配置**：保存只写入文件；点击“应用配置／切换配置”后才改变运行内容。
3. **设置访问密码**：认证初始关闭，可在“访问认证”中开启。

> **按需开启网络接管。** 安装后在后台配置 DNS 与 TUN，再按自己的网络方案启用。

Web UI 在线更新保留 Core 代理运行和用户数据；Core 更新及 PVE 运行环境更新会重启 Core。

## 文档与许可

- [使用指南](docs/user/usage.md)：配置、订阅、规则与日常维护。
- [版本说明](docs/user/release-notes.md)：本次版本的主要变化。
- [GitHub Releases](https://github.com/buluw/mihomo-manager/releases)：程序包、源码与校验文件。

本项目采用 [GPL-3.0-only](LICENSE)。第三方组件保留各自许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [许可文本](THIRD_PARTY_LICENSES.txt)。
