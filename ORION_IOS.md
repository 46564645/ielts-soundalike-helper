# Orion（iPhone / iPad）安装与打包

Orion 使用标准 WebExtensions 接口，不支持 Safari 专有扩展格式。手机端请安装本文件对应的 **Orion 包**，不要安装 `ielts-soundalike-helper-safari-*.zip`。

## 1. 打包

在仓库根目录运行：

```bash
./scripts/build-orion.sh
```

输出：

- `dist/orion-extension/`：可直接作为文件夹加载的扩展资源。
- `dist/ielts-soundalike-helper-orion-v2.11.1.zip`：通过 Orion 的“文件安装”入口导入。

## 2. 在 Orion iOS 安装

1. 打开 Orion，点右下角 `•••` → **Settings**，在 **Extensions** 分组中打开 Chrome 扩展支持。
2. 回到页面，点 `•••` → **Extensions**。
3. 点 **+**，选择 **file-based extension**，选中 `ielts-soundalike-helper-orion-v2.11.1.zip`。
4. 在扩展列表中启用“听写辨音助手”。
5. 打开 `https://ielts.itongzhuo.com/...` 与 `https://www.idictation.cn/home`，在 Orion 的网站设置里把该扩展设为允许运行。

安装后刷新练习页。第一题判题出现辨音面板后，页面右下会出现 36px 小喇叭；点击播放当前词，拖动可换位置。

## 3. Orion 上的降级行为

Orion iOS 的后台 Service Worker、`tabs`、`storage.sync` 支持并不完整，扩展会自动降级：

- **后台不可用**：小喇叭直接播放网页下发的原始音频地址，发音功能不受影响；30 题会话缓存降级为“边用边取”，不再预下载。
- **没有 `sender.tab`**：会话仍然创建，按 6 小时上限自动过期，不再依赖关闭标签页清理。
- **没有 `storage.sync`**：开关和口音设置自动改用本地存储，功能一致。
- **没有 `tabs` API**：音标收藏页入口会提示“当前浏览器不支持打开扩展标签页”，其余功能正常。
- **网页脚本注入被 CSP 拦截**：页面根节点会带 `data-ielts-audio-bridge-injection-error="yes"`，此时只能手动使用辨音面板，无法监听网页自身的播放。

## 4. 与 Safari 包的区别

| | Orion 包 | Safari 包 |
| --- | --- | --- |
| 扩展格式 | 标准 WebExtensions（MV3） | Safari Web Extension |
| 安装方式 | Orion 扩展列表 → 文件安装 | Xcode / App Store Connect 打包 |
| 主世界脚本 | `safari-page-loader.js` 注入 | 同左 |
| 权限 | `storage`、`activeTab` | `storage`、`unlimitedStorage`、`activeTab`、`tabs` |

## 5. 排查

- 小喇叭一直灰色：确认当前是 `/home` 练习页，并等网页队列加载完成；换题后再看状态。
- 完全没有小喇叭：确认扩展已在 Orion 中启用，且当前网站允许该扩展运行。
- 播放无声：Orion 可能拦截了自动播放，先点一下小喇叭再试；仍无声时检查网页本身能否播放。
