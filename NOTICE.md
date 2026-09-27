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
| `lib/wbi.mjs` | `core/api/bili/BiliClient.kt` — `signWbiUrl` / `getOrRefreshMixinKey` / `fetchMixinKey` / `fetchMixinKeyFromNav` / `fetchMixinKeyFromTicket` / `ensureValidMixin` / `webTicketHmacSha256Hex` |
| `lib/lrc.mjs` | `core/api/lyrics/LyricTimelinePolicy.kt` |
| `lib/match.mjs` | `core/api/lyrics/LrcLibClient.kt`（清洗与归一化）+ `core/api/lyrics/ExternalLyricMatchPolicy.kt`（时长容差） |
| `lib/lyric-match.mjs` | `core/api/lyrics/EditableLyricMatchPolicy.kt`（评分制；两处外围件 — 繁→简转换、拼音模糊匹配 — 做成可注入，默认恒等 / token 重合度） |
| `providers/bilibili.mjs` | `core/api/bili/BiliClient.kt`（搜索、WBI、取流、用户元数据）+ `core/api/bili/BiliSongResolver.kt` |
| `providers/lyrics/lrclib.mjs` | `core/api/lyrics/LrcLibClient.kt` |

## 语义参照

`lib/ttml.mjs` 与 `providers/lyrics/amll.mjs` 是**照着 [Folia](https://github.com/chthollyphile/folia-major) 自己的实现写的**，不是独立发明：

| 本仓库 | Folia 原文件 | 参照了什么 |
| --- | --- | --- |
| `lib/ttml.mjs` | `src/utils/lyrics/ttmlConversion.ts` | 相邻 syllable 合成 word 的规则（拉丁片段合、CJK 不合）、`endsWithSpace` 的语义 |
| `lib/ttml.mjs` | `src/utils/lyrics/enhancedLrcSerializer.ts` | `words` 拼接 === `fullText` 这条不变量（决定空格落在哪个词上） |
| `providers/lyrics/amll.mjs` | `src/utils/lyrics/providers/amllDbProvider.ts` | TTDB 服务的 URL 形状与 `?format=ttml` 参数 |
| `lib/word-timing.mjs`、`client.mjs` 的钩子 | `src/mods/folium/events.ts`、`dto.ts`、`experimental.ts` | `ASYNC_TIMEOUT_MS = 1500` 这个预算，以及 `fromFoliumLines` 会重建行（`renderHints` 由宿主重算） |

Folia 是 AGPL-3.0，与本仓库同一许可族，组合没有额外义务。这里是「照语义重写」而不是逐行复制 —— 模组的 client 入口不能 import 裸模块名，也拿不到宿主的打包产物。

## 新写的（不是移植）

`lib/http.mjs`、`lib/bili-cookie.mjs`、`lib/artist-candidates.mjs`、`lib/amll-index.mjs`、`lib/lyric-align.mjs`、`lib/word-timing.mjs`、`lib/ttml.mjs`、`providers/youtube.mjs`、`client.mjs`、`index.cjs`、`test/*`。

## 宿主

[Folia](https://github.com/chthollyphile/folia-major)，AGPL-3.0。

## 数据来源

[AMLL TTML DB](https://github.com/amll-dev/amll-ttml-db)，**CC0-1.0**（公有领域奉献）。本模组在运行时从它拉索引与 TTML 原文，不 vendor 任何歌词文件。

## 为什么是 AGPL-3.0

NeriPlayer 是 GPL-3.0，Folia 是 AGPL-3.0。GPLv3 §13 允许两者组合，组合后的整体必须以 AGPLv3 分发。

## 第三方库

一个都没 vendor。MD5、WBI 签名、Cookie 处理、TTML 解析、XML 树、URL 拼装全是手写的 —— 模组的 client 入口不能 import 裸模块名，装第三方库反而更麻烦。HMAC 用运行时的 WebCrypto（`crypto.subtle`）。

## 不做的事

不上传用户数据；不下载执行远程代码；不读写模组目录与数据目录以外的文件；不绕过付费内容；不在日志里打印 cookie（有 `redactCookie`，用它）。
