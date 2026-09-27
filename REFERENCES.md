# 参考与依赖（REFERENCES）

本文件把与 `folium-neri-bridge` 相关的上游项目**按法律关系分类**整理。区分这三类很重要：只有第一类会带来许可证义务。

| 类别 | 含义 | 是否有许可义务 |
| --- | --- | --- |
| **A. 代码来源** | 本仓库有文件是它的移植 | ✅ 有 |
| **B. 对照实现** | 只读文档、只观察行为，没有复制代码 | ❌ 无（但知识来源应致谢） |
| **C. 同生态依赖** | 不在本仓库内，理解上下文需要 | ❌ 无 |

本仓库自身许可证：**AGPL-3.0-only**（理由见 [NOTICE.md](./NOTICE.md)）。

---

## 总表

| # | 项目 | 许可证 | ★ | 类别 | 与本仓库的关系 |
| --- | --- | --- | --- | --- | --- |
| 1 | [cwuom/NeriPlayer](https://github.com/cwuom/NeriPlayer) | GPL-3.0 | 3,561 | **A** | 本仓库五个文件移植自它 |
| 2 | [6xingyv/accompanist-lyrics-core](https://github.com/6xingyv/accompanist-lyrics-core) | Apache-2.0 | 48 | C | NeriPlayer 的歌词解析库 |
| 3 | [6xingyv/accompanist-lyrics-ui](https://github.com/6xingyv/accompanist-lyrics-ui) | Apache-2.0 | 152 | C | NeriPlayer 的逐字歌词渲染 |
| 4 | [cwuom/accompanist-lyrics-ui](https://github.com/cwuom/accompanist-lyrics-ui) | Apache-2.0 | 0 | C | 上一条的 fork，NeriPlayer 实际编译它 |
| 5 | [cwuom/accompanist-lyrics-core](https://github.com/cwuom/accompanist-lyrics-core) | Apache-2.0 | 0 | C | 同上 |
| 6 | [chaunsin/netease-cloud-music](https://github.com/chaunsin/netease-cloud-music) | MIT | 399 | B | 网易云接口对照（本项目**未**移植） |
| 7 | [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) | ⚠️ **已关停** | 20,202 | B | 见下方专节 —— 不再作为参考来源 |
| 8 | [yt-dlp/ejs](https://github.com/yt-dlp/ejs) | Unlicense | 455 | B | YouTube 签名求解对照（本项目**未**移植 YouTube） |
| 9 | [MorpheApp/ejs](https://github.com/MorpheApp/ejs) | Unlicense | 2 | B | 上一条的同名副本，**不是官方仓库** |
| 10 | [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC) | GPL-3.0 | 1,800 | B | 歌词匹配体验参考 |
| 11 | [MetrolistGroup/Metrolist](https://github.com/MetrolistGroup/Metrolist) | GPL-3.0 | 13,024 | B | YouTube Music 客户端参考 |
| 12 | [ReChronoRain/HyperCeiler](https://github.com/ReChronoRain/HyperCeiler) | AGPL-3.0 | 5,445 | C | NeriPlayer 的界面灵感来源之一，与本仓库无关 |
| 13 | [Xposed-Modules-Repo/com.sevtinge.hyperceiler](https://github.com/Xposed-Modules-Repo/com.sevtinge.hyperceiler) | — | 452 | C | 上一条的发布仓库 |

> 若你看到的列表里第 8 项写的是 `MorpheApp/ejs` 并注明「yt-dlp 官方也维护了同名项目」，实际关系是**反过来的**：`yt-dlp/ejs` 是官方主仓库（455★，最近更新 2026-06），`MorpheApp/ejs` 是 2★ 的同名副本。NeriPlayer 的 README 指向的是前者。

---

## A. 代码来源

### 1. cwuom/NeriPlayer — GPL-3.0

本仓库的这些文件是它的移植（逐文件对照见 [NOTICE.md](./NOTICE.md)）：

| 本仓库 | NeriPlayer 原文件 |
| --- | --- |
| `lib/wbi.mjs` | `core/api/bili/BiliClient.kt`（WBI 签名相关函数） |
| `lib/lrc.mjs` | `core/api/lyrics/LyricTimelinePolicy.kt` |
| `lib/match.mjs` | `core/api/lyrics/LrcLibClient.kt` + `core/api/lyrics/ExternalLyricMatchPolicy.kt` |
| `providers/bilibili.mjs` | `core/api/bili/BiliClient.kt` + `core/api/bili/BiliSongResolver.kt` |
| `providers/lyrics/lrclib.mjs` | `core/api/lyrics/LrcLibClient.kt` |

**许可后果**：GPL-3.0 是强 copyleft，移植即衍生，本仓库必须以 GPL-3.0 兼容的许可证发布。又因为本模组运行在 Folia（AGPL-3.0）内，按 GPLv3 §13 组合后的整体须按 AGPLv3 分发，因此本仓库取 **AGPL-3.0-only**。

`lib/http.mjs`、`client.mjs`、`index.cjs`、`test/*` 是**新写的 Folium 适配层**，不是移植。

---

## B. 对照实现

这几个项目**没有代码进入本仓库**，但在做设计决策时被参考过。

### 6. chaunsin/netease-cloud-music — MIT

网易云音乐接口的 Golang 实现。本项目没有移植网易云（Folia 内建已有 `neteaseProvider`），列在这里是因为它是 NeriPlayer 多源能力的接口参考。MIT 无传染性。

### 7. SocialSisterYi/bilibili-API-collect — ⚠️ 已关停，不再作为参考来源

**这个项目已经不存在了**，必须单独说明。

仓库现在只剩一份 README 与一张图片，内容为（原文）：

> 本仓库停止维护并永久关停。
>
> 2026年1月28日，本仓库维护者收到 B 站委托的律师事务所发律师函警告邮件，指控本仓库中的项目存在「通过技术手段对哔哩哔哩平台非公开的 API 接口及其调用逻辑、参数结构、访问控制及安全认证机制进行系统性收集、整理，并以技术文档、代码示例等形式向不特定公众传播」的侵权行为。
>
> 即日起停止维护并删除相关文档及源代码。

**对本仓库的三点含义：**

1. **不再把它列为参考来源。** 在文档里指向一个因法律原因被清空的仓库，既不实用也不明智。
2. **它被指控的行为与「使用 API」不是一回事。** 指控指向的是**系统性收集 + 向公众传播**接口的认证机制。本仓库不复制它的文档或代码，本仓库的 WBI 实现移植自 NeriPlayer 的 Kotlin —— 但**本仓库确实公开了一份 WBI 签名实现**，这一点必须诚实承认。
3. **风险不对称。** NeriPlayer（3,561★）与 Folia（3,096★）都在公开仓库里发布了同类实现，本仓库是其中最小的一个。若要评估自身风险，应把它们作为参照，而不是只看本仓库。

**可选的降低暴露手段**（未实施，留作决策）：

- 把 B 站支持从公开仓库移出，改为本地安装的模组（用户自行构建）；
- 或放弃 B 站路径，把精力放在没有这类风险的源上（LRCLIB、AMLL TTDB、酷狗）；
- 或在 README 显著位置补一份「个人使用、不绕过付费内容、用户须自行承担合规责任」的声明。

### 8 / 9. ejs — Unlicense

为 yt-dlp 提供的外部 JavaScript，用于处理 YouTube 的签名求解。本项目**没有移植 YouTube Music**（原因见 README「已知限制」）。Unlicense 等价于公有领域，无任何约束。

### 10. chenmozhijin/LDDC — GPL-3.0

多平台精准歌词下载匹配工具。本项目在**歌词匹配的用户体验**上参考过它（NeriPlayer 的 README 也是这么标注的），但没有复制代码。注意它与本仓库同为 GPL-3.0 系，不存在冲突。

### 11. MetrolistGroup/Metrolist — GPL-3.0

Android 上的 YouTube Music 客户端。与 `ejs` 同属 YouTube 方向，本项目未采用。

---

## C. 同生态依赖

这些项目不在本仓库内，但读代码时需要知道它们的位置。

### 2–5. accompanist-lyrics-core / -ui 及其 fork — Apache-2.0

Kotlin 的歌词解析库与 Compose 的逐字歌词组件。它们被 **NeriPlayer** 作为 git submodule 引入（`np-submodule/accompanist-lyrics-{core,ui}`），是 NeriPlayer 实现逐字卡拉 OK 的核心。

**为什么要在这里列出来**：本项目的上游议题 [#440](https://github.com/chthollyphile/folia-major/issues/440) 讨论的正是「逐字歌词」。Folia 侧的 `wordByWordText` 管道能与这套库对齐。如果将来要参考它们的数据模型来设计 Folium 的逐字接口，**Apache-2.0 与 AGPL-3.0 兼容**，但需要在引入时保留其 LICENSE 与 NOTICE。

### 12 / 13. HyperCeiler — AGPL-3.0

HyperOS 的 Xposed 增强模块。NeriPlayer 把它的界面风格列为灵感来源之一。**与本仓库没有任何代码或设计关系**，列在这里只是为了对齐 NeriPlayer 原 README 的致谢表。

---

## 许可证兼容性矩阵

本仓库的依赖方向是单向的，所以只需要判断「能不能吸收 A 类」与「将来能不能吸收 C 类」：

| 来源许可证 | 吸收进本仓库（AGPL-3.0-only） | 说明 |
| --- | --- | --- |
| GPL-3.0（NeriPlayer） | ✅ 可以 | GPLv3 §13 允许与 AGPLv3 组合，组合后整体按 AGPLv3 |
| AGPL-3.0（Folia、HyperCeiler） | ✅ 可以 | 同许可证 |
| Apache-2.0（accompanist） | ✅ 可以 | 需保留 LICENSE 与 NOTICE；与 AGPLv3 兼容 |
| MIT（netease-cloud-music） | ✅ 可以 | 需保留版权声明 |
| Unlicense（ejs） | ✅ 可以 | 无约束 |
| ⚠️ 非商业许可 | ❌ 不可 | 本仓库未引入任何 CC-NC 类内容 |

---

## 维护说明

- 新增上游参考时，先在这里加一行，写清**类别**与**许可证**。
- 只要有任何一行从 B 类变成 A 类（即开始复制代码），必须同步更新 [NOTICE.md](./NOTICE.md) 的逐文件对照表。
- 本表最近一次核对：2026-09-27。
