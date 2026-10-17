# 公开源码与程序包

`public-files.json` 是公开内容的唯一明确清单。`source.mjs` 将清单内文件导出为全新的目录，同时产生 `SOURCE_FILES_SHA256` 与 `SOURCE_METADATA.json`。导出单向复制，源码维护仍在原工作树。

## 导出源码

在 Node.js 24 环境中：

```bash
node release/source.mjs export /tmp/mihomo-public-source
node --test release/test/source.test.mjs
```

导出目录必须位于维护工作树之外且尚不存在。元数据记录版本、Git HEAD、工作区 dirty 状态及公开内容的 SHA256。HEAD 是基线，dirty 为 true 时不能单独代表导出内容。已有公开快照也可以再次导出，身份由保存的元数据与实际文件摘要确认。

依赖、构建产物和程序运行数据通过各自的安装／运行流程生成。变更公开文件范围时，明确更新清单并检查引用与隐私；整份原始 Git 历史不随源码快照导出。

## 第三方许可

在 Linux 上按四组件的包锁安装依赖后，运行 `node release/notices.mjs` 汇集实际安装包的许可。生成 `THIRD_PARTY_LICENSES.txt` 和 `release/dependencies.json` 后，复核声明及清单，再重新导出源码。许可生成发生在维护工作树或独立准备目录，生成结果经核对后成为公开源文件。

## 正式源码身份

正式发布从独立的公开仓库产生：仅提交 `public-files.json` 内的源文件，生成的 `SOURCE_FILES_SHA256` 与 `SOURCE_METADATA.json` 随归档分发。在最终干净提交上建立与组件版本一致的标签（例如 `v0.2.1`），然后运行：

```bash
node release/source.mjs manifest /tmp/mihomo-release-identity --release
node release/source.mjs export /tmp/mihomo-manager-v0.2.1 --release
```

`--release` 要求 HEAD 对应版本标签且工作区干净；元数据记录 `status=release`、公开 commit、标签、`dirty=false` 和源摘要。已导出的正式源码可以凭匹配的元数据与实际摘要保持该身份。省略此选项时仍生成候选身份，用于发布前验证。

## 构建与纯打包

在现有受管 Debian 构建环境中，从已标记版本且干净的公开源码目录执行以下命令。构建在独立目录内完成，各组件按锁文件安装依赖：

```bash
work="/tmp/mihomo-runtime-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
node release/source.mjs manifest "$work" --release
node release/source.mjs export "$work/build" --release
cp deploy/debian/runtime-artifact.sh "$work/runtime-artifact.sh"
for component in frontend configd logd sysinfo; do
  (cd "$work/build/$component" && npm ci)
done
node release/runtime.mjs build "$work/build" "$work"
sudo bash "$work/runtime-artifact.sh" pack "$work"
```

`build` 在构建前后核对完整公开源码摘要，构建四组件并记录产物摘要。`pack` 复用现有成品装配流程，核对构建身份和实际产物，仅生成文件。已有依赖只有在与最终源码锁文件一致时才可复用。修改公开源码后，重新生成身份并构建。

正式程序包采用 ustar + gzip，名为 `mihomo-manager-v<版本>-linux-x64.tar.gz`，同时输出 `SHA256SUMS`；候选包保留 `candidate.<源码摘要前12位>` 身份后缀。为既有部署工具兼容保留工作目录中的 `runtime.tar.gz`。包内含四组件、必要 YAML 依赖、固定部署文件、许可及源／构建／包内文件清单；运行环境要求记录在 `RUNTIME_BUILD.json`。安装检查仍以完整 Node 版本、Linux 平台和 x64 架构为准。

将同一正式源码导出目录打包为 `mihomo-manager-v<版本>-source.tar.gz`，归档内部保留一层项目目录。将源码包、程序包和发布说明摘要一起写入最终 `SHA256SUMS`，并将附件发布至对应正式标签的 GitHub Release。发布后核对正式 latest 查询、附件 URL 与 GitHub SHA256 digest，再下载附件逐一验证实际字节。

## Web UI 更新协议

运行包使用 ustar + gzip，webuiUpdateProtocol=1；必须包含 release/package.mjs 与 sysinfo Web UI 更新及访问认证模块。包内 RUNTIME_FILES_SHA256 覆盖整个归档，BUILD_PROVENANCE 绑定实际编译产物、源码摘要和构建环境。普通账号与固定受限安装器复用校验器；压缩上限 128 MiB、展开上限 512 MiB、最多 10,000 条归档项，拒绝目录穿越、链接及特殊文件。

在线安装应用协议规定的运行范围，部署脚本与服务定义随归档分发供管理员部署使用。发布采用正式版本标签；API 读取对应 Linux x64 附件及 GitHub SHA256 摘要。后台自动安装使用真实正式 Release 的摘要核对结果。
