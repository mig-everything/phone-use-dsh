# 安装与连接

## 先使用鸿蒙模拟器

1. 安装 DevEco Studio 及所需原生 HarmonyOS SDK，在 Device Manager 中创建并启动手机模拟器。第一轮推荐普通直板机；折叠和三折叠需要对应镜像及型号。
2. 将 SDK 的 `hdc` 放入 PATH，或者用配置文件指定绝对路径。宿主启动的进程不一定继承终端 PATH，绝对路径更可靠。
3. 执行 `hdc list targets`，确认精确的 connect key。多设备时不可省略设备选择。
4. 构建仓库，执行 `npm run doctor`，再运行只读 MCP 检查。

```sh
npm ci
npm run build
npm run doctor
node scripts/smoke-device.mjs --device harmonyos:127.0.0.1:5559
```

设备 ID 是示例，请以本机发现结果为准。`doctor` 检查设备发现，`smoke-device` 进一步获取独占会话、探测能力、截屏、读取控件树和 UI 资源，然后关闭会话。后者会通过真实 stdio MCP 客户端执行，不只直接调用 adapter。

模拟器创建界面及镜像以 [DevEco Studio 官方指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-create)为准。服务本身不下载 SDK，也不自动修改模拟器的系统调试权限。

## 配置

复制 `phone-use.example.json` 为 `phone-use.local.json`。后者已被 Git 忽略。只有传入 `--config` 或 `PHONE_USE_CONFIG` 时才会加载该文件，避免受当前目录隐式影响。

```json
{
  "harmony": {
    "enabled": true,
    "binary": "/absolute/path/to/hdc",
    "allowEmulatorFold": false
  },
  "android": { "enabled": false, "binary": "adb" },
  "ios": [],
  "stateDirectory": "/absolute/path/to/shared/phone-use-state"
}
```

```sh
node dist/src/cli.js doctor --config /absolute/path/phone-use.local.json
node dist/src/cli.js stdio --config /absolute/path/phone-use.local.json
```

`PHONE_USE_HDC` / `PHONE_USE_ADB` / `PHONE_USE_SCRCPY` / `PHONE_USE_FFMPEG` 可覆盖可执行文件位置；`PHONE_USE_STATE_DIR` 覆盖状态目录。默认设备锁位于 `~/.local/state/phone-use/locks`。所有控制同一台设备的 Phone Use 实例应使用同一状态目录。锁不约束 DevEco、其他自动化程序或手动触摸。

HDC 使用其默认服务配置。若 SDK 要求指定服务地址，可配置 `harmony.server`，它会作为 `hdc -s` 参数传入。不要把常见默认端口硬编码到所有机器；本次环境中的有效默认服务端口是 8710。

## Codex 与其他本地 agent

构建后执行：

```sh
node scripts/install-codex.mjs --apply
```

脚本通过参数数组调用 `codex mcp add`，注册本仓库绝对路径下的 stdio 服务。无 `--apply` 时仅打印命令。配置需要固定路径时，也可自行注册：

```sh
codex mcp add phone_use -- node /absolute/path/Harmony_Use/scripts/start.mjs --config /absolute/path/phone-use.local.json
```

新开宿主会话后调用 `phone_devices`。普通 MCP agent 即使不支持组件也能收到截图；`skills/phone-use/SKILL.md` 提供工作流约定。仅注册 MCP 不等于安装 skill，可通过宿主的本地插件入口载入仓库，或按宿主支持的 skill 方式安装该目录。

仓库包含标准 `plugin.json` / `mcp.json`，并提供 `.codex-plugin/plugin.json` / `.mcp.json` 兼容入口。插件使用 `${PLUGIN_ROOT}` 定位启动脚本。源码目录在安装为插件前必须完成 `npm ci && npm run build`；不要把未经构建的 Git 源码目录当成已打包的可执行插件。

插件加载和界面桥接遵循 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)及 [MCP 服务文档](https://developers.openai.com/plugins/build/mcp-server)。本机已通过 CLI 安装完整插件，并由用户确认 Work 面板可以打开；真实 Work 中的全部控件和设备动作仍需逐项验收。

## 在 ChatGPT Work 中显示

使用 **ChatGPT 桌面端的本地 Work 会话**。本插件启动本机 stdio 服务，遵循 [Desktop-only 插件要求](https://developers.openai.com/plugins/deploy/desktop-only)。先保持 DevEco 模拟器运行，再在仓库中执行：

```sh
npm ci
npm run build
node scripts/install-work.mjs
codex plugin add phone-use@phone-use-local
codex plugin list --marketplace phone-use-local --json
npm run check:work
```

安装脚本将已构建的服务、界面、skill 和生产依赖复制到 `~/.codex/plugins/phone-use-local`，通过虚拟设备 MCP 检查后，写入个人插件源 `~/.agents/plugins/marketplace.json`。脚本保留已有源中的其他插件；若已有源使用其他名称，执行它打印的 `codex plugin add` 命令。重复运行时保留旧的自管目录备份，不覆盖非本脚本管理的插件。

安装副本的命令为插件内的 `./scripts/launch-node.sh`；本机 Node 的绝对路径通过 `PHONE_USE_NODE` 传入，HDC、ADB 也通过环境变量固定路径，避免桌面应用的 PATH 与终端不同。插件清单不能直接把 Node 绝对路径作为 `command`：Work 会在启动服务前拒绝它。更换 Node/SDK 安装位置后需重新运行脚本，必要时设置 `PHONE_USE_HDC` / `PHONE_USE_ADB`。源码清单仍保持可移植路径。自定义设备配置可在安装时指定：

```sh
node scripts/install-work.mjs --config /absolute/path/phone-use.local.json
```

脚本引用配置的绝对路径，不复制私有配置。升级时保留已有 `PHONE_USE_CONFIG` 和状态目录；新传入的配置优先。安装完整插件后，如曾注册独立的同名 MCP，请用 `codex mcp get phone_use --json` 确认来源，再执行 `codex mcp remove phone_use` 移除该注册。同名全局配置会优先于插件配置，可能继续指向旧版本；不同会话中的服务进程还会分别持有设备锁。

没有 Codex CLI 时，运行安装脚本后，在 **Plugins → Phone Use Local → Phone Use** 中安装；插件源尚未出现时重启桌面端。有 CLI 时，确认列表中 `installed` 和 `enabled` 均为 `true`，通过宿主加载检查后，重新连接或新开本地 Work 会话，选择 `Phone Use`，通过插件的对话入口打开“手机控制台”。

`phone_console` 是用户入口和模型均可调用的显式打开工具，无需先连接设备即可显示选择器。宿主未显示入口按钮时，可直接在对话中要求“打开手机控制台”。仅在打开时调用该工具；设备切换使用 `phone_focus`。它通过 `openai/ui.entrypoints: [{type: "thread"}]` 声明对话面板入口，资源声明 fullscreen / inline 展示能力。宿主负责将面板放在对话右侧或其他位置，插件不自行绘制聊天区。接入依据为 [Conversation panels](https://developers.openai.com/plugins/build/extensions) 和 [ChatGPT UI 桥接](https://developers.openai.com/plugins/build/chatgpt-ui)。

也可让 agent 先 `phone_devices`、`phone_open`，面板会发现同一作用域下的新会话。组件通过 app-only 的 `phone_connect` 交换 WebRTC SDP 和一次性凭据，再建立认证的本机视频/操作连接；不可用时尝试 WebSocket，最后回退 `tools/call`。组件不直接持有 HDC/ADB/WDA 端点或设备令牌。Agent 使用 `phone_focus` 切换已有面板，`phone_screen` 不再关联渲染模板。没有 UI 能力的客户端使用 `phone_observe`，或 `phone_screen({session_id})` 获取 PNG 图片。

早期对话曾返回 HarmonyOS 折叠模拟器图片回退；0.2.1 修复后，用户另外确认了实际 Work 面板可以打开。这两项验证分别对应图片工具和交互面板加载。

组件提供设备选择、单设备/并排视图、点击、拖动、滚轮滑动、刷新、连续预览、返回、Home、独立暂停和断开。常用操作悬浮或键盘聚焦时出现，设备 ID、尺寸、姿态、传输状态等放在详情菜单；折叠按钮仅在该设备声明 `foldControl` 时出现。文字输入通过 agent 工具执行。

本机直连默认对每台设备保留一批未确认的帧；DSH 协商为最多四批，并将帧确认与输入通道分开，减少宿主往返等待。客户端按设备顺序解码，队列始终有界；慢客户端从关键帧恢复。原生画面在设备执行动作时继续显示，但不能授权新的输入。兼容 MCP 预览目标间隔为单卡 100 ms、并排 180 ms，最多两条在途请求；实际帧率受采集与宿主桥接限制。停止预览只停止画面刷新；暂停同时停止截图和控制并清空画面，已提交的动作不能撤销。详情菜单显示渲染次数/秒、分辨率和动作耗时。静止画面按需发送，低更新率不等于动画期间的帧率。

Android 模拟器若使用 SwiftShader 等软件渲染，手机自身的动画生成也可能偏慢。仓库的 `scripts/start-android-emulator.mjs` 默认使用 `-gpu host`；可在模拟器日志中确认实际渲染后端。仅增加传输窗口不能补出设备尚未生成的画面。

多个设备可来自不同平台。通过 `phone_observe_many` 和 `phone_batch`，agent 为每台设备分别观察、定位和执行，图片和错误均带设备标识。并行执行不等于时间严格同步。行为对比工作流和报告不属于本版。

**Work Cloud 无法仅靠安装插件访问这台电脑的 USB。** 当前交付包括本地 stdio 和回环 HTTP 服务。云端访问还需要本机连接器、HTTPS/OAuth 网关和配对流程，尚未实现。不要直接将调试端口或本地 HTTP 服务映射到公网。[OpenAI UI 接入规范](https://developers.openai.com/plugins/build/chatgpt-ui)定义宿主展示协议，不替代设备网络连接。

## 刷新与热加载

画面刷新和插件升级是两个过程。现有面板会自动更新视频或截图；修改源码不会直接替换已安装的缓存副本或已经打开的页面。升级需要重新构建、运行安装器和它打印的 `codex plugin add` 命令，然后让宿主重新加载工具。先结束正在控制设备的旧会话，避免旧进程继续持有设备锁。

[iPhone-use 的安装脚本](https://github.com/zhongerxin/iPhone-use/blob/main/scripts/install.sh)在安装后提示重新连接聊天，没有自动热加载机制。其 [register_mcp.py](https://github.com/zhongerxin/iPhone-use/blob/main/scripts/register_mcp.py)额外注册同名全局 MCP，利用全局配置优先级覆盖插件注册；Phone Use 的完整插件采用可被宿主直接加载的相对命令，不需要这层覆盖。

本机 ChatGPT 内置 app-server 提供 `config/mcpServer/reload`。本次在同一诊断进程中先复现 0.2.0 加载失败，安装 0.2.1 后调用该接口，成功发现 12 个工具和对话面板资源。这证明服务层可以重载；不表示终端里的另一个进程能刷新正在打开的 Work 窗口。更新后重新连接会话并从插件入口打开一次控制台，仍用旧版本时才考虑重启应用。`phone_screen` 只读取/选择状态，不能刷新宿主代码或创建新面板。已在运行的旧版页面不会被安装器替换。具体刷新行为取决于宿主版本。

检查安装副本时运行：

```sh
node scripts/check-work.mjs
```

macOS 优先使用 ChatGPT 应用内置的 Codex 加载器，其他情况使用 PATH 中的 `codex`；可用 `--codex /path/to/codex` 覆盖。该检查验证插件解析、MCP 来源与版本、工具清单、thread 入口、对话打开工具的 model 可见性和 HTML 资源，不打开设备，不启动模型任务。输出的 `desktopWindowVerified: false` 明确表示本次脚本不检查真实窗口。`--interactive` 中的 `reload` 也仅作用于该独立诊断进程。

## 本地 HTTP MCP

需要 HTTP 的本机客户端可使用 Streamable HTTP：

```sh
export PHONE_USE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
node dist/src/cli.js serve --port 8765
```

端点为 `http://127.0.0.1:8765/mcp`，每个请求携带 `Authorization: Bearer <token>`。这是单用户、仅 POST 的本地端点，不提供网页或云端 OAuth。服务拒绝浏览器 Origin；屏幕组件通过宿主桥接调用工具。令牌不要写入仓库或聊天记录。

## Android 和 iPhone

Android：安装 Android Studio / platform-tools，启动一个独立 AVD；真机开启 USB 调试并确认授权。使用 `adb devices -l` 检查精确序列号。基础后端使用系统 `input` 和 `uiautomator`。中文输入需要后续 IME / companion adapter；当前明确拒绝 Unicode 和存在歧义的字面 `%s`。[ADB 官方文档](https://developer.android.com/tools/adb)。

iPhone / iOS Simulator：需要完整 Xcode 和正在运行的 [WebDriverAgent](https://github.com/appium/WebDriverAgent)。模拟器需对应的 simulator runner；真机还需完成设备信任、开发者模式、签名及 USB 端口转发。准备可访问的回环 HTTP 端点后，在配置中添加：

```json
{
  "harmony": { "enabled": false },
  "android": { "enabled": false },
  "ios": [{ "name": "test-iphone", "url": "http://127.0.0.1:8100" }]
}
```

服务会创建自己的 WDA session，并在关闭时删除该 session。请给本插件独占的 WDA runner；新建 WDA session 可能影响同一 runner 上已有的自动化。插件不自动管理签名、安装 runner 或 USB 转发；按下文准备端点后即可使用同一 adapter。配置名应唯一，且不要给同一端点设置多个名字。

本机已安装 Xcode 27、iOS 27 模拟器运行时，WDA 16.15.0 在专用 iPhone 16 Pro 模拟器上验证了树、截图、Home、设置启动和 MJPEG。真机签名与硬件操作仍待测。三端共用同一个会话和动作接口，真机不需要另一套插件，但各平台的调试连接和系统权限仍需由设备所有者准备。

## 连续预览与截图

### 轻量 OCR

0.8 安装包内置中英文模型（6.58 MB）及许可证，生产依赖包含 Tesseract.js / WASM，安装后无需下载模型或安装系统 OCR。`node scripts/check-ocr.mjs` 在源码/解包目录检查；`node scripts/check-ocr.mjs --installed` 检查本机已安装插件。均使用合成图，不打开设备。默认 `ocr.workers: 3` 支持三设备同时识别；内存受限可设 1–2，超出的请求排队且计入默认 2500 ms 总预算，可将 `ocr.timeoutMs` 调至最多 10000。模型文件体积不等于运行内存，每个活跃进程会另占 WASM/图像工作空间。

首次 `phone_devices` 的 OCR available 为 null，实际成功后才为 true。模型缺失/损坏会报告失败，包内 SHA-256 校验阻止加载；重新安装完整包恢复。超时会终止对应识别进程并短暂冷却，不强制终止手机应用，其他 OCR 槽继续工作。默认不再依赖 macOS Vision；Windows/Linux 使用同一个引擎。预览视频与纯控件读取不运行 OCR。

预览不进入模型上下文。模型优先用 `phone_inspect` 读取控件，`phone_act` 默认 `observe: "tree"`。必要时调用 `phone_observe`，默认最多 2 秒的有界稳定检查；`wait_for: "none"` 立即截图。结果中的 `stability` 明确是否稳定，不将超时当作加载完成。

面板相机按钮执行完整截图，显示稳定结果，并允许用户下载 PNG。普通截图/预览保存在当前进程内存，鸿蒙传输临时文件在 finally 中删除；显式下载位置由浏览器/Work 宿主决定。开发脚本指定 `--output` 才落盘；本仓库联调图片放在忽略的 `.phone-use/`，不会打包。真实 Work 的下载行为仍取决于其 iframe 下载权限。

直连优先 H.264 原始分辨率；JPEG 单卡最多 3200×3200，原生 JPEG 在尺寸允许时直接复用，并排最多 1440×1600。只有宿主禁止本机连接或视频解码时才使用 JPEG/MCP 回退；MCP 回退图像最多 960×1280。面板底部显示“本机直连”或“兼容预览”，设备详情显示实际视频来源。0.5.1 在设备详情中增加 JPEG 回退原因、单设备重试和操作耗时分项；一台设备解码失败不会降低其他设备的视频方式。鼠标按住时预览继续刷新，拖动仍在松手后提交。真实 Work 里的 WebSocket/CSP/WebCodecs 需要更新后验收；Chrome 的 sandbox iframe 已验证。

### Work 显示“兼容预览”时

“兼容预览”表示画面和手动操作经过 MCP 工具桥接；即使设备端是 scrcpy 连续采集，组件拿到的也是逐次 JPEG 图片。0.5.2 将这种状态明确标为“MCP 图片轮询”，点击底部状态可查看连接错误、组件版本、WebCodecs 能力并重试。`phone_panel` 接受仅供组件使用的 `preview_client` 枚举诊断，在 `_meta.preview` 返回服务端版本及连接状态；不记录地址、凭据、屏幕内容或用户输入。

**0.6 首先尝试免手动证书的 WebRTC。** MCP 负责信令，浏览器与本机服务自动生成临时 DTLS 身份并校验 SDP 指纹；无需导入证书或修改系统信任。浏览器不配置 STUN/TURN；服务以 ICE-lite 方式只监听 `127.0.0.1`，只接受回环候选和连接，不请求公网服务器。WebRTC 使用标准宿主 API，不修改 Work 策略。该通道在禁止普通直接请求的 Chrome sandbox iframe 中通过原生视频、多设备和操作测试；实际 Work 的可用性仍需在更新后确认。协议依据：[W3C WebRTC](https://www.w3.org/TR/webrtc/)。

播放器先协商硬件 H.264 解码，硬件不可用时允许浏览器使用软件解码；两者都不可用才把该设备切为 JPEG。没有 GPU 不再直接等于没有视频能力。软件解码会增加 CPU 负载，仍保留逐设备背压和解码超时回退。

更新后重新连接插件、重新打开控制台，点击底部状态，应显示“WebRTC 加密直连”。不成功会自动尝试 WS/WSS，再回退 MCP 图片轮询；`preview_client.transport` 和 `rtc_failure` 帮助区分具体通道和 WebRTC 失败。普通操作与截图不需要证书。WebRTC 只改善到看板的传输，不会让截图型设备自动获得原生视频源。

### 可选 WSS 后备（不是默认安装步骤）

2026-10-16 本机 Work 组件加载器会过滤 CSP 中的明文 `ws://` 地址。这是此前浏览器测试可直连、实际 Work 却走兼容预览的一个关键差异。插件按 [OpenAI UI 参考](https://developers.openai.com/plugins/reference) 声明精确的 WebSocket origin，不修改宿主策略。只有需要保留 WSS 后备时才配置下列证书；WebRTC 不使用它：

```json
{
  "preview": {
    "tls": {
      "certificate": "/absolute/private/path/localhost.pem",
      "key": "/absolute/private/path/localhost-key.pem"
    }
  }
}
```

证书必须包含 `127.0.0.1` 的 IP SAN、处于有效期并与私钥匹配。服务仍只监听 `127.0.0.1`、校验 Host、要求一次性组件凭据；配置错误不降级为明文监听。不使用公网隧道。证书与私钥留在本机，不进入插件包。

仓库脚本可生成一张有效期 365 天、`CA:FALSE` 的自签名服务器证书，并把路径写入指定的私有配置。这一步**不改变系统信任**：

```sh
node scripts/setup-preview-tls.mjs --config /absolute/path/phone-use.local.json
```

macOS 用户审阅输出的证书指纹后，可显式执行下面的信任步骤。它调用 `security add-trusted-cert`，只写入当前用户的登录钥匙串，信任范围限定为 SSL / `127.0.0.1`；不是安装可签发任意网站证书的根 CA，也不会关闭浏览器证书校验。系统可能要求交互确认：

```sh
node scripts/setup-preview-tls.mjs --trust-macos
```

如生成时传入了 `--directory`，信任时必须使用同一个目录。脚本同时输出按精确 SHA-256 指纹删除证书的回滚命令。其他系统可配置组织签发且受宿主信任的证书；本脚本只提供 macOS 的显式信任步骤。

配置后重新连接插件并重新加载看板；仅安装新版不会刷新已经运行的组件或 MCP 进程。资源 URI 含版本号，升级时更新组件，同版本内保持稳定以兼容宿主的工具声明缓存。切换设备不改变资源 URI；服务重启导致旧看板的端口 CSP 失效时需重新加载看板。WSS 通过 CSP 并不保证宿主允许本地网络或具备相应解码器，实际 Work 需确认显示“本机直连”，且各设备详情显示真实视频来源。TLS 本身不会将鸿蒙的截图采集升级为原生视频。

### 模拟器宿主通道（0.5）

模拟器可以单独选择宿主视频与输入后端。Android 使用 SDK 附带的实验性 `EmulatorController` gRPC；iOS 使用 Meta idb 1.7.3，依赖 Apple 的私有模拟器接口，当前验证组合为 Xcode 27 / iOS 27。它们复用现有多设备看板。真实手机继续使用下文的随包 Android server、WDA、Harmony UiTest 桥接或 companion。

Android 需要启用带 token 的回环 gRPC，以及 FFmpeg（macOS 使用 VideoToolbox，其他系统使用 libx264）。已在 Android Studio 启动但没有此端点的模拟器自动回退；插件不会终止或重启它。可显式启动一个空闲 AVD：

```sh
node scripts/start-android-emulator.mjs --avd Your_AVD_Name --port 5582
```

脚本使用宿主 GPU、随机 gRPC 端口和 `-grpc-use-token`，输出设备 ID 与日志路径，不输出 token。若端口已占用会退出。Linux/Windows 需另外指定 `--sdk` 和 `--discovery`，当前端到端验证仅覆盖 macOS。配置示例：

```json
{
  "android": {
    "enabled": true,
    "binary": "/absolute/path/to/adb",
    "emulator": {
      "sdkRoot": "/absolute/path/to/Android/sdk",
      "ffmpeg": "/absolute/path/to/ffmpeg"
    },
    "video": { "scrcpy": "bundled", "ffmpeg": "/absolute/path/to/ffmpeg" }
  }
}
```

macOS 默认从 `~/Library/Caches/TemporaryItems/avd/running` 按 ADB console 端口匹配存活进程及认证端点；其他目录使用 `android.emulator.discoveryDirectory`。从该 SDK 加载 proto。视频使用完整 RGB 帧，经宿主编码为 H.264；当前不启用尚未验证的 MMAP。方向和原生坐标已核对的竖屏点击/滑动，以及 Home/Back/Enter 可走 gRPC；旋转、几何未知或原生画面不可用时使用设备侧输入。应用管理、控件树及完整截图仍走 ADB。当前非零旋转的视频也优先回退 scrcpy，避免强制横屏与宿主传感器方向不一致。

iOS 先准备同一模拟器的 WDA，再从 [idb 官方发布](https://github.com/facebook/idb/releases/tag/v1.7.3)取得匹配主机架构的 companion 包，保留包内文件的相对位置。插件不内置这些二进制，也不自动下载。通过 `xcrun simctl list devices booted` 查找精确 UDID：

```json
{
  "ios": [{
    "name": "test-iphone",
    "model": "iPhone 16 Pro",
    "url": "http://127.0.0.1:18100",
    "mjpegUrl": "http://127.0.0.1:19100",
    "simulator": {
      "udid": "00000000-0000-4000-8000-000000000001",
      "simVideo": "/absolute/path/to/idb/sim-video",
      "nativeInput": true,
      "inputBridge": "bundled"
    }
  }]
}
```

示例 UDID 必须替换，且 WDA、MJPEG、UDID 必须指向同一台模拟器。`deviceSetPath` 可选，默认 Apple 标准设备目录。`sim-video` 从 IOSurface 经 VideoToolbox 输出 fMP4/H.264，主机只解包转发。控件树、完整截图、文本输入、Home/Enter 按键及应用启动仍使用 WDA。

iOS 的视频与触控兼容性分别判断。省略 `nativeInput` 仍默认使用 WDA。0.9.2 在 macOS 上提供随包的约 124 KiB 通用二进制，设置 `nativeInput: true` 和 `inputBridge: "bundled"` 后，复用已安装 Xcode 的 CoreSimulator / DTUHID 完成点击、连续拖动和系统边缘手势，不需要另外安装输入 companion 或在手机里安装 App。它通过进程私有管道连接精确 UDID，校验启动状态、屏幕尺寸及产物摘要；Xcode 27 / iOS 27、iPhone 16 Pro 模拟器竖屏已实测。

当前桥接只启用已核对的主屏竖屏几何，横屏、倒置或尺寸不匹配时，完整操作改用 WDA；已经开始的手势会先取消，不沿用旧坐标。桥接使用 CoreSimulator 私有接口，其他 Xcode / runtime 需单独验证；无法建立原生连接时仍可使用 WDA。详情与源码见 [iOS 输入桥接](../native/ios-simulator-input/README.md)。

旧的 `companion` + `nativeInput: true` 配置仍支持 idb 私有 Unix socket。idb 1.7.3 在本机 Xcode 27 上有落点偏移；新版 idb 的普通触摸虽可工作，其 gRPC 触摸消息没有系统手势的边缘标记，所以不能只升级 idb 就认为上滑返回桌面已经解决。旧通道的边缘滑动会在提交前选择完整 WDA 手势，且 WDA 在本机 iOS 27 上仍未通过该系统手势验收；该环境请使用随包桥接。

视频失败可回退原有视频或截图。输入只在原生连接尚未建立时回退；一旦提交过动作，失败会返回 `uncertain`，不会自动再用 ADB/WDA 重放。停止预览/关闭会话会清理本插件启动的媒体与输入进程。当前 DevEco macOS 尚无已验证的宿主媒体接口，鸿蒙使用下文设备侧 UiTest 桥接和已有回退路径，详见[接口研究](device-agent.md#模拟器优先使用宿主接口)。

### Android：scrcpy

0.9 默认使用随包的 scrcpy 4.0 server（约 715 KiB），仅需现有 ADB。无需主机 Java、完整 scrcpy 或安装 APK；设备使用自带 ART 运行 server。H.264 直传不需要 FFmpeg，JPEG 兼容解码可配置 FFmpeg：

```json
{
  "android": {
    "enabled": true,
    "binary": "adb",
    "video": { "scrcpy": "bundled", "ffmpeg": "/absolute/path/to/ffmpeg" }
  }
}
```

0.9 固定随包 4.0 协议并校验 SHA-256；历史实测还包括外部 scrcpy 4.1。仍可将 `scrcpy` 改为外部程序路径，使用其匹配的 server。优先使用保留包边界、时间戳、关键帧和旋转信息的原生 H.264 协议，浏览器 WebCodecs 解码，不经过 FFmpeg/JPEG。编码配置原始尺寸、最高 60 FPS、16 Mbps，实际依赖设备和宿主；Android 原生触摸/按键也复用该服务的 control socket，手势耗时包含手势本身的持续时间。其他 scrcpy 版本或解码不可用时回退 raw_stream + FFmpeg/JPEG，再回退截图。0.5.1 的 JPEG 通道同样保留原生 control socket，避免仅因宿主没有视频解码能力便把点击/滑动退回逐次 ADB 命令；视口不匹配仍保留安全回退。服务使用同版本附带的 server，动态建立独立 ADB 转发和 socket，关闭后清理本次资源。默认从已解析的 scrcpy 可执行文件相邻 `../share/scrcpy/scrcpy-server` 查找 server；特殊发行包可用 `SCRCPY_SERVER_PATH` 指定匹配版本的文件。没有依赖或视频失败时回退截图。真机先完成 USB 调试授权；若已通过 ADB 配对建立无线调试连接，同一设备选择和视频路径可复用。无线配对由用户按 Android 工具完成。

### iOS：WDA 控制与 MJPEG

```json
{
  "ios": [{
    "name": "test-iphone",
    "model": "iPhone 16 Pro",
    "url": "http://127.0.0.1:8100",
    "mjpegUrl": "http://127.0.0.1:9100"
  }]
}
```

WDA 两个端口分别提供控制和 MJPEG。实际端口以 runner 配置为准，可通过 `USE_PORT`、`MJPEG_SERVER_PORT` 的测试环境变量设置。多个设备分别配置唯一名称和主机端口；不能为同一 runner 配置多个设备名字。`model` 用于匹配本机安装的 Apple Simulator / Android SDK 外框素材；SDK 没有的摄像头图形不伪造。未知型号使用明确标注的通用边框。WDA session 关闭空闲/动画冷却等待，MJPEG 请求 30 FPS、质量 80、100% 尺寸；真实设备执行速度和实际 FPS 仍取决于 XCTest。

真机在 Xcode 签名并启动 WDA 后，可用安装好的 iproxy 分别转发端口（不同版本的 CLI 参数以其 help 为准）：

```sh
iproxy -u <UDID> 18100:8100
iproxy -u <UDID> 19100:9100
```

对应配置为主机 `127.0.0.1:18100` 和 `127.0.0.1:19100`。若使用已能访问的 LAN WDA，则填写设备 IP，并为该条配置设置 `allowRemote: true`。默认拒绝非回环地址、URL 内嵌凭据和重定向。WDA 调试端口本身不提供本插件的认证，不应暴露到公网；优先 USB 转发或受信任的加密隧道。签名与连接方式见 [WDA 官方指南](https://appium.github.io/appium-xcuitest-driver/latest/guides/wda-custom-server/)。

本机联调使用专用 `PhoneUse_iPhone16Pro` 模拟器，端口 18100 / 19100。WDA 必须持续运行；重启电脑或停止 runner 后需重新启动，插件不会在后台自动下载或运行 Xcode。

### 鸿蒙：轻量 UiTest 桥接

0.9 默认尝试随包的 ARM64/x86_64 UiTest C++ 扩展，经过现有 HDC 转发认证 socket，发送变化后的连续 JPEG 和触摸 ACK。无需 Java、安装 HAP 或主机编译；固件须支持 UiTest extension。它消除逐帧命令、文件传输与等待，但不是 H.264，帧率由系统 copyScreen 决定。可设置 `harmony.bridge.enabled: false` 关闭，或 `harmony.bridge.input: false` 仅观看。源码、编译命令与许可见 [native/harmony-bridge](../native/harmony-bridge/README.md)。

同一设备上的 HMBot 采集/人工输入互斥会被遵守；先关闭占用窗口，不删除其他服务的锁。设备显示 epoch 改变后旧手势失效。当前本机 API 24 模拟器已出帧；HarmonyOS 5/7、x86_64 运行和真机仍需验证。

### 鸿蒙：原生 companion

[companion 工程与步骤](../companion/harmony/README.md)包含公开 AVScreenCapture API、H.264 Surface 编码和 RGBA 备用路径，默认设备回环监听、连接码认证、无音频。主机通过 HDC 转发或显式启用的 LAN 接入。普通 HAP 只管视频，操作仍走 HDC / UITest。

工程已成功构建并安装在 API 22 折叠模拟器，系统授权流程通过；当前该镜像仍未返回原生帧，继续用截图预览。真机 H.264 和其他系统镜像需进一步验证，不能将“配置了视频通道”等同于“已经验证能出帧”。普通鸿蒙设备无需安装 companion 即可进行截图和控制。

## 故障排查

| 现象 | 检查方式 |
| --- | --- |
| `TOOL_MISSING` | 给 HDC/ADB 配置绝对路径，确认宿主环境能执行 |
| `DEVICE_NOT_FOUND` | 重新运行 `doctor`；模拟器重启后 connect key 可能改变 |
| HDC 连接超时 | 先确认 SDK 自带 `hdc list targets` 正常，检查服务地址及宿主沙箱网络权限 |
| `DEVICE_BUSY` | 先关闭占用会话；异常退出时检查错误中锁文件的 PID，确认进程已结束再人工删除 |
| `STALE_OBSERVATION` / `DISPLAY_CHANGED` | 重新观察，再决定下一步；不要直接重放动作 |
| `FOCUS_REQUIRED` / `FOCUS_CHANGED` | 点击正确输入框，带控件树重新观察 |
| 截图成功但控件少 | 检查 `warnings`；Canvas、WebView、受保护页面可能缺失可访问节点 |
| 点了节点但没有页面变化 | 节点可能只是文字标签；重新看截图，选择实际可点击区域 |
| 折叠按钮没有显示 | 先在 Device Manager 手动改变姿态；此设备没有满足模拟折叠能力条件 |
| npm 下载失败且代理指向本机 | 检查代理进程是否运行；修复当前终端代理设置后重试 |
| Work 中找不到 Phone Use | 确认桌面端本地会话和 installed/enabled；重新连接会话，仍未刷新时重启应用 |
| 能选中插件，但没有工具或面板 | 先运行 `check-work.mjs`；0.2.0 的绝对 `command` 会被宿主拒绝，升级至 0.2.1；检查同名全局 MCP 是否覆盖插件 |
| 只看到图片，没有交互面板 | 当前宿主可能未声明 MCP Apps 能力；仍可通过 agent 工具操作，交互面板需支持该协议的宿主 |

本地开发需要仓库写权限、依赖下载网络权限，以及访问 HDC/ADB 服务和所选模拟器的能力。当前环境已经具备 Full Access，无需再修改沙箱。真机仍需在手机上确认开发者调试授权。

### 型号外框

优先读取当前电脑的 Apple Simulator、Android SDK 素材，不把 SDK 图片打入发行包。Android 真机按可验证的 Pixel 型号匹配；0.5.2 的模拟器另外通过其精确 AVD 名称读取本机 `config.ini` 的 `skin.path` / `skin.name`，解决虚拟系统上报 `sdk_gphone64_arm64` 而无法匹配官方皮肤的问题。皮肤屏幕比例必须吻合，旋转会同时变换外框与触摸区域；不匹配时回退中性边框。Generic / Medium Phone AVD 未配置皮肤时，没有可对应的商品机型，不能冒充 Pixel。

Android 折叠 AVD 的 `default`（内屏）与 `closed`（外屏）素材按实际屏幕比例分别选择；未知铰链状态也不会沿用错误外框。自定义素材优先匹配精确 posture。

本机 DevEco 安装内只找到通用预览皮肤和设备图标，没有找到能匹配当前鸿蒙型号的完整官方外框。此状态与视频通道无关。可配置 `skinsDirectory` 安装有来源的精确型号素材，其 `skins.json` 为下列对象的数组：

```json
[{"platform":"harmonyos","model":"实际设备型号","posture":"expanded","image":"frame.png","mask":"screen-mask.png","width":1200,"height":1400,"screen":{"x":40,"y":40,"width":1120,"height":1320},"source":"你的已授权型号素材"}]
```

`overlay` 可选，用于真实摄像头覆盖层；`mask` 使用 alpha 遮罩。文件路径相对该目录，屏幕区域、比例和姿态必须匹配。折叠前后可分别配置，未知或不匹配则回退通用外框。画面坐标只按屏幕区域计算。
