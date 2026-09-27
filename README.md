# folium-neri-bridge

把 [NeriPlayer](https://github.com/cwuom/NeriPlayer) 的 B 站音源接进 [Folia](https://github.com/chthollyphile/folia-major)。跑在 Folium 模组平台上，**只在桌面版可用**（网页版没有模组系统）。

上游议题：[chthollyphile/folia-major#440](https://github.com/chthollyphile/folia-major/issues/440)（逐字歌词透传。**本模组不等它** —— 走 `omni.hooks` 自己装，见下）

## 能力

| 项 | 说明 |
| --- | --- |
| 搜索 | B 站视频搜索，WBI 签名。密钥两条路径：`nav`，失败时退到 `GenWebTicket` |
| 播放 | DASH 纯音频流，按档位挑流，带过期时间 |
| 多分 P | 每个分 P 是独立曲目（`bili:BV…:cid`）。把 BV 号或视频链接**粘进搜索框**就能列出并点播 |
| 歌词 | 行级走 LRCLIB；**逐字**走 AMLL TTDB（syllable 级，含翻译 / 音译 / 背景人声） |
| 登录 | 网页窗口 / 扫码 / 粘贴 Cookie 三种，登录态存本机 |
| YouTube Music | 搜索与元数据，**默认关闭**。播放不可用，原因见下 |

未登录也能搜和放，但只能拿到匿名档位（实测：64K / 132K / 192K 三档里的可用项；
杜比与 Hi-Res FLAC 拿不到流）。这条现在会显示在设置面板与 `Bilibili：登录状态` 命令里，
不再只写进日志。

## 装

```bash
# 在 folia-major 仓库根目录
git clone https://github.com/ZhuoMoStudio/folium-neri-bridge mods/neri-bridge
npm install && npm run dev:electron
```

设置 → 实验室 → 模组系统 开启总开关，然后在模组面板里启用本模组并确认。

## 多分 P

一个 250 P 的合集在 B 站是**一个** bvid，但对播放器来说它应该是 250 首独立的歌。
id 形状早就支持这件事（`bili:BV1os41197sv:5485403`），缺的从来不是 id，
而是「怎么把那些 cid 交到用户手里」。

宿主给 provider 的只有 `search` / `getSong` / `getAudioUrl` / `getLyrics` 四个口子
（`FoliumOmniProviderDef`），**没有**「列出这个视频的分 P」这种接口；而
`folium.playback.playSong` 只认宿主自己发出去的 ref（`dto.ts` 的 `resolveFoliumSongRef`
查的是一张宿主内部表），模组没法凭空把一首歌塞进队列。

所以走 `search`：**把 BV 号或视频链接粘进搜索框**，`search` 就按分 P 列出来，
每个分 P 一条正常结果，点进去就是一首独立曲目。

```
BV1Ps411F7sL                          → 4 个分 P 各一条
https://www.bilibili.com/video/BV…?p=3 → 只返回第 3 个分 P
bili:BV1Ps411F7sL:53978845            → 同上，直接给 cid
```

多 P 时标题会拼上分 P 名（`合集名 - P2-…`）：不拼的话，队列里就是 250 首同名曲目。
单 P 不拼 —— 那种稿件分 P 名常常等于标题（或干脆是「P1」），拼上去是噪音。

普通关键词搜索**不会**顺带展开多 P：一页 20 条结果就是 20 次 pagelist 请求。
点进去的那一条本来就是对的（`getSong` 会带上 cid 与分 P 名），够用了。

命令面板里还有一个 **Bilibili：列出分 P**，先看一眼再决定，比在搜索结果里翻要舒服。

## 自检

只有装了真 Folia 的人能确认的东西（监听器有没有挂上、`<audio>` 能不能播、逐字有没有渲染），
有一条命令可以一次问完：

> 命令面板 → **Bilibili：自检**（参数可以留空，用当前正在播的歌；也可以填 BV 号 / 视频链接 / `bili:BV…:cid`）

```
folium-neri-bridge 自检 · folium 1.3 / folia 0.7.2 / context main
[ok]   契约版本：实验接口 omni.providers + omni.hooks 都在（清单里声明过）
[ok]   Referer 监听器：已装上（本次会话改写 7 次；最近改写 upos-sz-mirrorcosov.bilivideo.com）
[warn] 登录态：未登录；音质受限：…
[ok]   CDN 直链 Range：HTTP 206（bytes 0-1023/37896722） · 180ms
[ok]   <audio> 播放：拿到元数据（时长 2332s） · 640ms ← 这一步走 Chromium 会话，成功即证明防盗链改写通了
[ok]   监听器实测：<audio> 探测期间改写计数 7 → 8（+1）⇒ webRequest 监听器确实拦到了这个请求
[ok]   逐字歌词索引：可用（数据文件）：3080 条，约 453KB（数据文件上限 1024KB），2 小时前更新
结论：没有失败项；1 项需要留意（[warn]）
```

两处值得说明的设计：

- **`监听器实测` 是计数差，不是状态位。** 「装上了」不等于「被调用过」；
  `<audio>` 探测前后各读一次改写计数，涨了才是真的拦到了请求。
- **`CDN 直链 Range` 自己带 Referer。** `folium.net.fetch` 在主进程里用 Node 全局 fetch，
  **不经过 Chromium 会话**（见坑 7），所以改写链路碰不到它 —— 这条证明的是「直链还活着、CDN 认 Range」，
  而不是「防盗链改写生效了」。后者由 `<audio>` 那一行负责。

整个流程与期望输出写在 [VERIFY.md](./VERIFY.md)，那里还有两件必须人做的事（真机扫码、逐字渲染）。

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

**7. `folium.net.fetch` 不经过 Chromium 会话，所以它看不到自己的 Referer 改写。** 它在主进程里用 Node 全局 fetch（`modSystem.cjs` 的 `invokeModNetFetch`），本模组注册的 `webRequest` 监听器碰不到它。两个后果：

- 走 `folium.net.fetch` 的探测必须**自己带** Referer，否则会被 CDN 当成盗链；
- 它的响应体上限是 **5MB**，因此探测音频直链必须带 `Range` —— 不带会以 `net-body-too-large` 结束，然后被误读成「CDN 坏了」。

自检命令里那两行（`CDN 直链 Range` 与 `<audio> 播放`）就是按这条分工的：前者走 `net.fetch` 自证直链可用，后者走 Chromium 会话证明改写链路生效。

**8. LRCLIB 有限流。** 连跑几轮测试会偶发 429，`lookup` 返回 `null` —— 和「上游真的没这条记录」是同一个返回值。`test/02-live.mjs` 里要断言「有」的两条因此带重试；自己写探测脚本时也别把一次 `null` 当成结论。

## 测

```bash
npm test              # 离线：纯函数 + 契约 + 匹配评分 + 逐字歌词 + 自检/登录/分 P 回归，不联网
npm run test:live     # 真实 B 站搜索 / 多分 P / 取流 / LRCLIB / WBI ticket 兜底 / 匿名音质档位
npm run test:cdn      # 采样两个 CDN，验防盗链策略
npm run test:login    # 扫码登录链路的端点形状
npm run test:amll     # 真实 AMLL TTDB：索引 → 匹配 → TTML → 对齐
npm run test:youtube  # 真实 InnerTube：搜索可用 + 播放不可用的金丝雀
npm run test:all      # 全部
```

单跑一套也行：`test:offline` / `test:contract` / `test:match` / `test:words` / `test:selfcheck`。

`03-contract` 不是自己写断言，是加载 folia-major 的 `manifest.cjs` 和打桩宿主，直接跑上游代码。

从干净克隆跑过：109 + 107 + 47 + 92 + 133（离线）+ 38 + 10 + 17 + 43 + 30（联网）= **626 项，0 失败**（Node 22.14，2026-09-27）。其中 `04-cdn` 的项数随采样到几个 CDN 家族浮动（6–10，上面写的是采到两个时的数），它本身要断言的就是「不同家族的策略不一致」。

`08-amll-live` 与 `09-youtube` 依赖上游可用性（raw.githubusercontent / amll-ttml-db.stevexmh.net / music.youtube.com），它们红了先看是不是上游的事。

装进真 Folia 之后要确认的三件事不在这里，在 [VERIFY.md](./VERIFY.md)。

## 登录

登录态只在主进程处理，因为 `folium.net.fetch` 拿不到可靠的 `Set-Cookie`：`modSystem.cjs:935` 把响应头归一化成普通对象，undici 会把多个 `Set-Cookie` 用逗号合并，而 cookie 的 `Expires` 自身含逗号。

三种方式：

- **网页窗口**（推荐）— 主进程开一个 BrowserWindow 指向 B 站登录页，轮询 `session.cookies` 直到出现 `SESSDATA`
- **从应用会话读取** — 如果你已经在别处用 Folia 登录过，直接认过来
- **粘贴 Cookie** — 从浏览器复制，粘进设置面板

登录后 Cookie 同时注入 CDN 请求（会员内容的流需要它）。

## 已知限制

- **逐字歌词取决于 TTDB 的覆盖。** 库里有 3000 多首（人工审核过的投稿），没有的歌就只有行级 LRC。这是数据问题，不是实现问题，日志里会写 `reason=no-candidate`。
- **逐字歌词走的是实验接口。** `omni.hooks` 与 `omni.providers` 一样，任何 minor 版本都可能变；拿不到时整条逐字链路降级（打一条警告），LRCLIB 行级歌词不受影响。`folium.host.folium.minor` 可以用来做功能探测，自检命令也会报出来。
- **艺术家是从标题/简介猜的。** 规则都对着实测样本写过测试（`test/01-offline.mjs`），但猜出来的名字会混进列表：有的视频会显示成「周杰伦 / 晴天 / UP主名」。真名的代价是多几个候选。
- **多分 P 要靠「粘进搜索框」才能看到。** 这不是偷懒，是宿主契约里没有别的入口（见「多分 P」一节）：provider 只有四个方法，`playSong` 只认宿主自己的 ref。普通关键词搜索不会展开多 P —— 那要多发 20 次请求。
- **未登录只能拿匿名档位。** 实测匿名取流的音频 id 并集是 {30216, 30232, 30280}，且稿件标着有 Hi-Res 时 `flac.display` 为 `true` 而 `flac.audio` 为 `null`。登录后能拿到什么取决于账号与稿件，本仓库不保存凭据、也没法替你验证这一侧。
- **YouTube Music 只能搜不能放。** 见上面那一节。
- **副歌识别**：宿主的内建逻辑读 `mainText`（本模组给的就是 LRC 原文），所以行级歌词能参与文本副歌检测；换成 TTML 之后的行会带上 `isChorus`（来自 `<div itunes:song-part="Chorus">`）。
- **`av` 号与 `b23.tv` 短链不作为入口。** 前者要先用 `view` 换 bvid，而 `view` 对某些正确稿件也返回 -404（坑 1）；后者要发一次跳转请求，而 `search` 里不该有这种副作用。用 BV 号。
- **真 Folia 里的三件事由你确认。** 监听器、`<audio>` 播放、逐字渲染在无显示器环境里测不了，所以有了自检命令与 [VERIFY.md](./VERIFY.md) 那份清单 —— 不是「未验证」，是「验证方式交给你，5 分钟」。
- **扫码登录的成功响应只有合成样本。** 三条路（poll 的 Set-Cookie / 票据那一跳的 Set-Cookie / Legacy 查询串）都有离线回归，但样本是照着形状手写的；真样本的位置与抓法写在 [`test/fixtures/CAPTURE.md`](./test/fixtures/CAPTURE.md)，欢迎补上。

## 上架

不用 fork。按 Folium 规范，模组放自己仓库、去 [folium-compound](https://github.com/chthollyphile/folium-compound) 开 issue 就行。还缺：

- [ ] `preview.png`（1280×720，<1MB）
- [ ] `LICENSE` 全文

## 合规

本模组走 B 站非公开接口。不绕过付费内容，不分发音频，只把用户自己账号权限内的地址交给播放器。使用者自行承担合规责任。

注意：`SocialSisterYi/bilibili-API-collect` 已于 2026-01-28 收到律师函后永久关停，指控是「系统性收集并向公众传播非公开 API 的认证机制」。本仓库不复制它的内容，但确实公开了一份 WBI 实现。详见 [REFERENCES.md](./REFERENCES.md)。

## 许可

AGPL-3.0-only。代码移植自 NeriPlayer（GPL-3.0）、运行在 Folia（AGPL-3.0）内，按 GPLv3 §13 组合后整体取 AGPLv3。逐文件对照见 [NOTICE.md](./NOTICE.md)，上游清单见 [REFERENCES.md](./REFERENCES.md)。
