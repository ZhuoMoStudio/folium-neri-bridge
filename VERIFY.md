# 手工验证清单

这里列的是**自动化测不了**的东西。沙盒里跑得动的那部分已经写进 `npm test` 与 `npm run test:all`
（见 [README](./README.md#测)），不用在这里重复。

三件事只有你能确认，加起来大约 15 分钟：

| | 要确认什么 | 为什么自动化测不了 |
| --- | --- | --- |
| **1** | 真 Folia 里的播放、监听器、逐字渲染 | 需要 Electron + 显示器 + 真宿主 |
| **2** | 真手机扫码登录一次 | 需要你的账号与手机 |
| **3** | （不用做）YouTube 播放 | 明确不做，见下 |

---

## 1. 真 Folia 里的三件事（约 5 分钟）

### 先装起来

```bash
# 在 folia-major 仓库根目录
git clone <本仓库> mods/neri-bridge
npm install && npm run dev:electron
```

设置 → 实验室 → 模组系统 开启总开关 → 在模组面板里启用 `neri-bridge` 并确认。

### 跑自检

命令面板（`Ctrl+K` / `Cmd+K`）→ 搜 `自检`，或直接找 **Bilibili：自检**。

先随便播一首 B 站的歌，或者在命令的参数框里填一个 `bili:BV…:cid`（也可以只填 BV 号或视频链接）。
然后看输出。

**一份全绿的输出长这样：**

```
folium-neri-bridge 自检 · folium 1.3 / folia 0.7.2 / context main
[ok]   契约版本：实验接口 omni.providers + omni.hooks 都在（清单里声明过）
[ok]   Referer 监听器：已装上（本次会话改写 7 次；最近改写 upos-sz-mirrorcosov.bilivideo.com）
[warn] 登录态：未登录；音质受限：未登录：只拿得到匿名档位（实测 64K / 132K / 192K 三档里的可用项），杜比与 Hi-Res FLAC 拿不到流（playurl 里 flac.display 为 true 而 flac.audio 为 null），会员内容同样不可用
[ok]   CDN 直链 Range：HTTP 206（bytes 0-1023/37896722） · 180ms
[ok]   <audio> 播放：拿到元数据（时长 2332s） · 640ms ← 这一步走 Chromium 会话，成功即证明防盗链改写通了
[ok]   监听器实测：<audio> 探测期间改写计数 7 → 8（+1）⇒ webRequest 监听器确实拦到了这个请求
[ok]   逐字歌词索引：可用（数据文件）：3080 条，约 453KB（数据文件上限 1024KB），2 小时前更新
结论：没有失败项；1 项需要留意（[warn]）
```

**`[warn] 登录态`** 在你没登录时是正常的 —— 那不是故障，是「你现在只有匿名档位」这个事实的呈现。
登录一次就会变成 `[ok]`。

### 三行分别证明了什么

| 行 | 证明的事 |
| --- | --- |
| `Referer 监听器` + `监听器实测` | `webRequest.onBeforeSendHeaders` 挂上了，**而且真的拦到了请求**（计数在 `<audio>` 探测前后 +1）。这两行要一起看：只有前者不能说明它被调用过 |
| `CDN 直链 Range` | 取流接口给出的直链本身是活的，而且 CDN 认 `Range`（206）。这一条走 `folium.net.fetch`，它**不经过 Chromium 会话**（主进程里用 Node 全局 fetch，见 README 的坑 7），所以 Referer 是自检自己带的 |
| `<audio> 播放` | 唯一能证明「防盗链改写 + 播放器路径」通了的一步。它走 Chromium 会话，拿到 `loadedmetadata` 就意味着 `<audio src=CDN 直链>` 真的能播 |

### 逐字歌词只能靠眼睛（30 秒）

自检覆盖不到渲染。挑一首 TTDB 里有的歌（例如 YOASOBI「夜に駆ける」），播起来看：

- ✅ 期望：歌词逐字/逐词地亮起来（syllable 级），而不是整行一起变。
- 拿不到逐字时看日志：`neri-bridge: word-by-word lyrics skipped`，后面跟着 `reason`：
  - `no-candidate`：TTDB 里没这首（数据问题，见 README 的已知限制）；
  - `not-aligned`：版本对不上（比如只有混音版），**这是设计如此**，硬套只会让高亮整体错位；
  - `title-too-weak`：没有参照时轴，且标题不是完全相等 —— 保守地不装。
- 日志里成功时是：`neri-bridge: word-by-word lyrics installed`，带 `offsetMs` 与 `aligned`。

### 顺手确认多分 P（1 分钟）

命令面板 → **Bilibili：列出分 P** → 参数填一个多 P 的合集（例如 `BV1Ps411F7sL`）。
应该列出每个分 P 的 id 与时长。然后把其中一行的 `bili:BV…:cid` 粘进搜索框，应该能搜出那一条并正常播放。

---

## 2. 真手机扫码登录一次（约 10 分钟）

要做的事：**扫一次码，把那一刻的两个响应抓下来，脱敏后放进 `test/fixtures/login-poll-local.json`**。

步骤与脱敏规则写在 [`test/fixtures/CAPTURE.md`](./test/fixtures/CAPTURE.md)，照那个做。
做完跑：

```bash
npm run test:selfcheck   # 或 npm test
```

测试发现那个文件就会额外重放一遍真样本（先验脱敏，不通过直接 FAIL），
于是「扫码成功后凭据由哪一跳下发」这件事就有了真实证据，而不是只有合成样本。

不提交也可以：`.gitignore` 已经按 `-local` 忽略它，测试在本地会跑、在 CI 上会跳过这一节。

---

## 3. YouTube 播放：明确不做

不用验证，因为不打算实现。原因与实测数据见 README 的「YouTube Music」一节。

`test/09-youtube.mjs` 里有一条**金丝雀**：它断言「匿名仍然拿不到播放地址」。
**它红了才是该回来实现 `getAudioUrl` 的时候** —— 看到它红先看那条测试的注释，别急着改代码。

---

## 出问题时

| 症状 | 先看哪一行 |
| --- | --- |
| 歌根本放不出来，控制台有 403 | `Referer 监听器`（应该是 `[ok]`）与 `监听器实测` |
| 直链 403 / `MEDIA_ERR_SRC_NOT_SUPPORTED` | `CDN 直链 Range`：403 通常是链接过期（`deadline`），重播一次再看 |
| 歌词只有整行、没有逐字 | 自检的 `逐字歌词索引` + 日志里的 `word-by-word lyrics skipped` 与它的 `reason` |
| 搜到的歌里没几个对得上 | 正常：B 站只给 UP 主名，艺术家是从标题/简介**猜**的（README 坑 6） |
| 全是 `[fail]`，连契约都红 | `mod.json` 的 `experimental` 是否声明了 `omni.providers` / `omni.hooks`；宿主版本是否 ≥ 1.3 |
