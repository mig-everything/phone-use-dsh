# Android device server

`scrcpy-server-v4.0` is the unmodified upstream Genymobile scrcpy 4.0 device artifact (Apache-2.0, see LICENSE).

- Source: https://github.com/Genymobile/scrcpy/tree/v4.0/server
- Release: https://github.com/Genymobile/scrcpy/releases/tag/v4.0
- SHA-256: `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a`
- Size: 732226 bytes. DEX bytecode runs through Android's existing `app_process`; no desktop Java runtime, scrcpy executable or APK installation is required.

Phone Use pushes it to a unique `/data/local/tmp` path using the user's authorized ADB connection, owns a private forwarding socket, and removes only its own file/forward on shutdown. H.264 is encoded by Android MediaCodec and forwarded to WebCodecs. The snapshot compatibility decoder may optionally use ffmpeg; H.264 passthrough does not.

The protocol is pinned to 4.0; newer upstream releases are not silently substituted. Maintainers can retrieve this exact release with `gh release download v4.0 --repo Genymobile/scrcpy --pattern scrcpy-server-v4.0 --dir native/android-server`, then run `npm run check:native`. Upstream source includes its reproducible build instructions. Android Emulator gRPC remains the preferred configured simulator backend.
