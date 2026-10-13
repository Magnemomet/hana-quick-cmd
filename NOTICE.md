# 第三方组件说明

## Hana 官方 App SDK（随包分发）

本应用随包携带 Hana 官方 App SDK 分发件，用于与宿主通信和页面引导：

- `sdk/` — 服务端契约与运行时类型（`@hana/app-sdk` 分发件）
- `ui/assets/sdk.js` — iframe 侧 SDK（页面就绪握手、输入面板桥接等）

这两个目录由 Hana 官方 SDK 分发，不随本应用修改。它们按 Hana 自身的许可分发；本应用的 MIT 许可仅覆盖本应用自己的代码（`index.js`、`lib/`、`ui/` 下本应用编写的文件）。

## 参考资料

应用骨架（manifest 结构、页面引导与 `app-api` 调用约定、`session/input` 钩子改写用户输入的用法）参考了本机已安装的官方应用 `prompt-studio` 与 `hana-preset` 的公开实现方式。
