// providers/lyrics/lrclib.mjs
//
// LRCLIB 歌词后端。移植自 NeriPlayer 的
//   app/src/main/java/moe/ouom/neriplayer/core/api/lyrics/LrcLibClient.kt
//
// LRCLIB 是免费开源的同步歌词库，无需 API Key，支持「歌名 + 艺术家 + 时长」精确匹配。
// 原实现在 Android 端被当作播放页元数据补全的外部歌词来源，这里当作 B 站音源的歌词回退：
// B 站搜索接口只给视频标题和 UP 主，所以先用清洗过的标题/UP 主/时长去碰，碰不到就算了。

import { extractPlainLyricsFromCollapsedTimeline, isUsableTimedLyricTimeline } from '../../lib/lrc.mjs';
import { cleanTrackName, isArtistCompatible, isDurationCompatible, isTitleCompatible, primaryArtist } from '../../lib/match.mjs';

const BASE_URL = 'https://lrclib.net/api';
const SEARCH_LIMIT = 10;
const USER_AGENT = 'NeriBridge/0.1.1 (https://github.com/ZhuoMoStudio/folium-neri-bridge)';

const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const readDurationMs = (json) => {
    const seconds = Number(json?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 1000);
};

/** 把一条 LRCLIB 记录转成内部形状；无法使用的条目返回 null。 */
const parseEntry = (json) => {
    const durationMs = readDurationMs(json);
    if (durationMs === null) return null;

    const rawSynced = typeof json?.syncedLyrics === 'string' ? json.syncedLyrics.trim() : '';
    const syncedLyrics = rawSynced && isUsableTimedLyricTimeline(rawSynced) ? rawSynced : null;
    const explicitPlain = typeof json?.plainLyrics === 'string' ? json.plainLyrics.trim() : '';
    const recoveredPlain = rawSynced ? extractPlainLyricsFromCollapsedTimeline(rawSynced) : null;
    const plainLyrics = explicitPlain || recoveredPlain || null;
    if (!syncedLyrics && !plainLyrics) return null;

    return {
        trackName: json?.trackName ?? '',
        artistName: json?.artistName ?? '',
        durationMs,
        syncedLyrics,
        plainLyrics,
    };
};

/**
 * 创建一个 LRCLIB 后端。
 *
 * @param http lib/http.mjs 创建的封装
 */
export const createLrclibBackend = (http) => {
    /** 精确接口：/get?track_name&artist_name&duration */
    const lookupExact = async ({ title, artist, durationSeconds }) => {
        const query = new URLSearchParams({
            track_name: cleanTrackName(title),
            artist_name: primaryArtist(artist),
            duration: String(durationSeconds),
        });
        const payload = await http.json(`${BASE_URL}/get?${query.toString()}`, { headers: HEADERS });
        return payload ? parseEntry(payload) : null;
    };

    /**
     * 模糊接口：/search?q，再在本地按身份判定筛。
     *
     * @param relaxedDuration 为 true 时不淘汰时长不符的候选，只把它们排在后面。
     */
    const lookupSearch = async ({ title, artist, durationMs, relaxedDuration = false }) => {
        const keyword = [cleanTrackName(title), primaryArtist(artist)].filter(Boolean).join(' ').trim();
        if (!keyword) return null;

        const payload = await http.json(`${BASE_URL}/search?${new URLSearchParams({ q: keyword }).toString()}`, {
            headers: HEADERS,
        });
        if (!Array.isArray(payload)) return null;

        const identityMatches = payload
            .slice(0, SEARCH_LIMIT)
            .map(parseEntry)
            .filter((entry) => entry !== null)
            .filter((entry) => isTitleCompatible(title, entry.trackName))
            .filter((entry) => isArtistCompatible(artist, entry.artistName));

        const candidates = relaxedDuration
            ? identityMatches
            : identityMatches.filter((entry) => isDurationCompatible(durationMs, entry.durationMs));
        if (candidates.length === 0) return null;

        // 有同步歌词的优先，其次时长最接近的
        candidates.sort((left, right) => {
            const leftSynced = left.syncedLyrics ? 0 : 1;
            const rightSynced = right.syncedLyrics ? 0 : 1;
            if (leftSynced !== rightSynced) return leftSynced - rightSynced;
            return Math.abs(left.durationMs - durationMs) - Math.abs(right.durationMs - durationMs);
        });
        return candidates[0];
    };

    return {
        /**
         * 找一份能用的歌词。
         *
         * @param {object}  query
         * @param {string}  query.title           歌名（调用方已清洗）
         * @param {string}  query.artist          艺术家
         * @param {number}  query.durationMs      时长
         * @param {boolean} query.relaxedDuration true 时不把时长当作硬门槛，
         *        只用它排序。视频源（B 站 MV）的时长天然长于录音室版本 ——
         *        实测「夜に駆ける」的 MV 是 276s 而 LRCLIB 记录是 259s，差 17s
         *        已经越过 15s 的容差上限，严格模式下会直接漏掉。
         * @returns {Promise<{ lrc: string, matched: boolean } | null>}
         *         **只返回带时间戳的歌词**。宿主对 getLyrics 的返回值一律走 parseLRC，
         *        而 parseLRC 会丢弃没有 LRC 时间标签的行（parserCore.ts:347 的
         *         parseSimpleTimedTextEntry 对无标签行返回 null）。所以把纯文本
         *        交出去只会得到一个空歌词列表，不如返回 null 诚实。
         */
        async lookup({ title, artist, durationMs, relaxedDuration = false }) {
            if (!title || !Number.isFinite(durationMs) || durationMs <= 0) return null;
            const durationSeconds = Math.round(durationMs / 1000);

            const accept = (candidate, enforceDuration) => {
                if (!isTitleCompatible(title, candidate.trackName)) return false;
                if (!isArtistCompatible(artist, candidate.artistName)) return false;
                return enforceDuration ? isDurationCompatible(durationMs, candidate.durationMs) : true;
            };
            const pickSynced = (candidate) =>
                candidate?.syncedLyrics ? { lrc: candidate.syncedLyrics, matched: true } : null;

            // 1) 精确接口。它按 ID 命中，但仍用本地判定确认一次，挡掉同名不同版本。
            const exact = await lookupExact({ title, artist, durationSeconds });
            if (exact && accept(exact, !relaxedDuration)) {
                const hit = pickSynced(exact);
                if (hit) return hit;
            }

            // 2) 搜索接口。内部已按「有同步歌词优先」排序，这里再取一次。
            const searched = await lookupSearch({ title, artist, durationMs, relaxedDuration });
            const searchedHit = pickSynced(searched);
            if (searchedHit) return searchedHit;

            return null;
        },
    };
};
