// lib/lyric-align.mjs
//
// 两条歌词时间轴的对齐。纯函数，不联网。
//
// 为什么需要：逐字歌词来自 AMLL TTDB，它按录音室母带对齐；而这首歌在 B 站上是**视频**，
// 经常带一段前奏/尾奏（实测「夜に駆ける」的 MV 276s，而 TTDB 与 LRCLIB 的记录都在 244–259s）。
// 直接把 TTDB 的时轴套到视频上，整首歌的逐字高亮会整体偏早或偏晚。
//
// 所以拿宿主已经算好的那份行级时轴（event.lines，来自 LRCLIB）当参照，
// 用**文本完全相同的行**求一个常量偏移，取中位数（对少量误配稳健）。
//
// 返回值刻意分三种：正数 / 负数（对齐成功）、0（确实对齐且无偏移）、null（判不出来）。
// 0 与 null 必须区分开 —— 调用方要靠它决定该不该用这份逐字歌词（见 lib/word-timing.mjs）。

import { normalizeLyricMatchText } from './lyric-match.mjs';

/** 至少要这么多对配对才敢偏移。 */
const MIN_PAIRS = 4;
/** 配对至少要覆盖这些参照行的比例。 */
const MIN_COVERAGE = 0.2;
/** 偏移量的中位数绝对偏差超过这个值就认为配对不可信（秒）。 */
const MAX_MAD_SECONDS = 1.5;
/** 偏移量的绝对值上限：超过它基本是配错歌了。 */
const MAX_OFFSET_SECONDS = 60;
/** 参照行的文本至少这么长才参与配对：太短的行（「啊」「La」）会大量误配。 */
const MIN_TEXT_LENGTH = 3;

/** 归一化与歌词匹配共用同一套，避免两处规则漂移。 */
const textKeyOf = (value) => normalizeLyricMatchText(value ?? '');

const median = (values) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const medianAbsoluteDeviation = (values, center) => median(values.map((value) => Math.abs(value - center)));

const lineTextOf = (line) => line?.fullText ?? line?.text ?? '';

/**
 * 估算「参照行时间 − 目标行时间」的常量偏移（秒）。
 *
 * @param reference 参照行（宿主已经解析好的那份），需要 startTime 与 fullText
 * @param target    候选行（TTML 解析结果）
 * @returns {number|null} 秒；**无法判定时返回 null**（与「判定为 0」必须区分开：
 *          0 表示两份时间轴确实对得上，null 表示这两份歌词压根不是同一个版本 ——
 *          调用方据此决定要不要用这份逐字歌词）。
 */
export const estimateLyricOffset = (reference, target) => {
    const referenceLines = Array.isArray(reference) ? reference : [];
    const targetLines = Array.isArray(target) ? target : [];
    if (referenceLines.length === 0 || targetLines.length === 0) return null;

    // 同一段文本在目标里可能出现多次（副歌），所以按文本收集成时间列表，用时取最近的那个
    const timesByText = new Map();
    for (const line of targetLines) {
        const key = textKeyOf(lineTextOf(line));
        if (!key || key.length < MIN_TEXT_LENGTH) continue;
        const list = timesByText.get(key) ?? [];
        list.push(Number(line.startTime));
        timesByText.set(key, list);
    }
    if (timesByText.size === 0) return null;

    const deltas = [];
    let eligible = 0;
    for (const line of referenceLines) {
        const key = textKeyOf(lineTextOf(line));
        if (!key || key.length < MIN_TEXT_LENGTH) continue;
        eligible += 1;
        const candidates = timesByText.get(key);
        if (!candidates || candidates.length === 0) continue;
        const time = Number(line.startTime);
        if (!Number.isFinite(time)) continue;

        let best = null;
        for (const candidate of candidates) {
            if (!Number.isFinite(candidate)) continue;
            if (best === null || Math.abs(candidate - time) < Math.abs(best - time)) best = candidate;
        }
        if (best === null) continue;
        deltas.push(time - best);
    }

    if (deltas.length < MIN_PAIRS) return null;
    if (eligible > 0 && deltas.length / eligible < MIN_COVERAGE) return null;

    const center = median(deltas);
    if (Math.abs(center) > MAX_OFFSET_SECONDS) return null;
    if (medianAbsoluteDeviation(deltas, center) > MAX_MAD_SECONDS) return null;
    // 小于 10ms 的偏移没有意义，还会让「偏移过没有」这件事变得不可读
    return Math.abs(center) < 0.01 ? 0 : center;
};

const shiftPoint = (point, offset) => ({
    ...point,
    startTime: Number(point.startTime) + offset,
    ...(Number.isFinite(point.endTime) ? { endTime: Number(point.endTime) + offset } : {}),
});

/**
 * 给一行的词与音节加同一个偏移。宿主会在 fromFoliumLines 里重建行，
 * 所以这里给的是新对象，不动调用方手里那一份。
 */
const shiftWords = (words, offset) =>
    (Array.isArray(words) ? words : []).map((word) => ({
        ...shiftPoint(word, offset),
        ...(Array.isArray(word.syllables)
            ? { syllables: word.syllables.map((syllable) => shiftPoint(syllable, offset)) }
            : {}),
    }));

const shiftBackgroundVocals = (vocals, offset) =>
    (Array.isArray(vocals) ? vocals : []).map((vocal) => ({
        ...shiftPoint(vocal, offset),
        ...(Array.isArray(vocal.words) ? { words: shiftWords(vocal.words, offset) } : {}),
    }));

/**
 * 给整份歌词加一个常量偏移（秒）。offset 为 0 时原样返回，省掉一次全量拷贝。
 *
 * @param lines  FoliumLine 形状的行
 * @param offset 秒
 */
export const shiftLyricLines = (lines, offset) => {
    const list = Array.isArray(lines) ? lines : [];
    if (!Number.isFinite(offset) || offset === 0) return list;
    return list.map((line) => ({
        ...shiftPoint(line, offset),
        ...(Array.isArray(line.words) ? { words: shiftWords(line.words, offset) } : {}),
        ...(Array.isArray(line.backgroundVocals)
            ? { backgroundVocals: shiftBackgroundVocals(line.backgroundVocals, offset) }
            : {}),
    }));
};

export const LYRIC_ALIGN_LIMITS = {
    MIN_PAIRS,
    MIN_COVERAGE,
    MAX_MAD_SECONDS,
    MAX_OFFSET_SECONDS,
    MIN_TEXT_LENGTH,
};
