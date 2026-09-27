# folium-neri-bridge

把 Android 端 [NeriPlayer](https://github.com/cwuom/NeriPlayer) 的**音源与歌词源**接入 [Folia](https://github.com/chthollyphile/folia-major) 的官方模组平台 **Folium**。

- 上游议题：[folia-major#440 — omni.providers 透传逐字歌词 wordByWordText](https://github.com/chthollyphile/folia-major/issues/440)
- 模组 id：`neri-bridge`

---

## 为什么需要它

Folia 内建音源是网易云 / 酷狗 / QQ（`src/services/onlineMusic/providerRegistry.ts`）。NeriPlayer 在 Android 端能接的源比这多，本模组就是把差额搬过去。

当前已移植：

| 来源 | 类型 | 状态 |
| --- | --- | --- |
| Bilibili 搜索 | 音源 | ✅ v0.1.0 |
| Bilibili DASH 取流 | 音源 | ✅ v0.1.0 |
| LRCLIB | 歌词 | ✅ v0.1.0 |
| AMLL TTML | 逐字歌词 | ⏳ 需要 #440 先落地 |
| 酷狗 krc | 逐字歌词 | ⏳ 同上 |
| YouTube Music | 音源 + 歌词 | ❌ 移植难度极高（EJS challenge / PoToken / NewPipe 兜底），单独立项 |

---

## 当前状态：v0.1.0，**未经验证**

写这份代码的环境里没有 Node、也没有 Folia 运行时，所以：

- ✅ **已验证**：`lib/md5.mjs` 过了 RFC 1321 全部标准测试向量（含 80 字符长串）与 UTF-8 多字节边界。
- ❌ **未验证**：其余全部。代码是照着 NeriPlayer 的实现与 Folium 契约写的，但**一次都没跑过**。

第一次跑起来时，请按下面「首次验证清单」逐项确认。

### 首次验证清单

1. **模组能被发现**：`npm run dev:electron`，模组面板里应出现「NeriPlayer 音源桥」，状态为未验证。
2. **启用后日志里出现一行** `neri-bridge: registered provider folium.neri-bridge.bilibili`。
   - 如果出现 `omni.providers is unavailable`，说明 `mod.json` 的 `experimental` 没生效或宿主版本不支持。
3. **搜索**：源选择器里应多出「Bilibili（NeriPlayer 桥）」，搜个中文歌名试试。
   - 空结果先在 devtools console 里看 `bili search failed` 的 `code`。
   - `code: -352` / `-412` 是风控，`code: -403` 是签名不对。
4. **播放**：点进任意一首，看是否出声。
   - 不出声的话，见下面的「已知风险 1」。
5. **歌词**：播放页应能出 LRCLIB 的歌词；出不来属预期（B 站搜索只给视频标题和 UP 主，匹配率天然有限）。

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

---

## 已知风险

### 1. B 站取流可能需要 Referer（最高优先级）

`x/player/wbi/playurl` 返回的 `*.bilivideo.com` 地址带签名参数（`deadline` / `upsig`）。这类 CDN 地址通常可以直接播，但**不排除有防盗链**。

`<audio>` 元素无法自定义请求头，所以如果实际不出声，唯一的解法是让模组自己起一个**回环 HTTP 代理**：

- 模组新增 `main` 入口（`index.cjs`，跑在主进程，有完整 Node 权限），监听 `127.0.0.1` 随机端口；
- 代理按 Range 转发字节，并补上 `Referer` / `User-Agent`；
- `getAudioUrl` 返回 `http://127.0.0.1:<port>/bili/<bvid>/<cid>`。

`omni.hooks` 的 `omni.audioSourceResolved` 只接受 `^https?://`，所以回环地址是符合契约的。

**v0.1.0 没有实现这个代理**，因为它无法在本机验证，而且它引入了端口占用、生命周期、Range 正确性三个新的出错点。先确认直链能不能播，不能再说。

### 2. WBI 签名只有一条密钥获取路径

原实现有两条：优先 `/x/web-interface/nav`，失败则回退到 `GenWebTicket`（带 HMAC-SHA256 与 `key_id`）。**v0.1.0 只做了第一条。** 如果匿名 `nav` 开始拒绝返回 `wbi_img`，签名会直接失效，搜索和取流全部报错。

### 3. 逐字歌词这条路暂时是堵的

Folium 的 mod provider 能力是硬编码的（`src/mods/folium/registries/omniProviders.ts:62` 的 `wordByWordLyrics: false`），而 `getLyrics` 只返回 `{ lrc, translationLrc }`，宿主一律走 `parseLRC`。这也是 [#440](https://github.com/chthollyphile/folia-major/issues/440) 的内容。

在它落地前，本模组提供的歌词只有逐行 LRC。想要逐字动画，只能走 `omni.hooks` 的 `omni.lyricsResolved` 改写 `lines` 那条绕行路线。

### 4. 歌词匹配是简化版

NeriPlayer 的完整匹配策略在 `EditableLyricMatchPolicy.kt`（约 480 行的评分制，能处理《曲名 (Live ver.)》这类版本差异）。v0.1.0 只做了归一化后的相等判定 + 艺术家包含判定，**误匹配率会比 Android 端高**。已在 v0.2.0 路线图里。

### 5. 上游可能会变

`omni.providers` 是实验接口，契约原文写明「任何 minor 都可能变」。`mod.json` 里没有锁 `folia` 版本范围（锁了就要跟着上游升，不锁则在接口变动时静默失效）。

---

## 与上游的关系

本仓库**不是** fork。按 Folium 规范《发布到模组市场》：

> 不需要 fork 任何仓库：你只需要把模组放在自己的公开源码仓库里，再开一个 issue。

如果想上架模组市场，在 [folium-compound](https://github.com/chthollyphile/folium-compound) 开一个「模组提交」issue。上架前还需补上：

- [ ] `preview.png`（1280×720，<1MB）—— 现在是缺的，本地开发不影响
- [ ] `LICENSE` 全文（见下）

---

## 许可证

**AGPL-3.0-only**。

理由：本模组的音源与歌词源代码移植自 NeriPlayer（GPL-3.0），而它运行在 Folia（AGPL-3.0）里。GPLv3 §13 允许与 AGPLv3 组合，组合后的整体须以 AGPLv3 分发。逐文件对照见 [NOTICE.md](./NOTICE.md)。

> ⚠️ 仓库里**还没有放置 AGPL-3.0 许可全文**。正式分发前请补 `LICENSE`（https://www.gnu.org/licenses/agpl-3.0.txt）。
