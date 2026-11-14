# Phone Use for DeepSeek Harness

Agent tools and a multi-device sidebar for connected HarmonyOS, Android and iPhone devices. Uses the shared device core in this repository.

Install the prebuilt GitHub Release, which includes the compiled core and client:

```sh
dsh plugin --profile desktop add --save-exact --ignore-scripts https://github.com/mig-everything/phone-use-dsh/releases/latest/download/phone-use-dsh.tgz
```

Refresh the plugin list, enable Phone Use and confirm the component is running. Open **Phone Use ▾** in a conversation header to add a device. The agent tools also work without opening the sidebar.

This source directory is a packaging input, not a complete installation. From the repository root, run `npm ci`, `npm run package:dsh`, then install the generated archive. The package is not published to npm.

- [中文安装与设备配置](https://github.com/mig-everything/phone-use-dsh/blob/main/docs/dsh.md)
- [Requirements and capabilities](https://github.com/mig-everything/phone-use-dsh#readme)
- [Verification and limits](https://github.com/mig-everything/phone-use-dsh/blob/main/docs/validation.md)

Storefront images show synthetic demo devices in a browser test host. They do not represent real phones or an actual DSH desktop screenshot.
