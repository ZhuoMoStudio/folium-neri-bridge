// providers/youtube.mjs
//
// YouTube Music（InnerTube）音源。**只做搜索与元数据，不做播放**，原因见下。
//
// ── 实测记录（2026-09-27，本沙盒，Node 22 + 直连）────────────────────────────
//
//   搜索结果：✅ 匿名可用。POST music.youtube.com/youtubei/v1/search，
//             context.client = WEB_REMIX，返回 20 条 musicResponsiveListItemRenderer，
//             标题/艺术家/专辑/时长齐全（实测「yoru ni kakeru」首条 by4SYYWlhEs = 夜に駆ける / YOASOBI）。
//
//   播放地址：❌ 匿名拿不到。同一个 videoId 在所有匿名客户端下都拿不到 streamingData：
//             - WEB_REMIX（首页下发的最新 clientVersion 1.20260922.09.00）→ UNPLAYABLE / Video unavailable
//             - WEB（2.20260925.01.00）                                  → UNPLAYABLE / Video unavailable
//             - ANDROID_VR 1.62.27 / 1.60.19                             → LOGIN_REQUIRED / Sign in to confirm you're not a bot
//             - TVHTML5 7.x / TVHTML5_SIMPLY_EMBEDDED_PLAYER 2.0         → LOGIN_REQUIRED（后者：YouTube is no longer supported…）
//             - MWEB                                                      → UNPLAYABLE / The page needs to be reloaded.
//             `videoDetails` 会正常返回（说明请求本身没问题，视频也存在，oEmbed 200 可证），
//             缺的只是 streamingData —— 也就是 PO Token / BotGuard 那一关。
//
//   PO Token 需要跑 Google 的混淆 VM（yt-dlp 要外挂 bgutil 之类的 sidecar），
//   在模组里做既不可靠也违背「不下载执行远程代码」这条自我约束。
//   所以这里**不声明 getAudioUrl**：能力表里 playback 为 false，宿主不会把它当可播放源，
//   我们也不会在运行时假装能放。等哪天匿名播放真的开了，test/09-youtube.mjs 的金丝雀会先失败。
//
// ── 参考 ─────────────────────────────────────────────────────────────────
//   sigma67/ytmusicapi（MIT）：请求形状与「只支持 cookie 认证」的结论
//   yt-dlp/yt-dlp（Unlicense）：客户端模拟的通用参考
//   TeamNewPipe/NewPipe、maxrave-dev/SimpMusic（GPL-3.0）：免 PO Token 的路线（现已失效）

import { cleanTrackName } from '../lib/match.mjs';

const ORIGIN = 'https://music.youtube.com';
const SEARCH_ENDPOINT = `${ORIGIN}/youtubei/v1/search?prettyPrint=false`;
const PLAYER_ENDPOINT = `${ORIGIN}/youtubei/v1/player?prettyPrint=false`;
const HOME_URL = `${ORIGIN}/`;

const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 首页读不到 clientVersion 时的退路。实测这个版本搜索仍然可用。 */
const FALLBACK_CLIENT_VERSION = '1.20250101.01.00';
/** 首页元数据的缓存时长。clientVersion 跟着发版走，没必要每次搜索都问一次。 */
const HOME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** InnerTube 的「只看歌曲」过滤参数（与 ytmusicapi 用的同一个）。 */
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
/** 最多记住几个查询的翻页令牌。 */
const CONTINUATION_CACHE_LIMIT = 16;
const MAX_PAGE_SIZE = 50;

const ID_PREFIX = 'yt:';

const HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': WEB_UA,
    Origin: ORIGIN,
    'X-Goog-Api-Format-Version': '2',
};

const makeSongId = (videoId) => `${ID_PREFIX}${videoId}`;

const parseSongId = (id) => {
    const raw = String(id ?? '');
    const body = raw.startsWith(ID_PREFIX) ? raw.slice(ID_PREFIX.length) : raw;
    return /^[\w-]{6,20}$/.test(body) ? body : '';
};

/** "4:22" / "1:02:33" → 毫秒。 */
const parseDurationToMs = (value) => {
    const parts = String(value ?? '').trim().split(':').map((part) => Number(part));
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return undefined;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return seconds > 0 ? seconds * 1000 : undefined;
};

/**
 * YouTube 的频道名常常带 " - Topic"（自动生成的音乐频道），那不是艺术家名的一部分。
 * 留着会让艺术家匹配整体偏掉，所以在这里剪掉。
 */
export const cleanChannelName = (value) =>
    String(value ?? '')
        .replace(/\s*-\s*Topic\s*$/i, '')
        .trim();

/** 在 renderer 树里收集指定 key 的节点。InnerTube 的层级不稳定，只能靠递归找。 */
export const collectRenderers = (node, key, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (node[key]) out.push(node[key]);
    for (const value of Object.values(node)) collectRenderers(value, key, out);
    return out;
};

const runsText = (runs) => (Array.isArray(runs) ? runs.map((run) => run?.text ?? '').join('') : '');

/** 一条 musicResponsiveListItemRenderer → { id, title, artists, album, durationMs }。 */
export const parseSearchItem = (renderer) => {
    const videoId = renderer?.playlistItemData?.videoId;
    if (typeof videoId !== 'string' || !videoId) return null;

    const columns = (renderer?.flexColumns ?? []).map((column) =>
        runsText(column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs).trim(),
    );
    const title = columns[0] || '';
    if (!title) return null;

    // 第二列形如 "YOASOBI • 夜に駆ける • 4:22"（有时只有 "艺术家 • 时长"）
    const parts = (columns[1] ?? '').split('•').map((part) => part.trim()).filter(Boolean);
    const durationIndex = parts.findIndex((part) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(part));
    const durationMs = durationIndex >= 0 ? parseDurationToMs(parts[durationIndex]) : undefined;
    const meta = durationIndex >= 0 ? parts.slice(0, durationIndex) : parts;

    return {
        id: makeSongId(videoId),
        title,
        artists: meta.length > 0 ? [meta[0]] : [],
        album: meta.length > 1 ? meta.slice(1).join(' • ') : undefined,
        durationMs,
        videoId,
    };
};

/** 翻页令牌。放在 musicShelfRenderer（搜索）或 sectionListRenderer 的续页节点上。 */
const findContinuation = (json) => {
    for (const node of collectRenderers(json, 'nextContinuationData')) {
        if (typeof node?.continuation === 'string') return node.continuation;
    }
    for (const node of collectRenderers(json, 'continuationEndpoint')) {
        const token = node?.continuationCommand?.token;
        if (typeof token === 'string') return token;
    }
    return null;
};

/**
 * 建一个 YouTube Music provider。
 *
 * `getAudioUrl` 故意不实现 —— 见文件顶部的实测记录。
 *
 * @param http       lib/http.mjs 的封装
 * @param lrclib     歌词后端（可选）
 * @param log        folium.log
 * @param wordTiming 逐字歌词的预备通道（可选）
 */
export const createYoutubeProvider = ({ http, lrclib, log, wordTiming }) => {
    let home = null;
    let homeAt = 0;
    /** 查询 → 翻页令牌。offset 大于 0 时用它续页。 */
    const continuations = new Map();

    const rememberContinuation = (query, token) => {
        if (continuations.size >= CONTINUATION_CACHE_LIMIT) {
            const oldest = continuations.keys().next().value;
            if (oldest !== undefined) continuations.delete(oldest);
        }
        continuations.set(query, token);
    };

    /** 首页里的 clientVersion / visitorData。抓不到就用常量，搜索仍可用。 */
    const ensureHome = async () => {
        if (home && Date.now() - homeAt < HOME_CACHE_TTL_MS) return home;
        const html = await http.text(HOME_URL, { timeoutMs: 15000, headers: { 'User-Agent': WEB_UA } });
        const pick = (key) => {
            const match = String(html ?? '').match(new RegExp(`"${key}":"([^"]+)"`));
            return match?.[1];
        };
        home = {
            clientVersion: pick('INNERTUBE_CLIENT_VERSION') ?? FALLBACK_CLIENT_VERSION,
            visitorData: pick('VISITOR_DATA'),
        };
        homeAt = Date.now();
        log?.info?.('youtube: home metadata resolved', { clientVersion: home.clientVersion });
        return home;
    };

    const contextFor = async () => {
        const resolved = await ensureHome();
        return {
            client: {
                clientName: 'WEB_REMIX',
                clientVersion: resolved.clientVersion,
                hl: 'en',
                gl: 'US',
                ...(resolved.visitorData ? { visitorData: resolved.visitorData } : {}),
            },
        };
    };

    const post = async (endpoint, body) => http.json(endpoint, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });

    /**
     * player 端点。**只用来读 videoDetails（标题/时长/频道），不碰 streamingData。**
     * 也把 streamingData 的计数一并报出来，供 test/09-youtube.mjs 的金丝雀用：
     * 一旦匿名 streamingData 出现，就说明 YouTube 放开了，那时应该回来实现 getAudioUrl。
     */
    const fetchPlayerStatus = async (videoId) => {
        const payload = await post(PLAYER_ENDPOINT, {
            context: await contextFor(),
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
        });
        if (!payload) return null;
        const adaptive = (payload?.streamingData?.adaptiveFormats ?? []).filter((format) =>
            String(format?.mimeType ?? '').startsWith('audio'),
        );
        return {
            status: String(payload?.playabilityStatus?.status ?? 'unknown'),
            reason: String(payload?.playabilityStatus?.reason ?? ''),
            details: payload?.videoDetails ?? null,
            audioFormatCount: adaptive.length,
            playable: adaptive.some((format) => typeof format.url === 'string'),
        };
    };

    return {
        id: 'youtube',
        displayName: 'YouTube Music（仅搜索，播放不可用）',
        shortName: 'YT',

        async search(query, page) {
            const keyword = String(query ?? '').trim();
            if (!keyword) return { items: [], hasMore: false };

            const pageSize = Math.min(Math.max(Number(page?.limit) || 20, 1), MAX_PAGE_SIZE);
            const offset = Math.max(Number(page?.offset) || 0, 0);
            const token = offset > 0 ? continuations.get(keyword) : null;

            // 续页时不能再带 query：InnerTube 要求二者之一
            const body = token
                ? { context: await contextFor(), continuation: token }
                : { context: await contextFor(), query: keyword, params: SONGS_FILTER };

            const payload = await post(SEARCH_ENDPOINT, body);
            if (!payload) {
                log?.info?.('youtube: search request failed', { query: keyword, offset });
                return { items: [], hasMore: false };
            }

            const items = collectRenderers(payload, 'musicResponsiveListItemRenderer')
                .map(parseSearchItem)
                .filter(Boolean);

            const next = findContinuation(payload);
            if (next) rememberContinuation(keyword, next);
            else continuations.delete(keyword);

            return {
                items,
                // 拿不到令牌就是没有下一页；InnerTube 不给总数
                hasMore: Boolean(next) && items.length > 0,
            };
        },

        async getSong(id) {
            const videoId = parseSongId(id);
            if (!videoId) return null;

            const status = await fetchPlayerStatus(videoId);
            const details = status?.details;
            if (!details) return null;

            const lengthSeconds = Number(details.lengthSeconds);
            return {
                id: makeSongId(videoId),
                title: String(details.title ?? '').trim() || videoId,
                artists: details.author ? [cleanChannelName(details.author)] : [],
                durationMs: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds * 1000 : undefined,
            };
        },

        /**
         * 歌词还是走 LRCLIB + AMLL 那两条路（YouTube 自己不提供歌词接口给匿名调用）。
         * 注意：因为播放不可用，这个 provider 的歌通常不会被真正播放，
         * 这条路径实际是为「以后接上播放」准备的。
         */
        async getLyrics(song) {
            const title = cleanTrackName(song?.title ?? '');
            const artists = (Array.isArray(song?.artists) ? song.artists : []).map(cleanChannelName).filter(Boolean);
            const durationMs = Number(song?.durationMs) || 0;
            if (!title) return null;

            if (wordTiming) {
                try {
                    await wordTiming.prepare({ key: song?.id, title, artists, durationMs });
                } catch (error) {
                    log?.warn?.('youtube: word timing prepare failed', { message: String(error?.message ?? error) });
                }
            }

            if (!lrclib) return null;
            try {
                const found = await lrclib.lookup({ title, artists, durationMs, relaxedDuration: false });
                return found ? { lrc: found.lrc } : null;
            } catch (error) {
                log?.warn?.('youtube: lyric lookup failed', { message: String(error?.message ?? error) });
                return null;
            }
        },
    };
};

export const YOUTUBE_LIMITS = { MAX_PAGE_SIZE, HOME_CACHE_TTL_MS };
