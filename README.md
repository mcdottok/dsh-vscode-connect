# DSH VS Code Connect

[简体中文](README.md) | [English](README.en.md)

让 DeepSeek Harness / DSH Desktop 与 VS Code 中的 DSH 扩展连接，在编辑器中接续同一会话。

## 安装即连接

1. 在 DSH 桌面端的插件安装入口安装本插件的 `.tgz`，启用插件并保持桌面端运行。首次安装默认开启 **VS Code 连接**。
2. 在 VS Code 中安装配套的 DSH 扩展，打开并信任项目文件夹。
3. Windows 同机环境下自动发现并连接；选择同一工作区和已有会话，即可继续开发。

无需开启桌面端浏览器访问，也无需切换桌面布局。曾手动关闭连接的设置会保留，可在 **设置 → 通用设置 → VS Code 连接** 重新开启。

## 手动连接与管理

其他平台、远程环境或自动连接不可用时，在上述入口点击 **复制连接地址**，然后在 VS Code 执行 **DSH: Connect to Desktop / 连接桌面端**。已有手动配置优先于自动发现。

连接地址含凭据，请勿分享。自动连接当前仅支持 Windows 本机，凭据由 Windows 账户加密与 VS Code SecretStorage 保护。关闭连接开关会停止专用连接和自动发现。

## 开发与兼容

```powershell
npm ci --ignore-scripts
npm test
```

Windows 可运行 `.\build.cmd` 构建并打包到 `artifacts/`。独立命令为 `npm run build`，然后创建 `artifacts/` 并运行 `npm pack --ignore-scripts --pack-destination artifacts`。构建不需要旁边的扩展仓库。

兼容声明以 `package.json` 的 `engines.dsh` 为准；声明的内核版本不等于全部现场交互均已验收。见[更新日志](CHANGELOG.md)、[贡献指南](CONTRIBUTING.md)和[生命周期检查记录](reviews/memory-lifecycle.md)。

## 许可

MIT。DeepSeek 派生代码及依赖署名见 [第三方声明](THIRD_PARTY_NOTICES.txt)。本项目由社区独立维护。
