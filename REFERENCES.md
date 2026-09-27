# 上游清单

只有第一类会带来许可证义务。

- **A 代码来源** — 本仓库有文件是它的移植
- **B 对照** — 只读文档、只看行为，没复制代码
- **C 生态** — 不在仓库里，理解上下文需要

本仓库自身：**AGPL-3.0-only**。

## A 代码来源

| 项目 | 许可 | 移植了什么 |
| --- | --- | --- |
| [cwuom/NeriPlayer](https://github.com/cwuom/NeriPlayer) ★3561 | GPL-3.0 | `lib/wbi.mjs`、`lib/lrc.mjs`、`lib/match.mjs`、`providers/bilibili.mjs`、`providers/lyrics/lrclib.mjs` |

逐文件对照在 [NOTICE.md](./NOTICE.md)。`lib/http.mjs`、`lib/bili-cookie.mjs`、`client.mjs`、`index.cjs`、`test/*` 是新写的，不是移植。

## B 对照

### B 站

| 项目 | 许可 | ★ | 用途 |
| --- | --- | --- | --- |
| [public-clis/bilibili-cli](https://github.com/public-clis/bilibili-cli) | Apache-2.0 | 1055 | **2026-08 扫码响应改版的情报来源**：`data.url` 从「带 cookie 查询串」变成 crossDomain 票据链接，cookie 改由 `Set-Cookie` 下发。只解析查询串的实现会「报成功但存到空凭据」 |
| [Nemo2011/bilibili-api](https://github.com/Nemo2011/bilibili-api) | 未声明 | 4173 | Python 版 B 站 API，接口形状对照 |
| [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | ⚠️ **已关停** | 20202 | 见下方专节 |

### 歌词

| 项目 | 许可 | ★ | 用途 |
| --- | --- | --- | --- |
| [amll-dev/amll-ttml-db](https://github.com/amll-dev/amll-ttml-db) | **CC0-1.0** | 424 | 逐字 TTML 歌词库。CC0 意味着可以随便用，但它要的不是 LRC，得靠 [#440](https://github.com/chthollyphile/folia-major/issues/440) 之后才有意义 |
| [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC) | GPL-3.0 | 1800 | 多平台歌词匹配，手动匹配的交互参考 |
| [tranxuanthang/lrcget](https://github.com/tranxuanthang/lrcget) | MIT | 3204 | LRCLIB 客户端，看它怎么处理匹配与降级 |
| [WXRIW/Lyricify-App](https://github.com/WXRIW/Lyricify-App) | 未声明 | 7263 | Windows 歌词工具，逐字渲染参考 |

### YouTube

| 项目 | 许可 | ★ | 用途 |
| --- | --- | --- | --- |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | 193793 | 客户端模拟的通用参考 |
| [yt-dlp/ejs](https://github.com/yt-dlp/ejs) | Unlicense | 455 | yt-dlp 的外部 JS 签名求解。官方仓库是 `yt-dlp/ejs`，`MorpheApp/ejs`（★2）是同名副本 |
| [sigma67/ytmusicapi](https://github.com/sigma67/ytmusicapi) | MIT | 3029 | **登录方式的主要参考**：只支持 cookie 认证，需要 `__Secure-3PAPISID` / `SAPISID` / `__Secure-1PSID`，并据此构造 `SAPISIDHASH` 授权头；cookie 会轮换，要从未轮换的会话里导出 |
| [maxrave-dev/SimpMusic](https://github.com/maxrave-dev/SimpMusic) | GPL-3.0 | 11510 | Kotlin 版 YouTube Music 客户端 |
| [TeamNewPipe/NewPipe](https://github.com/TeamNewPipe/NewPipe) | GPL-3.0 | 39789 | 免 PO Token 的匿名播放路线 |
| [MetrolistGroup/Metrolist](https://github.com/MetrolistGroup/Metrolist) | GPL-3.0 | 13024 | 同上，Android |

### 其它

| 项目 | 许可 | ★ | 用途 |
| --- | --- | --- | --- |
| [chaunsin/netease-cloud-music](https://github.com/chaunsin/netease-cloud-music) | MIT | 399 | 网易云接口参考（本项目没移植网易云） |
| [music-assistant/server](https://github.com/music-assistant/server) | Apache-2.0 | 3113 | 多源聚合的登录/降级设计参考 |

## C 生态

| 项目 | 许可 | ★ | 位置 |
| --- | --- | --- | --- |
| [6xingyv/accompanist-lyrics-ui](https://github.com/6xingyv/accompanist-lyrics-ui) | Apache-2.0 | 152 | NeriPlayer 的逐字歌词组件 |
| [6xingyv/accompanist-lyrics-core](https://github.com/6xingyv/accompanist-lyrics-core) | Apache-2.0 | 48 | 上一条的解析库 |
| [cwuom/accompanist-lyrics-ui](https://github.com/cwuom/accompanist-lyrics-ui) | Apache-2.0 | 0 | NeriPlayer 实际编译的 fork |
| [amll-dev/applemusic-like-lyrics](https://github.com/amll-dev/applemusic-like-lyrics) | AGPL-3.0 | 2146 | 上面两套的源头。TTML 逐字歌词的规范来源，与 Folia 同为 AGPL |
| [ReChronoRain/HyperCeiler](https://github.com/ReChronoRain/HyperCeiler) | AGPL-3.0 | 5445 | NeriPlayer 的界面灵感来源，与本仓库无关 |

## ⚠️ bilibili-API-collect 已关停

仓库现在只剩一份 README：

> 2026年1月28日，本仓库维护者收到 B 站委托的律师事务所发律师函警告邮件，指控本仓库中的项目存在「通过技术手段对哔哩哔哩平台非公开的 API 接口及其调用逻辑、参数结构、访问控制及安全认证机制进行系统性收集、整理，并以技术文档、代码示例等形式向不特定公众传播」的侵权行为。即日起停止维护并删除相关文档及源代码。

三点：

1. 不再把它列为参考来源。
2. 被指控的是**系统性收集 + 向公众传播认证机制**，与「使用 API」不是一回事。本仓库不复制它的内容，但**确实公开了一份 WBI 实现**，这点不掩饰。
3. 参照尺度：NeriPlayer（3561★）与 Folia（3096★）都在公开仓库里发布了同类实现，本仓库是其中最小的。

要降低暴露面，可选：把 B 站支持移出公开仓库改为本地构建；或只保留 LRCLIB / AMLL / 酷狗这些没有这类风险的源。

## 兼容性

| 来源 | 能否吸收进本仓库 |
| --- | --- |
| GPL-3.0 / AGPL-3.0 | ✅ GPLv3 §13 允许组合，整体按 AGPLv3 |
| Apache-2.0 / MIT / Unlicense / CC0 | ✅ 保留声明即可 |
| 未声明许可 | ⚠️ 只当文档看，不复制代码 |
| 非商业许可 | ❌ 未引入任何此类内容 |

核对于 2026-09-27。
