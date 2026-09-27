// providers/lyrics/amll.mjs
//
// AMLL TTDB 逐字歌词后端。
//
// 上游：https://github.com/amll-dev/amll-ttml-db —— **CC0-1.0**（公有领域奉献）。
// 库里的文件是人工审核过的逐字 TTML，正是 Folium 的 FoliumLine.words[].syllables[] 需要的形状。
//
// 三步走：
//   1. 拉 metadata/raw-lyrics-index.jsonl（1.6MB，gzip 传输约 428KB），
//      压成紧凑形状后落到模组数据文件里（3080 条 / 453KB，占 1MB 上限的 44%），默认 7 天才重拉；
//   2. 在本地用 lib/lyric-match.mjs 的评分挑候选（TTDB 没有搜索接口，只能本地筛）；
//   3. 按候选的平台 id 或 rawLyricFile 取 TTML 原文，交给 lib/ttml.mjs 解析。
//
// 为什么不用第三方检索站（amlldb.bikonoo.com 之类）：它们是社区搭的，可用性没有承诺，
// 而 raw.githubusercontent 与官方 TTDB 服务都是上游自己的东西。少一个依赖少一种死法。
//
// 规矩：任何一步失败都返回 null，绝不抛错。歌词拿不到不该影响播放。

import {
    AMLL_INDEX_FORMAT,
    compactAmllIndex,
    dedupeAmllEntries,
    expandAmllIndex,
    parseAmllIndex,
} from '../../lib/amll-index.mjs';
import { CONFIDENCE, rankLyricCandidates, scoreLyricMatchArtist, scoreLyricMatchTitle } from '../../lib/lyric-match.mjs';
import { isDurationCompatible } from '../../lib/match.mjs';
import { parseTtml } from '../../lib/ttml.mjs';

const INDEX_URL = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/metadata/raw-lyrics-index.jsonl';
/** 官方 TTDB 在线服务，按平台 id 取。`format=ttml` 是默认值，写出来是为了自明。 */
const TTDB_BASE = 'https://amll-ttml-db.stevexmh.net';
const RAW_TTML_BASE = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/raw-lyrics';
/** 取歌词时按这个顺序试平台 id。 */
const PLATFORM_ORDER = ['ncmMusicId', 'qqMusicId', 'appleMusicId', 'spotifyId'];
/** 平台 id → TTDB 的路径段。 */
const PLATFORM_PATH = { ncmMusicId: 'ncm', qqMusicId: 'qq', appleMusicId: 'am', spotifyId: 'spotify' };

const STORAGE_INDEX_KEY = 'amllIndex';
const STORAGE_INDEX_AT_KEY = 'amllIndexFetchedAt';
const STORAGE_FORMAT_KEY = 'amllIndexFormat';
/** 索引多久算过期。上游是人工投稿的仓库，一天也没几条变更。 */
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** TTML 原文的内存缓存条数。 */
const TTML_CACHE_LIMIT = 24;

/**
 * 匹配门槛。**两个都要过**，缺一不可：
 *   - 标题必须「相等 / 前缀 / 互相包含」（对应 scoreLyricMatchTitle 的 52 档及以上）；
 *   - 艺术家必须命中（对应 MIN_RELIABLE_LYRIC_ARTIST_SCORE，即「集合包含」或更高）。
 * 逐字歌词是整体替换宿主那份歌词的，配错比配不上难发现得多，所以这里卡得比 LRC 回退严。
 */
const MIN_TITLE_SCORE = 52;
const MIN_ARTIST_SCORE = 24;
/** 一次查询最多取几份 TTML 来试（第一份不成功时兜底用）。 */
const MAX_TTML_ATTEMPTS = 2;

const describeError = (error) => String(error?.message ?? error);

export const createAmllBackend = ({ http, log, storage }) => {
    /** 索引：内存里一份，数据文件里一份。 */
    let index = null;
    let indexPromise = null;
    const ttmlCache = new Map();

    const storageGet = async (key) => {
        try {
            return await storage?.get?.(key);
        } catch (error) {
            log?.warn?.('amll: storage read failed', { key, message: describeError(error) });
            return undefined;
        }
    };
    const storageSet = async (key, value) => {
        try {
            await storage?.set?.(key, value);
        } catch (error) {
            // 数据文件有 1MB 上限：索引压完 453KB，超了说明上游长大了一倍，值得在日志里看见。
            // 写失败不影响使用 —— 索引还在内存里，只是下次启动要重新下载。
            log?.warn?.('amll: storage write failed', { key, message: describeError(error) });
        }
    };

    const readCachedIndex = async () => {
        const format = await storageGet(STORAGE_FORMAT_KEY);
        if (format !== undefined && format !== AMLL_INDEX_FORMAT) {
            log?.info?.('amll: cached index has an older format; refetching', { format });
            return null;
        }
        const fetchedAt = Number(await storageGet(STORAGE_INDEX_AT_KEY));
        if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > INDEX_TTL_MS) return null;
        const entries = expandAmllIndex(await storageGet(STORAGE_INDEX_KEY));
        if (entries.length === 0) return null;
        log?.info?.('amll: index loaded from storage', {
            entries: entries.length,
            ageHours: Math.round((Date.now() - fetchedAt) / 3600000),
        });
        return entries;
    };

    const fetchIndex = async () => {
        const text = await http.text(INDEX_URL, { timeoutMs: 30000, headers: { Accept: 'text/plain' } });
        if (!text) {
            log?.warn?.('amll: index download failed');
            return null;
        }
        const entries = dedupeAmllEntries(parseAmllIndex(text));
        if (entries.length === 0) {
            log?.warn?.('amll: index parsed to nothing; the upstream format may have changed');
            return null;
        }
        await storageSet(STORAGE_INDEX_KEY, compactAmllIndex(entries));
        await storageSet(STORAGE_INDEX_AT_KEY, Date.now());
        await storageSet(STORAGE_FORMAT_KEY, AMLL_INDEX_FORMAT);
        log?.info?.('amll: index fetched', { entries: entries.length, bytes: text.length });
        return entries;
    };

    /** 拿索引。多个调用共用同一次加载；失败不缓存，下一次会重试。 */
    const ensureIndex = async () => {
        if (index) return index;
        if (indexPromise) return indexPromise;
        indexPromise = (async () => {
            try {
                index = (await readCachedIndex()) ?? (await fetchIndex());
                return index;
            } catch (error) {
                log?.warn?.('amll: index unavailable', { message: describeError(error) });
                return null;
            } finally {
                indexPromise = null;
            }
        })();
        return indexPromise;
    };

    const rememberTtml = (key, value) => {
        if (ttmlCache.size >= TTML_CACHE_LIMIT) {
            const oldest = ttmlCache.keys().next().value;
            if (oldest !== undefined) ttmlCache.delete(oldest);
        }
        ttmlCache.set(key, value);
    };

    /** 取一份 TTML 原文。先按平台 id 走官方服务，再退回 raw 文件。 */
    const fetchTtml = async (entry, platformKey) => {
        const urls = [];
        if (platformKey) {
            urls.push(
                `${TTDB_BASE}/${PLATFORM_PATH[platformKey]}/${encodeURIComponent(entry.ids[platformKey])}?format=ttml`,
            );
        }
        urls.push(`${RAW_TTML_BASE}/${entry.rawLyricFile}`);

        for (const url of urls) {
            if (ttmlCache.has(url)) {
                const cached = ttmlCache.get(url);
                if (cached) return cached;
                continue;
            }
            const text = await http.text(url, {
                timeoutMs: 20000,
                headers: { Accept: 'application/xml, text/xml, text/plain, */*' },
            });
            if (!text || !/<tt(?:\s|>)/i.test(text)) continue;
            const parsed = parseTtml(text);
            if (parsed.lines.length === 0 || !parsed.hasWordTiming) {
                log?.info?.('amll: ttml has no word timing; ignoring', { file: entry.rawLyricFile });
                rememberTtml(url, null);
                continue;
            }
            const value = { ...parsed, url };
            rememberTtml(url, value);
            return value;
        }
        return null;
    };

    /** 索引条目 → rankLyricCandidates 的候选形状。 */
    const toCandidate = (entry) => ({
        // `lyrics` 在这里的含义是「这份条目确有歌词文件」——它就是文件名，不是 LRC 文本。
        // rankLyricCandidates 拿它当「有没有歌词」的门槛用，这是这个字段的唯一用途。
        lyrics: entry.rawLyricFile,
        id: entry.rawLyricFile,
        source: 'amll',
        title: entry.title,
        artist: entry.artists.join('/'),
        format: 'ttml',
        hasWordTiming: true,
    });

    return {
        /** 预热索引。打开设置面板或准备播放时调一次，别在钩子里调。 */
        async warm() {
            await ensureIndex();
        },

        /**
         * 自检用的索引状态。**不联网**：自检不该顺带拉 1.6MB 索引。
         *
         * `bytes` 是紧凑索引的 JSON 长度，也就是写进模组数据文件的大致体积
         * （数据文件上限 1MB，实测 453KB）—— 只有真写进去过才拿得到，
         * 所以内存里刚拉完但还没落盘时它会是 0。
         */
        async stats() {
            const format = await storageGet(STORAGE_FORMAT_KEY);
            const fetchedAt = Number(await storageGet(STORAGE_INDEX_AT_KEY));
            const ageMs = Number.isFinite(fetchedAt) && fetchedAt > 0 ? Date.now() - fetchedAt : null;
            const stored = await storageGet(STORAGE_INDEX_KEY);
            const bytes = Array.isArray(stored) ? JSON.stringify(stored).length : 0;
            const base = { bytes, ageMs, format: format ?? null };

            if (Array.isArray(index) && index.length > 0) {
                return { available: true, entries: index.length, source: 'memory', ...base };
            }
            const entries = expandAmllIndex(stored);
            if (entries.length === 0) return { available: false, entries: 0, source: 'none', ...base };
            return {
                available: true,
                entries: entries.length,
                source: 'storage',
                stale: Number.isFinite(ageMs) && ageMs > INDEX_TTL_MS,
                ...base,
            };
        },

        /**
         * 找一份逐字歌词。
         *
         * @param query.title      歌名（调用方已清洗）
         * @param query.artists    艺术家候选，按优先级排列
         * @param query.durationMs 时长（可为 0；B 站视频源与母带时长常不一致，只用于排序）
         * @returns {Promise<{lines: object[], metadata: object, entry: object, source: string,
         *                    titleScore: number, artistScore: number} | null>}
         *          `titleScore` 是「标题完全相等」程度的度量（80 = 完全相等），
         *          调用方在没有参照时轴时用它判断这份歌词可不可信。
         */
        async lookup({ title, artists, durationMs = 0 } = {}) {
            const trackName = String(title ?? '').trim();
            const artistList = (Array.isArray(artists) ? artists : [])
                .map((name) => String(name ?? '').trim())
                .filter(Boolean);
            if (!trackName || artistList.length === 0) return null;

            const entries = await ensureIndex();
            if (!entries || entries.length === 0) return null;

            // 多条候选艺术家用 '/' 连接：scoreLyricMatchArtist 会把它拆成集合，
            // 任一条命中就算命中 —— 这正是「多给候选」这个策略的着力点。
            const artistName = artistList.join('/');
            const ranked = rankLyricCandidates(
                {
                    trackName,
                    artistName,
                    durationMs: Number(durationMs) > 0 ? Number(durationMs) : 0,
                    preferWordTimed: true,
                },
                entries.map(toCandidate),
                { isDurationCompatible },
            );

            let attempts = 0;
            // 先按标题分排序再试：rankLyricCandidates 的排序里置信度和总分优先，
            // 而这里最想要的是「标题完全相符」的那条 —— 标题 80 分对应完全相等，
            // 68/52 则是带版本后缀或互相包含，未必是同一份录音。
            const gated = ranked
                .map((hit) => ({
                    hit,
                    titleScore: scoreLyricMatchTitle(trackName, hit.candidate.title),
                    artistScore: scoreLyricMatchArtist(artistName, hit.candidate.artist),
                }))
                .filter((entry) => entry.titleScore >= MIN_TITLE_SCORE && entry.artistScore >= MIN_ARTIST_SCORE)
                .sort((left, right) =>
                    right.titleScore - left.titleScore ||
                    right.hit.confidence - left.hit.confidence ||
                    right.hit.score - left.hit.score,
                );

            for (const { hit, titleScore, artistScore } of gated) {
                if (attempts >= MAX_TTML_ATTEMPTS) break;
                const entry = entries.find((candidate) => candidate.rawLyricFile === hit.candidate.id);
                if (!entry) continue;

                attempts += 1;
                const ttml = await fetchTtml(entry, PLATFORM_ORDER.find((key) => entry.ids[key]) ?? null);
                if (!ttml) continue;

                log?.info?.('amll: word-timed lyrics found', {
                    title: entry.title,
                    artist: entry.artists.join('/'),
                    lines: ttml.lines.length,
                    titleScore,
                    artistScore,
                    confidence:
                        hit.confidence === CONFIDENCE.HIGH
                            ? 'high'
                            : hit.confidence === CONFIDENCE.MEDIUM
                                ? 'medium'
                                : 'low',
                });
                return { lines: ttml.lines, metadata: ttml.metadata, entry, source: ttml.url, titleScore, artistScore };
            }
            return null;
        },
    };
};

export const AMLL_MATCH_THRESHOLDS = { MIN_TITLE_SCORE, MIN_ARTIST_SCORE };
