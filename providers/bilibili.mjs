// providers/bilibili.mjs
//
// B 站音源。移植自 NeriPlayer 的：
//   core/api/bili/BiliClient.kt              （搜索 / WBI / 取流）
//   core/api/bili/BiliSongResolver.kt        （歌曲映射）
// 只取了音源所需的最小集合：搜索、Cid 解析、取音频流、歌词回退。
// 收藏夹 / UP 主空间 / 评论 / 扫码登录等 NeriPlayer 里为完整客户端准备的部分没有搬。

import { cleanTrackName, stripHtml } from '../lib/match.mjs';
import { createWbiSigner } from '../lib/wbi.mjs';

const API_ROOT = 'https://api.bilibili.com';
const SEARCH_URL = `${API_ROOT}/x/web-interface/wbi/search/type`;
const VIEW_URL = `${API_ROOT}/x/web-interface/wbi/view`;
const PAGELIST_URL = `${API_ROOT}/x/player/pagelist`;
const PLAY_URL = `${API_ROOT}/x/player/wbi/playurl`;

/** 与原实现同款 Web UA：接口对 UA 敏感，别改。 */
const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS = {
    'User-Agent': WEB_UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
};

const ID_PREFIX = 'bili:';

/** 搜索结果的 page_size 上限（接口实际为 50）。 */
const MAX_PAGE_SIZE = 50;
/** Cid 缓存的条目上限，防止长会话里无限增长。 */
const CID_CACHE_LIMIT = 500;

/**
 * 音频流 id → 档位。B 站 DASH 音频的 id 是固定的几个值：
 *   30216 = 64K   30232 = 132K   30280 = 192K   30250 = 杜比   30251 = Hi-Res FLAC
 */
const TIER_BY_STREAM_ID = { 30216: 0, 30232: 1, 30280: 2, 30250: 3, 30251: 4 };
/** FoliumAudioQuality → 允许的最高档位。 */
const MAX_TIER_BY_QUALITY = { standard: 1, high: 2, lossless: 3, hires: 4 };

const streamTier = (stream) => TIER_BY_STREAM_ID[Number(stream?.id)] ?? 1;

const ensureHttps = (url) => {
    const value = String(url ?? '');
    if (!value) return undefined;
    if (value.startsWith('//')) return `https:${value}`;
    if (value.startsWith('http://')) return value.replace('http://', 'https://');
    return value;
};

/** 搜索结果的时长是 "MM:SS" 或 "HH:MM:SS"。 */
const parseDurationToMs = (value) => {
    const parts = String(value ?? '').split(':').map((part) => Number(part));
    if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return undefined;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return seconds > 0 ? seconds * 1000 : undefined;
};

/** 从取流 URL 里读 deadline（秒级时间戳）作为过期时间。 */
const deadlineFromUrl = (url) => {
    try {
        const raw = new URL(url).searchParams.get('deadline');
        const seconds = Number(raw);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    } catch {
        return undefined;
    }
};

const makeSongId = (bvid, cid) => `${ID_PREFIX}${bvid}${cid ? `:${cid}` : ''}`;

const parseSongId = (id) => {
    const raw = String(id ?? '');
    const body = raw.startsWith(ID_PREFIX) ? raw.slice(ID_PREFIX.length) : raw;
    const [bvid = '', cid = ''] = body.split(':');
    const parsedCid = Number(cid);
    return { bvid, cid: Number.isFinite(parsedCid) && parsedCid > 0 ? parsedCid : null };
};

/**
 * 创建 B 站 provider 定义（直接交给 folium.experimental['omni.providers'].register）。
 *
 * @param http   lib/http.mjs 的封装
 * @param lrclib 歌词后端
 * @param log    folium.log
 */
export const createBilibiliProvider = ({ http, lrclib, log }) => {
    const wbi = createWbiSigner((url) => http.json(url, { headers: HEADERS }));
    /** bvid → { cid, durationMs, partName }。搜索接口不返回 cid，取流时补。 */
    const partCache = new Map();

    const rememberPart = (bvid, part) => {
        if (partCache.size >= CID_CACHE_LIMIT) {
            const oldest = partCache.keys().next().value;
            if (oldest !== undefined) partCache.delete(oldest);
        }
        partCache.set(bvid, part);
    };

    const signedGet = async (base, params) => {
        let url;
        try {
            url = await wbi.sign(base, params);
        } catch (error) {
            log?.warn?.('wbi signing failed', { message: String(error?.message ?? error) });
            // 签名器本身可能持有过期密钥，丢掉缓存让下一次重拉
            wbi.invalidate();
            return null;
        }
        return http.json(url, { headers: HEADERS });
    };

    /**
     * 取视频的分 P 列表。用 /x/player/pagelist 而不是 /x/web-interface/wbi/view：
     * 前者不要求 WBI 签名、不要求 cookie，实测最稳；后者在实测网络里对正确的 bvid
     * 和 aid 都返回 code -404，而同一个 bvid 在 pagelist 里能正常拿到 cid。
     *
     * @returns {Promise<{ cid: number, partName: string, durationMs: number } | null>}
     */
    const fetchFirstPart = async (bvid) => {
        const cached = partCache.get(bvid);
        if (cached) return cached;

        const payload = await signedGet(PAGELIST_URL, { bvid });
        if (payload?.code !== 0 || !Array.isArray(payload?.data) || payload.data.length === 0) {
            log?.info?.('bili pagelist failed', { bvid, code: payload?.code, message: payload?.message });
            return null;
        }

        const first = payload.data[0];
        const cid = Number(first?.cid);
        if (!Number.isFinite(cid) || cid <= 0) return null;

        const part = {
            cid,
            partName: typeof first?.part === 'string' ? first.part : '',
            durationMs: Number(first?.duration) > 0 ? Number(first.duration) * 1000 : 0,
        };
        rememberPart(bvid, part);
        return part;
    };

    /** 只有在 pagelist 拿不到时才退到 view；它可能带更完整的元数据，但要求更苛刻。 */
    const fetchView = async (bvid) => {
        const payload = await signedGet(VIEW_URL, { bvid });
        return payload?.code === 0 ? (payload.data ?? null) : null;
    };

    /** 在候选流里按档位挑一条。优先取不超过请求档位的最高档。 */
    const pickStream = (streams, quality) => {
        const usable = (Array.isArray(streams) ? streams : []).filter(
            (stream) => typeof stream?.baseUrl === 'string' && stream.baseUrl.length > 0,
        );
        if (usable.length === 0) return null;

        const maxTier = MAX_TIER_BY_QUALITY[quality] ?? MAX_TIER_BY_QUALITY.high;
        const withinCap = usable.filter((stream) => streamTier(stream) <= maxTier);
        const pool = withinCap.length > 0 ? withinCap : usable;

        return pool.reduce((best, current) => {
            const bestTier = streamTier(best);
            const currentTier = streamTier(current);
            if (currentTier !== bestTier) return currentTier > bestTier ? current : best;
            return (Number(current.bandwidth) || 0) > (Number(best.bandwidth) || 0) ? current : best;
        });
    };

    return {
        id: 'bilibili',
        displayName: 'Bilibili（NeriPlayer 桥）',
        shortName: 'B站',

        async search(query, page) {
            const keyword = String(query ?? '').trim();
            if (!keyword) return { items: [], hasMore: false };

            const pageSize = Math.min(Math.max(Number(page?.limit) || 20, 1), MAX_PAGE_SIZE);
            const pageNumber = Math.floor((Number(page?.offset) || 0) / pageSize) + 1;

            const payload = await signedGet(SEARCH_URL, {
                search_type: 'video',
                keyword,
                order: 'totalrank',
                duration: '0',
                tids: '0',
                page: String(pageNumber),
                page_size: String(pageSize),
            });
            if (payload?.code !== 0) {
                log?.info?.('bili search failed', { code: payload?.code, message: payload?.message });
                return { items: [], hasMore: false };
            }

            const data = payload?.data ?? {};
            const items = (Array.isArray(data.result) ? data.result : [])
                .filter((entry) => entry?.type === 'video' && entry?.bvid)
                .map((entry) => ({
                    id: makeSongId(entry.bvid, null),
                    title: stripHtml(entry.title) || entry.bvid,
                    artists: entry.author ? [stripHtml(entry.author)] : [],
                    coverUrl: ensureHttps(entry.pic),
                    durationMs: parseDurationToMs(entry.duration),
                }));

            const totalPages = Number(data.numPages);
            const hasMore = Number.isFinite(totalPages)
                ? pageNumber < totalPages
                : items.length >= pageSize;

            return { items, hasMore, total: Number(data.numResults) || undefined };
        },

        async getSong(id) {
            const { bvid, cid } = parseSongId(id);
            if (!bvid) return null;

            const part = await fetchFirstPart(bvid);
            const resolvedCid = cid ?? part?.cid;
            if (!resolvedCid) return null;

            // view 能给出真正的标题与封面；拿不到就退回分 P 名（对 MV 来说通常就是曲名）
            const view = await fetchView(bvid);
            const title = view?.title || part?.partName || bvid;
            const owner = view?.owner?.name;

            return {
                id: makeSongId(bvid, resolvedCid),
                title: String(title).trim() || bvid,
                artists: owner ? [owner] : [],
                coverUrl: ensureHttps(view?.pic),
                durationMs: part?.durationMs > 0
                    ? part.durationMs
                    : Number(view?.duration) > 0 ? Number(view.duration) * 1000 : undefined,
            };
        },

        async getAudioUrl(song, quality) {
            const { bvid, cid } = parseSongId(song?.id);
            if (!bvid) return null;

            const resolvedCid = cid ?? (await fetchFirstPart(bvid))?.cid;
            if (!resolvedCid) {
                log?.warn?.('bili cid unresolved', { bvid });
                return null;
            }

            const payload = await signedGet(PLAY_URL, {
                bvid,
                cid: String(resolvedCid),
                // fnval=16 要 DASH（只有 DASH 才给纯音频流）；这几个常量都不要改
                fnval: '16',
                fnver: '0',
                fourk: '1',
                otype: 'json',
                platform: 'pc',
            });
            if (payload?.code !== 0) {
                log?.info?.('bili playurl failed', { bvid, cid: resolvedCid, code: payload?.code });
                return null;
            }

            const stream = pickStream(payload?.data?.dash?.audio, quality);
            if (!stream) {
                log?.warn?.('bili returned no usable audio stream', { bvid, cid: resolvedCid });
                return null;
            }

            const url = ensureHttps(stream.baseUrl);
            const expiresAt = deadlineFromUrl(url);
            return expiresAt ? { url, expiresAt } : { url };
        },

        async getLyrics(song) {
            if (!lrclib) return null;
            const title = cleanTrackName(song?.title ?? '');
            const artist = (Array.isArray(song?.artists) ? song.artists[0] : '') ?? '';
            try {
                // relaxedDuration：B 站是视频源，时长天然长于录音室版本（MV 常有前奏/尾奏），
                // 拿严格时长去卡会大面积漏掉。宽松模式下时长只用于排序，不用于淘汰。
                const found = await lrclib.lookup({
                    title,
                    artist,
                    durationMs: Number(song?.durationMs) || 0,
                    relaxedDuration: true,
                });
                return found ? { lrc: found.lrc } : null;
            } catch (error) {
                log?.warn?.('lyric lookup failed', { message: String(error?.message ?? error) });
                return null;
            }
        },
    };
};
