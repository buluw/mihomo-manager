# PVE 容器安装与维护

PVE 向导在宿主机以 root 运行，面向 amd64，当前验证平台为 PVE 8.4。菜单包含安装、更新、查看容器信息。

在 PVE 宿主机以 root 运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/buluw/mihomo-manager/main/pve/install.sh)
```

PVE 模板与环境包使用独立发布标签 pve-v0.2.3，内含管理器 0.2.3；网页程序更新继续使用管理器的正式版本发布。

## 安装

- 默认 1 核、1024 MiB 内存、4 GiB 根盘、名称 mihomo。存储与两张网卡的网桥从宿主已有资源选择。
- 管理网卡默认 DHCP；手动地址使用 /24 并填写网关。内部网卡可填写 /24 静态地址，或稍后配置。DNS 在创建时继承宿主机。
- 确认页可以修改参数；回车保留当前显示值。新建前复核容器编号，下载后校验附件大小与 SHA256。
- 非特权容器使用标准 UID 映射与 nesting=1，透传 TUN 字符设备，IPv4 转发持久开启。默认引导配置仅监听回环代理端口，TUN 和 DNS 接管由用户配置。
- 初次启动生成机器身份与 SSH 主机密钥。SSH 组件保留，模板账户不带共享登录密码或授权密钥；管理员通过 PVE 设置自己的登录凭据。
- 完成后显示实际后台地址；DHCP 暂未获得地址时如实提示，可通过“查看容器信息”再次查询。PVE 宿主机可通过 pct enter 维护容器。

## 更新

“更新”面向已由本项目部署的运行容器。环境包包含已发布管理器成品、Node 运行时与管理员部署入口，更新程序、Node、Nginx 配置、固定服务定义及受限安装器，保留用户数据、Core 二进制、网络和机器身份。Debian 系统软件包由发行版维护流程负责。

环境维护会重启包括 Core 在内的五个服务，确认页明确提示代理中断。日常 Web UI 更新继续使用网页入口。环境包中的应用版本早于当前安装时，脚本拒绝降级。

应用部署与回退复用 deploy/debian/runtime-artifact.sh；环境入口持有相同部署锁和 Core 锁，管理 Node 的替换与失败恢复。成功后保留一个本入口创建的管理员恢复点，输出恢复命令。恢复点包含私有状态，只在容器 root 目录保存。

## 制作模板

从已完成备份还原隔离构建 CT，使用明确备份 SHA256 和独立编号；prepare 创建的副本保持停止、网卡断开。pack 仅接受带构建描述的停止容器。正式程序使用已发布成品，初始化与清理在副本完成。

```bash
bash pve/build.sh prepare /private/backup.tar.zst BACKUP_SHA256 BUILD_CT STORAGE
bash pve/build.sh pack BUILD_CT /private/output /private/runtime.tar.gz RUNTIME_SHA256
bash pve/build.sh environment BUILD_CT /private/output /private/runtime.tar.gz RUNTIME_SHA256
```

输出目录须先由管理员创建并保持私有。rootfs 模板归档采用容器 UID/GID，清理真实数据、历史恢复点、认证及主机身份；保留精简系统、SSH、Node、Nginx、Core、管理器及许可。首次启动按标准引导配置准备数据。

候选验收使用 root 持有且其他账号不可写的本地清单：`bash pve/install.sh --manifest /private/output/candidate.json`。候选附件路径必须位于清单所在目录中。公开 template.json 仅在审核和附件发布后填写正式 URL、大小和 SHA256，模板与环境附件分别记录，程序单独发布不会让安装入口引用不存在的模板。
