# iOS Simulator input bridge

Small macOS Objective-C++ helper using the installed Xcode/CoreSimulator and the
runtime's DTUHID service. It sends touch events over a private stdio pipe and XPC;
it does not install an app in the simulator, open a network listener, or require
Java/Python. Signing and real iPhone control remain with WDA.

`npm run build:ios-input` produces the signed universal macOS binary and SHA-256
manifest. `npm run check:native` checks both architectures and the source digest.
End users use the bundled artifact and do not need to compile it.

Configure `simulator.nativeInput: true` and `simulator.inputBridge: "bundled"`.
The initial liveness probe confirms the exact booted UDID without injecting a
keypress. Current support is the portrait main display whose point dimensions
match the displayed WDA viewport. Other rotations/dimensions use WDA; ongoing
touches are cancelled when geometry changes. Wider display/rotation support
needs separate validation rather than guessed coordinate transforms.

Unlike the idb HID RPC, this bridge preserves the touch's origin-edge flag on
every move and release. Bottom, top, left and right edge gestures retain their
normal OS meaning. A swipe is never translated into a hardcoded Home command.
Acknowledgements mean events were submitted to XPC, not that an app reached a
particular state. Callers must observe outcomes when that distinction matters.

Input is bounded, sequence checked, and tied to one connection. Stdin EOF,
termination, pointer inactivity and explicit cancellation release the finger.
An interrupted submission is uncertain and must not be replayed via WDA.

The protocol models and private API signatures were studied from Meta idb
[v1.7.8](https://github.com/meta/idb/tree/v1.7.8/FBSimulatorControl/HID), including
`DTUHIDModels.swift`, `SimulatorDTUHIDConnection.swift`, `SimulatorHIDTypes.swift`
and `SimulatorXPCConnection.swift`. Their MIT license is retained in
[LICENSE.Meta](LICENSE.Meta). Apple frameworks are loaded from the installed
developer environment and are not redistributed.
