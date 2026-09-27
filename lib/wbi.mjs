// lib/wbi.mjs
//
// B 站 WBI 签名。移植自 NeriPlayer 的
//   app/src/main/java/moe/ouom/neriplayer/core/api/bili/BiliClient.kt
// 原实现见 signWbiUrl / getOrRefreshMixinKey / fetchMixinKeyFromNav / ensureValidMixin。
//
// 算法：
//   1. GET /x/web-interface/nav 拿 data.wbi_img.{img_url,sub_url}（匿名也可用）；
//   2. 取两个 URL 的最后一段文件名（去扩展名）拼成 64 字符 raw；
//   3. mixinKey = raw 按 MIXIN_INDEX 重排后的前 32 字符；
//   4. 参数值去掉 !'()* ，加 wts=秒级时间戳，按键名排序；
//   5. w_rid = md5(urlEncode(k)=urlEncode(v) 用 & 连接 + mixinKey)。
//
// 与原实现的两处差异（都已注释在代码里）：
//   - 原实现还有一条 GenWebTicket 的 HKDF/HMAC 兜底，这里没做（匿名 nav 够用）；
//   - 原实现用 HttpUrl 组装，这里用 URL + URLSearchParams 等价实现。

import { md5 } from './md5.mjs';

/** Wbi 图像 URL 的重排索引表。 */
const MIXIN_INDEX = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 62, 6, 63, 57, 20, 34, 52, 59, 11, 36, 44,
];

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
/** mixin key 缓存时长（原实现为 10 分钟）。 */
const MIXIN_KEY_TTL_MS = 10 * 60 * 1000;

/** 原实现的 filterValue：参数值里的这五个字符会被丢弃。 */
const filterValue = (value) => String(value).replace(/[!'()*]/g, '');

const encode = (value) => encodeURIComponent(String(value));

/** 从 .../7cd084941338484aae1ad9425b84077c.png 这样的 URL 里取文件名主干。 */
const keyFromUrl = (url) => {
    const last = String(url).split('/').pop() ?? '';
    const dot = last.indexOf('.');
    return dot >= 0 ? last.slice(0, dot) : last;
};

const deriveMixinKey = (imgUrl, subUrl) => {
    const raw = keyFromUrl(imgUrl) + keyFromUrl(subUrl);
    if (raw.length < 64) throw new Error(`wbi: mixin url too short (${raw.length})`);
    let mixed = '';
    for (const index of MIXIN_INDEX) mixed += raw[index] ?? '';
    return mixed.length >= 32 ? mixed.slice(0, 32) : mixed;
};

/**
 * 创建签名器。
 *
 * @param getJson 形如 (url, init) => Promise<object>，失败时应返回 null；
 *               注入而不是直接依赖 folium，方便在没有宿主的环境里测试。
 */
export const createWbiSigner = (getJson) => {
    let mixinKey = null;
    let cachedAt = 0;
    let inflight = null;

    const fetchMixinKey = async () => {
        const payload = await getJson(NAV_URL);
        const wbiImg = payload?.data?.wbi_img;
        const imgUrl = wbiImg?.img_url;
        const subUrl = wbiImg?.sub_url;
        if (!imgUrl || !subUrl) throw new Error('wbi: nav did not return wbi_img');
        return deriveMixinKey(imgUrl, subUrl);
    };

    const resolveMixinKey = async () => {
        const now = Date.now();
        if (mixinKey && now - cachedAt < MIXIN_KEY_TTL_MS) return mixinKey;
        // 并发调用共用同一次刷新，避免同时打多次 nav
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const key = await fetchMixinKey();
                mixinKey = key;
                cachedAt = Date.now();
                return key;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    };

    return {
        /** 清掉缓存，下一次 sign 会重新拉 nav。 */
        invalidate() {
            mixinKey = null;
            cachedAt = 0;
        },

        /**
         * 给 base 加上签名参数，返回可直接请求的完整 URL。
         * 抛错表示这次调用拿不到密钥，调用方应把它当作一次普通的网络失败处理。
         */
        async sign(base, params = {}) {
            const key = await resolveMixinKey();
            const sorted = Object.entries({ ...params })
                .map(([name, value]) => [name, filterValue(value)])
                .concat([['wts', String(Math.floor(Date.now() / 1000))]])
                .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

            const query = sorted.map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
            const wRid = md5(query + key);

            const search = new URLSearchParams();
            for (const [name, value] of sorted) search.append(name, value);
            search.append('w_rid', wRid);
            return `${base}?${search.toString()}`;
        },
    };
};
