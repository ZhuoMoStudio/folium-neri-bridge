// lib/bili-video-ref.mjs
//
// 把用户手里的一串东西识别成「这是一个具体的 B 站视频（某一分 P）」。
// 纯函数，不联网。
//
// 为什么需要它：多 P 视频的每个分 P 在 `bili:BV...:cid` 这个 id 形状里本来就是独立曲目
// （见 providers/bilibili.mjs 的 makeSongId），但**没有地方能把那些 cid 变成可点的条目** ——
// 宿主的 FoliumOmniProviderDef 只有 search / getSong / getAudioUrl / getLyrics 四个口子，
// 而 search 接的是一串文本。所以约定：把 BV 号或视频链接粘进搜索框，
// search 就走「按视频取分 P 列表」这条路，每个分 P 返回成一条正常结果，点进去就能放。
//
// 只认 BV 号：av 号要先经过 view 换 bvid，而实测 view 对某些正确稿件也会返回 -404
// （见 README 的坑 1），拿它做入口只会得到一个时灵时不灵的搜索。
// 短链（b23.tv）要发一次跳转请求，search 里不该有这种副作用，同样不做。

/** 模组自己的歌曲 id 前缀。与 providers/bilibili.mjs 保持一致。 */
const ID_PREFIX = 'bili:';

/** BV 号：BV + 10 位 base58 字符。 */
const BVID_BODY = '[0-9A-Za-z]{10}';
const BVID_IN_TEXT = new RegExp(`BV${BVID_BODY}`);
const BARE_REF = new RegExp(`^BV(${BVID_BODY})(?::(\\d+))?$`);
/** 只认 bilibili.com 自己的域名；协议头可省（从地址栏复制时常被截掉）。 */
const BILIBILI_HOST = /^(?:https?:\/\/)?(?:[\w-]+\.)*bilibili\.com\//i;

/** 视频链接里的分 P 参数。`?p=3` 表示第 3 个分 P（从 1 开始）。 */
const parsePage = (value) => {
    const page = Number(value);
    return Number.isFinite(page) && page >= 1 ? Math.floor(page) : null;
};

/**
 * 解析一个视频引用。
 *
 * 认得出这几种（其余一律返回 null，交给调用方当普通关键词处理）：
 *   - `BV1Ps411F7sL`                  → 整个视频（调用方自行决定取哪些分 P）
 *   - `BV1Ps411F7sL:53978845`         → 指定 cid
 *   - `bili:BV1Ps411F7sL:53978845`    → 模组自己的 id 形状，同样认
 *   - `https://www.bilibili.com/video/BV1Ps411F7sL?p=3`
 *   - `https://m.bilibili.com/video/BV1Ps411F7sL/`
 *   - `www.bilibili.com/video/BV1Ps411F7sL`（没有协议头也认）
 *
 * @returns {{ bvid: string, cid: number | null, page: number | null } | null}
 */
export const parseVideoRef = (raw) => {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    const body = text.startsWith(ID_PREFIX) ? text.slice(ID_PREFIX.length).trim() : text;

    // 1) 裸 id：BV... 或 BV...:cid
    const bare = BARE_REF.exec(body);
    if (bare) {
        const cid = Number(bare[2]);
        return { bvid: `BV${bare[1]}`, cid: Number.isFinite(cid) && cid > 0 ? cid : null, page: null };
    }

    // 2) 链接。只认 bilibili.com 自己的域名 —— 别的站点路径里出现 BV 号不算「用户要这个视频」，
    //    否则「BV1Ps411F7sL 钢琴版」这种关键词也会被劫走。
    if (!BILIBILI_HOST.test(text)) return null;
    const bvid = BVID_IN_TEXT.exec(text)?.[0];
    if (!bvid) return null;
    let page = null;
    try {
        page = parsePage(new URL(text.startsWith('http') ? text : `https://${text}`).searchParams.get('p'));
    } catch {
        // 域名前缀对上了但 URL 解析不了：仍然认这个 BV，只是没有分 P 信息
    }
    return { bvid, cid: null, page };
};

/** 这个查询串是不是「一个视频引用」而不是关键词。 */
export const isVideoRef = (raw) => parseVideoRef(raw) !== null;
