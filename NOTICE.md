# NOTICE

本模组：**AGPL-3.0-only**。上游清单（含许可证与风险提示）见 [REFERENCES.md](./REFERENCES.md)。

## 代码来源

移植自 **NeriPlayer**（GPL-3.0）：

```
Copyright (C) 2025-2025 NeriPlayer developers
https://github.com/cwuom/NeriPlayer
```

| 本仓库 | NeriPlayer 原文件 |
| --- | --- |
| `lib/wbi.mjs` | `core/api/bili/BiliClient.kt` — `signWbiUrl` / `getOrRefreshMixinKey` / `fetchMixinKeyFromNav` / `ensureValidMixin` |
| `lib/lrc.mjs` | `core/api/lyrics/LyricTimelinePolicy.kt` |
| `lib/match.mjs` | `core/api/lyrics/LrcLibClient.kt`（清洗与归一化）+ `core/api/lyrics/ExternalLyricMatchPolicy.kt`（时长容差） |
| `providers/bilibili.mjs` | `core/api/bili/BiliClient.kt`（搜索与取流）+ `core/api/bili/BiliSongResolver.kt` |
| `providers/lyrics/lrclib.mjs` | `core/api/lyrics/LrcLibClient.kt` |

新写的、不是移植的：`lib/http.mjs`、`lib/bili-cookie.mjs`、`client.mjs`、`index.cjs`、`test/*`。

## 宿主

[Folia](https://github.com/chthollyphile/folia-major)，AGPL-3.0。

## 为什么是 AGPL-3.0

NeriPlayer 是 GPL-3.0，Folia 是 AGPL-3.0。GPLv3 §13 允许两者组合，组合后的整体必须以 AGPLv3 分发。

## 第三方库

一个都没 vendor。MD5、WBI 签名、Cookie 处理、URL 拼装全是手写的 —— 模组的 client 入口不能 import 裸模块名，装第三方库反而更麻烦。

## 不做的事

不上传用户数据；不下载执行远程代码；不读写模组目录与数据目录以外的文件；不绕过付费内容。
