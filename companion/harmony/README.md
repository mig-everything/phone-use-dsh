# 鸿蒙屏幕采集伴随应用

Phone Use Capture 是可选的设备端投屏组件，不包含模型。控制仍由主机的 HDC / UITest 提供；不安装本 HAP 也能使用截图、控件树和基础操作。

本项目使用公开的 AVScreenCapture C API（最低 API 12），通过系统授权弹窗启动视频采集，不录制麦克风或系统声音。默认仅在设备回环地址监听；HDC 转发后电脑可读取画面。H.264 编码器通过 Surface 接收画面，配置长边最多 2560、30 FPS、12 Mbps。0.4 增加带边界/时间戳/关键帧信息的直传协议，浏览器直接解码，不转 JPEG。无编码器时尝试原始 RGBA 回调，由主机 FFmpeg 转成兼容帧。仅保留有限的内存缓冲，不保存录像。

## 当前验证范围

- DevEco Studio 6.24.2 工具链、HarmonyOS 6.1.1 / API 24 SDK：ArkTS 和 ARM64 C++ 编译通过，生成 HAP。
- HarmonyOS 6.0 / API 22 Mate X5 模拟器：安装、启动、授权弹窗通过；编码器创建失败，原始回调也未出帧。**这台镜像尚不能提供连续视频，主机继续使用截图预览。** 无帧连接在 5 秒后停止并显示原因。
- 真机视频、HarmonyOS 5 / 7：待设备验证；最低 API 声明不等于全版本验证。
- 横竖屏/折叠导致尺寸变化时停止采集，用户重新开始；连续视频跨姿态切换尚未实现。

## 构建与安装

用 DevEco Studio 打开本目录，选择已安装的 API 24 SDK，执行 Sync 和 Build Hap(s)。最低兼容版本为 5.0.0 / API 12。本仓库不包含签名凭据。

本机 macOS 命令行示例（工具目录因安装位置而异）：

```sh
cd companion/harmony
/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin/ohpm install
/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw --mode module -p product=default -p module=entry@default assembleHap --no-daemon
hdc -t <connect-key> install entry/build/default/outputs/default/entry-default-unsigned.hap
hdc -t <connect-key> shell aa start -b dev.phoneuse.capture -a EntryAbility
```

需要 SDK 路径时在本目录的 `local.properties` 中设置 `sdk.dir`，例如 `/Applications/DevEco-Studio.app/Contents/sdk`；该文件已忽略。测试模拟器接受未签名开发包。真机请在 DevEco Studio 为自己的应用和测试设备配置签名后安装 signed HAP，不能直接套用模拟器的安装结果。

## 连接主机

```sh
hdc -t <connect-key> fport tcp:27184 tcp:27183
```

在应用里点击“开始投屏”，确认系统屏幕共享弹窗。把连接码放入本机私有配置，不提交到 Git 或聊天：

```json
{
  "harmony": {
    "enabled": true,
    "video": {
      "ffmpeg": "/absolute/path/to/ffmpeg",
      "devices": [{
        "deviceId": "harmonyos:<connect-key>",
        "url": "http://127.0.0.1:27184/stream",
        "token": "<应用显示的连接码>"
      }]
    }
  }
}
```

每台设备使用独立的主机转发端口、设备 ID 和连接码。`GET /stream` 接收 `Authorization: Bearer <code>`，响应为 H.264，或带 `X-Frame-Width/Height` 的 RGBA；`GET /status` 使用相同认证。当前每台设备只提供一个视频消费者，状态查询请在视频连接前进行。连接码每次应用进程启动重新生成。

0.4 主机自动优先请求 `/stream-framed`，认证与 `/stream` 相同，Content-Type 为 `application/x-phone-use-h264`。负载为 `h264` 四字节、12 字节尺寸头和带长度/PTS/配置/关键帧标记的编码包（沿用 scrcpy 4.x 视频包格式）；无需修改上述配置 URL。旧 companion、无编码器或浏览器解码不可用时回退 `/stream` / 截图。新协议已编译并通过主机解析/真实浏览器解码测试，但鸿蒙设备出帧仍需真机验证。编码上限不代表可达到的用户预览 FPS。

真机可通过 USB 转发使用同一接口。需要 LAN 时，先在应用勾选“允许局域网连接”，并在该设备配置设置 `allowRemote: true`、填写设备 IP。此开发通道为明文 HTTP，推荐 USB；跨网络连接应通过受信任的加密隧道。录屏授权不授予跨应用点击权限，控制仍需要已授权的 HDC。

主机隐藏预览超过 5 秒会断开视频；设备在消费者离开后 10 秒停止采集，首次等待连接最多 60 秒。系统取消、来电打断、用户停止会异步释放资源。不要自动批准或绕过系统录屏弹窗。

公开 API 依据：[录屏取码流流程](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/media/media/avscreencapture-c-basic-process.md)、[AVScreenCapture API](https://developer.huawei.com/consumer/en/doc/harmonyos-references-V13/native__avscreen__capture_8h-V13)。
