# Linux 安装与运行

## 环境

当前验证范围为 Debian 12（glibc、x86_64）、systemd 和 Node.js 24.15.0。需要管理员权限、可用的 DNS 与 HTTPS 出站访问。Web 入口使用 Nginx。运行包校验 Node 的完整版本、平台和架构，部署时以 `RUNTIME_BUILD.json` 中的实际值为准。

使用 TUN 时，系统或容器须提供 `/dev/net/tun` 和对应网络管理权限。首次安装的引导配置关闭 TUN 与 DNS 服务、关闭 LAN 代理接入，仅监听回环地址；正式网络接管按使用者的网络方案单独配置。

## 首次源码安装

在专用且尚未由其他应用占用本项目目录的 Debian 环境中，准备完整公开源码包。以下命令中的文件名替换为实际下载的 `-source.tar.gz` 附件：

```bash
stage="/tmp/mihomo-manager-deploy-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$stage/source"
tar -xzf mihomo-manager-v0.2.0-source.tar.gz \
  -C "$stage/source" --strip-components=1
sudo bash "$stage/source/deploy/debian/update.sh" "$stage" full
```

部署入口安装所需 Debian 软件包，准备固定 Node 和 Core 二进制，安装锁定的 npm 依赖，执行现有验证与构建，生成服务及 Nginx 配置，再启动项目服务。该入口会在完成时移除本次传入的临时目录。安装完成后访问 `http://服务器地址:9090`。

已有受管开发安装可以用相同源码入口更新；它会重启项目 target，包括 Core，须安排允许中断的维护时间。带 `runtime-only` 标记的受管环境使用程序成品安装流程。

## 固定目录

| 路径 | 内容 |
| --- | --- |
| `/opt/mihomo-manager/app` | 程序、前端资源及受管运行依赖 |
| `/opt/mihomo-manager/node` | 固定 Node.js 运行时 |
| `/opt/mihomo-manager/bin` | Mihomo Core 及本地上一版本 |
| `/etc/mihomo-manager/manager.env` | 部署环境配置 |
| `/var/lib/mihomo-manager` | 配置、集合、日志、管理器设置及运行文件 |
| `/var/lib/mihomo-manager/access` | 默认访问认证目录 |

环境项示例见 `deploy/debian/manager.env.example`。网站监听容器或主机的全部本地 IPv4 地址，部署健康检查使用 `127.0.0.1:9090`；后端服务保持回环监听。Controller Secret 与网站密码分属不同机制。

`ACCESS_DATA_DIR` 可以指定其他专用绝对目录。部署入口统一创建该目录并生成 sysinfo 的 `20-access-data.conf` 权限片段；服务账号保持普通用户，使用 `ProtectSystem=strict`。选择服务账号可遍历父路径的位置；`ProtectHome` 仍限制用户主目录。改变目录前由管理员安排已有认证数据迁移，更新程序保留当前认证文件。

## 程序成品与回退

`-linux-x64.tar.gz` 是程序成品，适用于已有 `deployment-owned` 和 `runtime-only` 标记的受管环境。先核对 `SHA256SUMS` 与包内平台／Node 要求，并安排维护时间。现有命令行安装和回退会重启项目 target，包括 Core。

```bash
sha256sum --check SHA256SUMS
stage="/tmp/mihomo-runtime-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -m 700 "$stage"
cp mihomo-manager-v0.2.0-linux-x64.tar.gz "$stage/runtime.tar.gz"
tar -xOf "$stage/runtime.tar.gz" ./deploy/debian/runtime-artifact.sh > "$stage/runtime-artifact.sh"
sudo bash "$stage/runtime-artifact.sh" install "$stage"
```

安装核验文件清单与运行环境，保存私有程序备份并打印 `RUNTIME_BACKUP` 路径。程序、部署文件与运行数据分开处理；配置、认证、Core 和 Node 文件进入保留校验。安装成功并记录备份路径后，可清理本次临时目录。

需要回退时，使用本次安装实际打印的备份路径运行 `sudo bash 备份目录/restore.sh rollback 备份目录`。回退恢复之前的程序与部署文件，保留当前环境及运行数据，按当前认证目录重新生成权限并进行健康检查。认证开启时，目标程序必须支持网站认证。

## 服务与诊断

固定的五个服务为 `mihomo-manager-core`、`configd`、`logd`、`sysinfo` 和 `web`，完整名称均以 `mihomo-manager-` 开头、以 `.service` 结尾。它们由 `mihomo-manager.target` 组织。使用 systemd 的 status／journalctl 查看对应服务；分享诊断信息前去除真实配置、订阅地址及凭据。

首次认证初始化生成 `settings.json` 和 `.initialized`。已经初始化的认证文件缺失或损坏时访问保持不可用，管理员应从有效备份恢复文件及账号权限。sysinfo 重启后内存会话结束，需要重新登录。

## Web UI 在线安装入口

首次源码安装和命令行成品安装会部署 Web UI 更新 socket、固定受限安装器与恢复入口。已有相同更新协议的管理器，可在“更新与维护”中上传或下载运行包并确认安装。此路径仅切换四组件 dist、package 元数据、受管 YAML 依赖、运行包校验模块及许可／源码／构建元数据，保留开发源码、用户数据和 Core 进程。部署服务定义、Node、Nginx 配置与受限安装器本身由管理员部署入口维护。

下载与后台策略目录默认 /var/lib/mihomo-manager/webui-update，可由管理员通过 WEBUI_UPDATE_DIR 指定专用目录；部署入口生成 sysinfo 的 30-webui-update.conf 写权限。安装状态位于 root 所有、服务账号只读的 /var/lib/mihomo-manager-webui-install，事务和上一程序位于 /opt/mihomo-manager/.webui-update。固定安装器位于 /usr/local/libexec/mihomo-manager-webui，使用部署锁和 Core 控制锁互斥。更新 socket 按请求启动一次任务，恢复服务为 oneshot；五个常驻项目服务保持。

运行包要求 RUNTIME_BUILD.json 的 webuiUpdateProtocol 为 1。协议定义固定运行范围；安装器不执行包内部署脚本，不将归档清单当作完整应用目录替换清单。受限入口结束时和容器启动后恢复未完成事务。上一程序仅保留一个完整运行范围快照，回退成功后与当前程序交换。
