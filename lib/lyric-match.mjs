// lib/lyric-match.mjs
//
// 歌词匹配评分。移植自 NeriPlayer 的
//   app/src/main/java/moe/ouom/neriplayer/core/api/lyrics/EditableLyricMatchPolicy.kt
//
// 前一版只做了「归一化后相等 + 艺术家包含」，误匹配率比 Android 端高。这里是完整移植：
// 歌名分档打分、艺术家集合运算、时长带符号计分、专辑、格式质量、逐词加成，
// 以及 reliable / plausible 两级身份判定。
//
// 两处外围件没有照搬，都做成了可注入的（见 toSimplified 与 keywordScorer）：
//   - toSimplifiedChineseForDomesticSearch：繁→简。原实现依赖一张转换表，本模块默认恒等，
//     调用方可以传自己的实现。不传的后果是繁体标题匹配不到简体候选。
//   - SearchTextMatcher.score：带拼音候选生成的模糊匹配，约 150 行。默认用 token 重合度顶替，
//     所以「未知歌手」这类占位元数据的兜底会比原实现弱。
//
// 除这两处外，常量、分档与阈值都与原实现一致。

const MIN_EDITABLE_LYRIC_MATCH_SCORE = 35;
const WORD_TIMED_LYRIC_MATCH_BONUS = 36;
const MIN_RELIABLE_LYRIC_TITLE_SCORE = 52;
const MIN_RELIABLE_LYRIC_ARTIST_SCORE = 24;

export const CONFIDENCE = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** 音源优先级：酷狗 5 → 网易云 4 → QQ 3 → LRCLIB 2 → AMLL 1 → YouTube 0 */
export const SOURCE_PRIORITY = {
    kugou: 5,
    netease: 4,
    qq: 3,
    lrclib: 2,
    amll: 1,
    youtube: 0,
};

/** 格式质量分。 */
const FORMAT_SCORE = { ttml: 16, yrc: 14, lrc: 10, plain: 2 };

const WHITESPACE = /\s+/g;
const HARD_ARTIST_SEPARATOR = /[/,，、&+]|\s+[xX]\s+/;
const FEATURED_ARTIST_SEPARATOR = /\b(?:feat\.?|ft\.?|featuring)\b/i;
const ARTIST_COLLABORATION_CONNECTIVES = new Set(['and', 'with', 'x', 'vs', 'versus', '和', '与']);

const VERSION_MODIFIER =
    /\b(?:remaster(?:ed)?|remix|live|acoustic|instrumental|karaoke|demo|cover|rework|slowed|sped\s+up|version|edit|extended|radio|clean|explicit)\b/g;
const CANONICAL_TRAILING_NOISE =
    /(?:\s+|^)(?:official|audio|video|lyrics?|visualizer|hd|hq|4k|mv|官方|官方版|官方视频|音频|歌词|歌词版|高清|完整版)(?:\s+(?:official|audio|video|lyrics?|visualizer|hd|hq|4k|mv|官方|官方版|官方视频|音频|歌词|歌词版|高清|完整版))*$/;

const PLACEHOLDER_METADATA = new Set([
    'unknown',
    'unknown artist',
    'unknown song',
    'unknown title',
    '未知',
    '未知歌手',
    '未知歌曲',
    '未知标题',
]);

/** 默认的繁→简是恒等。要更准就传一个真实现进来。 */
const identity = (value) => value;

/**
 * 归一化。原实现是 NFKC + 小写 + 折叠 & / feat / 括号 + 只留字母数字。
 *
 * @param toSimplified 可选的繁→简转换；默认恒等
 */
export const normalizeLyricMatchText = (value, toSimplified = identity) => {
    const source = toSimplified(String(value ?? ''));
    return source
        .normalize('NFKC')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/\b(feat|ft|featuring)\.?\b/g, ' ')
        .replace(/[(){}\[\]【】（）]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(WHITESPACE, ' ');
};

const tokenOverlapRatio = (left, right) => {
    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = new Set(right.split(' ').filter(Boolean));
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let intersection = 0;
    for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
    return intersection / Math.max(leftTokens.size, rightTokens.size);
};

const artistSegments = (value, toSimplified) =>
    String(value ?? '')
        .split(FEATURED_ARTIST_SEPARATOR)
        .flatMap((segment) => segment.split(HARD_ARTIST_SEPARATOR))
        .map((segment) => normalizeLyricMatchText(segment, toSimplified))
        .filter(Boolean);

/** 艺术家拆成集合：整名 + 每个片段。 */
export const splitLyricMatchArtists = (value, toSimplified) => {
    const whole = normalizeLyricMatchText(value, toSimplified);
    return new Set([whole, ...artistSegments(value, toSimplified)].filter(Boolean));
};

/** 第一位艺术家。 */
export const primaryLyricMatchArtist = (value, toSimplified) => artistSegments(value, toSimplified)[0] ?? null;

const hasAlignedContainment = (left, right) => left === right || right.startsWith(`${left} `);

/**
 * 候选艺术家只有在通过明确的合作连接词扩展主艺术家时才算同一人。
 * 「Artist One Tribute」这种普通后缀不算。
 */
const hasCollaboratorSuffix = (candidateArtistName, expectedPrimaryArtist) => {
    if (!candidateArtistName.startsWith(`${expectedPrimaryArtist} `)) return false;
    const connective = candidateArtistName.slice(expectedPrimaryArtist.length).trimStart().split(' ')[0];
    return ARTIST_COLLABORATION_CONNECTIVES.has(connective);
};

/** 歌名打分：完全相等 80、前缀 68/62、包含 52、否则按词重合 ×44。 */
export const scoreLyricMatchTitle = (expected, candidate, toSimplified) => {
    const expectedText = normalizeLyricMatchText(expected, toSimplified);
    const candidateText = normalizeLyricMatchText(candidate, toSimplified);
    if (!expectedText || !candidateText) return 0;
    if (candidateText === expectedText) return 80;
    if (candidateText.startsWith(`${expectedText} `)) return 68;
    if (expectedText.startsWith(`${candidateText} `)) return 62;
    if (candidateText.includes(expectedText) || expectedText.includes(candidateText)) return 52;
    return Math.round(tokenOverlapRatio(expectedText, candidateText) * 44);
};

/** 艺术家打分：集合相等 55、包含 46、有交集 28+18·i/n、否则 24 或按词重合 ×20。 */
export const scoreLyricMatchArtist = (expected, candidate, toSimplified) => {
    const expectedArtists = [...splitLyricMatchArtists(expected, toSimplified)];
    const candidateArtists = [...splitLyricMatchArtists(candidate, toSimplified)];
    if (expectedArtists.length === 0 || candidateArtists.length === 0) return 0;
    if (expectedArtists.length === candidateArtists.length && expectedArtists.every((a) => candidateArtists.includes(a))) {
        return 55;
    }
    if (expectedArtists.every((a) => candidateArtists.includes(a))) return 46;
    const intersectionSize = expectedArtists.filter((a) => candidateArtists.includes(a)).length;
    if (intersectionSize > 0) {
        return 28 + Math.floor((18 * intersectionSize) / Math.max(expectedArtists.length, 1));
    }
    let best = 0;
    for (const expectedArtist of expectedArtists) {
        for (const candidateArtist of candidateArtists) {
            const score = hasAlignedContainment(expectedArtist, candidateArtist)
                ? 24
                : Math.round(tokenOverlapRatio(expectedArtist, candidateArtist) * 20);
            if (score > best) best = score;
        }
    }
    return best;
};

const hasPrimaryArtist = (expected, candidate, toSimplified) => {
    const expectedPrimary = primaryLyricMatchArtist(expected, toSimplified);
    if (!expectedPrimary) return false;
    return [...splitLyricMatchArtists(candidate, toSimplified)].some((name) => name === expectedPrimary);
};

const lyricVersionSignature = (value, toSimplified) => {
    const normalized = normalizeLyricMatchText(value, toSimplified);
    const found = normalized.match(VERSION_MODIFIER) ?? [];
    return new Set(found.map((modifier) => (modifier === 'remastered' ? 'remaster' : modifier)));
};

const hasCompatibleLyricVersion = (expectedTitle, candidateTitle, toSimplified) => {
    const expected = lyricVersionSignature(expectedTitle, toSimplified);
    const candidate = lyricVersionSignature(candidateTitle, toSimplified);
    if (expected.size !== candidate.size) return false;
    for (const modifier of expected) if (!candidate.has(modifier)) return false;
    return true;
};

/** 去掉尾部噪声与版本修饰词后的标题。 */
export const canonicalLyricMatchTitle = (value, toSimplified) =>
    normalizeLyricMatchText(value, toSimplified)
        .replace(new RegExp(CANONICAL_TRAILING_NOISE.source, 'g'), ' ')
        .replace(VERSION_MODIFIER, ' ')
        .replace(WHITESPACE, ' ')
        .trim();

const hasPlaceholderMetadata = (value, toSimplified) =>
    PLACEHOLDER_METADATA.has(normalizeLyricMatchText(value, toSimplified));

/** 时长打分：兼容区间内 42−Δms/500（不低于 22），否则按每 3s 扣 1 分（不深于 −48）。 */
export const scoreLyricMatchDuration = (expectedMs, candidateMs, isCompatible) => {
    if (!(expectedMs > 0) || !(candidateMs > 0)) return 0;
    const deltaMs = Math.abs(expectedMs - candidateMs);
    if (isCompatible(expectedMs, candidateMs)) {
        return Math.max(22, 42 - Math.floor(deltaMs / 500));
    }
    return -Math.min(48, Math.floor(deltaMs / 3000));
};

const scoreLyricMatchAlbum = (expected, candidate, toSimplified) => {
    const expectedAlbum = normalizeLyricMatchText(expected, toSimplified);
    const candidateAlbum = normalizeLyricMatchText(candidate, toSimplified);
    if (!expectedAlbum || !candidateAlbum) return 0;
    if (candidateAlbum === expectedAlbum) return 8;
    if (candidateAlbum.includes(expectedAlbum) || expectedAlbum.includes(candidateAlbum)) return 4;
    return 0;
};

const scoreLyricMatchQuality = (candidate) => {
    const formatScore = FORMAT_SCORE[candidate.format] ?? FORMAT_SCORE.lrc;
    const translationScore = candidate.translatedLyrics ? 5 : 0;
    // 音源额外加分与 SOURCE_PRIORITY 是两套独立的分。原实现也是两份
    const sourceScore = ['kugou', 'netease', 'qq'].includes(candidate.source)
        ? 4
        : candidate.source === 'lrclib'
            ? 2
            : candidate.source === 'amll'
                ? 1
                : 0;
    return formatScore + translationScore + sourceScore;
};

/** reliable 级身份：版本一致 + 主艺术家命中 + 标题规范形相等 + 两项阈值都过。 */
export const isReliableLyricMatchIdentity = (
    { expectedTitle, expectedArtist, candidateTitle, candidateArtist },
    toSimplified,
) => {
    if (!expectedTitle || !expectedArtist || !candidateTitle || !candidateArtist) return false;
    if (!hasCompatibleLyricVersion(expectedTitle, candidateTitle, toSimplified)) return false;
    const expectedPrimary = primaryLyricMatchArtist(expectedArtist, toSimplified);
    const candidateArtists = [...splitLyricMatchArtists(candidateArtist, toSimplified)];
    const primaryMatches =
        expectedPrimary !== null &&
        candidateArtists.some((name) => name === expectedPrimary || hasCollaboratorSuffix(name, expectedPrimary));
    return (
        primaryMatches &&
        canonicalLyricMatchTitle(expectedTitle, toSimplified) === canonicalLyricMatchTitle(candidateTitle, toSimplified) &&
        scoreLyricMatchTitle(expectedTitle, candidateTitle, toSimplified) >= MIN_RELIABLE_LYRIC_TITLE_SCORE &&
        scoreLyricMatchArtist(expectedArtist, candidateArtist, toSimplified) >= MIN_RELIABLE_LYRIC_ARTIST_SCORE
    );
};

/** plausible 级身份：reliable 之外放宽到三条可接受的组合。 */
export const isPlausibleLyricMatchIdentity = (
    { expectedTitle, expectedArtist, candidateTitle, candidateArtist, durationCompatible },
    toSimplified,
) => {
    const identity = { expectedTitle, expectedArtist, candidateTitle, candidateArtist };
    if (isReliableLyricMatchIdentity(identity, toSimplified)) return true;
    const titleScore = scoreLyricMatchTitle(expectedTitle, candidateTitle, toSimplified);
    const artistScore = scoreLyricMatchArtist(expectedArtist, candidateArtist, toSimplified);
    const primaryMatch = hasPrimaryArtist(expectedArtist, candidateArtist, toSimplified);
    return (
        (primaryMatch && titleScore >= 20 && durationCompatible) ||
        (titleScore >= MIN_RELIABLE_LYRIC_TITLE_SCORE && durationCompatible && !candidateArtist) ||
        (titleScore >= 20 && artistScore >= MIN_RELIABLE_LYRIC_ARTIST_SCORE && durationCompatible)
    );
};

/** 时长差；任一方缺时长则返回 null。 */
export const durationDeltaMs = (expectedMs, candidateMs) =>
    expectedMs > 0 && candidateMs > 0 ? Math.abs(expectedMs - candidateMs) : null;

/**
 * 给一批候选打分排序。
 *
 * @param request   { trackName, artistName, albumName?, durationMs, preferWordTimed?, keyword? }
 * @param candidates [{ id, source, title, artist, album?, durationMs?, lyrics, translatedLyrics?, format?, hasWordTiming?, sourceScore? }]
 * @param options   { toSimplified?, isDurationCompatible, keywordScorer? }
 */
export const rankLyricCandidates = (request, candidates, options) => {
    const toSimplified = options?.toSimplified ?? identity;
    // 入口就校验。原先写成「默认值是个会抛错的函数」，但它只在某条候选真的走到
    // 时长比较时才会被调用 —— 没有候选时就静默通过了，属于最糟的失败方式。
    const isCompatible = options?.isDurationCompatible;
    if (typeof isCompatible !== 'function') {
        throw new Error('rankLyricCandidates: options.isDurationCompatible is required');
    }
    const keywordScorer = options?.keywordScorer;

    const ranked = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!candidate?.lyrics) continue;
        if (candidate.collapsedTimeline) continue;

        const titleScore = scoreLyricMatchTitle(request.trackName, candidate.title, toSimplified);
        const artistScore = scoreLyricMatchArtist(request.artistName, candidate.artist, toSimplified);
        const albumScore = scoreLyricMatchAlbum(request.albumName ?? '', candidate.album ?? '', toSimplified);
        const durationScore = scoreLyricMatchDuration(request.durationMs ?? 0, candidate.durationMs ?? 0, isCompatible);
        const qualityScore = scoreLyricMatchQuality(candidate);
        const hasWordTiming = Boolean(candidate.hasWordTiming);
        const wordTimingBonus = request.preferWordTimed && hasWordTiming ? WORD_TIMED_LYRIC_MATCH_BONUS : 0;
        const keywordScore = keywordScorer ? (keywordScorer(request.keyword ?? '', candidate) ?? 0) : 0;

        const canUseKeywordFallback =
            hasPlaceholderMetadata(request.trackName, toSimplified) ||
            hasPlaceholderMetadata(request.artistName, toSimplified);
        const primaryMatch = hasPrimaryArtist(request.artistName, candidate.artist, toSimplified);
        const hasDurationSignal =
            (request.durationMs ?? 0) <= 0 || (candidate.durationMs ?? 0) <= 0 ||
            isCompatible(request.durationMs, candidate.durationMs);
        const reliable = isReliableLyricMatchIdentity(
            {
                expectedTitle: request.trackName,
                expectedArtist: request.artistName,
                candidateTitle: candidate.title,
                candidateArtist: candidate.artist,
            },
            toSimplified,
        );
        const plausible =
            isPlausibleLyricMatchIdentity(
                {
                    expectedTitle: request.trackName,
                    expectedArtist: request.artistName,
                    candidateTitle: candidate.title,
                    candidateArtist: candidate.artist,
                    durationCompatible: hasDurationSignal,
                },
                toSimplified,
            ) ||
            (canUseKeywordFallback && (keywordScore > 0 || titleScore >= 20));
        if (!plausible) continue;

        const score =
            titleScore + artistScore + albumScore + durationScore + qualityScore +
            wordTimingBonus + keywordScore + Math.min(Math.max(candidate.sourceScore ?? 0, 0), 20);
        if (score < MIN_EDITABLE_LYRIC_MATCH_SCORE) continue;

        const confidence = reliable && hasDurationSignal
            ? CONFIDENCE.HIGH
            : primaryMatch && hasDurationSignal && titleScore >= 20
                ? CONFIDENCE.MEDIUM
                : titleScore >= MIN_RELIABLE_LYRIC_TITLE_SCORE && hasDurationSignal
                    ? CONFIDENCE.MEDIUM
                    : CONFIDENCE.LOW;

        ranked.push({
            candidate,
            score,
            durationDeltaMs: durationDeltaMs(request.durationMs ?? 0, candidate.durationMs ?? 0),
            confidence,
            hasWordTiming,
        });
    }

    // 偏好逐词时整体提为一档，而不是只加分 —— 只加分的话「高置信度的逐行结果」
    // 仍会压过「中置信度的逐词结果」，与「优先逐词」的语义不符。原实现如此。
    ranked.sort((left, right) => {
        if (request.preferWordTimed && left.hasWordTiming !== right.hasWordTiming) return left.hasWordTiming ? -1 : 1;
        if (left.confidence !== right.confidence) return right.confidence - left.confidence;
        if (left.score !== right.score) return right.score - left.score;
        const leftDelta = left.durationDeltaMs ?? Number.MAX_SAFE_INTEGER;
        const rightDelta = right.durationDeltaMs ?? Number.MAX_SAFE_INTEGER;
        if (leftDelta !== rightDelta) return leftDelta - rightDelta;
        const leftPriority = SOURCE_PRIORITY[left.candidate.source] ?? 0;
        const rightPriority = SOURCE_PRIORITY[right.candidate.source] ?? 0;
        if (leftPriority !== rightPriority) return rightPriority - leftPriority;
        return normalizeLyricMatchText(left.candidate.title, toSimplified).localeCompare(
            normalizeLyricMatchText(right.candidate.title, toSimplified),
        );
    });
    return ranked;
};

export const LYRIC_MATCH_THRESHOLDS = {
    MIN_SCORE: MIN_EDITABLE_LYRIC_MATCH_SCORE,
    WORD_TIMED_BONUS: WORD_TIMED_LYRIC_MATCH_BONUS,
    MIN_TITLE: MIN_RELIABLE_LYRIC_TITLE_SCORE,
    MIN_ARTIST: MIN_RELIABLE_LYRIC_ARTIST_SCORE,
};
