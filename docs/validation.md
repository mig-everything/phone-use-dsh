# Verification

This record separates automated protocol checks, official-host integration and device observations. Passing virtual-device tests is not a claim that every phone or application has been tested.

## Public 0.9.4 release

The first public release derives from the 0.9.3 implementation and introduces distribution metadata, explicit supported DSH prerelease ranges, public installation instructions and package validation. Device action semantics remain shared by SDK, MCP and DSH. Release acceptance also found and fixed a shared-core bug: scroll regions advertised in navigation could be rejected after a small node budget or query omitted them from the control index. Advertised regions now retain native evidence separately; this does not authorize taps or text into omitted controls.

Checks on November 14, 2026, on macOS / Apple Silicon:

- Full regression: **147 passed, 0 failed, 0 skipped**, including browser, MCP, OCR and DSH protocol tests (76.9 seconds for the final run).
- Formatting, TypeScript build and bundled native artifact checks passed.
- The 0.9.4 archive passed entry-point, dependency, license, screenshot and local-file exclusion checks.
- The official **DSH 0.2.2-rc.1** runtime loaded the archive with independently installed production dependencies. It verified 14 tools, skill loading, dispatch, conversation isolation, panel reuse, session release, authenticated Fetch and disable/re-enable. No external model requests were made.
- DSH Desktop displayed the installed **0.9.4** component running. An isolated Android emulator connected through the device picker; H.264 preview and native input readiness were visible, and a tap dismissed a system dialog.
- The installed 0.9.4 core separately exercised continuous Android `down/move/up` input at 1080×2340 with a 944×2048 scrcpy stream. A fresh screenshot confirmed that the notification shade opened. This validates that device path and coordinate mapping, not the desktop mouse event path. The test session and emulator were released afterward.

The desktop drag check is **not signed off**: the initial Android 17 cold boot showed Launcher/System UI ANRs under severe host memory pressure. A later desktop attempt confirmed the updated 0.9.4 source and running component after disable/re-enable, but desktop automation continued returning `noWindowsAvailable` and inconsistent window observations. The device-backed browser integration checks below verify the shipped sidebar and DSH Fetch transport separately. They are not measurements of desktop end-to-end latency or a guaranteed frame rate.

### Release acceptance on isolated devices

The installed 0.9.4 archive was exercised through a real stdio MCP client, without model/image mocks. Tests used dedicated devices and released their leases afterward. Other occupied devices were left untouched. After an initial disk-space and memory-pressure failure, platform checks ran sequentially.

| Platform | Observed acceptance results |
| --- | --- |
| HarmonyOS 6.1.1 / API 24 | Unlock; launch Settings; native Battery navigation; cancel a login dialog; switch to Contacts; enter Chinese/English text in a draft; recognize its screenshot with bundled OCR; discard the draft; Home; scroll the About page. |
| Android 15 / API 35 | Launch Settings; focus search; enter `battery`; open the matching Battery page; return; scroll search results; stable screenshot and bundled OCR; Home. The compact-navigation regression was reproduced before the fix and passed on the updated installed archive with `max_nodes: 1` and a query. |
| iOS 27 / iPhone 16 Pro simulator | Launch Settings; focus search and enter Chinese text; close search; navigate General → About; scroll using a navigation-only region after a fresh compact inspection; stable screenshot and bundled OCR; Home; relaunch and navigate back. Screenshot pixels (1206×2622) and input points (402×874) remained aligned. |

The device-backed sidebar test mounts the shipped DSH Fetch routes in an isolated browser integration host. It waits for client input readiness, sends real mouse down/move/up, verifies that down and move reach the native channel **before** mouseup, and compares the resulting page. HarmonyOS used the bundled UiTest JPEG stream (1056×2288, 1080×2340 input); Android used H.264 (944×2048, 1080×2340 input); iOS used H.264 (1206×2622, 402×874 input). All three scrolled Settings successfully without native-channel errors. Sample server-side down submission took 463 ms on HarmonyOS, 42 ms on Android and 152 ms on iOS; these include validation and are not glass-to-glass latency measurements. HarmonyOS's default UiTest channel is not H.264. The iOS panel briefly reported 52.9 FPS; this is a sample, not a sustained benchmark.

An initial browser test sent a drag before explicitly awaiting client input readiness and recorded no native pointer events. The fixture was corrected to finish its own inspection and await readiness before starting a new gesture; subsequent checks passed. Failed or uncertain submitted actions were not automatically replayed.

Three real captured screenshots (one per platform) were also recognized concurrently by the installed bundle's cold portable OCR workers. All three returned `ok` within the default 2500 ms deadline: HarmonyOS 614 ms, Android 865 ms and iOS 787 ms, with total wall time 866 ms and peak concurrency 3. Expected Chinese/English page text was checked. This validates OCR concurrency independently of device acquisition; it is not a simultaneous three-emulator action test.

The cold iOS Springboard tree request hit WDA's 15-second deadline; a screenshot succeeded and subsequent Settings trees/actions passed. One iOS scroll attempt after a page transition correctly returned `STALE_NODE`; a fresh inspection was required. HarmonyOS screenshot settling reached its deadline when a capture itself was slow, and returned that status instead of claiming animation completion. These limits remain visible to callers.

The CI workflow is configured for the Linux full suite plus macOS/Windows portability checks on Node.js 22. Local checks do not establish a remote CI result; consult [public CI](https://github.com/mig-everything/phone-use-dsh/actions) after the source is pushed.

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
