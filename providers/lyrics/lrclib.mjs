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
const USER_AGENT = 'NeriBridge/0.1.0 (https://github.com/ZhuoMoStudio/folium-neri-bridge)';

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
    const matches = ({ title, artist, durationMs }, candidate) =>
        isTitleCompatible(title, candidate.trackName) &&
        isArtistCompatible(artist, candidate.artistName) &&
        isDurationCompatible(durationMs, candidate.durationMs);

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

    /** 模糊接口：/search?q，再在本地按身份判定筛 */
    const lookupSearch = async ({ title, artist, durationMs }) => {
        const keyword = [cleanTrackName(title), primaryArtist(artist)].filter(Boolean).join(' ').trim();
        if (!keyword) return null;

        const payload = await http.json(`${BASE_URL}/search?${new URLSearchParams({ q: keyword }).toString()}`, {
            headers: HEADERS,
        });
        if (!Array.isArray(payload)) return null;

        const candidates = payload
            .slice(0, SEARCH_LIMIT)
            .map(parseEntry)
            .filter((entry) => entry !== null)
            .filter((entry) => matches({ title, artist, durationMs }, entry));
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
         * @returns {Promise<{ lrc: string, translationLrc?: string, matched: boolean } | null>}
         *          lrc 可能是不带时间戳的纯文本（原实现同样允许这种降级）；
         *          matched 为 true 表示通过了两轮身份校验，为 false 表示是宽泛搜索的兜底结果。
         */
        async lookup({ title, artist, durationMs }) {
            if (!title || !Number.isFinite(durationMs) || durationMs <= 0) return null;
            const durationSeconds = Math.round(durationMs / 1000);

            const exact = await lookupExact({ title, artist, durationSeconds });
            if (exact) {
                // /get 理论上已经按 ID 命中，再用本地判定确认一次，挡掉同名但版本不同的条目
                if (matches({ title, artist, durationMs }, exact)) {
                    return { lrc: exact.syncedLyrics ?? exact.plainLyrics, matched: true };
                }
            }

            const searched = await lookupSearch({ title, artist, durationMs });
            if (searched) {
                return { lrc: searched.syncedLyrics ?? searched.plainLyrics, matched: true };
            }

            return null;
        },
    };
};
