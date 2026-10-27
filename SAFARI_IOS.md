# iOS Safari 版构建与安装

当前仓库同时保留 Edge/Chrome 扩展和 iOS Safari Web Extension 资源。Safari 版最低要求是 iOS/iPadOS 15.4，因为本项目使用 Manifest V3 与后台 Service Worker。

## 1. 在 Windows 生成 Safari 资源包

在 PowerShell 中运行：

```powershell
.\scripts\build-safari.ps1
```

输出位于：

- `dist/safari-extension/`：供 Apple 打包器读取的扩展资源目录。
- `dist/ielts-soundalike-helper-safari-v2.9.0.zip`：可传到 Mac 或 App Store Connect 的压缩包。

该步骤只整理 Web Extension 资源，不会生成可直接安装到 iPhone 的 `.ipa`。

## 2A. 没有 Mac：通过 App Store Connect 打包（推荐）

Apple 现在支持从任意桌面浏览器上传 Safari Web Extension ZIP，不要求 Mac 或 Xcode，但需要加入 Apple Developer Program：

1. 在 App Store Connect 新建 App，平台选择 iOS，并创建唯一的 Bundle ID。
2. 打开该 App 的 Xcode Cloud 页面，在 Safari Web Extension Packager 下点击 Upload。
3. 上传 `dist/ielts-soundalike-helper-safari-v2.9.0.zip`。
4. 打包完成后通过 TestFlight 安装到自己的 iPhone 进行测试。

## 2B. 有 Mac：生成 iOS Xcode 工程

安装最新版 Xcode，解压资源包，然后在终端运行：

```bash
xcrun safari-web-extension-packager \
  --ios-only \
  --swift \
  --copy-resources \
  --app-name "听写辨音助手" \
  --bundle-identifier "com.yourname.ieltssoundalikehelper" \
  /path/to/safari-extension
```

将 `com.yourname.ieltssoundalikehelper` 换成你 Apple 开发者账号下唯一的 Bundle ID。旧版 Xcode 中工具名可能仍是 `safari-web-extension-converter`。

打开生成的 Xcode 工程后：

1. 给 iOS App 和 Safari Extension 两个 Target 选择同一个开发团队。
2. 连接 iPhone，选择真机并运行。
3. 在 iPhone 的“设置 → Safari → 扩展”中启用“听写辨音助手”。
4. 给 `ielts.itongzhuo.com` 和 `www.idictation.cn` 设置“始终允许”。

## 3. 手机界面与兼容处理

- 学习结果改为底部抽屉，适配 iPhone 安全区和 Safari 动态工具栏。
- 上下拖动红色标题栏可调整抽屉高度，关闭键保持可用。
- 手机端隐藏实体键盘快捷键提示，播放和收藏按钮扩大到触控尺寸。
- 音标、声音—字母块、复数、DeepSeek 解释和收藏继续使用原有逻辑。
- Safari 不支持 `chrome.tts`；扩展使用网页音频，并在需要时回退到 iOS 的 `speechSynthesis`。
- 爱听写的正文捕获通过 `safari-page-loader.js` 注入页面环境，避免依赖 Chromium 的 `world: MAIN` 清单字段。

## 4. 当前验证边界

Windows 可以验证 JavaScript、清单、测试和资源压缩包；Safari 打包器、代码签名、真机安装、麦克风/音频策略及实际网页交互必须在 Mac/Xcode/iPhone 上验证。首次播放仍需要用户点击，符合 iOS 的媒体自动播放限制。
