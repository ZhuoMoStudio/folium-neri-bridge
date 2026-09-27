// providers/bilibili.mjs
//
// B 站音源。移植自 NeriPlayer 的：
//   core/api/bili/BiliClient.kt              （搜索 / WBI / 取流）
//   core/api/bili/BiliSongResolver.kt        （歌曲映射）
// 只取了音源所需的最小集合：搜索、Cid 解析、取音频流、歌词回退。
// 收藏夹 / UP 主空间 / 评论 / 扫码登录等 NeriPlayer 里为完整客户端准备的部分没有搬。
//
// 艺术家候选（lib/artist-candidates.mjs）是本仓库新加的：B 站搜索只给 UP 主名，
// 那对歌词匹配等于没有信息，所以从标题/简介/合作者里再提一批候选出来。

import { artistCandidatesFromTitle, extractArtistCandidates } from '../lib/artist-candidates.mjs';
import { parseCookieHeader } from '../lib/bili-cookie.mjs';
import { parseVideoRef } from '../lib/bili-video-ref.mjs';
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
/** Cid / view / 旁路候选缓存的条目上限，防止长会话里无限增长。 */
const CID_CACHE_LIMIT = 500;
/** getSong 对外显示的艺术家个数上限：候选是给匹配用的，不是给界面堆名字用的。 */
const DISPLAY_ARTIST_LIMIT = 3;

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
 * @param http       lib/http.mjs 的封装
 * @param lrclib     歌词后端（可选）
 * @param log        folium.log
 * @param getCookie  取当前 Cookie 头
 * @param wordTiming 逐字歌词的「预备」通道（可选）。见 client.mjs：
 *        provider 在 getLyrics 里把逐字时轴先取好放进去，宿主随后调用的
 *        omni.lyricsResolved 钩子只有 1.5s 预算，来不及联网。
 */
export const createBilibiliProvider = ({ http, lrclib, log, getCookie, wordTiming }) => {
    /**
     * 每次请求现取一次头：登录态可能在会话中被改（面板里登录/退出），
     * 把 Cookie 固定在模块常量里就会一直用旧的。
     */
    const headersFor = () => {
        const cookie = typeof getCookie === 'function' ? getCookie() : '';
        return cookie ? { ...HEADERS, Cookie: cookie } : HEADERS;
    };
    const loggedIn = () => Boolean(typeof getCookie === 'function' ? getCookie() : '');
    const csrfToken = () => {
        const cookie = typeof getCookie === 'function' ? getCookie() : '';
        return cookie ? (parseCookieHeader(cookie).get('bili_jct') ?? '') : '';
    };

    /**
     * 签名器要能发两种请求，所以这里把 init 一路透传：
     *   - 不给 init  → 走 headersFor()（nav，普通 UA + Cookie）
     *   - 给了 init  → 完全按 init 走（ticket，Firefox UA + POST，**不带 Cookie**，与 NeriPlayer 一致）
     */
    const wbi = createWbiSigner((url, init) => http.json(url, init ?? { headers: headersFor() }), {
        log,
        getCsrf: csrfToken,
    });

    /** bvid → 分 P 数组 [{ cid, name, durationMs }]。搜索接口不返回 cid，取流时补。 */
    const partCache = new Map();
    /** bvid → { entry }；entry 为 null 表示「这个 bvid 的 view 拿不到」，也要缓存。 */
    const viewCache = new Map();
    /**
     * bvid → 旁路来源的艺术家候选（搜索结果里的 UP 主，以及从搜索标题里提的名字）。
     *
     * 为什么需要旁路：`wbi/view` 不是稳定的元数据来源 —— 实测 BV1Ph411C7S5（YOASOBI 的
     * 夜に駆ける MV）对正确的 bvid 返回 code -404，那时 getSong 只剩分 P 名可用，
     * 艺术家会变成空列表，歌词匹配跟着一起退化。而搜索接口在同一时刻明明给了
     * 标题「YOASOBI 夜に駆ける (Yoru ni Kakeru) Official Music Video」和 UP 主名 ——
     * 前者提得出 YOASOBI，正是匹配需要的那一个。所以任何时候拿到的线索都按 bvid 攒起来。
     */
    const knownArtists = new Map();

    const remember = (cache, key, value) => {
        if (cache.size >= CID_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, value);
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
        return http.json(url, { headers: headersFor() });
    };

    /**
     * 取视频的分 P 列表。用 /x/player/pagelist 而不是 /x/web-interface/wbi/view：
     * 前者不要求 WBI 签名、不要求 cookie，实测最稳。
     *
     * 多 P 支持从这一层长出来：每个分 P 的 cid 都能拼成 `bili:BV...:cid`，
     * 那就是一首独立曲目（makeSongId / parseSongId / getAudioUrl 本来就认这个形状）。
     * 缺的从来不是 id 形状，而是「怎么把那些 cid 交到用户手里」—— 答案见 searchVideoRef。
     *
     * @returns {Promise<Array<{ cid: number, name: string, durationMs: number }> | null>}
     */
    const fetchParts = async (bvid) => {
        const cached = partCache.get(bvid);
        if (cached) return cached;

        const payload = await signedGet(PAGELIST_URL, { bvid });
        if (payload?.code !== 0 || !Array.isArray(payload?.data) || payload.data.length === 0) {
            log?.info?.('bili pagelist failed', { bvid, code: payload?.code, message: payload?.message });
            return null;
        }

        // 实测 250 P 的合集也走这一个请求（BV1os41197sv），所以整列表拿回来不心疼
        const parts = payload.data
            .map((entry) => ({
                cid: Number(entry?.cid),
                name: typeof entry?.part === 'string' ? entry.part : '',
                durationMs: Number(entry?.duration) > 0 ? Number(entry.duration) * 1000 : 0,
            }))
            .filter((part) => Number.isFinite(part.cid) && part.cid > 0);
        if (parts.length === 0) return null;

        remember(partCache, bvid, parts);
        return parts;
    };

    const fetchFirstPart = async (bvid) => (await fetchParts(bvid))?.[0] ?? null;

    /**
     * 定位一个分 P。
     *
     * 优先级：id 里的 cid → 链接里的 ?p= → 第一个。
     * `total > 1` 时标题要带分 P 名，否则一个 250 P 的合集在队列里就是 250 首同名曲目。
     *
     * cid 不在列表里时**不返回 null**：那可能是旧的收藏（分 P 被删了、稿件被重传）。
     * 元数据拿不到没关系，取流只认 cid，照样能放 —— 让队列变成「不可播放」比让它少一个名字糟得多。
     */
    const resolvePart = async (bvid, ref = {}) => {
        const parts = await fetchParts(bvid);
        if (!parts) return null;

        if (ref.cid) {
            const index = parts.findIndex((part) => part.cid === ref.cid);
            if (index >= 0) return { part: parts[index], index, total: parts.length };
            return { part: { cid: ref.cid, name: '', durationMs: 0 }, index: -1, total: parts.length };
        }
        if (ref.page) {
            const index = ref.page - 1;
            if (index >= 0 && index < parts.length) return { part: parts[index], index, total: parts.length };
        }
        return { part: parts[0], index: 0, total: parts.length };
    };

    /**
     * 曲目标题。多 P 时拼上分 P 名。
     *
     * 宿主只拿得到 title 一个字符串，所以「这是第几 P」只能写在这里。
     * 单 P 视频不拼：那种稿件的分 P 名常常等于标题（或干脆是「P1」），拼上去是噪音。
     */
    const displayTitle = ({ viewTitle, partName, bvid, total }) => {
        const name = String(partName ?? '').trim();
        const base = String(viewTitle ?? '').trim() || name || bvid;
        if (total > 1 && name && name !== base) return `${base} - ${name}`;
        return base;
    };

    /**
     * 视频元数据。给 cid 之外的用途：真正的标题、封面、简介、合作者名单。
     *
     * ⚠️ wbi/view 不是可靠的 cid 来源。实测 BV1Ph411C7S5（YOASOBI 的夜に駆ける MV）
     * 对正确的 bvid 与 aid 都返回 code -404，同一个 bvid 在 pagelist 上完全正常；
     * 所以 cid 一律走 pagelist。但它给的标题/简介是搜索接口没有的，仍然值得取。
     *
     * 失败结果也缓存（存 `{ entry: null }`）：那个 -404 的 bvid 会被 getSong / getLyrics /
     * 艺术家候选三条路各问一次，不缓存就是三次无谓的请求，还更容易触发风控。
     */
    const fetchView = async (bvid) => {
        const cached = viewCache.get(bvid);
        if (cached) return cached.entry;

        const payload = await signedGet(VIEW_URL, { bvid });
        if (payload?.code !== 0 || !payload?.data) {
            log?.info?.('bili view failed', { bvid, code: payload?.code, message: payload?.message });
            remember(viewCache, bvid, { entry: null });
            return null;
        }

        const data = payload.data;
        const ownerName = data?.owner?.name;
        const entry = {
            title: typeof data?.title === 'string' ? data.title : '',
            desc: typeof data?.desc === 'string' ? data.desc : '',
            ownerName: typeof ownerName === 'string' ? ownerName : '',
            coverUrl: ensureHttps(data?.pic),
            durationMs: Number(data?.duration) > 0 ? Number(data.duration) * 1000 : 0,
            partName: typeof data?.pages?.[0]?.part === 'string' ? data.pages[0].part : '',
            // 匹配用的完整候选列表
            artists: extractArtistCandidates({
                title: data?.title,
                ownerName,
                desc: data?.desc,
                staff: data?.staff,
            }),
        };
        remember(viewCache, bvid, { entry });
        return entry;
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

    /** 歌词匹配要用的艺术家候选：view 提的 + 旁路记下的 + 调用方给的，按优先级合并去重。 */
    const artistCandidatesFor = async (bvid, song) => {
        const view = bvid ? await fetchView(bvid) : null;
        const merged = [];
        const seen = new Set();
        const push = (values) => {
            for (const value of values ?? []) {
                const text = String(value ?? '').trim();
                if (!text) continue;
                const key = text.normalize('NFKC').toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(text);
            }
        };
        push(view?.artists);
        push(bvid ? knownArtists.get(bvid) : null);
        push(Array.isArray(song?.artists) ? song.artists : []);
        return merged;
    };

    const rememberArtists = (bvid, artists) => {
        if (!bvid || !Array.isArray(artists) || artists.length === 0) return;
        const existing = knownArtists.get(bvid) ?? [];
        const merged = [...new Set([...existing, ...artists.map((name) => String(name ?? '').trim()).filter(Boolean)])];
        if (merged.length === existing.length) return;
        if (knownArtists.size >= CID_CACHE_LIMIT) {
            const oldest = knownArtists.keys().next().value;
            if (oldest !== undefined) knownArtists.delete(oldest);
        }
        knownArtists.set(bvid, merged);
    };

    /**
     * 按视频引用取条目：一个分 P 一条，每个 id 都是 `bili:BV...:cid`。
     *
     * 为什么要从 search 走这条路：宿主给 provider 的只有 search / getSong / getAudioUrl /
     * getLyrics 四个口子（FoliumOmniProviderDef），**没有**「列出这个视频的分 P」这种接口；
     * 而 `folium.playback.playSong` 只认宿主自己发出去的 ref，模组没法凭空把一首歌塞进队列。
     * search 收的是一串文本，于是它成了唯一能把分 P 交给用户的入口。
     * 约定：搜索框里粘 BV 号或视频链接 = 要这个视频的分 P。
     *
     * 为什么不在普通关键词搜索里顺带展开多 P：一页 20 条结果就要 20 次 pagelist。
     * 点进去的那一条（getSong 会带上 cid 与分 P 名）本来就是对的，够用了。
     */
    const searchVideoRef = async (ref) => {
        const parts = await fetchParts(ref.bvid);
        if (!parts) {
            log?.info?.('bili video lookup failed', { bvid: ref.bvid });
            return { items: [], hasMore: false };
        }

        const view = await fetchView(ref.bvid);
        const artists = (await artistCandidatesFor(ref.bvid, null)).slice(0, DISPLAY_ARTIST_LIMIT);
        const displayArtists = artists.length > 0
            ? artists
            : extractArtistCandidates({ title: view?.title, limit: DISPLAY_ARTIST_LIMIT });

        // ?p=3 就要第 3 个分 P（用户从地址栏复制过来时通常只想要那一个）；
        // 给了 cid 就只要那一个；什么都没给就是整个视频。
        let selected = parts;
        if (ref.cid) {
            selected = parts.filter((part) => part.cid === ref.cid);
        } else if (ref.page) {
            selected = parts.slice(ref.page - 1, ref.page);
        }

        const items = selected.map((part) => ({
            id: makeSongId(ref.bvid, part.cid),
            title: displayTitle({
                viewTitle: view?.title,
                partName: part.name,
                bvid: ref.bvid,
                total: parts.length,
            }),
            // 与关键词搜索不同：这里的 results 是用户点名要的，标题和封面都已经拿到了，
            // 所以直接把艺术家候选放上去，不必再等 getSong 补
            artists: displayArtists,
            coverUrl: view?.coverUrl,
            durationMs: part.durationMs > 0 ? part.durationMs : view?.durationMs,
        }));
        log?.info?.('bili video lookup', {
            bvid: ref.bvid,
            parts: parts.length,
            returned: items.length,
            page: ref.page ?? undefined,
        });
        return { items, hasMore: false, total: items.length };
    };

    return {
        id: 'bilibili',
        displayName: 'Bilibili（NeriPlayer 桥）',
        shortName: 'B站',

        async search(query, page) {
            const keyword = String(query ?? '').trim();
            if (!keyword) return { items: [], hasMore: false };

            // 粘进来的是视频（BV 号 / 视频链接）就按分 P 列出来，见 searchVideoRef
            const ref = parseVideoRef(keyword);
            if (ref) return searchVideoRef(ref);

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
                .map((entry) => {
                    const title = stripHtml(entry.title) || entry.bvid;
                    const author = entry.author ? stripHtml(entry.author) : '';
                    // 搜索结果是「这个 bvid 属于这个 UP 主」以及「标题里有这个曲名」的
                    // 可靠记录；view 挂掉时就靠它兜底。标题里的名字排在 UP 主前面，
                    // 因为它更可能是曲目艺术家。
                    rememberArtists(entry.bvid, [
                        ...artistCandidatesFromTitle(title),
                        ...(author ? [author] : []),
                    ]);
                    return {
                        id: makeSongId(entry.bvid, null),
                        title,
                        // 列表里保持 B 站自己的字段（UP 主），不做标题猜测：
                        // 20 条结果逐条打 view 太重，而那个名字是用户预期看到的。
                        // 真正的艺术家候选在 getSong 与 getLyrics 里补。
                        artists: author ? [author] : [],
                        coverUrl: ensureHttps(entry.pic),
                        durationMs: parseDurationToMs(entry.duration),
                    };
                });

            const totalPages = Number(data.numPages);
            const hasMore = Number.isFinite(totalPages)
                ? pageNumber < totalPages
                : items.length >= pageSize;

            return { items, hasMore, total: Number(data.numResults) || undefined };
        },

        async getSong(id) {
            const { bvid, cid } = parseSongId(id);
            if (!bvid) return null;

            const resolved = await resolvePart(bvid, { cid });
            const resolvedCid = resolved?.part.cid ?? null;
            if (!resolvedCid) return null;

            // view 能给出真正的标题、封面与艺术家候选；拿不到就退回分 P 名
            const view = await fetchView(bvid);
            const title = displayTitle({
                viewTitle: view?.title,
                partName: resolved.part.name,
                bvid,
                total: resolved.total,
            });
            const artists = (await artistCandidatesFor(bvid, null)).slice(0, DISPLAY_ARTIST_LIMIT);

            // 标题也参与候选提取：view 挂掉时它就是唯一线索
            const displayArtists = artists.length > 0
                ? artists
                : extractArtistCandidates({ title, limit: DISPLAY_ARTIST_LIMIT });

            return {
                id: makeSongId(bvid, resolvedCid),
                title: String(title).trim() || bvid,
                artists: displayArtists,
                coverUrl: view?.coverUrl,
                // 分 P 自己的时长优先：一个 250 P 合集的总时长不是任何一首歌的时长
                durationMs: resolved.part.durationMs > 0
                    ? resolved.part.durationMs
                    : view?.durationMs > 0 ? view.durationMs : undefined,
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
            if (!loggedIn() && quality !== 'standard') {
                // 未登录时 B 站会压低可用音质；这不是错误，但日志里说清楚省得排查
                log?.info?.('not signed in; Bilibili caps audio quality', { requested: quality });
            }
            // 播放要开始了：顺手把逐字歌词的索引预热掉，和启动耗时重叠。
            // 索引有 7 天的落盘缓存，命中缓存时这一步几乎不花时间。
            wordTiming?.warm?.();

            const url = ensureHttps(stream.baseUrl);
            const expiresAt = deadlineFromUrl(url);
            return expiresAt ? { url, expiresAt } : { url };
        },

        async getLyrics(song) {
            const { bvid } = parseSongId(song?.id);
            const title = cleanTrackName(song?.title ?? '');
            if (!title) return null;

            // 艺术家候选：view 里提的最准，拿不到就用调用方给的。
            // 这一步多半不额外发请求 —— getSong / getAudioUrl 已经把 view 缓上了。
            const artists = await artistCandidatesFor(bvid, song);
            const durationMs = Number(song?.durationMs) || 0;

            // 逐字歌词先备好。宿主随后调用的 omni.lyricsResolved 钩子只有 1.5s 预算，
            // 联网一定要发生在这里。失败不影响下面的 LRC 回退。
            if (wordTiming) {
                try {
                    await wordTiming.prepare({
                        key: song?.id,
                        title,
                        artists,
                        durationMs,
                    });
                } catch (error) {
                    log?.warn?.('word timing prepare failed', { message: String(error?.message ?? error) });
                }
            }

            if (!lrclib) return null;
            try {
                // relaxedDuration：B 站是视频源，时长天然长于录音室版本（MV 常有前奏/尾奏），
                // 拿严格时长去卡会大面积漏掉。宽松模式下时长只用于排序，不用于淘汰。
                const found = await lrclib.lookup({
                    title,
                    artists,
                    durationMs,
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
