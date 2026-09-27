# folium-neri-bridge

把 Android 端 [NeriPlayer](https://github.com/cwuom/NeriPlayer) 的**音源与歌词源**接入 [Folia](https://github.com/chthollyphile/folia-major) 的官方模组平台 **Folium**。

- 上游议题：[folia-major#440 — omni.providers 透传逐字歌词 wordByWordText](https://github.com/chthollyphile/folia-major/issues/440)
- 模组 id：`neri-bridge`

---

## 为什么需要它

Folia 内建音源是网易云 / 酷狗 / QQ（`src/services/onlineMusic/providerRegistry.ts`）。NeriPlayer 在 Android 端能接的源比这多，本模组就是把差额搬过去。

当前状态：

| 来源 | 类型 | 状态 |
| --- | --- | --- |
| Bilibili 搜索（WBI 签名） | 音源 | ✅ 已跑通真实 API |
| Bilibili DASH 取流 | 音源 | ✅ 已跑通真实 API |
| Bilibili → LRCLIB 歌词回退 | 歌词 | ✅ 已跑通真实 API |
| AMLL TTML | 逐字歌词 | ⏳ 阻塞于 [#440](https://github.com/chthollyphile/folia-major/issues/440) |
| 酷狗 krc | 逐字歌词 | ⏳ 同上 |
| YouTube Music | 音源 + 歌词 | ❌ 移植难度极高（EJS challenge / PoToken / NewPipe 兜底），单独立项 |

---

## 验证状态

**测试不是走过场：它们抓到了三个真实缺陷，其中一个是「看起来能跑但会随机失败」的那种。**

```
npm test           # 01-offline + 03-contract，不联网
npm run test:live  # 02-live，打真实 B 站与 LRCLIB
npm run test:cdn   # 04-cdn，采样 CDN 域名并测防盗链策略
```

最近一次结果（Node 22.14.0，2026-09-27）：

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `01-offline` | **33 / 33** | MD5 的 RFC 1321 向量、LRC 塌缩时间轴、歌名/艺术家归一化、时长容差边界 |
| `02-live` | **15 / 15** | 真实 B 站搜索、WBI 缓存、pagelist 取 cid、DASH 取流、CDN 请求头、LRCLIB |
| `03-contract` | **47 / 47** | 用 **Folia 自己的 `validateManifest`** 校验清单；Referer 判定；打桩宿主端到端跑 `client.mjs` |
| `04-cdn` | **10 / 10** | 两个 CDN 家族的防盗链策略采样 |

仍然**没有覆盖**的只剩一件事：模组被 Folia 真正加载后，宿主 UI 里能不能搜到、点开能不能出声。这需要在装有 Folia 的机器上跑一次。

---

## 三个被测试抓出来的缺陷

### 1. `view` 接口不可用 → 改用 `pagelist`

`getSong` / `resolveCid` 原本走 `/x/web-interface/wbi/view`，实测对**正确的 bvid 和 aid 都返回 `code: -404`**，而同一个 bvid 在 `/x/player/pagelist` 上能正常拿到 cid。已改为优先 `pagelist`，`view` 只作为补充元数据的次要路径。

### 2. B 站 CDN 的 Referer 是**必需**的，不是可选的

这是最花时间的一个。`<audio>` 无法自定义请求头，所以如果 CDN 要求 Referer，模组无法直接播。

一开始测到「不带 Referer → 206」，据此把 `main` 入口写成了「删掉 Referer」。后来换个节点，同样的请求全部 403。做了受控复现（每变体 3 次、2 轮）之后才看清：**B 站同时用两个 CDN 家族，策略不同。**

| CDN | 不带 Referer | 带 B 站 Referer | 带 localhost Referer |
| --- | --- | --- | --- |
| `upos-sz-mirrorcosov.bilivideo.com` | **403** | 206 | 403 |
| `upos-hz-mirrorakam.akamaized.net` | 206 | 206 | 403 |

而 Folia 的页面来源恰好是两种都不行的情况：开发模式 `http://localhost:3000`（`main.cjs:4205` `loadURL`），生产模式 `file://`（`main.cjs:4209` `loadFile`）。

所以 `index.cjs` 做的是**把 Referer 一律改写成 `https://www.bilibili.com/`**（而不是删掉），这是唯一在两个 CDN 上都稳定通过的配置。

`04-cdn.mjs` 就是为这件事写的：它在一次运行里同时采到两个 CDN，并把策略差异打印出来，避免以后有人再被单次采样误导。

### 3. 纯文本歌词交出去等于没有歌词

`getLyrics` 原本在找不到同步歌词时退回纯文本。但宿主对返回值一律走 `parseLRC`，而 `parseLRC` 会**丢弃所有没有 LRC 时间标签的行**（`parserCore.ts:347` 的 `parseSimpleTimedTextEntry` 对无标签行返回 `null`）。所以交纯文本只会得到一个空歌词列表。现在只在有同步歌词时返回，否则返回 `null`。

顺带发现：B 站是视频源，**MV 时长天然长于录音室版本** —— 实测「夜に駆ける」的 MV 是 276s 而 LRCLIB 记录是 259s，差 17s 已越过 15s 容差上限。所以 Bilibili provider 走 `relaxedDuration`，时长只用于排序，不用于淘汰。

---

## 安装

把模组目录放进 Folia 的模组目录（面板右上角「打开模组目录」），或在开发版里放进仓库的 `mods/`：

```bash
# 在 folia-major 仓库里
git clone https://github.com/ZhuoMoStudio/folium-neri-bridge mods/neri-bridge
npm install
npm run dev:electron
```

然后在「设置 → 实验室 → 模组系统」开启总开关，在模组面板启用本模组并确认。

启用后日志里应出现：

```
neri-bridge: registered provider neri-bridge:bilibili
bilibili referer guard installed
```

---

## 实现要点

### 注册通道不在 `registries` 下

`omni.providers` 是实验接口，挂在 `folium.experimental` 上，且必须在清单里显式选用：

```js
folium.experimental['omni.providers'].register({ id, displayName, search, getSong, getAudioUrl, getLyrics })
```

`docs/folium/api.md` 生成的 `FoliumRegistries` 列表里**没有** `omniProviders`，照着写会静默失效。

### 一个「拥有歌曲」的音源，而不是纯歌词源

`src/services/onlineMusic/omni.ts:49` 的 `providerForSong` 按 `song.sourceRef.providerId` 路由，非在线歌曲直接抛 `unsupported`。所以 LRCLIB **不能**作为独立 provider 存在 —— provider 只会在自己的歌被播时被问到，而纯歌词源自己没有歌。它只能活在音源 provider 内部，作为 `getLyrics` 的回退。这个问题已在上游 [议题 #440 的评论](https://github.com/chthollyphile/folia-major/issues/440) 里报给了维护者。

### 为什么 `main` 入口能碰 Electron API

模组的 `main` 入口是用 Node 原生 `require` 加载的（`modSystem.cjs:352`），跑在主进程，有完整 Node 权限，所以 `require('electron')` 拿得到 `session.defaultSession`（Folia 主窗口用的就是它，`main.cjs:2633`）。

改的是 `session.webRequest.onBeforeSendHeaders`，只动两个请求头，范围限定在 B 站 CDN 域名加 `/upgcxcode/` 路径特征。不会误伤 `folium.net.fetch` —— 后者在主进程用 Node 全局 `fetch` 发请求（`modSystem.cjs:874` 的注释与 `:910` 的调用），不经过 Chromium session。

---

## 已知限制

### 逐字歌词这条路暂时是堵的

Folium 的 mod provider 能力硬编码在 `src/mods/folium/registries/omniProviders.ts:62` 的 `wordByWordLyrics: false`，而 `getLyrics` 只返回 `{ lrc, translationLrc }`，宿主一律 `parseLRC`。在 [#440](https://github.com/chthollyphile/folia-major/issues/440) 落地前，本模组只能提供逐行歌词。

附带影响：`chorusResolver.ts:54` 读 `providerResult.wordByWordText` 判副歌，所以模组音源的歌也拿不到副歌识别。

### WBI 签名只有一条密钥获取路径

原实现（NeriPlayer）有两条：优先 `/x/web-interface/nav`，失败则回退 `GenWebTicket`（带 HMAC-SHA256）。本模组只做了第一条。若匿名 `nav` 开始拒绝返回 `wbi_img`，签名会直接失效。

### 歌词匹配是简化版

NeriPlayer 的完整匹配策略在 `EditableLyricMatchPolicy.kt`（约 480 行评分制，能处理《曲名 (Live ver.)》这类版本差异）。本模组只做了归一化后的相等判定加艺术家包含判定，误匹配率会比 Android 端高。

### B 站歌名的艺术家信息很弱

搜索接口只给 UP 主名（例：「Ayase-YOASOBI」），不是真正的曲目艺术家。这会让 LRCLIB 的艺术家判定打折。NeriPlayer 的做法是再用网易云反查一次元数据，本模组还没做。

---

## 与上游的关系

本仓库**不是** fork。按 Folium 规范《发布到模组市场》：

> 不需要 fork 任何仓库：你只需要把模组放在自己的公开源码仓库里，再开一个 issue。

若要上架模组市场，在 [folium-compound](https://github.com/chthollyphile/folium-compound) 开「模组提交」issue。上架前还需补：

- [ ] `preview.png`（1280×720，<1MB）
- [ ] `LICENSE` 全文

---

## 许可证

**AGPL-3.0-only**。音源与歌词源代码移植自 NeriPlayer（GPL-3.0），运行在 Folia（AGPL-3.0）内；GPLv3 §13 允许与 AGPLv3 组合，组合后整体须以 AGPLv3 分发。逐文件对照见 [NOTICE.md](./NOTICE.md)。

> ⚠️ 仓库里**还没有放置 AGPL-3.0 许可全文**。正式分发前请补 `LICENSE`（https://www.gnu.org/licenses/agpl-3.0.txt）。
