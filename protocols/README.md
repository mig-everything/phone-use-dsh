# Simulator protocol provenance

`idb.proto` is the unmodified MIT-licensed protocol from
[Meta idb v1.7.3](https://github.com/facebook/idb/blob/v1.7.3/proto/idb.proto).
The license is in `idb-LICENSE`. Phone Use uses only `describe` and `hid` in its
optional simulator control connection, over a private local Unix socket.

The Android controller protocol is loaded from the user's installed Android SDK
(`emulator/lib/emulator_controller.proto`) to match that emulator version.
No Android/Huawei/Apple SDK binaries or device artwork are redistributed here.
