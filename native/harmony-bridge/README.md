# HarmonyOS UiTest extension

Phone Use ships `bin/phone-use-aarch64.so` and `bin/phone-use-x86_64.so`. These are device binaries, not host libraries. End users need the HDC connection and the device's built-in UiTest extension support; no host C++ compiler, Java runtime or SDK JAR is loaded.

The bridge uses UiTest `startCapture("copyScreen")` and `atomicTouch`, plus public NativeDisplayManager and OH_Input APIs. It sends bounded latest-only JPEG frames and acknowledged input over an authenticated abstract socket forwarded by HDC. It does not encode H.264. UiTest's capture implementation determines the achievable frame rate. This build has been exercised on the local HarmonyOS API 24 emulator; HarmonyOS 5/7, x86_64 execution and physical devices need separate compatibility verification.

Build both device architectures using the existing HarmonyOS native SDK:

```sh
PHONE_USE_NATIVE_SDK=/path/to/openharmony/native npm run build:harmony-bridge
npm run check:native
```

Build outputs include SHA-256 hashes. The loader uses content-addressed filenames rather than a shared `agent.so`; it removes only its own forwarding rule. It honors HMBot's capture/manual-input ownership sockets. Each input carries the current native display epoch; rotation, resize and fold-display changes invalidate it and release a held finger. Uncertain inputs are never replayed through CLI commands.

`phone_use.cpp` is derived from the MIT-licensed HMBot device bridge in `hmbot_dsh/native/device-bridge/hmbot_device.cpp`, with protocol, lifecycle, geometry and input-acknowledgment changes for Phone Use. See LICENSE.HMBot. `extension_c_api.h` comes from OpenHarmony arkxtest (line endings normalized, declarations unchanged), licensed under Apache-2.0; see LICENSE.OpenHarmony and https://github.com/openharmony/testfwk_arkxtest/tree/master/uitest/addon.

Native SDK artifacts are not redistributed. Device model artwork is also read from local SDKs rather than included here.
