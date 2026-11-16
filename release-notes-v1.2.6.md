# 云上会议 v1.2.6 · 修复开机自启开关失灵

## 🐛 修复：点「开机自动启动」没反应、自动弹回关闭

- 根因：v1.2.5 调用 Electron 的 `setLoginItemSettings` 时多传了 `name` 参数（该参数是 macOS 专用的），在 Windows 上会导致注册表写入静默失败——界面回读不到开关状态，自动弹回关闭
- 已去掉该参数，打包版实测：开启→注册表写入成功、回读 true；关闭→清除成功、回读 false
- 自检钩子（CM_TEST_AUTOSTART）固化该场景，防止回归

## 安装

下载 `CloudMeeting-Setup-1.2.6.exe` 安装即可；已装旧版的直接覆盖安装，数据保留。
