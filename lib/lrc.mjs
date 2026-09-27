// lib/lrc.mjs
//
// LRC 时间轴策略。移植自 NeriPlayer 的
//   app/src/main/java/moe/ouom/neriplayer/core/api/lyrics/LyricTimelinePolicy.kt
//
// 为什么需要它：外部歌词库（LRCLIB 等）里有一部分条目的 syncedLyrics 虽然带时间戳，
// 但所有行的时间戳完全相同（作者把未同步的歌词批量套了一个时间戳）。这种“塌缩时间轴”
// 如果当成同步歌词用，播放时会整屏同亮，比没有歌词还难看。原实现把它们识别出来并降级成纯文本。

/** 少于这么多行时不去判定“塌缩”：两行歌词碰巧同时开始不算异常。 */
const MIN_LINES_FOR_COLLAPSED_TIMELINE = 3;

const TIMESTAMP_PATTERN = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

const parseTimestampMs = (match) => {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    if (seconds < 0 || seconds > 59) return null;
    const fraction = match[3] ?? '';
    let milliseconds = 0;
    if (fraction.length === 1) milliseconds = Number(fraction) * 100;
    else if (fraction.length === 2) milliseconds = Number(fraction) * 10;
    else if (fraction.length >= 3) milliseconds = Number(fraction.slice(0, 3));
    if (!Number.isFinite(milliseconds)) return null;
    return minutes * 60000 + seconds * 1000 + milliseconds;
};

/** 每一条“有文本且有时间戳”的歌词行，收集该行上的全部时间戳。 */
const collectTimestampedLines = (rawLyric) => {
    const lines = [];
    for (const line of String(rawLyric ?? '').split(/\r?\n/)) {
        TIMESTAMP_PATTERN.lastIndex = 0;
        const matches = [...line.matchAll(TIMESTAMP_PATTERN)];
        if (matches.length === 0) continue;
        const text = line.replace(TIMESTAMP_PATTERN, '').trim();
        if (!text) continue;
        const stamps = matches.map(parseTimestampMs).filter((value) => value !== null);
        if (stamps.length > 0) lines.push(stamps);
    }
    return lines;
};

/** 全部时间戳里只有不到两种不同取值 → 视为塌缩。 */
export const hasCollapsedTimeline = (rawLyric) => {
    const lines = collectTimestampedLines(rawLyric);
    if (lines.length < MIN_LINES_FOR_COLLAPSED_TIMELINE) return false;
    const distinct = new Set();
    for (const stamps of lines) {
        for (const stamp of stamps) {
            distinct.add(stamp);
            if (distinct.size >= 2) return false;
        }
    }
    return true;
};

/** 时间轴可用：有带文本的带戳行，且没有塌缩。 */
export const isUsableTimedLyricTimeline = (rawLyric) => {
    const lines = collectTimestampedLines(rawLyric);
    return lines.length > 0 && !hasCollapsedTimeline(rawLyric);
};

export const hasLrcTimestamp = (rawLyric) => {
    TIMESTAMP_PATTERN.lastIndex = 0;
    return TIMESTAMP_PATTERN.test(String(rawLyric ?? ''));
};

/** 把塌缩的带戳歌词取回纯文本；不是塌缩则返回 null。 */
export const extractPlainLyricsFromCollapsedTimeline = (rawLyric) => {
    if (!hasCollapsedTimeline(rawLyric)) return null;
    const text = String(rawLyric ?? '')
        .split(/\r?\n/)
        .map((line) => line.replace(TIMESTAMP_PATTERN, '').trim())
        .filter((line) => line.length > 0)
        .join('\n');
    return text.length > 0 ? text : null;
};
