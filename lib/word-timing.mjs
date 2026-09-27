// lib/word-timing.mjs
//
// 逐字歌词的「预备—取用」中继与安装决策。纯内存 / 纯函数，无外部依赖。
//
// 为什么需要这一层：宿主对 omni.lyricsResolved 钩子的每个处理器只给 **1.5 秒**
// （folia-major 的 src/mods/folium/events.ts，ASYNC_TIMEOUT_MS = 1500），超时就放弃等待，
// 钩子对 event.lines 的改动不再生效。而拉一次 TTML 索引 + TTML 文件远超 1.5s，
// 所以联网必须提前发生 —— 由 provider 在自己的 getLyrics 里做完（那条路径没有预算限制），
// 钩子只做一次内存取用 + 一次纯函数判断。

import { estimateLyricOffset } from './lyric-align.mjs';

/** 默认保留多少首。够覆盖「上一首/当前/下一首」之间来回切换。 */
const DEFAULT_LIMIT = 12;

/** 「标题完全相等」在 lib/lyric-match.mjs 里的分数。 */
export const EXACT_TITLE_SCORE = 80;

/**
 * 决定要不要把这份逐字歌词装上去，以及装的时候要偏移多少。
 *
 * 抽成纯函数是为了能离线测：client.mjs 里的钩子只是把它的结论套到 event.lines 上。
 *
 * 三条规则：
 *   1. 没有候选行 → 不装。
 *   2. 有参照时轴（宿主已经解析好的行级歌词）→ **对齐必须成功**。
 *      对齐失败说明两份歌词不是同一个版本（实测「残酷な天使のテーゼ」的 TTDB 里只有
 *      Ambivalence Mix，和视频版的时间轴对不上），套上去只会让逐字高亮整体错位。
 *   3. 没有参照时轴 → 没有东西能证明版本一致，只认标题完全相等。
 *      68 分对应「候选标题比预期多一截」，正是上面那种混音版/现场版的情形。
 *
 * @param referenceLines 宿主那份行级歌词（event.lines）
 * @param candidateLines TTML 解析出来的逐字行
 * @param titleScore     候选与请求标题的相似度（80 = 完全相等）
 * @returns {{install: boolean, reason: string, offset?: number, aligned?: boolean}}
 */
export const planWordTimingInstall = ({
    referenceLines,
    candidateLines,
    titleScore = 0,
    exactTitleScore = EXACT_TITLE_SCORE,
} = {}) => {
    const candidates = Array.isArray(candidateLines) ? candidateLines : [];
    if (candidates.length === 0) return { install: false, reason: 'no-word-timing' };

    const reference = Array.isArray(referenceLines) ? referenceLines : [];
    if (reference.length === 0) {
        if (titleScore < exactTitleScore) return { install: false, reason: 'unverified-title-not-exact' };
        return { install: true, offset: 0, aligned: false, reason: 'title-exact-without-reference' };
    }

    const offset = estimateLyricOffset(reference, candidates);
    if (offset === null) return { install: false, reason: 'timelines-do-not-line-up' };
    return { install: true, offset, aligned: true, reason: 'aligned' };
};

export const createWordTimingRelay = ({ limit = DEFAULT_LIMIT } = {}) => {
    const entries = new Map();

    const evict = () => {
        while (entries.size > limit) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
        }
    };

    return {
        /**
         * 记下某首歌的逐字歌词。`lines` 为空等于「这首歌没有逐字」，也要记下来 ——
         * 否则钩子每次都要重试一遍没有任何结果的查询。
         */
        put(key, value) {
            if (typeof key !== 'string' || !key) return;
            // 重新插入以刷新 LRU 顺序
            entries.delete(key);
            entries.set(key, { ...value });
            evict();
        },

        /**
         * 取某首歌的逐字歌词，取不到返回 null。
         * 不删除条目：同一首歌会被反复请求（重放、切回来）。
         */
        take(key) {
            if (typeof key !== 'string' || !key) return null;
            const entry = entries.get(key);
            if (!entry) return null;
            // 刷新 LRU
            entries.delete(key);
            entries.set(key, entry);
            return entry;
        },

        has(key) {
            return typeof key === 'string' && entries.has(key);
        },

        clear() {
            entries.clear();
        },

        get size() {
            return entries.size;
        },
    };
};

export const WORD_TIMING_RELAY_LIMIT = DEFAULT_LIMIT;
