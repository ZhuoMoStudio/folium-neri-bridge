# folium-neri-bridge

把 [NeriPlayer](https://github.com/cwuom/NeriPlayer) 的 B 站音源接进 [Folia](https://github.com/chthollyphile/folia-major)。跑在 Folium 模组平台上，**只在桌面版可用**（网页版没有模组系统）。

上游议题：[chthollyphile/folia-major#440](https://github.com/chthollyphile/folia-major/issues/440)（逐字歌词透传，模组侧暂时拿不到）

## 能力

| 项 | 说明 |
| --- | --- |
| 搜索 | B 站视频搜索，WBI 签名 |
| 播放 | DASH 纯音频流，按档位挑流，带过期时间 |
| 歌词 | LRCLIB 回退。只返回带时间戳的歌词 |
| 登录 | 网页窗口 / 扫码 / 粘贴 Cookie 三种，登录态存本机 |

未登录也能搜和放，但 B 站会压低音质、会员内容拿不到。

## 装

```bash
# 在 folia-major 仓库根目录
git clone https://github.com/ZhuoMoStudio/folium-neri-bridge mods/neri-bridge
npm install && npm run dev:electron
```

设置 → 实验室 → 模组系统 开启总开关，然后在模组面板里启用本模组并确认。

## 测

```bash
npm test            # 离线：纯函数 + 契约，不联网
npm run test:live   # 真实 B 站搜索 / 取流 / LRCLIB
npm run test:cdn    # 采样两个 CDN，验防盗链策略
npm run test:login  # 扫码登录链路
```

从干净克隆跑过：54 + 17 + 66 + 17 + 10 = **164 项，0 失败**（Node 22.14，2026-09-27）。

`03-contract` 不是自己写断言，是加载 folia-major 的 `manifest.cjs` 和打桩宿主，直接跑上游代码。

## 踩过的三个坑

都写进对应文件的注释了，这里只留结论：

**1. `/x/web-interface/wbi/view` 拿不到 cid。** 对正确的 bvid 和 aid 都返回 `code: -404`，同一个 bvid 在 `/x/player/pagelist` 上正常。已改用 pagelist。

**2. B 站有两个 CDN 家族，防盗链策略不一样。**

| CDN | 带 B 站 Referer | 不带 |
| --- | --- | --- |
| `upos-sz-mirrorcosov.bilivideo.com` | 206 | **403** |
| `upos-hz-mirrorakam.akamaized.net` | 206 | 206 |

Folia 的页面来源两种都撞 403（开发 `localhost:3000`、生产 `file://`），而 `<audio>` 没法自定义请求头。所以 `index.cjs` 把 Referer 一律改写成 B 站的值。

只测一个节点会得出「不带 Referer 也行」的错误结论 —— 我第一版就是这么写错的。`test/04-cdn.mjs` 专门用来复现这件事。

**3. 纯文本歌词交出去等于没有歌词。** `parseLRC` 会丢无时间标签的行（`parserCore.ts:347`），所以拿不到同步歌词时返回 `null`，不返回纯文本。

## 登录

登录态只在主进程处理，因为 `folium.net.fetch` 拿不到可靠的 `Set-Cookie`：`modSystem.cjs:935` 把响应头归一化成普通对象，undici 会把多个 `Set-Cookie` 用逗号合并，而 cookie 的 `Expires` 自身含逗号。

三种方式：

- **网页窗口**（推荐）— 主进程开一个 BrowserWindow 指向 B 站登录页，轮询 `session.cookies` 直到出现 `SESSDATA`
- **从应用会话读取** — 如果你已经在别处用 Folia 登录过，直接认过来
- **粘贴 Cookie** — 从浏览器复制，粘进设置面板

登录后 Cookie 同时注入 CDN 请求（会员内容的流需要它）。

## 已知限制

- **逐字歌词拿不到。** Folium 的 mod provider 能力硬编码在 `omniProviders.ts:62` 的 `wordByWordLyrics: false`，`getLyrics` 只收 `{ lrc, translationLrc }`。等 #440 落地。附带影响：`chorusResolver.ts:54` 读 `wordByWordText` 判副歌，所以模组音源的歌也拿不到副歌识别。
- **WBI 只有一条密钥路径。** 原实现还有 `GenWebTicket` 兜底，本模组没做。
- **歌词匹配是简化版。** NeriPlayer 的完整策略是约 480 行评分制（`EditableLyricMatchPolicy.kt`），这里只做了归一化相等 + 艺术家包含。误匹配率会高一些。
- **B 站歌名的艺术家很弱。** 搜索只给 UP 主名，LRCLIB 的艺术家判定会打折。
- **还没在真的 Folia 里跑过。** 契约层验过（上游校验器 + 打桩宿主），但 `webRequest` 的实际行为和 `<audio>` 播放要在装了 Folia 的机器上确认。

## 上架

不用 fork。按 Folium 规范，模组放自己仓库、去 [folium-compound](https://github.com/chthollyphile/folium-compound) 开 issue 就行。还缺：

- [ ] `preview.png`（1280×720，<1MB）
- [ ] `LICENSE` 全文

## 合规

本模组走 B 站非公开接口。不绕过付费内容，不分发音频，只把用户自己账号权限内的地址交给播放器。使用者自行承担合规责任。

注意：`SocialSisterYi/bilibili-API-collect` 已于 2026-01-28 收到律师函后永久关停，指控是「系统性收集并向公众传播非公开 API 的认证机制」。本仓库不复制它的内容，但确实公开了一份 WBI 实现。详见 [REFERENCES.md](./REFERENCES.md)。

## 许可

AGPL-3.0-only。代码移植自 NeriPlayer（GPL-3.0）、运行在 Folia（AGPL-3.0）内，按 GPLv3 §13 组合后整体取 AGPLv3。逐文件对照见 [NOTICE.md](./NOTICE.md)，上游清单见 [REFERENCES.md](./REFERENCES.md)。
