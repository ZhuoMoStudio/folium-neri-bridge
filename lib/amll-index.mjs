// lib/amll-index.mjs
//
// AMLL TTDB 的索引解析。纯函数，不联网。
//
// 上游仓库：https://github.com/amll-dev/amll-ttml-db（**CC0-1.0**，公有领域奉献）
// 索引文件：metadata/raw-lyrics-index.jsonl，每行一条：
//   {"metadata":[["album",["夜に駆ける"]],["artists",["YOASOBI"]],["musicName",["夜に駆ける"]],
//                ["ncmMusicId",["1409311773"]],...],"rawLyricFile":"1689400682000-83578994-e3ba9609.ttml"}
//
// 为什么要索引而不是直接搜：TTDB 的在线服务（https://amll-ttml-db.stevexmh.net）只按
// `[平台]/[音乐ID]` 取歌词，**没有搜索接口**，而 B 站的歌没有 ncm/qq/am/spotify 的 id。
// 所以流程是：拉索引 → 在本地按标题/艺术家匹配 → 拿到 id 或 rawLyricFile → 再取 TTML。
//
// 索引原始体积 1.6MB（gzip 传输约 428KB），超出模组数据文件的 1MB 上限，
// 所以落盘前先压成紧凑形状：3080 条 / 453KB，占 1MB 上限的 44%（实测，见 test/08-amll-live.mjs）。
// 压缩只丢字段、不丢条目。

/** 索引里保留的平台 id。用于取歌词文件，也用于匹配时的身份判定。 */
const ID_KEYS = ['ncmMusicId', 'qqMusicId', 'appleMusicId', 'spotifyId'];

/**
 * 落盘用的短键。改这里要同时改 expandAmllIndex 与 AMLL_INDEX_FORMAT。
 *
 * 为什么连键名都要缩：3080 条 × 每条 4 个长键，光键名就差出几十 KB，
 * 而模组的数据文件总共只有 1MB。
 *
 * 为什么不存 album：`scoreLyricMatchAlbum` 最多加 8 分，而请求侧（B 站）根本没有专辑名，
 * 这 8 分永远拿不到 —— 白占 87KB（实测 679KB → 592KB）。等哪天真有专辑元数据了再加回来。
 */
const COMPACT_KEYS = { title: 't', artists: 'a', ids: 'i', rawLyricFile: 'f' };
const SHORT_ID_KEYS = { ncmMusicId: 'n', qqMusicId: 'q', appleMusicId: 'm', spotifyId: 's' };
const LONG_ID_KEYS = Object.fromEntries(Object.entries(SHORT_ID_KEYS).map(([long, short]) => [short, long]));

/** 换字段就改它：旧缓存会被版本号挡下，而不是解析出半截数据。 */
export const AMLL_INDEX_FORMAT = 2;

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

/** 一条 metadata 的 [[key, [values]], ...] → 普通对象（同名 key 合并成数组）。 */
const metadataToObject = (metadata) => {
    const out = {};
    for (const entry of Array.isArray(metadata) ? metadata : []) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [key, value] = entry;
        if (typeof key !== 'string') continue;
        const values = (Array.isArray(value) ? value : [value])
            .map((item) => String(item ?? '').trim())
            .filter(Boolean);
        if (values.length === 0) continue;
        out[key] = out[key] ? [...out[key], ...values] : values;
    }
    return out;
};

/**
 * 解析 raw-lyrics-index.jsonl。
 *
 * 坏行直接跳过（上游是人工投稿的仓库，格式偶有不齐），不抛错 ——
 * 一条坏行不该让整个歌词源不可用。
 *
 * @returns {Array<{title: string, artists: string[], ids: object, rawLyricFile: string}>}
 */
export const parseAmllIndex = (text) => {
    const entries = [];
    for (const line of String(text ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try {
            row = JSON.parse(trimmed);
        } catch {
            continue;
        }
        const metadata = metadataToObject(row?.metadata);
        const title = String(firstValue(metadata.musicName) ?? '').trim();
        const rawLyricFile = String(row?.rawLyricFile ?? '').trim();
        if (!title || !rawLyricFile) continue;

        const ids = {};
        for (const key of ID_KEYS) {
            const value = firstValue(metadata[key]);
            if (value) ids[key] = String(value);
        }

        entries.push({
            title,
            artists: (metadata.artists ?? []).slice(0, 4),
            ids,
            rawLyricFile,
        });
    }
    return entries;
};

/** 身份去重用的键：同一首歌被投稿多次（rawLyricFile 不同）时只留第一条。 */
const identityOf = (entry) =>
    [entry.title, entry.artists.join('/'), ID_KEYS.map((key) => entry.ids[key] ?? '').join(',')]
        .join('\u0001')
        .toLowerCase();

/** 去重，保留先出现的那条。 */
export const dedupeAmllEntries = (entries) => {
    const seen = new Set();
    const out = [];
    for (const entry of entries) {
        const key = identityOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
};

/** 压成落盘用的形状。artists 用 `/` 连接：lyric-match 的艺术家拆分本来就认这个分隔符。 */
export const compactAmllIndex = (entries) =>
    entries.map((entry) => {
        const compact = {
            [COMPACT_KEYS.title]: entry.title,
            [COMPACT_KEYS.artists]: entry.artists.join('/'),
            [COMPACT_KEYS.rawLyricFile]: entry.rawLyricFile,
        };
        const ids = {};
        for (const key of ID_KEYS) if (entry.ids[key]) ids[SHORT_ID_KEYS[key]] = entry.ids[key];
        if (Object.keys(ids).length > 0) compact[COMPACT_KEYS.ids] = ids;
        return compact;
    });

/** compactAmllIndex 的逆操作。形状不对的条目跳过。 */
export const expandAmllIndex = (compact) =>
    (Array.isArray(compact) ? compact : [])
        .map((row) => {
            const title = String(row?.[COMPACT_KEYS.title] ?? '').trim();
            const rawLyricFile = String(row?.[COMPACT_KEYS.rawLyricFile] ?? '').trim();
            if (!title || !rawLyricFile) return null;
            const artists = String(row?.[COMPACT_KEYS.artists] ?? '')
                .split('/')
                .map((name) => name.trim())
                .filter(Boolean);
            const ids = {};
            for (const [short, long] of Object.entries(LONG_ID_KEYS)) {
                const value = row?.[COMPACT_KEYS.ids]?.[short];
                if (value) ids[long] = String(value);
            }
            return { title, artists, ids, rawLyricFile };
        })
        .filter(Boolean);

export const AMLL_PLATFORM_IDS = ID_KEYS;
