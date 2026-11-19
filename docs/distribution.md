# 多宿主分发与更新影响

从 0.9.5 起，同一份核心提供三类 GitHub Release 产物。DSH 保留原有登记与安装入口；Codex/Work、独立 MCP/SDK 使用各自的固定标签下载，不要求发布到 npm。

## 当前安装与校验

公开源码与发行包位于 [mig-everything/phone-use-dsh](https://github.com/mig-everything/phone-use-dsh)，无需仓库读取授权或 npm 账号。DSH 可从 [最新 Release](https://github.com/mig-everything/phone-use-dsh/releases/latest) 下载 `phone-use-dsh.tgz`，在「插件 → 添加插件」中填写本地完整路径，或使用官方 CLI：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/latest/download/phone-use-dsh.tgz
```

刷新插件列表并启用 Phone Use，确认组件运行，在对话顶部的 **Phone Use ▾** 打开控制台。配置、设备授权和 WDA 准备见 [DSH 指南](dsh.md) 与[设备准备](setup.md)。安装会下载生产依赖，无需 TypeScript 或 C++ 编译器。

固定版本安装可使用已发布的地址：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/download/v0.9.5/mig-everything-phone-use-dsh-0.9.5.tgz
```

同时下载包与相邻 `.sha256` 后，macOS/Linux 使用 `shasum -a 256 -c phone-use-dsh.tgz.sha256`；Windows PowerShell 使用 `Get-FileHash phone-use-dsh.tgz -Algorithm SHA256` 与校验文件比较。Codex/Work、MCP 和 SDK 的安装步骤见 [README](../README.md)。

## 一个仓库，三类产物

| 用途 | 现有打包方式 | 文件示例 | 消费方 |
| --- | --- | --- | --- |
| DSH | `npm run package:dsh` | `mig-everything-phone-use-dsh-0.9.5.tgz`，另带稳定文件名 `phone-use-dsh.tgz` | DSH 插件安装器 |
| Codex / ChatGPT Work 本地插件 | `npm run package:plugin` | `phone-use-0.9.5.tar.gz` | 解压后运行 `node scripts/install-work.mjs` |
| 独立 MCP 与 SDK | `npm run package:core` | `phone-use-0.9.5.tgz` | 安装根包，运行 MCP CLI 或导入 SDK |

MCP 和 SDK 使用同一个根包，无需复制两套实现。Codex/Work 归档包含已编译入口、插件清单、技能、看板和安装脚本；安装时仍需 Node.js 22+、npm 和网络以获取生产依赖。DSH 的包名保持 `@mig-everything/phone-use-dsh`，根包保持 `phone-use`；均不要求发布到公共 npm。

DSH 目录登记的是 `packages/dsh` 子目录。[上游贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)明确允许 monorepo 子包声明 `dsh.bundle`，没有要求整个仓库只能提供 DSH 功能。保留现有子目录、清单、包名和安装包，即可继续维护同仓其他宿主。

## 发布方式

本次采用三个独立标签，指向同一份已验证的源码提交：

| 渠道 | Release | 附件 | GitHub Latest |
| --- | --- | --- | --- |
| DSH | [v0.9.5](https://github.com/mig-everything/phone-use-dsh/releases/tag/v0.9.5) | `mig-everything-phone-use-dsh-0.9.5.tgz`、`phone-use-dsh.tgz` 及校验和 | 是 |
| Codex/Work | [codex-v0.9.5](https://github.com/mig-everything/phone-use-dsh/releases/tag/codex-v0.9.5) | `phone-use-0.9.5.tar.gz` 及校验和 | 否，必须 `--latest=false` |
| MCP/SDK | [core-v0.9.5](https://github.com/mig-everything/phone-use-dsh/releases/tag/core-v0.9.5) | `phone-use-0.9.5.tgz` 及校验和 | 否，必须 `--latest=false` |

后续可按渠道独立发行。只有带完整、已验证 DSH 包的发行才能成为 Latest；不含 DSH 包的发行始终显式设置 `--latest=false`。

GitHub 的 Latest 是仓库级别的单一选择，不会按标签前缀或附件名称自动分流。仅使用不同的版本号或 bundle 名称不能保护 DSH 下载入口。[GitHub CLI 的 `--latest=false`](https://cli.github.com/manual/gh_release_create)用于明确禁止某次发行成为 Latest；通过 REST API 发布时，对应 `make_latest: "false"`。

当前 DSH 目录的地址是：

```text
https://github.com/mig-everything/phone-use-dsh/releases/latest/download/phone-use-dsh.tgz
```

独立 Codex Release 使用固定链接：

```text
https://github.com/mig-everything/phone-use-dsh/releases/download/codex-v0.9.5/phone-use-0.9.5.tar.gz
```

MCP/SDK 使用 `https://github.com/mig-everything/phone-use-dsh/releases/download/core-v0.9.5/phone-use-0.9.5.tgz`。无需为这两个渠道修改已合并的 DSH 目录条目。

## 版本关系

打包器校验 DSH 包版本与它嵌入的核心版本一致，Codex 两份插件清单也必须与运行时版本一致。保留同一份核心版本号，以 Release 标签区分发布渠道；各渠道可以暂留在不同的已发布版本。

这不等于让同一次构建的清单任意使用不同版本。真正独立的适配器版本需要额外记录其依赖的核心版本、兼容范围并修改打包校验，当前没有必要引入这套维护成本。构建本地新版也不会重写先前 Release 中已发布的旧包。

## 对已有用户的影响

| 操作 | 生效范围 |
| --- | --- |
| 修改 README 或推送源码 | 改变仓库说明并触发 CI；不会自动发布 GitHub Release、npm 或安装插件 |
| 发布非 Latest 的 Codex/核心 Release | 只有显式选择新标签的下载和安装使用它，DSH 的 Latest 入口继续指向原包 |
| 发布含 DSH 包的新 Latest | DSH 目录的后续下载转向新版；使用固定旧标签的链接仍取旧包 |
| 更新 Codex/Work 插件 | 安装器准备新的本地副本；需要宿主重新加载才能使用，旧会话可能继续使用旧模块 |
| 更新 DSH 插件 | 先结束自己的设备会话、停用插件，再安装并重新启用；过程中释放本插件的设备控制权 |
| 更新 MCP/SDK | 已安装的包或运行中的进程不随 Release 自动替换；调用方按固定版本升级并重启相应服务 |

不要覆盖旧标签下同名附件。每个发行包记录源码提交、版本和 SHA-256；回退使用旧标签和旧文件。不同宿主升级互不替换安装目录，但控制同一设备时仍共同遵守设备锁。

## 发布前需要验证

DSH 安装与官方宿主验证继续保留。可下载产物还需要验证：

- Codex/Work：从归档解压、安装生产依赖，检查启动器、19 个 MCP 工具、对话入口与面板资源；桌面画面、设备切换和手势单独验收。加载器检查通过不代表桌面交互已验收。
- MCP/SDK：从根包安装，验证库导出、stdio、受认证的本机 HTTP，以及不依赖侧栏的观察与动作。
- 各包：无本机路径、私有配置、凭据或真实设备截图，保留原生组件与模型许可证；核对每份清单与嵌入运行时的版本。
- 发行地址：发布前后核对 DSH 的 Latest 解析结果及包哈希；独立发行确认 `--latest=false`，同步发行确认 Latest 包含 `phone-use-dsh.tgz`。

现有 DSH 发行验证命令为：

```sh
npm ci
npm run format:check
npm test
npm run check:native
npm run package:dsh
npm run check:dsh -- /absolute/path/to/node_modules/@deepseek-ai/dsh
npm run package:plugin
npm run package:core
npm run check:distributions
```

`check:distributions` 在临时目录安装生产依赖，验证 SDK 四个导出入口、19 个 MCP 工具、demo 的观察/点击/文本/截图、面板 HTML 以及 HTTP 认证。它不修改用户已安装的插件，也不连接真实设备。Linux、macOS、Windows CI 都运行这项检查；Codex 桌面加载器和真实手机交互仍需单独验收。

打包使用文件白名单；发布前还需核对公开下载的哈希。源码、标签和附件应对应同一次构建，发行包不包含 `node_modules`、设备日志、个人配置、证书、平台 SDK 或系统镜像。

标准 MCP 是接入合同，不代表每一个第三方 Agent 框架都已实测。没有 MCP Apps 的宿主仍可使用工具与截图；看板需要宿主的 UI 支持。普通 MCP 进程默认共用一个作用域，多对话宿主需要分进程或提供可信会话适配，详见[接入指南](integrations.md)。

## 扫描报告的两项表达优化

M8ven 在旧提交上报告了三个工具缺少行为字段、两处 shell 调用。实际 MCP `tools/list` 的 19 个工具均包含四个布尔提示字段；三个工具通过公共对象继承字段。外框转换使用 `execFile` 与参数数组，没有启用 shell。

本次将三个工具的字段显式列出，将 `exec` 局部变量更名为 `execFileAsync`，并检查协议实际返回的字段完整性。保持原有布尔值、工具参数和命令参数；这些变动便于审阅和静态分析，不改变手机操作或预览性能。扫描器是否消除误报，以重新扫描结果为准。
