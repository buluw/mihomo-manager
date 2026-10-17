# 第三方声明

Mihomo Manager 自有代码采用 GPL-3.0-only。以下第三方内容保留原有许可；项目许可证不改变其独立的版权和分发条件。

| 内容 | 来源与许可 | 随附声明 |
| --- | --- | --- |
| `frontend/src/components/ui/` 的官方 primitive 及相关生成样式 | shadcn/ui，MIT | `licenses/shadcn-ui-MIT.txt` |
| Lucide 图标及基于 Route 图标、调整颜色的两个 favicon | lucide-react，ISC；其中 Feather 衍生图标另有 MIT 声明 | `licenses/lucide.txt` |
| Inter 字体 | @fontsource-variable/inter，SIL OFL 1.1 | `THIRD_PARTY_LICENSES.txt` 中的完整原文 |
| Monaco 编辑器及中文资源 | monaco-editor，MIT，保留包内第三方声明 | `THIRD_PARTY_LICENSES.txt` 与构建资源中的 LICENSE |
| React、Base UI、dnd-kit、ECharts、YAML 及其他锁定依赖 | 各依赖自身声明的许可 | `release/dependencies.json` 与 `THIRD_PARTY_LICENSES.txt` |

依赖清单由四组件的 `package-lock.json` 和 Linux 构建环境中的实际安装包生成，覆盖运行依赖和构建工具；包含它们的声明不表示每个工具均进入浏览器或运行包。平台可选包按实际安装的平台记录。原始锁文件保留其他平台所需版本与校验值。

DOMPurify 提供 MPL-2.0／Apache-2.0 双许可，随包保留上游两份文本；GPL-3.0 分发采用 Apache-2.0 选项。Lightning CSS 构建工具保留 MPL-2.0 文本，Inter 字体保持 OFL，caniuse-lite 数据保持 CC-BY-4.0。第三方内容的对应源代码由依赖清单、锁文件的 registry 地址和版本标识定位。

size-sensor 1.0.3 的发布包及固定提交 README 声明 ISC，作者为 hustcc；其 npm 附件未带独立 LICENSE 文件。`licenses/size-sensor.txt` 保存上游声明、固定提交来源和 ISC 条款。

Mihomo Core 是单独安装的上游项目；管理器通过其原始 API 协作。Node.js、Nginx 和 Debian 软件包也由部署环境单独安装，遵循各自分发条款。公开源码和程序包中的项目业务实现按 GPL-3.0-only 提供，分发程序包时应同时提供其对应源码。

来源：shadcn/ui 官方 LICENSE（https://github.com/shadcn-ui/ui/blob/main/LICENSE.md）；Lucide 声明来自锁定的 lucide-react 1.28.0 包；其余具体版本、声明来源及原文摘要见依赖清单。
