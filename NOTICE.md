# NOTICE

## 本模组的许可证

**AGPL-3.0-only**

## 代码来源

本模组的音源与歌词源实现移植自 **NeriPlayer**，授权 **GPL-3.0**：

```
Copyright (C) 2025-2025 NeriPlayer developers
https://github.com/cwuom/NeriPlayer
```

逐文件对照：

| 本仓库 | NeriPlayer 原文件 |
| --- | --- |
| `lib/wbi.mjs` | `app/src/main/java/moe/ouom/neriplayer/core/api/bili/BiliClient.kt`（`signWbiUrl` / `getOrRefreshMixinKey` / `fetchMixinKeyFromNav` / `ensureValidMixin`） |
| `lib/lrc.mjs` | `app/src/main/java/moe/ouom/neriplayer/core/api/lyrics/LyricTimelinePolicy.kt` |
| `lib/match.mjs` | `app/src/main/java/moe/ouom/neriplayer/core/api/lyrics/LrcLibClient.kt`（清洗/归一化部分）、`core/api/lyrics/ExternalLyricMatchPolicy.kt`（时长容差） |
| `providers/bilibili.mjs` | `core/api/bili/BiliClient.kt`（搜索 / 取流）、`core/api/bili/BiliSongResolver.kt` |
| `providers/lyrics/lrclib.mjs` | `core/api/lyrics/LrcLibClient.kt` |
| `lib/http.mjs` / `client.mjs` | 新写的 Folium 适配层，不是移植 |

## 宿主

本模组运行在 **Folia**（AGPL-3.0）的 Folium 模组平台上：

```
https://github.com/chthollyphile/folia-major
```

## 许可兼容性说明

NeriPlayer 是 GPL-3.0，Folia 是 AGPL-3.0。GPLv3 §13 允许将 GPLv3 作品与 AGPLv3 作品组合，组合后的整体必须以 AGPLv3 分发。因此本模组选择 AGPL-3.0-only。

## 第三方资源

目前没有 vendor 任何第三方库（所有依赖都是手写的：MD5、WBI 签名、URL 处理）。若日后为了逐字歌词或 Pixi 渲染引入第三方库，请把它的 ESM 构建放进 `vendor/` 并附上它的许可证文件。

## 不做的事

- 不上传用户数据；
- 不下载并执行远程代码；
- 不读写模组目录与数据目录以外的文件；
- 不绕过付费内容：音源返回的是用户自己账号权限内的地址，与在浏览器里打开 B 站播放是同一回事。
