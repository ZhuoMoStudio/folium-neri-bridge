# folium-neri-bridge

把 [NeriPlayer](https://github.com/cwuom/NeriPlayer) 的 B 站音源接进 [Folia](https://github.com/chthollyphile/folia-major)。跑在 Folium 模组平台上，**只在桌面版可用**（网页版没有模组系统）。

上游议题：[chthollyphile/folia-major#440](https://github.com/chthollyphile/folia-major/issues/440)（逐字歌词透传。**本模组不等它** —— 走 `omni.hooks` 自己装，见下）

## 能力

| 项 | 说明 |
| --- | --- |
| 搜索 | B 站视频搜索，WBI 签名。密钥两条路径：`nav`，失败时退到 `GenWebTicket` |
| 播放 | DASH 纯音频流，按档位挑流，带过期时间 |
| 歌词 | 行级走 LRCLIB；**逐字**走 AMLL TTDB（syllable 级，含翻译 / 音译 / 背景人声） |
| 登录 | 网页窗口 / 扫码 / 粘贴 Cookie 三种，登录态存本机 |
| YouTube Music | 搜索与元数据，**默认关闭**。播放不可用，原因见下 |

未登录也能搜和放，但 B 站会压低音质、会员内容拿不到。

## 装

```bash
# 在 folia-major 仓库根目录
git clone https://github.com/ZhuoMoStudio/folium-neri-bridge mods/neri-bridge
npm install && npm run dev:electron
```

设置 → 实验室 → 模组系统 开启总开关，然后在模组面板里启用本模组并确认。

## 逐字歌词

`omni.providers` 的 `getLyrics` 只能返回 `{ lrc, translationLrc }`，逐字时轴没有地方放。本模组从侧门进去：宿主在歌词到达播放器前会派发 `omni.lyricsResolved`，钩子可以**整体替换** `lines`，而 `FoliumLine.words[].syllables[]` 正是逐字高亮读的东西。

链路分两半，中间靠一个内存中继传递，原因是一个硬约束：

```
provider.getLyrics  ──联网取 TTML + 对齐──▶  relay  ──纯内存取用──▶  omni.lyricsResolved 钩子
   没有时间预算                                     每个处理器只有 1500ms
```

`src/mods/folium/events.ts` 的 `ASYNC_TIMEOUT_MS = 1500`：钩子里的 `await` 一旦超时，宿主就不再等，对 `event.lines` 的赋值也不再生效。所以**联网必须发生在 `getLyrics` 里**（那条路径没有预算限制），钩子只做一次内存查表加一次纯函数判断。

歌词源用 [AMLL TTDB](https://github.com/amll-dev/amll-ttml-db)（**CC0-1.0**，公有领域奉献）。它的在线服务只按 `[平台]/[音乐ID]` 取歌词，**没有搜索接口**，而 B 站的歌没有 ncm/qq/am/spotify 的 id。所以流程是：拉 `metadata/raw-lyrics-index.jsonl`（1.6MB，gzip 传输约 428KB）→ 压成紧凑形状落到模组数据文件（实测 453KB / 3080 条，占 1MB 上限的 44%）→ 本地按标题/艺术家匹配 → 拿到 id 或文件名再取 TTML。

装上去之前要过三道门：

1. **标题**：必须「相等 / 前缀 / 互相包含」（`scoreLyricMatchTitle` ≥ 52）；
2. **艺术家**：必须命中（`scoreLyricMatchArtist` ≥ 24）。B 站搜索只给 UP 主名，所以 `lib/artist-candidates.mjs` 会从标题、简介、合作者名单里再提一批候选；
3. **对齐**：TTML 按母带对齐，而 B 站是视频源，常有前奏/尾奏差。拿宿主已经解析好的行级时轴当参照求一个常量偏移，取中位数。**对不齐就不装** —— 实测「残酷な天使のテーゼ」在 TTDB 里只有 Ambivalence Mix，和视频版对不上，硬套只会让逐字高亮整体错位。

没有参照时轴可对（LRCLIB 也没这份歌）时，只认「标题完全相等」这一档：没有东西能证明版本一致，就别硬装。

## YouTube Music

**搜索可用，播放不可用。** 这不是省事，是实测结论（2026-09-27，直连）：

| 端点 / 客户端 | 结果 |
| --- | --- |
| `youtubei/v1/search`（WEB_REMIX） | ✅ 匿名可用，20 条结果，标题/艺术家/专辑/时长齐全，翻页令牌也能用 |
| `youtubei/v1/player` WEB_REMIX（首页下发的最新 clientVersion） | ❌ `UNPLAYABLE / Video unavailable`，0 个音频格式 |
| 同上 WEB（`2.20260925.01.00`） | ❌ 同上 |
| `ANDROID_VR` 1.62.27 / 1.60.19 | ❌ `LOGIN_REQUIRED / Sign in to confirm you're not a bot` |
| `TVHTML5` / `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | ❌ `LOGIN_REQUIRED`（后者：YouTube is no longer supported…） |
| `MWEB` | ❌ `UNPLAYABLE / The page needs to be reloaded.` |

请求本身没问题：`videoDetails` 正常返回，同一个 videoId 的 oEmbed 也是 200（「夜に駆ける」，YOASOBI - Topic，261s）。缺的只有 `streamingData`，也就是 PO Token / BotGuard 那一关。而 PO Token 要跑 Google 的混淆 VM（yt-dlp 得外挂 bgutil 之类的 sidecar），在模组里做既不可靠，也违背本仓库「不下载执行远程代码」这条自我约束。

所以 `providers/youtube.mjs` **不声明 `getAudioUrl`**，能力表里 `playback` 就是 false，宿主不会把它当可播放源；同时它默认关闭（设置 → 音源 → 「启用 YouTube Music 搜索」），一个放不了的音源出现在选择器里只会让人以为坏了。

`test/09-youtube.mjs` 里有一条**金丝雀**：它断言「仍然拿不到匿名播放地址」。哪天它红了，说明 YouTube 放开了，那时应该回来把 `getAudioUrl` 实现掉。看到它红请先看那条测试的注释。

## 踩过的坑

结论写在这里，过程写在对应文件的注释里。

**1. `/x/web-interface/wbi/view` 不是可靠的 cid 来源。** 实测 `BV1Ph411C7S5`（YOASOBI 的夜に駆ける MV）对**正确的** bvid 和 aid 都返回 `code: -404`，同一个 bvid 在 `/x/player/pagelist` 上完全正常。所以 cid 一律走 pagelist。`view` 仍然有用（标题、封面、简介、合作者名单），但失败要缓存 —— 不缓存的话 `getSong` / `getLyrics` / 艺术家候选三条路会各问一次同一个 -404。

**2. B 站有两个 CDN 家族，防盗链策略不一样。**

| CDN | 带 B 站 Referer | 不带 |
| --- | --- | --- |
| `upos-sz-mirrorcosov.bilivideo.com` | 206 | **403** |
| `upos-hz-mirrorakam.akamaized.net` | 206 | 206 |

Folia 的页面来源两种都撞 403（开发 `localhost:3000`、生产 `file://`），而 `<audio>` 没法自定义请求头。所以 `index.cjs` 把 Referer 一律改写成 B 站的值。

只测一个节点会得出「不带 Referer 也行」的错误结论 —— 第一版就是这么写错的。`test/04-cdn.mjs` 专门用来复现这件事。

**3. 纯文本歌词交出去等于没有歌词。** `parseLRC` 会丢无时间标签的行（`parserCore.ts:347`），所以拿不到同步歌词时返回 `null`，不返回纯文本。

**4. 宿主给钩子的预算是 1.5 秒。** 见「逐字歌词」一节。第一版把联网放在钩子里，代码看起来对，实际上是死路 —— 超时后宿主直接放弃等待，`event.lines` 的赋值没人看。

**5. `words` 拼接必须等于 `fullText`。** 这不是我们的约定，是宿主的：`enhancedLrcSerializer.ts` 的 `alignWordSegments` 用这条不变量判断要不要自己去 `fullText` 里找词。所以 TTML 里「写在下个 span 开头的空格」要折算到上一个 syllable 的尾部，行末空格要去掉。实测 Idol 的 91 行里就有 1 行以空格结尾，差这一个字符就会让宿主白跑一遍重新对齐。

**6. 第一个艺术家候选可能是错的。** B 站只给 UP 主名，其余候选是从标题/简介里猜的。把猜测拼进 LRCLIB 的搜索关键词，一次错猜就会让整次搜索搜不到东西（实测 `['完全不存在的名字', 'YOASOBI']`）。所以搜索退到纯标题再试一次 —— 本地身份判定本来就对全部候选放行，退一步不会放宽标准。

## 测

```bash
npm test              # 离线：纯函数 + 契约 + 匹配评分 + 逐字歌词，不联网
npm run test:live     # 真实 B 站搜索 / 取流 / LRCLIB / WBI ticket 兜底
npm run test:cdn      # 采样两个 CDN，验防盗链策略
npm run test:login    # 扫码登录链路
npm run test:amll     # 真实 AMLL TTDB：索引 → 匹配 → TTML → 对齐
npm run test:youtube  # 真实 InnerTube：搜索可用 + 播放不可用的金丝雀
npm run test:all      # 全部
```

`03-contract` 不是自己写断言，是加载 folia-major 的 `manifest.cjs` 和打桩宿主，直接跑上游代码。

从干净克隆跑过：109 + 84 + 47 + 92（离线）+ 24 + 10 + 17 + 43 + 30（联网）= **456 项，0 失败**（Node 22.14，2026-09-27）。

`08-amll-live` 与 `09-youtube` 依赖上游可用性（raw.githubusercontent / amll-ttml-db.stevexmh.net / music.youtube.com），它们红了先看是不是上游的事。

## 登录

登录态只在主进程处理，因为 `folium.net.fetch` 拿不到可靠的 `Set-Cookie`：`modSystem.cjs:935` 把响应头归一化成普通对象，undici 会把多个 `Set-Cookie` 用逗号合并，而 cookie 的 `Expires` 自身含逗号。

三种方式：

- **网页窗口**（推荐）— 主进程开一个 BrowserWindow 指向 B 站登录页，轮询 `session.cookies` 直到出现 `SESSDATA`
- **从应用会话读取** — 如果你已经在别处用 Folia 登录过，直接认过来
- **粘贴 Cookie** — 从浏览器复制，粘进设置面板

登录后 Cookie 同时注入 CDN 请求（会员内容的流需要它）。

## 已知限制

- **逐字歌词取决于 TTDB 的覆盖。** 库里有 3000 多首（人工审核过的投稿），没有的歌就只有行级 LRC。这是数据问题，不是实现问题。
- **逐字歌词走的是实验接口。** `omni.hooks` 与 `omni.providers` 一样，任何 minor 版本都可能变；拿不到时整条逐字链路降级（打一条警告），LRCLIB 行级歌词不受影响。`folium.host.folium.minor` 可以用来做功能探测。
- **艺术家是从标题/简介猜的。** 规则都对着实测样本写过测试（`test/01-offline.mjs`），但猜出来的名字会混进列表：有的视频会显示成「周杰伦 / 晴天 / UP主名」。真名的代价是多几个候选。
- **YouTube Music 只能搜不能放。** 见上面那一节。
- **副歌识别**：宿主的内建逻辑读 `mainText`（本模组给的就是 LRC 原文），所以行级歌词能参与文本副歌检测；换成 TTML 之后的行会带上 `isChorus`（来自 `<div itunes:song-part="Chorus">`）。

## 上架

不用 fork。按 Folium 规范，模组放自己仓库、去 [folium-compound](https://github.com/chthollyphile/folium-compound) 开 issue 就行。还缺：

- [ ] `preview.png`（1280×720，<1MB）
- [ ] `LICENSE` 全文

## 合规

本模组走 B 站非公开接口。不绕过付费内容，不分发音频，只把用户自己账号权限内的地址交给播放器。使用者自行承担合规责任。

注意：`SocialSisterYi/bilibili-API-collect` 已于 2026-01-28 收到律师函后永久关停，指控是「系统性收集并向公众传播非公开 API 的认证机制」。本仓库不复制它的内容，但确实公开了一份 WBI 实现。详见 [REFERENCES.md](./REFERENCES.md)。

## 许可

AGPL-3.0-only。代码移植自 NeriPlayer（GPL-3.0）、运行在 Folia（AGPL-3.0）内，按 GPLv3 §13 组合后整体取 AGPLv3。逐文件对照见 [NOTICE.md](./NOTICE.md)，上游清单见 [REFERENCES.md](./REFERENCES.md)。
