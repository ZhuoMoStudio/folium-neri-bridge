// lib/artist-candidates.mjs
//
// 从 B 站视频的元数据里猜「真正的曲目艺术家」。
//
// 为什么需要：B 站搜索接口只返回 UP 主名（`entry.author`），那不是曲目艺术家 ——
// 实测「夜に駆ける」的搜索结果里，UP 主是「Ayase-YOASOBI」「云妮洁」「来吧马猴」，
// 而曲目艺术家是 YOASOBI。拿 UP 主去 LRCLIB / AMLL 匹配，艺术家那一项等于白送。
//
// 这里不追求「猜对唯一答案」，而是**产出多个候选**：`FoliumProviderSong.artists` 是
// `string[]`，匹配评分（lib/lyric-match.mjs）取预期艺术家与候选集合的最佳交集，
// LRCLIB 那条路则逐个试、第一个命中的就用。所以多给几个候选的代价很低，
// 漏掉真名的代价很高。据此设计：标题里 `X - Y` 的哪边是艺术家并不确定
// （实测 `周杰伦 - 晴天` 与 `晴天-周杰伦` 都常见），与其猜不如两边都给，
// 把选择权交给评分。
//
// 规则来源是实测数据，样本见 test/01-offline.mjs 的「从标题/简介提艺术家」一节。

/** 标题里被这些括号包起来的内容通常是画质/字幕组标记，不是艺术家名。 */
const NOISE_BRACKET = /【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g;

/** 括号里的内容像不像噪声标记。命中就当作噪声，不采信。 */
const BRACKET_NOISE_HINT =
    /(?:字幕|中字|中日|罗马音|谐音|无损|音质|画质|修复|转载|搬运|手书|教程|翻唱|合集|歌单|纯音乐|伴奏|教学|cover|lyric|sub|mv|pv|hi-?res|4k|8k|1080|720|hdr|hd|母带|现场|live|官方|完整版|高音质|flac|mp3|wav|demo|remix|教程)/i;

/**
 * 连字符家族。注意两个常量必须分开：
 * 往否定字符组里插 `[-–—－]` 会得到 `[^\s[-–—－]]`，第一个 `]` 就把字符组关掉了，
 * 后面的 `]` 变成字面量 —— 实测就是这个写法让 `晴天-周杰伦` 一条都提不出来。
 */
const DASH_CHARS = '-–—－';
const DASH_IN_CLASS = '\\-–—－';
/** 两侧带空白的连字符，或左侧无空白右侧有空白的连字符。 */
const DASH_SEPARATOR = new RegExp(`\\s+[${DASH_CHARS}]\\s+|\\s*[${DASH_CHARS}]\\s+`);
/** 整体就是一个 `X-Y`（两侧都短且无空白）：`晴天-周杰伦`、`Ayase-YOASOBI`。 */
const TIGHT_DASH = new RegExp(`^([^\\s${DASH_IN_CLASS}]{1,20})[${DASH_CHARS}]([^\\s${DASH_IN_CLASS}]{1,20})$`);
/** 《》前面那一段名字里不能出现这些字符。 */
const NOT_BEFORE_BOOK_TITLE = '\\s《》【】\\[\\]｜|';
const TITLE_PREFIX = `[^${NOT_BEFORE_BOOK_TITLE}]{1,40}`;

/** 简介里明写「歌手：X」这类字段。可信度最高。 */
const DESC_FIELD_PATTERNS = [
    /(?:歌手|演唱|主唱|Vocal|Artist)\s*[:：]\s*([^\r\n]{1,40})/gi,
    /(?:^|[\r\n|｜])\s*(?:唱|歌)\s*[:：]\s*([^\r\n]{1,40})/g,
];

/** 作词/作曲：这是「创作」而不是「演唱」，可信度次之，但常含真名（如 Ayase）。 */
const DESC_CREATOR_PATTERNS = [/(?:作词|作曲|编曲|詞曲|词曲)\s*[:：]\s*([^\r\n]{1,40})/g];

/** 单个候选名的最长长度。超过它基本是整句文案。 */
const MAX_CANDIDATE_LENGTH = 40;
/** 名字里不该出现的东西。命中即丢弃。 */
const REJECT_PATTERN = /(?:https?:|\d{5,})/u;
/** 句子标点出现即说明这不是一个名字，而是一段描述。 */
const SENTENCE_PUNCTUATION = /[，。！？；：,.!?;]/u;
/** 结尾是这些字符的也不是名字。 */
const BAD_TAIL = /[!！?？。，,、~～]+$/u;
/** 只有这些内容的候选没有信息量。 */
const PLACEHOLDER = /^(?:unknown|n\/?a|none|-|—|未知|佚名|无)$/i;
/** 单个候选首尾的装饰性括号与引号。 */
const TRIM_DECORATION = /^[\s《》【】「」『』“”"'｜|]+|[\s《》【】「」『』“”"'｜|]+$/g;

const clean = (value) => String(value ?? '').trim().replace(TRIM_DECORATION, '').trim();

const isUsableCandidate = (value) => {
    const text = clean(value);
    if (!text || text.length > MAX_CANDIDATE_LENGTH) return false;
    if (PLACEHOLDER.test(text)) return false;
    if (REJECT_PATTERN.test(text)) return false;
    if (SENTENCE_PUNCTUATION.test(text)) return false;
    if (BAD_TAIL.test(text)) return false;
    // 至少要有字母或 CJK，纯标点/纯数字不算名字
    return /\p{L}/u.test(text);
};

/** 把「A / B / C」「A+B」「A@B」这类枚举拆成单个名字。 */
const splitList = (value) =>
    String(value ?? '')
        .split(/[、,，;；/／|｜+＋@]|\s+&\s+|\s+and\s+|\s+x\s+/i)
        .map((part) => clean(part))
        .filter(Boolean);

/**
 * 扩展一个候选：先给整段，再给「首词」。
 *
 * 首词这一步实测很值：`YOASOBI Ayase+ikura` 这样的串，评分只认得 YOASOBI，
 * 而 `+` 拆出来的 `Ayase+ikura` 不是真名。首词一定要排在整段之后，
 * 否则「周杰伦 -‘故事的小黄花’」这种会先被拆成「周杰伦」而丢掉上下文。
 */
const expand = (value) => {
    const whole = clean(value);
    if (!whole) return [];
    const out = [whole];
    const firstToken = whole.match(/^([^\s]{2,20})\s+\S/);
    if (firstToken) out.push(firstToken[1]);
    return out;
};

/**
 * 从一段「看起来像名字」的文本里产出候选。
 *
 * @param bothSides 标题里 `X - Y` 的哪边是艺术家不确定，true 时两边都产出。
 */
const candidatesFromPair = (left, right, bothSides) => {
    const out = [];
    const push = (value) => {
        for (const part of splitList(value)) out.push(...expand(part));
    };
    if (bothSides) push(left);
    push(right);
    if (!bothSides) push(left);
    return out;
};

/** 从标题里提取候选。标题是最可靠且免费的来源（搜索接口就返回了）。 */
export const artistCandidatesFromTitle = (title) => {
    const raw = String(title ?? '').trim();
    if (!raw) return [];

    const out = [];

    // 1. 《曲名》- 艺术家 / 《曲名》艺术家（实测：「｜《晴天》- 周杰伦」）
    for (const match of raw.matchAll(new RegExp(`《([^》]{1,60})》(?:\\s*[${DASH_CHARS}]\\s*)?([^\\r\\n]{0,40})`, 'g'))) {
        const tail = match[2]?.trim().replace(new RegExp(`^[${DASH_CHARS}]\\s*`), '');
        if (tail) out.push(...candidatesFromPair(match[1], tail, false));
    }

    // 2. 艺术家《曲名》—— 《》前面那一段就是名字
    for (const match of raw.matchAll(new RegExp(`(${TITLE_PREFIX})\\s*《[^》]+》`, 'g'))) {
        out.push(...expand(match[1]));
    }

    // 3. 【艺术家】曲名：只在括号内容不像噪声标记时才采信
    for (const match of raw.matchAll(/【([^】]{1,40})】/g)) {
        const inner = clean(match[1]);
        if (BRACKET_NOISE_HINT.test(inner)) continue;
        if (!isUsableCandidate(inner)) continue;
        // 括号里不含空白又非纯拉丁的，多半是标签而不是人名
        if (/\s/.test(inner) || /^[A-Za-z][\w.'\- ]*$/.test(inner)) out.push(...expand(inner));
    }

    // 4. 去掉括号噪声后剩下的部分
    const stripped = raw
        .replace(NOISE_BRACKET, ' ')
        .replace(/[｜|]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (stripped) {
        const dash = stripped.split(DASH_SEPARATOR);
        if (dash.length >= 2) {
            out.push(...candidatesFromPair(dash[0], dash.slice(1).join(' - '), true));
        }
        // 5. 整段就是一个短 `X-Y`（实测：「晴天-周杰伦」）
        const tight = stripped.match(TIGHT_DASH);
        if (tight) out.push(...candidatesFromPair(tight[1], tight[2], true));
        // 6. 空白分隔：左半段像一个「名字」（短、无标点）时才采纳
        const firstToken = stripped.match(/^([^\s]{1,20})\s+(.+)$/);
        if (firstToken && isUsableCandidate(firstToken[1]) && !/\p{P}/u.test(firstToken[1])) {
            out.push(firstToken[1]);
        }
    }

    return out;
};

/** 从简介里提取候选。简介里明写「歌手：X」的准确率最高。 */
export const artistCandidatesFromDescription = (desc) => {
    const text = String(desc ?? '');
    if (!text.trim()) return [];

    const out = [];
    for (const pattern of [...DESC_FIELD_PATTERNS, ...DESC_CREATOR_PATTERNS]) {
        for (const match of text.matchAll(pattern)) {
            for (const part of splitList(match[1])) out.push(...expand(part));
        }
    }
    return out;
};

/**
 * 汇总所有来源，去重后返回候选列表。
 *
 * 顺序即优先级：合作者（staff，真实署名）→ 简介明写的歌手/创作者 → 标题 → UP 主
 * → 调用方给的额外候选。上游按顺序试，所以最可能命中的排前面。
 *
 * @param {object}   input
 * @param {string}   input.title     视频标题
 * @param {string}   input.ownerName UP 主名
 * @param {string}   input.desc      视频简介
 * @param {object[]} input.staff     view 接口的 data.staff
 * @param {string[]} input.extra     调用方已经知道的候选
 * @param {number}   input.limit     最多返回几个（默认 8）
 */
export const extractArtistCandidates = ({ title, ownerName, desc, staff, extra, limit = 8 } = {}) => {
    const ordered = [];

    for (const member of Array.isArray(staff) ? staff : []) {
        if (member?.name) ordered.push(member.name);
    }
    ordered.push(...artistCandidatesFromDescription(desc));
    ordered.push(...artistCandidatesFromTitle(title));
    if (ownerName) ordered.push(ownerName);
    for (const value of Array.isArray(extra) ? extra : []) if (value) ordered.push(value);

    const seen = new Set();
    const out = [];
    for (const value of ordered) {
        if (!isUsableCandidate(value)) continue;
        const text = clean(value);
        const key = text.normalize('NFKC').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }
    return out;
};

export const ARTIST_CANDIDATE_LIMIT = 8;
