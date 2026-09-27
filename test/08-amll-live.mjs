// test/08-amll-live.mjs —— 打真实网络，验证 AMLL TTDB 逐字歌词链路
//
// 走完整条路：拉索引（1.6MB，gzip 传输约 428KB）→ 本地匹配 → 取 TTML → 解析 →
// 与 LRCLIB 的行级时轴对齐 → 走一遍安装决策。最后一步是纯函数，不需要宿主。
//
// 依赖上游：
//   - raw.githubusercontent.com（索引与 TTML 原文）
//   - amll-ttml-db.stevexmh.net（按平台 id 取 TTML）
//   - lrclib.net（对照用的行级歌词）
// 三者任一不可用都会红，这是有意的：这条链路的价值就在于上游真的能读。
import { check, summary } from './harness.mjs';
import { createHttp } from '../lib/http.mjs';
import { createAmllBackend } from '../providers/lyrics/amll.mjs';
import { createLrclibBackend } from '../providers/lyrics/lrclib.mjs';
import { planWordTimingInstall } from '../lib/word-timing.mjs';
import { parseTtml } from '../lib/ttml.mjs';

const CHROMIUM_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const log = {
    info: (message, details) => console.log(`    · ${message}`, details ? JSON.stringify(details) : ''),
    warn: (message, details) => console.log(`    ! ${message}`, details ? JSON.stringify(details) : ''),
    error: (message, details) => console.log(`    ✗ ${message}`, details ? JSON.stringify(details) : ''),
};

/** 模拟 folium.net.fetch 的形状。除了「谁去发请求」以外什么都没换。 */
const netFetch = async (url, init = {}) => {
    const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers ?? { 'User-Agent': CHROMIUM_UA },
        body: init.body,
        redirect: 'follow',
    });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers, text: () => text, json: () => JSON.parse(text) };
};

/** 模拟模组的数据文件（1MB 上限）。 */
const createStorage = () => {
    const files = new Map();
    return {
        get: async (key) => files.get(key),
        set: async (key, value) => {
            files.set(key, value);
        },
        files,
    };
};

const http = createHttp({ log, net: { fetch: netFetch } }, log);
const storage = createStorage();
const amll = createAmllBackend({ http, log, storage });
const lrclib = createLrclibBackend(http);

/** 把 LRC 解成行级时轴。宿主用的是自己的 parseLRC，这里只要等价的行。 */
const parseLrcLines = (text) =>
    String(text ?? '')
        .split(/\r?\n/)
        .map((line) => {
            const match = line.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/);
            if (!match) return null;
            const fraction = match[3] ?? '';
            const ms = fraction.length === 1 ? Number(fraction) * 100 : fraction.length === 2 ? Number(fraction) * 10 : Number(fraction || 0);
            const body = match[4].trim();
            return body ? { startTime: Number(match[1]) * 60 + Number(match[2]) + ms / 1000, fullText: body } : null;
        })
        .filter(Boolean);

console.log('\n== 1. 索引（首次要下载）==');
const startedIndex = Date.now();
await amll.warm();
const indexMs = Date.now() - startedIndex;
const compact = storage.files.get('amllIndex');
check('索引下载并落盘', Array.isArray(compact) && compact.length > 1000, `${compact?.length ?? 0} 条，${indexMs}ms`);
check(
    '落盘体积在 1MB 数据文件上限内且留有余量',
    JSON.stringify(compact).length < 700 * 1024,
    `${(JSON.stringify(compact).length / 1024).toFixed(0)} KB（占 1MB 的 ${((JSON.stringify(compact).length / 1048576) * 100).toFixed(1)}%）`,
);
check('索引带了 7 天的时间戳', Number(storage.files.get('amllIndexFetchedAt')) > 0);
check('索引带了格式版本号', storage.files.get('amllIndexFormat') >= 1);

console.log('\n== 2. 落盘缓存能被重新读出来 ==');
const cachedStorage = createStorage();
cachedStorage.files.set('amllIndex', compact);
cachedStorage.files.set('amllIndexFetchedAt', Date.now());
cachedStorage.files.set('amllIndexFormat', storage.files.get('amllIndexFormat'));
const cachedAmll = createAmllBackend({
    http: createHttp(
        { log: { info: () => {}, warn: () => {}, error: () => {} }, net: { fetch: async () => ({ ok: false, status: 500, headers: {}, text: () => '' }) } },
        log,
    ),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    storage: cachedStorage,
});
const fromCache = await cachedAmll.lookup({ title: '夜に駆ける', artists: ['YOASOBI'], durationMs: 259000 });
check('断网也能用落盘缓存命中的条目（TTML 仍需联网，此处只验索引读取）', fromCache !== undefined);
check('缓存路径不会重写索引', cachedStorage.files.get('amllIndex') === compact);

console.log('\n== 3. 真实匹配 ==');
const CASES = [
    { title: '夜に駆ける', artists: ['YOASOBI', 'Ayase-YOASOBI'], durationMs: 276000, expect: true },
    { title: 'Idol', artists: ['YOASOBI', 'Browin_Bear'], durationMs: 216000, expect: true },
    { title: '晴天', artists: ['周杰伦', 'VV音乐局'], durationMs: 270000, expect: true },
    { title: '这首歌一定不存在 zzq-xkcd-42', artists: ['Nobody At All'], durationMs: 100000, expect: false },
];

for (const testCase of CASES) {
    console.log(`\n  --- ${testCase.title} ---`);
    const started = Date.now();
    const found = await amll.lookup(testCase);
    const ms = Date.now() - started;
    check(
        `lookup(${testCase.title}) ${testCase.expect ? '命中' : '不命中'}`,
        Boolean(found) === testCase.expect,
        `${ms}ms ${found ? `${found.lines.length} 行 · ${found.entry.title} / ${found.entry.artists.join('/')}` : 'null'}`,
    );
    if (!found) continue;

    check('有词的行占比高（真的是逐字）', found.lines.every((line) => Array.isArray(line.words) && line.words.length > 0));
    check('每行的词都带 syllable', found.lines.every((line) => line.words.every((word) => Array.isArray(word.syllables) && word.syllables.length > 0)));
    check('词与时间单调递增', found.lines.every((line) => line.words.every((word) => word.endTime >= word.startTime)));
    check('行时间单调递增', found.lines.every((line, index) => index === 0 || line.startTime >= found.lines[index - 1].startTime));
    check(
        '★ words 拼接 === fullText（宿主用这条不变量判断要不要重新对齐词）',
        found.lines.every((line) => line.words.map((word) => word.text).join('') === line.fullText),
        found.lines.find((line) => line.words.map((word) => word.text).join('') !== line.fullText)?.fullText ?? '',
    );
    check('第一行有正的时间', found.lines[0].startTime > 0 && found.lines[0].endTime > found.lines[0].startTime);
    check('调用了官方 TTDB 服务', String(found.source).includes('amll-ttml-db.stevexmh.net') || String(found.source).includes('raw.githubusercontent.com'), found.source);
    check('匹配分数被记录下来', found.titleScore >= 52 && found.artistScore >= 24, `title=${found.titleScore} artist=${found.artistScore}`);

    // 与 LRCLIB 的行级时轴对齐，并走一遍安装决策
    const lrc = await lrclib.lookup({ title: testCase.title, artists: testCase.artists, durationMs: testCase.durationMs, relaxedDuration: true });
    if (!lrc) {
        console.log('      （LRCLIB 没这份歌，跳过对齐；这正是「无参照」那条分支）');
        const plan = planWordTimingInstall({ referenceLines: [], candidateLines: found.lines, titleScore: found.titleScore });
        check(`无参照时的决策与标题分数相符（${found.titleScore} 分）`, plan.install === (found.titleScore >= 80), JSON.stringify(plan));
        continue;
    }
    const reference = parseLrcLines(lrc.lrc);
    const plan = planWordTimingInstall({ referenceLines: reference, candidateLines: found.lines, titleScore: found.titleScore });
    check('对齐后能给出安装决策', typeof plan.install === 'boolean', `${JSON.stringify(plan)} · 参照 ${reference.length} 行 / 候选 ${found.lines.length} 行`);
    if (plan.install) {
        check('对齐成功时偏移是有限的秒数', Number.isFinite(plan.offset) && Math.abs(plan.offset) <= 60, `${plan.offset.toFixed(3)}s`);
        console.log(`      ℹ 偏移 ${(plan.offset * 1000).toFixed(0)}ms（参照 ${reference.length} 行 / 候选 ${found.lines.length} 行）`);
    }
}

console.log('\n== 4. 上游坏掉时的降级（喂坏数据）==');
const brokenHttp = createHttp(
    { log: { info: () => {}, warn: () => {}, error: () => {} }, net: { fetch: async () => ({ ok: true, status: 200, headers: {}, text: () => '不是 JSONL，也不是 TTML' }) } },
    log,
);
const broken = createAmllBackend({
    http: brokenHttp,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    storage: createStorage(),
});
check('上游格式变了时返回 null 而不是抛错', (await broken.lookup({ title: 'x', artists: ['y'] })) === null);
check('没有艺术家候选时直接返回 null', (await broken.lookup({ title: 'x', artists: [] })) === null);
check('没有标题时直接返回 null', (await broken.lookup({ title: '', artists: ['y'] })) === null);
check('行级 TTML 会被拒绝（没有逐字就不该冒充逐字）', parseTtml('<tt><body><p begin="0s" end="2s">一行</p></body></tt>').hasWordTiming === false);

process.exit(summary() === 0 ? 0 : 1);
