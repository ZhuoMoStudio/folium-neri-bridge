// lib/match.mjs
//
// 外部歌词的身份判定。移植自 NeriPlayer 的：
//   core/api/lyrics/LrcLibClient.kt            （歌名/艺术家清洗与归一化）
//   core/api/lyrics/ExternalLyricMatchPolicy.kt （时长容差）
//
// ⚠️ 已知的简化：原实现还有一套位于 EditableLyricMatchPolicy.kt 的评分制
//    （canonicalLyricMatchTitle / scoreLyricMatchTitle / scoreLyricMatchArtist，共约 480 行，
//    能处理《曲名 (Live ver.)》《曲名 - TV Size》这类版本差异与 feat. 合唱）。
//    v0.1.0 只做了归一化后的相等判定 + 艺术家包含判定，误匹配率会比原实现高。
//    对齐评分制已列为 v0.2.0 的任务。

const MIN_DURATION_TOLERANCE_MS = 7000;
const MAX_DURATION_TOLERANCE_MS = 15000;
const DURATION_TOLERANCE_PERCENT = 6;

/** 原实现只接受分号、feat./ft.、x、&、and 之前的第一位艺术家。 */
const ARTIST_SPLIT_PATTERN = /\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s+[xX]\s+|\s*&\s*|\s+and\s+/i;

/** 搜索标题里常见的后缀。原实现同样处理了这些。 */
const NOISE_PAREN_PATTERN =
    /\s*(?:\(.*?(?:official|video|audio|lyrics?|visualizer|hd|hq|4k).*?\)|\[.*?(?:official|video|audio|lyrics?|visualizer|hd|hq|4k).*?\]|【.*?】)/gi;
const NOISE_TAIL_PATTERN = /\s*-\s*(official|video|audio|lyrics?)$/i;

/** B 站视频标题里常见的、对外部歌词库没有意义的标记。 */
const BILI_TITLE_NOISE = [
    /【[^】]*】/g,
    /\[[^\]]*\]/g,
    /（[^）]*(?:MV|PV|官方|高清|完整版|中文字幕|无损| Lyrics?)[^）]*）/gi,
    /\b(?:MV|PV|OFFICIAL\s*VIDEO|Official\s*Music\s*Video)\b/gi,
];

/** 剥掉搜索接口返回标题里的 <em class="keyword"> 等标签。 */
export const stripHtml = (html) =>
    String(html ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim();

export const cleanTrackName = (value) => {
    const stripped = String(value ?? '').replace(NOISE_PAREN_PATTERN, '').replace(NOISE_TAIL_PATTERN, '');
    let result = stripped.trim();
    for (const pattern of BILI_TITLE_NOISE) result = result.replace(pattern, '');
    return result.replace(/\s{2,}/g, ' ').trim();
};

export const primaryArtist = (value) =>
    String(value ?? '').trim().split(ARTIST_SPLIT_PATTERN)[0]?.trim() ?? '';

/** NFKC + 小写 + 只留字母数字与 CJK，空格归一。 */
export const normalizeText = (value) =>
    String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s{2,}/g, ' ');

/** 时长容差：7s 与预期的 6% 取大，封顶 15s。与原实现同参数。 */
export const isDurationCompatible = (expectedMs, candidateMs) => {
    if (!(expectedMs > 0) || !(candidateMs > 0)) return false;
    const tolerance = Math.min(
        Math.max(MIN_DURATION_TOLERANCE_MS, Math.floor((expectedMs * DURATION_TOLERANCE_PERCENT) / 100)),
        MAX_DURATION_TOLERANCE_MS,
    );
    return Math.abs(expectedMs - candidateMs) <= tolerance;
};

/** 歌名归一后相等，或一方包含另一方（处理副标题差异）。 */
export const isTitleCompatible = (expectedTitle, candidateTitle) => {
    const expected = normalizeText(cleanTrackName(expectedTitle));
    const candidate = normalizeText(cleanTrackName(candidateTitle));
    if (!expected || !candidate) return false;
    return expected === candidate || expected.includes(candidate) || candidate.includes(expected);
};

/** 代表性艺术家相同，或一方包含另一方（处理“某某 / 某某”这类差别）。 */
export const isArtistCompatible = (expectedArtist, candidateArtist) => {
    const expected = normalizeText(primaryArtist(expectedArtist));
    const candidate = normalizeText(primaryArtist(candidateArtist));
    if (!expected || !candidate) return false;
    return expected === candidate || expected.includes(candidate) || candidate.includes(expected);
};

/** 完整的身份判定：歌名 + 艺术家 + 时长三者都过。 */
export const isCandidateMatch = ({ expectedTitle, expectedArtist, expectedDurationMs }, candidate) =>
    isTitleCompatible(expectedTitle, candidate.trackName) &&
    isArtistCompatible(expectedArtist, candidate.artistName) &&
    isDurationCompatible(expectedDurationMs, candidate.durationMs);
