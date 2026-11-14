# Verification

This record separates automated protocol checks, official-host integration and device observations. Passing virtual-device tests is not a claim that every phone or application has been tested.

## Public 0.9.4 release

The first public release derives from the 0.9.3 implementation and introduces distribution metadata, explicit supported DSH prerelease ranges, public installation instructions and package validation. Device action semantics remain shared by SDK, MCP and DSH.

Checks on November 14, 2026, on macOS / Apple Silicon:

- Full regression: **146 passed, 0 failed, 0 skipped**, including browser, MCP, OCR and DSH protocol tests.
- Formatting, TypeScript build and bundled native artifact checks passed.
- The 0.9.4 archive passed entry-point, dependency, license, screenshot and local-file exclusion checks.
- The official **DSH 0.2.2-rc.1** runtime loaded the archive with independently installed production dependencies. It verified 14 tools, skill loading, dispatch, conversation isolation, panel reuse, session release, authenticated Fetch and disable/re-enable. No external model requests were made.
- DSH Desktop displayed the installed **0.9.4** component running. An isolated Android emulator connected through the device picker; H.264 preview and native input readiness were visible, and a tap dismissed a system dialog.

The desktop drag check is **not signed off**: the cold-booted emulator showed Launcher/System UI ANRs, a fallback gesture reported about 6.2 seconds of queue time, and desktop automation repeatedly returned `noWindowsAvailable`. These observations do not establish smooth dragging or a fixed frame rate. Protocol/browser input regressions passed separately. Do not interpret those tests as a desktop performance measurement.

CI runs the Linux full suite plus macOS/Windows portability checks on Node.js 22. See the [public CI results](https://github.com/mig-everything/phone-use-dsh/actions).

## Automated coverage

- Coordinates: screenshot pixels versus native input units; scaled Android video, codec alignment, edges, rotation and changed displays.
- Connection lifetime: readiness agrees with submission checks; old fingers cannot migrate to replacement sockets; uncertain actions are not replayed.
- Control actions: partially visible nodes use the visible intersection; fully offscreen nodes are rejected; focus and stale observations are rechecked.
- Standard MCP without UI: discovery, open, tree lookup, tap, text, screenshot, swipe, Home, stale observation rejection and close.
- DSH: tool/skill registration, conversation isolation, read-only input policy, image attachments, a single reusable panel, authenticated Fetch transport, enable/disable cleanup and browser pointer gestures.
- OCR: local bilingual models, concurrency, worker failure, deadlines and platform fallback behavior.
- Distribution: compiled entries, matching versions, production-only installation, native binary/source checksums, retained upstream notices and excluded local files.

## Recorded device observations

These are prior development observations, not new measurements of the public package unless explicitly stated.

| Environment | Observed behavior | Scope |
| --- | --- | --- |
| HarmonyOS 6.1 / API 24 emulator | HDC/UiTest tree, screenshot, launch and input; bundled UiTest bridge preview/control | HarmonyOS 5/7 and physical devices need separate checks |
| HarmonyOS 6 / API 22 foldable emulator | Expanded display, tree, screenshot, launch and Chinese input | Physical folding and all display transitions were not verified |
| Android 17 emulator | Headless MCP Settings search, text entry, Battery navigation and Home | Native tree export can take several seconds |
| Android scaled scrcpy stream | 1080×2340 input with 944×2048 H.264; continuous down/move/up opened the notification shade | Confirms coordinate mapping, not end-to-end latency or DSH desktop mouse behavior |
| Xcode 27 / iOS 27 simulator | WDA tree/focused text and bundled native portrait input, including bottom-edge Home gesture | Other orientations, Xcode versions and iPhone hardware need separate checks |

Earlier desktop observations also confirmed iOS H.264 preview. Those observations used a prior development build, not the public 0.9.4 archive.

## Limits

- Acknowledgement means an action was submitted. It does not establish that an app reached the intended business state. Follow-up observations are separate, and a failed follow-up does not replay the action.
- Android ADB text currently supports ASCII. Control-tree export and fallback ADB/UiTest/WDA operations can be slow; MCP does not remove driver latency.
- Continuous manual touch requires a verified native channel. The fallback is a complete gesture, not continuous pointer streaming.
- Multi-device batches are bounded concurrency with separate results, not atomic transactions or exact synchronization.
- Screenshots in the storefront use synthetic demo devices in a browser test host and are labeled accordingly. They are not evidence of physical-device support.
- Physical phones, HarmonyOS 5/7, and broad app/device compatibility are not yet comprehensively validated.

See [public CI](https://github.com/mig-everything/phone-use-dsh/actions), [device setup](setup.md), and [native helpers](../native) for implementation and reproducible setup.
