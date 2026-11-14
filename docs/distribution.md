# 下载与分发

公开源码与发行包位于 [mig-everything/phone-use-dsh](https://github.com/mig-everything/phone-use-dsh)。无需仓库读取授权，也无需 npm 账号。首版通过 GitHub Release 分发 DSH 预构建包，暂不发布 npm 包。

## DSH 安装

从 [最新 Release](https://github.com/mig-everything/phone-use-dsh/releases/latest) 下载 `phone-use-dsh.tgz`，在 DSH「插件 → 添加插件」中填入本地完整路径。也可以使用官方 CLI：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/latest/download/phone-use-dsh.tgz
```

刷新插件列表，启用 Phone Use，确认组件「运行中」。在对话顶部的 **Phone Use ▾** 打开控制台、添加设备。三端 SDK、模拟器或真机调试授权、WDA 准备见 [DSH 指南](dsh.md) 和 [设备准备](setup.md)。

插件包标识是 `@mig-everything/phone-use-dsh`，但它目前没有发布到 npm；安装时使用上述 URL 或 `.tgz` 文件路径。安装过程会下载对应主机平台的生产依赖，不需要 TypeScript 或 C++ 编译器。DSH Desktop 使用自带的 Node，命令行宿主遵循 DSH 自身运行要求。

## 版本与校验

每个 Release 包含带版本号的 `.tgz`、固定名称 `phone-use-dsh.tgz`，以及各自的 `.sha256`。固定名称方便市场持续使用同一个 `latest/download` 链接；具体标签下的资产不覆盖。固定版本安装可使用：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/download/v0.9.4/mig-everything-phone-use-dsh-0.9.4.tgz
```

同时下载包与相邻 `.sha256` 后，在 macOS/Linux 执行 `shasum -a 256 -c phone-use-dsh.tgz.sha256`。Windows PowerShell 使用 `Get-FileHash phone-use-dsh.tgz -Algorithm SHA256` 与校验文件比较。

升级前结束自己的设备操作，在 DSH 中停用 Phone Use，安装新版本后刷新、重新启用。停用会释放该插件的设备会话。完整重启宿主只作为模块仍旧缓存时的排查步骤。

## SDK、MCP 和 Work

同一公开仓库保留共享 SDK、MCP 与 Work 安装器。当前 Release 的 `.tgz` 面向 DSH；其他宿主先从源码构建：

```sh
git clone https://github.com/mig-everything/phone-use-dsh.git
cd phone-use-dsh
npm ci
npm run build
npm run demo
```

之后按 [接入指南](integrations.md) 使用 SDK，或按 [配置指南](setup.md) 注册 MCP / 安装 Work 插件。MCP 可以独立读取控件、截图和操作手机，不依赖侧栏。

## 维护者发行

```sh
npm ci
npm run format:check
npm test
npm run check:native
npm run package:dsh
npm run check:dsh -- /absolute/path/to/node_modules/@deepseek-ai/dsh
```

打包使用文件白名单，并检查 manifest、版本、入口、相对资源、许可证和包内文件。随包核心与 DSH 版本必须一致。发行包不包含 `node_modules`、设备日志、个人配置、证书、SDK、系统镜像或历史 Git 数据；生产依赖在安装端解析。

发布前在干净的目录安装候选包，运行官方 DSH 集成检查，确认公开下载与校验和一致。源码、标签和 Release 包应对应同一次发布。目录收录只提交插件自己的 YAML 条目；截图清单和图标在本仓库维护。
