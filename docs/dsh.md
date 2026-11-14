# Phone Use for DeepSeek Harness

Phone Use 的 DSH Bundle 与 Codex/MCP 插件共用三端驱动、会话锁、操作校验、OCR、工具合同和多设备看板。DSH 接入层只负责宿主会话、原生工具注册、模型图片附件和侧栏通道。

## 安装

从 [公开 GitHub Release](https://github.com/mig-everything/phone-use-dsh/releases/latest) 下载 `phone-use-dsh.tgz`，在 DSH 的「插件 → 添加插件」填写文件的完整路径，启用 Phone Use。发行包已经编译，安装程序只需解析对应主机平台的生产依赖，不需要 TypeScript、Bun 或 C++ 编译器。

也可使用官方 CLI：

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/latest/download/phone-use-dsh.tgz
```

也可以将 URL 替换为本地 `.tgz` 完整路径。CLI 安装后，在「插件」中刷新并启用 Phone Use，打开详情确认组件显示为运行状态。`--ignore-scripts` 避免生产依赖的可选构建脚本触发 pnpm 审批；发行包的代码和设备产物已经编译。当前未发布 npm，不能仅用 `@mig-everything/phone-use-dsh` 名称安装。桌面版本使用自带 Node；命令行宿主需满足 DSH 自身的 Node 版本要求。

## 配置设备

沿用 `phone-use.example.json` 的 HDC、ADB、WDA 配置。可在宿主启动环境中设置 `PHONE_USE_CONFIG`，或在 profile 的 `cordis.patch.yml` 中配置插件：

```yaml
- id: phone-use-dsh
  config:
    configPath: /absolute/path/phone-use.json
```

在运行 DSH 的电脑上配置 HDC、ADB 或 WDA，然后选择已连接的手机或已启动的模拟器。调试授权和 iOS WDA 准备见核心包的 `docs/setup.md`。

## 使用

点击会话顶部 **Phone Use ▾**，从下拉菜单打开控制台、添加设备或切换多设备视图，在「添加设备」中选择具体设备。多设备可在同一看板中切换或并排显示；切换设备不会新建侧栏标签。隐藏面板停止画面消费，已绑定的 Agent 会话继续存在。

对话中可使用 `/phone-use`，或直接要求 Agent 操作设备。控件读取优先；截图仅在需要时交给模型。DSH 模型必须声明图片输入能力才能接收截图附件；不支持图片的模型仍能使用控件和 OCR，用户仍可观看侧栏画面。

侧栏是可选界面。其他 Agent 可通过标准 MCP stdio/HTTP 直接调用 `phone_open`、`phone_inspect`、`phone_observe`、`phone_act` 和多设备工具，无需先打开控制台。宿主接入与设备功能独立，但不同驱动的速度不同：没有活动原生通道时，Android 完整手势使用 ADB，鸿蒙使用 UiTest，iPhone 使用 WDA；MCP 本身不会自动消除设备导出控件或执行命令的耗时。

侧栏通过 DSH 已认证的 Fetch 通道传送二进制画面及输入，不需要另配 localhost 证书。预览不会进入模型上下文。手动截图仍由用户显式下载。

设备会话绑定到 DSH 对话，核心文件锁同时保护其他 Phone Use 宿主。关闭设备释放控制权；不要手动删除其他会话的锁。原生 DSH 工具策略继续生效，read-only 会话不执行手机输入。

## 更新与原生依赖

更新时先关闭自己的设备会话并停用 Phone Use，再安装新版本包，在插件页刷新并重新启用。确认版本、组件运行状态和侧栏画面后重新添加设备。仅刷新插件列表不保证运行中的模块已重新加载；如仍使用旧模块，待其他任务空闲时完整退出并重新打开 DSH。停用 Phone Use 会释放它的设备会话，无需同时停用其他插件。

每个交付版本使用独立版本号和发行文件，不覆盖旧包。开发同一版本时使用不同文件名，避免包管理器复用旧缓存。出现「启用」但组件「未运行」时，不把开关状态视为启动成功；先查看启用错误和实际安装版本。

- 鸿蒙：随包 ARM64/x86_64 `.so`，使用现有 HDC 与系统 UiTest，无主机 Java/C++ 依赖；设备固件不支持时回退截图和 CLI。
- Android：随包约 715 KiB 的 scrcpy 4.0 server，复用 ADB 与设备已有 ART，不需安装主机 Java 或完整 scrcpy。配置模拟器 gRPC 时优先使用该通道。
- iOS：复用现有 WDA；idb 模拟器视频加速可选。macOS 随包约 124 KiB 的通用输入桥接，配置 `nativeInput: true`、`inputBridge: "bundled"` 后复用 Xcode / DTUHID，支持普通拖动和系统边缘上滑。已验证 Xcode 27 / iOS 27 的 iPhone 16 Pro 主屏竖屏；其他方向或尺寸使用 WDA。默认仍使用 WDA，iPhone 真机保留原有签名及调试通道。

连续拖动依赖设备原生输入通道就绪；只有 WDA 或命令行时使用完整手势。面板隐藏、暂停、断连或显示几何改变会取消当前手势。折叠和旋转后重新读取画面再操作。帧率还受设备采集、编码、主机负载和宿主通道影响，安装包不承诺固定 FPS。

## 二次开发

使用核心 SDK 或 `createPhoneTools` 接入新宿主。DSH Bundle 中的 `core` 是同一源码的构建副本；不要直接修改发行副本。源码执行 `npm run package:dsh` 重新生成 Bundle。架构与验证边界见核心 `docs/architecture.md` 和 `docs/validation.md`。

源码目录 `packages/dsh` 是打包输入；安装应使用构建得到的 `.tgz`，其中才包含服务入口、UI 和共享核心。验证发行包可运行：

```sh
npm run package:dsh
npm run check:dsh -- /absolute/path/to/node_modules/@deepseek-ai/dsh
```

检查使用临时 profile，默认单独安装包的生产依赖，验证工具注册、对话隔离、侧栏 Fetch 握手及停用/重新启用，不调用外部模型。可用 `--archive /path/to/package.tgz` 指定包；诊断现有安装时可显式传入 `--dependencies /path/to/profile/node_modules`，输出会区分依赖来源。它不能替代实际桌面的画面和输入验收。
