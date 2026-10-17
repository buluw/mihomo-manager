# Mihomo Manager 0.2.0 发布说明

基于 Linux 的 Mihomo Web UI 管理器，提供桌面和移动端配置管理界面。

## 主要能力

- 多配置 YAML 编辑、订阅定时更新、代理集合提取与节点过滤。
- 代理／规则集合及配置引用管理，规则顺序和策略编辑。
- 代理选择、延迟和健康检查、节点显示合并与人工地区。
- 连接、流量、日志及固定服务资源查看。
- 独立管理器设置、运行配置生成与明确的保存／应用状态。
- 网站访问认证、会话撤销及到期后的编辑草稿保留。
- Core 版本检查、发布说明、候选校验、安装与本地回退。
- Web UI 正式版本查询、运行包下载／上传、独立安装、健康检查恢复与上一程序回退；后台自动检查、自动下载和按容器时区定时安装。

## 附件与身份

正式标签为 `v0.2.0`，发布附件如下：

- `mihomo-manager-v0.2.0-linux-x64.tar.gz`：Linux x64 程序包。
- `mihomo-manager-v0.2.0-source.tar.gz`：对应源码，归档内保留一层项目目录。
- `SHA256SUMS`：程序包、源码包和发布说明的 SHA256。
- `RELEASE_NOTES.md`：本发布说明。

`SOURCE_FILES_SHA256` 列出 378 份公开源文件及摘要；`SOURCE_METADATA.json` 记录最终公开 Git commit、`v0.2.0` 标签、`dirty=false` 和完整源码清单摘要。正式源码包与程序包来自同一干净公开提交。

`RUNTIME_BUILD.json` 记录包格式、组件版本、源码身份及 Node／平台要求；`BUILD_PROVENANCE.json` 将构建源摘要关联到实际编译产物；`RUNTIME_FILES_SHA256` 校验包内文件。

## 安装范围

程序包使用协议 1、ustar + gzip，适用于 Linux x64/glibc、Node.js 24.15.0，验证平台为 Debian 12。包含前端、configd、logd、sysinfo、configd 的 YAML 运行依赖、固定部署文件与许可声明。Mihomo Core、Node.js 和 Nginx 由环境提供。

首次部署使用[源码安装入口](https://github.com/buluw/mihomo-manager/blob/v0.2.0/docs/user/installation.md)；程序包面向已有受管运行环境。命令行程序安装／回退会重启项目服务，包括 Core，应安排维护时间。Web UI 在线更新支持独立安装、健康检查恢复和本地回退，并提供后台自动检查、下载及定时安装；在线安装保留 Core 运行，自动策略首次关闭。

自有代码使用 GPL-3.0-only；第三方依赖、图标与字体保留各自许可。运行包与同源摘要的源码附件共同分发。
