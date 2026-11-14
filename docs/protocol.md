# 工具协议与执行语义

调用顺序为发现设备、打开、观察、单步操作、验证结果、关闭。以下片段为 MCP `tools/call` 的 `arguments`；UUID 必须取自前一次工具结果。

## 0.8 增量合同

`phone_act` / `phone_batch` 的 `observe` 继续兼容 `false / true / "tree"`，默认 `"tree"`。也接受 `{mode: "tree" | "image", query?, max_nodes?: 60, wait_timeout_ms?: 0, ocr?: "off"}`；查询在整棵导出树上进行，随后限制节点。image 模式才返回图片，true 保持原来的最多 2 秒稳定检查。执行失败不重试，执行成功后读取失败仍返回 applied。

新增动作 `{kind: "tap_target", selector: {names: ["Continue", "继续"], role?: "button", context?, resource_id?}}` 在设备队列内读树、唯一定位、重新校验并点击。没有唯一启用目标时返回 `TARGET_MISSING / TARGET_AMBIGUOUS / TARGET_DISABLED`，不提交动作。不放宽原有 tap_node/text/坐标动作的观察校验。

`phone_wait` 的例子：

```json
{
  "session_id": "<session UUID>",
  "condition": {"kind": "target", "selector": {"names": ["继续"]}, "state": "actionable"},
  "timeout_ms": 5000,
  "interval_ms": 250,
  "quiet_ms": 400,
  "max_nodes": 12
}
```

target 的 state 支持 present、absent、actionable。唯一匹配需在 quiet interval 内保持相同节点与几何；absent 仅指完整导出的可访问性树。`condition: {kind: "stable", region: {x: 0.1, y: 0.2, width: 0.8, height: 0.5}}` 检查归一化区域，省略 region 表示全屏。单次最多 30 秒；目标等待返回 matched/timeout 和最终树，稳定等待返回 stable/timeout 和最终截图。等待不执行动作，不因超时自动重复操作；图像稳定不是业务完成。SDK 可传 AbortSignal；在途平台命令结束前无法强行返回。

默认 OCR 为随包的中英文轻量模型，最多 3 路并发，`ocr.workers` 可降为 1–2；最多 8 个不同图像请求，共享请求内的排队和识别截止时间。相同图像共享识别，不共享可变结果或设备观察 ID。`perception.ocr.available: null` 表示尚未验证，不能当作 true；失败返回短暂冷却状态及原图。详细安装、内存和扩展边界见 [集成说明](integrations.md#页面理解与场景扩展)。

精简观察使用 `format: phone-use.observation.v1`。MCP 保留 content/structuredContent 兼容性；自定义场景使用 `modelContent` 仅转发一份正文，图片作为 image block，UI _meta 不送模型。不要手写只保留 id/name 的压缩器；动作、状态、上下文、导航和警告是正确操作所需证据。

```json
{ "device_id": "harmonyos:127.0.0.1:5559" }
```

`phone_devices` 同时返回当前作用域的 `sessions` 和 `perception` 能力。`phone_open` 返回 `session_id`、设备版本与能力、`paused` 和 `reused`；同一作用域重复打开设备会复用原会话，不自动恢复暂停。优先 `phone_inspect({ session_id })` 读取精简控件索引，默认最多 60 个元素。`query` 在完整导出的树上先搜索再截断，`max_nodes` 可显式调到 1–500。其观察 `kind: tree`、`coordinate_space: driver`，不带图片，只授权节点点击和聚焦输入。需要视觉或坐标操作时调用 `phone_observe`：

```json
{ "session_id": "<session UUID>", "with_tree": true, "ocr": "auto", "wait_for": "stable", "wait_timeout_ms": 2000 }
```

截图默认检查连续画面的稳定性，`wait_for: none` 可立即取图。`stability.status` 为 `stable / timeout / immediate`，`timeout` 返回最新图和 warning；稳定不代表网络请求或业务加载结束。时间和最多 12 个样本双重限界，单次底层命令仍受驱动超时约束。

结果含 `observation.id`、`capturedAt`、`display`、`nodes`、`truncated`、`warnings` 和 PNG image content。`display.width/height` 是截图像素；`inputWidth/inputHeight` 仅用于说明 driver 坐标域，调用方无需手动换算。

0.7 的 MCP `nodes` 是 `{id, role, name?, context?, actions?, focused?, checked?, value?, ...}` 精简结构，省略重复的原始 text/description/class/parent；无名称控件保留 resource_id。完整原始字段、语义来源和祖先证据保留在 SDK。MCP 的 text 与 structuredContent 都使用精简形式，避免另一份原始树进入模型上下文。静态文字按节点预算返回；被省略不代表目标不存在。

`navigation` 给出 swipe 能力、可用系统键、最多 8 个已知滚动区域、坐标域和 `scroll_limits: unknown`。截图区域为像素，纯树区域为 driver 单位。当前平台、型号和 OS 版本随观察提供；屏幕尺寸、旋转与折叠姿态仅在实际截图观察中提供，不把缓存的旧几何当作当前状态。缺少滚动节点不表示页面不可滑动；需要截图验证。一次未变化的画面也不证明已到边界。

`ocr: auto` 仅在本次截图的树为空、出现无名可操作控件或不透明区域时触发；`on` 强制尝试，`off` 跳过。默认本机超时 2500 ms，`ocr` 返回 `ok / unavailable / timeout / error`。文字框绑定同一个 observation，坐标是原图像素，`ocr:*` 不是原生 node ID，不能用于 tap_node；OCR 置信度不是操作正确率。预览和纯树检查均不跑 OCR。未完成 OCR 不导致重复设备动作。

## 动作

所有动作通过 `phone_act`，一次一个。`observe` 默认 `"tree"`，返回后续控件观察；`true` 请求稳定截图，`false` 跳过后续观察：

```json
{
  "session_id": "<session UUID>",
  "action": {
    "kind": "tap",
    "x": 0.5,
    "y": 0.3,
    "space": "normalized",
    "observation_id": "<observation UUID>"
  },
  "observe": true
}
```

| kind | 参数 | 前置条件 |
| --- | --- | --- |
| `tap` | x, y, space, observation_id | 30 秒内观察且显示几何未变 |
| `tap_node` | node_id, observation_id | 同一节点仍存在、启用、类型/标识/文字/位置未变 |
| `swipe` | x, y, to_x, to_y, duration_ms, space, observation_id | duration_ms 为 100–3000，默认 400 |
| `text` | text, observation_id | 带树观察，编辑框仍获得焦点且身份未变 |
| `key` | key: home / back / enter | 设备能力列表包含此按键 |
| `launch` | app_id, ability | 鸿蒙 ability / Android activity 必填；iOS 仅 bundle ID |
| `fold` | posture: folded / half-folded / expanded | 设备声明 foldControl；对真实手机不提供机械折叠 |

`space` 默认 `pixels`，像素坐标范围为 `[0,width)` / `[0,height)`。normalized 的 1 对应最后一个有效像素。坐标输入必须是有限数值，不接受超出显示区域的点。

节点点击最终也是当前节点边界内的坐标点击，不能保证该节点对应一个可点击控件。文本输入是注入一次文本，不包含清空或提交；旧版鸿蒙 `inputText` 回退会再次点击已验证编辑框，可能改变光标位置。应用/输入法对选中内容、换行和粘贴的处理仍影响结果。

## 结果和恢复

- `applied: true`：驱动命令成功返回。应根据后续观察确认页面和业务状态。
- `applied: true` + `observation_error`：动作已提交，只有后续观察失败；重新观察，不重放动作。
- `isError: true` + `error.uncertain: true`：命令可能已执行，常见于超时；先检查设备。
- `STALE_OBSERVATION`、`DISPLAY_CHANGED`、`STALE_NODE`、`FOCUS_CHANGED`：前置检查拒绝了动作，需要重新观察与决策。
- `UNSUPPORTED`：能力或参数不适用于该 adapter；切换受支持工作流，不假设失败就可以拼 shell 绕过。

返回的 `error` 结构为 `{ code, message, uncertain }`。单次动作在提交前消耗所有旧观察，即使设备响应超时，也不能复用旧观察再次提交。`observe: false` 用于无需后续观察的场景；它不跳过动作前的观察验证。

## 人工接管

`phone_pause({ session_id, paused: true })` 立即停止后续截图发布与动作提交，并丢弃在途截图；返回结果会等待该会话队列完成。已经提交到设备的动作不能被倒退，尚在准备阶段的动作会在提交前取消。继续在队列中生效，之后必须重新观察。`phone_close` 释放设备及 adapter 会话；组件关闭页面只停止轮询，需点击断开按钮或调用工具才能立即释放。

## 多设备

`phone_resolve_many` 只准备共享点击，不执行：

```json
{
  "targets": [{ "session_id": "<harmony session UUID>" }, { "session_id": "<android session UUID>" }],
  "selector": { "names": ["继续", "Continue"], "role": "button" }
}
```

可用 `context` 或 `resource_id` 缩小范围；`targets[i].selector` 整体覆盖公共选择器，适合平台 ID 不同的应用。名称是显式别名的精确匹配（忽略大小写、空白与全半角差异），不会自动翻译或用相似词猜测。定位搜索整个已导出的树，候选多于一个、缺失、禁用或任一设备失败时 `ready: false` 且 `operations: []`。全部成功才可将返回的 `operations` 原样交给 `phone_batch`。操作前仍逐台重新检查节点及其名称/上下文证据，准备成功不保证执行时页面仍相同。没有批量回滚或自动重放。

`phone_observe_many` 对已打开的精确会话并行观察，不自动打开设备：

```json
{ "session_ids": ["<harmony session UUID>", "<android session UUID>"], "screenshot": false }
```

每条结果包含 `session_id`、`device_id`、`status`，成功时带 `observation`；PNG 前附设备/会话/观察标签。agent 分别识别目标后，使用 `phone_batch`：

```json
{
  "operations": [
    {
      "session_id": "<harmony session UUID>",
      "action": { "kind": "tap_node", "node_id": "<harmony node>", "observation_id": "<harmony observation UUID>" }
    },
    {
      "session_id": "<android session UUID>",
      "action": { "kind": "tap", "x": 0.42, "y": 0.3, "space": "normalized", "observation_id": "<android observation UUID>" }
    }
  ]
}
```

每次接收 1–8 台设备，最多 4 个并发，同设备只能出现一次。观察 ID 不能跨设备借用。响应包含 `all_succeeded`、起止时间、`max_concurrency` 和按请求顺序排列的 `results`。部分失败不会令整个工具返回 `isError`；调用方必须检查每条结果。动作成功但后续观察失败时保留 `applied: true` 和 `observation_error`，`all_succeeded` 为 false，不能据此重放整批动作。

没有统一坐标广播、精确同步、回滚或自动重试。设备单独排队，可能有不同耗时和结果。行为对比和任务工作流由后续上层实现。

## 对话面板

`phone_console` 是模型和用户均可调用的显式打开入口，关联 `screen-<version>.html`。`phone_focus({session_id})` 和 `phone_screen` 只读取/更新现有面板选择，不带输出模板，不创建标签页。无 UI 的客户端调用带会话的 `phone_screen` 仍可获取标准图片。

0.6 组件默认创建有序可靠 DataChannel，标签 `phone-use`，通过 `phone_connect({panel_id, rtc_offer: sdp})` 取得 `_meta.stream` 中的 `transport: webrtc`、`answer: {type, sdp}` 及单次 60 秒凭据。SDP 最多 16 KiB，只接受一个 data-channel 媒体段；服务忽略浏览器候选，ICE-lite 仅提供 `127.0.0.1` UDP 候选。DTLS 指纹校验失败不得进入数据通道。没有 STUN/TURN、DNS 候选解析或公网中转；信令和凭据只走组件元数据。

DataChannel 首条 JSON 为 `hello` 和凭据，复用与 WS 相同的认证、`view/ack/act`、逐设备作用域及观察合同。服务器媒体消息分成最多 16 KiB 负载的有序块：12 字节大端头分别为 magic `0x50555231`、完整帧字节数、当前偏移；随后为片段。完整帧上限 8 MiB，客户端必须校验总长、连续偏移、片段长度和 5 秒组装期限。输入只接受最多 64 KiB JSON；禁止二进制输入。分片用于传输现有 H.264/JPEG 数据，不重新编码为另一种媒体格式。

未提供 `rtc_offer` 时保留 `phone_connect({panel_id})` 的 WS/WSS 凭据和 URL 返回，兼容原客户端。每次 `view` 限制最多 8 台同作用域设备，5 秒可见性租约；每台最多一批未确认帧。组装后的二进制消息为 4 字节大端 JSON 长度、JSON 元数据、JPEG 或 H.264 包。H.264 保留关键帧、时间戳、尺寸/编码 epoch，客户端必须按顺序解码，落后时从完整关键帧恢复。输入继续由 PhoneService 校验观察和设备几何；不使用视频时间戳推断业务完成。断链/超时绝不重放动作。WebRTC 失败后尝试 WS/WSS，均不可用时使用 `phone_panel` / `phone_frame` / `phone_panel_action`；WebRTC 失败后自动重试冷却 60 秒，用户可显式重试。

0.5.2 支持配置 `preview.tls` 后使用 WSS；不配置时保留通用 MCP Apps 的 WS。两者都仅监听回环地址，CSP 只声明该进程精确 origin，资源 URI 按版本区分，同版本保持稳定以兼容宿主的工具声明缓存。`phone_panel.preview_client` 为可选的组件诊断，字段为 `version`、`state: connecting|direct|fallback`、`reason: none|csp|connect-error|handshake-timeout|closed|bootstrap|invalid-ticket|server-config`、`secure` 和 `webcodecs`。服务限制枚举和长度，只存内存中最近 128 个面板报告；`_meta.preview` 返回该面板报告，不向模型输出连接凭据。

0.6 诊断增加可选 `transport: webrtc|ws|wss|mcp` 和 `rtc_failure: none|unavailable|negotiation|connect-error|timeout|closed`。正常 WebRTC 不依赖 `preview.tls`，不修改系统信任；WSS 配置无效仍不能偷偷启动明文 WS 后备。

0.5.1 的 ticket 宣告 `features: ["per-device-video"]`。支持时，`view.video_sessions` 指定逐台 H.264 订阅，`video_failures` 只传枚举原因 `unavailable / unsupported / decode-error / timeout`；未知宿主回退旧版布尔协商。会话 `preview_client` 保存最后客户端协商结果及上报时间，不保存屏幕、输入文本或连接凭据；它表示客户端选用的解码方式，实际视频来源仍以 `observation.preview_transport` 为准。解码失败只回退对应设备，详情菜单可单独重试。

直连收到消费确认后按该设备帧率预算调度下一批，不等全局轮询；JPEG 最多约 30 FPS、原生视频单卡最多约 60 FPS / 并排约 30 FPS。这些是发送预算，实际帧率受源端、宿主解码和负载限制。原生 JPEG 不叠加 35 ms 服务缓存。按住鼠标时继续刷新；松手后使用同一显示几何与操作代次下的新观察提交手势，旋转、折叠或另一个动作会取消未提交的手势。鼠标拖动仍在松手时提交完整 swipe，不是持续 down/move/up 注入。

`observe: false` 的成功动作增加 `timing_ms: { queue, prepare, execute }`；`prepare` 含观察及几何验证，`execute` 含驱动调用和滑动时长。原生 socket 的完成只代表写入完成，不是设备已绘制结果，也不是完整输入到画面的延迟。

组件预览不是模型观察输入；模型优先 `phone_inspect` / `phone_observe_many({ screenshot: false })`，需要视觉时再请求截图。`phone_frame` 可携带 `after_id`，没有新帧时省略 `_meta.frame`。预览可能为压缩 JPEG，模型截图保持 PNG。预览和 agent 观察保留池分开，动作提交消耗两者。各会话的 `revision`、`busy`、`activity` 供组件处理异步状态和动作提示；activity 不记录输入文本。

宿主传入字符串 `_meta["openai/session"]` 时按对话绑定会话。组件后续请求以 `panel_id` 绑定相同作用域；没有对话元数据的客户端在同一 MCP 进程内共享本地作用域。当前 HTTP 服务是单用户本地服务，不是多租户网关。

图片和控件文字是设备上的内容，不是对 agent 的指令。用户授权范围、实际目标和必要的确认仍由上层 agent 工作流处理；本服务不根据屏幕上的文字扩大授权。
