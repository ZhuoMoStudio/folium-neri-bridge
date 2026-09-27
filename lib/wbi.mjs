// lib/wbi.mjs
//
// B 站 WBI 签名。移植自 NeriPlayer 的
//   app/src/main/java/moe/ouom/neriplayer/core/api/bili/BiliClient.kt
// 原实现见 signWbiUrl / getOrRefreshMixinKey / fetchMixinKey / fetchMixinKeyFromNav /
// fetchMixinKeyFromTicket / ensureValidMixin / webTicketHmacSha256Hex。
//
// 算法：
//   1. 拿 data.wbi_img.{img_url,sub_url}（两条路径，见下）；
//   2. 取两个 URL 的最后一段文件名（去扩展名）拼成 64 字符 raw；
//   3. mixinKey = raw 按 MIXIN_INDEX 重排后的前 32 字符；
//   4. 参数值去掉 !'()* ，加 wts=秒级时间戳，按键名排序；
//   5. w_rid = md5(urlEncode(k)=urlEncode(v) 用 & 连接 + mixinKey)。
//
// 两条密钥路径（与原实现一致）：
//   a) GET /x/web-interface/nav  —— 匿名可用，日常走这条；
//   b) POST /bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket —— nav 失败时的兜底。
//      ticket 要一个 HMAC-SHA256 的 hexsign，消息是 `ts<秒级时间戳>`，密钥是下面那个常量，
//      用的是 WebCrypto（crypto.subtle）。Folia 的开发页（http://localhost:3000）与生产页
//      （file://）都是安全上下文，所以有它；万一没有，**降级并打警告**，不静默失败。
//
// 与原实现的差异：原实现用 HttpUrl 组装，这里用 URL + URLSearchParams 等价实现。

import { md5 } from './md5.mjs';

/** Wbi 图像 URL 的重排索引表。 */
const MIXIN_INDEX = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 62, 6, 63, 57, 20, 34, 52, 59, 11, 36, 44,
];

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const WEB_TICKET_URL = 'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';
/** WebTicket 的 key_id。 */
const WEB_TICKET_KEY_ID = 'ec02';
/** WebTicket 的 HMAC 密钥。 */
const WEB_TICKET_KEY = 'XgwSnGZ1p';
/**
 * WebTicket 接口专用 UA。**和普通接口不同**，原实现里就是两个独立常量，
 * 混用会被拒绝 —— 别顺手改成 WEB_UA。
 */
const WEB_TICKET_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0';
const WEB_TICKET_REFERER = 'https://www.bilibili.com/';

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

/**
 * 从一对 wbi 图像 URL 推出 mixin key。导出是为了让测试能直接对着已知值校验 ——
 * 经由 sign() 的结果去反证会带上时间戳，跨秒时不稳定。
 */
export const deriveMixinKey = (imgUrl, subUrl) => {
    const raw = keyFromUrl(imgUrl) + keyFromUrl(subUrl);
    if (raw.length < 64) throw new Error(`wbi: mixin url too short (${raw.length})`);
    let mixed = '';
    for (const index of MIXIN_INDEX) mixed += raw[index] ?? '';
    return mixed.length >= 32 ? mixed.slice(0, 32) : mixed;
};

/**
 * HMAC-SHA256 的十六进制小写。
 *
 * 用 WebCrypto。拿不到 `crypto.subtle` 时**返回 null**（而不是抛错或返回垃圾）：
 * 调用方据此判断「这条路径在这个环境里不可用」并给出可读的日志。
 *
 * @param subtle 注入点，默认取 `globalThis.crypto.subtle`；测试用它跑 Node 侧对照。
 */
export const hmacSha256Hex = async (key, message, subtle = globalThis.crypto?.subtle) => {
    if (!subtle?.importKey || !subtle?.sign || typeof TextEncoder === 'undefined') return null;
    try {
        const encoder = new TextEncoder();
        const cryptoKey = await subtle.importKey(
            'raw',
            encoder.encode(key),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const signature = await subtle.sign('HMAC', cryptoKey, encoder.encode(message));
        return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
};

/** 拼 WebTicket 的查询串。`context[ts]` 会被 URLSearchParams 编码成 context%5Bts%5D，正确。 */
export const buildWebTicketUrl = (hexsign, ts, csrf = '') => {
    const search = new URLSearchParams();
    search.set('key_id', WEB_TICKET_KEY_ID);
    search.set('hexsign', hexsign);
    search.set('context[ts]', String(ts));
    if (csrf) search.set('csrf', csrf);
    return `${WEB_TICKET_URL}?${search.toString()}`;
};

/**
 * 创建签名器。
 *
 * @param getJson (url, init?) => Promise<object|null>，失败时应返回 null；
 *                注入而不是直接依赖 folium，方便在没有宿主的环境里测试。
 *                init 省略时由调用方自带默认头（nav 那条路就是这样）；
 *                给了 init 就按 init 走（ticket 那条路要换 UA 和 method）。
 * @param options.getCsrf 取 bili_jct，有就带进 ticket 的查询串
 * @param options.log     注入日志，用来记录「降级」这件事
 * @param options.hmac    HMAC 实现，默认 hmacSha256Hex
 */
export const createWbiSigner = (getJson, options = {}) => {
    const log = options?.log;
    const getCsrf = typeof options?.getCsrf === 'function' ? options.getCsrf : () => '';
    const hmac = typeof options?.hmac === 'function' ? options.hmac : hmacSha256Hex;

    let mixinKey = null;
    let cachedAt = 0;
    let inflight = null;

    const mixinFromUrls = (imgUrl, subUrl, source) => {
        if (!imgUrl || !subUrl) throw new Error(`wbi: ${source} did not return a usable mixin url`);
        try {
            return deriveMixinKey(imgUrl, subUrl);
        } catch (error) {
            throw new Error(`wbi: ${source} mixin url unusable: ${String(error?.message ?? error)}`);
        }
    };

    /** 路径 a：nav。匿名可用，最常用。 */
    const fetchMixinKeyFromNav = async () => {
        const payload = await getJson(NAV_URL);
        const wbiImg = payload?.data?.wbi_img;
        return mixinFromUrls(wbiImg?.img_url, wbiImg?.sub_url, 'nav');
    };

    /** 路径 b：GenWebTicket。nav 失败时的兜底。 */
    const fetchMixinKeyFromTicket = async () => {
        const ts = Math.floor(Date.now() / 1000);
        const hexsign = await hmac(WEB_TICKET_KEY, `ts${ts}`);
        if (typeof hexsign !== 'string' || !/^[0-9a-f]{64}$/.test(hexsign)) {
            // 这里不抛「HMAC 失败」就完事：要让调用方看得出是环境缺 WebCrypto，而不是网络问题
            const error = new Error('wbi: crypto.subtle is unavailable; cannot sign the web ticket');
            error.code = 'no-subtle-crypto';
            throw error;
        }
        const payload = await getJson(buildWebTicketUrl(hexsign, ts, getCsrf()), {
            method: 'POST',
            headers: { 'User-Agent': WEB_TICKET_UA, Referer: WEB_TICKET_REFERER },
        });
        const nav = payload?.data?.nav;
        if (!nav?.img || !nav?.sub) {
            throw new Error(`wbi: ticket returned no nav (code ${payload?.code ?? 'no response'})`);
        }
        return mixinFromUrls(nav.img, nav.sub, 'ticket');
    };

    /** 先 nav 后 ticket。两条都失败时把两条的原因都带上，别只说最后一条。 */
    const fetchMixinKey = async () => {
        try {
            return await fetchMixinKeyFromNav();
        } catch (navError) {
            const navMessage = String(navError?.message ?? navError);
            log?.warn?.('wbi: nav key path failed; falling back to the web ticket', { message: navMessage });
            try {
                const key = await fetchMixinKeyFromTicket();
                log?.info?.('wbi: mixin key obtained from the web ticket fallback');
                return key;
            } catch (ticketError) {
                const ticketMessage = String(ticketError?.message ?? ticketError);
                if (ticketError?.code === 'no-subtle-crypto') {
                    log?.warn?.('wbi: no crypto.subtle in this environment; the ticket fallback is unusable');
                }
                throw new Error(`wbi: both key paths failed (nav: ${navMessage}; ticket: ${ticketMessage})`);
            }
        }
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
        /** 清掉缓存，下一次 sign 会重新拉密钥。 */
        invalidate() {
            mixinKey = null;
            cachedAt = 0;
        },

        /** 供测试与日志用：当前是否持有有效密钥。 */
        hasCachedKey() {
            return Boolean(mixinKey) && Date.now() - cachedAt < MIXIN_KEY_TTL_MS;
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
