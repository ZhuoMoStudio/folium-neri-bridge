// test/02-live.mjs —— 打真实网络，验证 B 站链路与 LRCLIB
//
// 覆盖 README「首次验证清单」里除了「模组能否被宿主加载」以外的全部步骤。
// 仍无法覆盖的只有两件：宿主是否接受这个 provider 定义、以及 <audio> 元素能否播放。
// 后者用一次带/不带 Referer 的 Range 请求来逼近。
import { createFakeFolium, check, summary } from './harness.mjs';
import { createHttp } from '../lib/http.mjs';
import { createBilibiliProvider } from '../providers/bilibili.mjs';
import { createLrclibBackend } from '../providers/lyrics/lrclib.mjs';

const KEYWORD = process.argv[2] ?? '夜に駆ける';

const { folium, calls } = createFakeFolium();
const http = createHttp(folium, folium.log);
const lrclib = createLrclibBackend(http);
const provider = createBilibiliProvider({ http, lrclib, log: folium.log });

const attempt = async (label, fn) => {
    try {
        return await fn();
    } catch (error) {
        check(label, false, `抛错: ${error?.message ?? error}`);
        return null;
    }
};

// ---------------------------------------------------------------- 1. 搜索
console.log(`\n== 1. B 站搜索（WBI 签名 + /wbi/search/type）keyword="${KEYWORD}" ==`);
const page = await attempt('provider.search', () => provider.search(KEYWORD, { limit: 5, offset: 0 }));
const items = page?.items ?? [];
check('search 返回结构正确', Array.isArray(page?.items) && typeof page?.hasMore === 'boolean');
check('搜索有结果', items.length > 0, `拿到 ${items.length} 条`);
if (items[0]) {
    console.log('    首条：', JSON.stringify(items[0], null, 0));
}
check(
    '搜索结果字段完整（id/title/artists）',
    items.every((item) => item.id?.startsWith('bili:') && item.title && Array.isArray(item.artists)),
);
check('搜索结果带时长', items.some((item) => Number(item.durationMs) > 0));

const first = items[0];

// ------------------------------------------------------- 2. WBI 密钥缓存
console.log('\n== 2. WBI 密钥缓存行为 ==');
const navCalls = calls.filter((call) => call.url.includes('/x/web-interface/nav'));
const before = navCalls.length;
await attempt('第二次 search（应命中缓存）', () => provider.search('残酷な天使のテーゼ', { limit: 3, offset: 0 }));
const after = calls.filter((call) => call.url.includes('/x/web-interface/nav')).length;
check('nav 未被重复请求（10 分钟缓存生效）', after === before, `nav 调用次数 ${before} → ${after}`);

// ------------------------------------------------------------ 3. cid 解析
console.log('\n== 3. cid 解析（/x/player/pagelist）==');
const song = await attempt('provider.getSong', () => provider.getSong(first?.id));
check('getSong 返回歌曲', Boolean(song?.id), JSON.stringify(song));
check('返回的 id 带上了 cid', /^bili:BV[^:]+:\d+$/.test(song?.id ?? ''), String(song?.id));

// ------------------------------------------------------------ 4. 取音频流
console.log('\n== 4. 取音频流（/wbi/playurl, fnval=16 DASH）==');
const audio = await attempt('provider.getAudioUrl(high)', () => provider.getAudioUrl(song ?? first, 'high'));
check('拿到音频直链', typeof audio?.url === 'string' && audio.url.length > 0, audio?.url?.slice(0, 90));
check('带 expiresAt（从 deadline 解析）', Number.isFinite(audio?.expiresAt), String(audio?.expiresAt));
if (audio?.url) {
    const deadlineSeconds = new URL(audio.url).searchParams.get('deadline');
    check('url 带 deadline 参数', Boolean(deadlineSeconds), `deadline=${deadlineSeconds}`);
}

// ----------------------------------------- 5. 关键：CDN 是否需要 Referer
console.log('\n== 5. 关键风险验证：音频 CDN 的 Referer 策略 ==');
if (audio?.url) {
    /** expectOk=false 时只观察不断言（用于预期就该被 CDN 拒绝的探针）。 */
    const probe = async (label, headers, expectOk = true) => {
        const startedAt = Date.now();
        try {
            const response = await fetch(audio.url, { headers });
            const buffer = await response.arrayBuffer();
            const ms = Date.now() - startedAt;
            if (expectOk) {
                check(
                    label,
                    response.ok,
                    `HTTP ${response.status} ${response.statusText} · ${buffer.byteLength} bytes · ${ms}ms`,
                );
            } else {
                console.log(`    （观察）${label} → HTTP ${response.status} · ${ms}ms`);
            }
            return { status: response.status, bytes: buffer.byteLength };
        } catch (error) {
            check(label, false, `请求失败: ${error?.message ?? error}`);
            return null;
        }
    };

    // 模拟 Electron 里 <audio src> 的真实情形。
    // 实测（test/04-cdn.mjs）：B 站同时用两个 CDN，防盗链策略不同 ——
    //   upos-sz-mirrorcosov.bilivideo.com   无 Referer → 403
    //   upos-hz-mirrorakam.akamaized.net    无 Referer → 206
    // 所以「不带 Referer」是 CDN 相关的，不能当作可行方案；
    // 唯一在两个 CDN 上都稳定的是带 B 站 Referer。
    const CHROMIUM_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    console.log(`    本次 CDN: ${new URL(audio.url).host}`);

    const fixed = await probe('带 B 站 Referer ← main 入口改写后的样子', {
        Range: 'bytes=0-2047',
        'User-Agent': CHROMIUM_UA,
        Referer: 'https://www.bilibili.com/',
    });
    // 下面两条按设计就是被拒的：一条随 CDN 变化，一条是 Folia 的默认状态
    const noReferer = await probe('无 Referer', { Range: 'bytes=0-2047', 'User-Agent': CHROMIUM_UA }, false);
    const devOrigin = await probe(
        '带 localhost Referer ← Folia 开发模式',
        { Range: 'bytes=0-2047', 'User-Agent': CHROMIUM_UA, Referer: 'http://localhost:3000/' },
        false,
    );

    check('带 B 站 Referer 可用 ⇒ 修复后一定能播', [200, 206].includes(fixed?.status), `status=${fixed?.status}`);
    check('localhost Referer 被拒 ⇒ 证明 main 入口确有必要', devOrigin?.status === 403, `status=${devOrigin?.status}`);
    console.log(`    ℹ 无 Referer 本次返回 ${noReferer?.status}（随 CDN 变化，见 test/04-cdn.mjs）`);
}

// ------------------------------------------------------------ 6. LRCLIB
console.log('\n== 6. LRCLIB 歌词后端 ==');

// 不变量：只要返回非 null，就必须是带时间戳的歌词。
// 纯文本一律不返回 —— parseLRC 会丢弃无时间标签的行（parserCore.ts:347），
// 交出去只会得到一个空歌词列表。
const lrclibDirect = await attempt('lrclib.lookup(夜に駆ける / YOASOBI / 259s, 严格时长)', () =>
    lrclib.lookup({ title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000 }),
);
check(
    '返回值若存在则必带时间戳',
    !lrclibDirect || /\[\d{2}:\d{2}/.test(lrclibDirect.lrc),
    lrclibDirect ? `长度 ${lrclibDirect.lrc.length}` : 'null（该记录只有纯文本，按设计不返回）',
);
if (lrclibDirect) console.log('    命中:', JSON.stringify(lrclibDirect.lrc.slice(0, 70)));

// 这是 B 站路径的真实情形：MV 时长 276s，LRCLIB 记录 259s，差 17s 越过 15s 上限。
// 严格模式漏掉，宽松模式靠标题+艺术家命中。
const mvRelaxed = await attempt('lrclib.lookup(MV 时长 276s, relaxedDuration)', () =>
    lrclib.lookup({ title: '夜に駆ける', artist: 'Ayase-YOASOBI', durationMs: 276_000, relaxedDuration: true }),
);
check(
    '宽松模式下 MV 时长也能命中',
    Boolean(mvRelaxed?.lrc) && /\[\d{2}:\d{2}/.test(mvRelaxed.lrc),
    mvRelaxed ? `长度 ${mvRelaxed.lrc.length}` : 'null',
);

// ------------------------------------------------- 7. provider.getLyrics
console.log('\n== 7. provider.getLyrics（B 站标题 + UP 主 → LRCLIB）==');
const lyrics = await attempt('provider.getLyrics', () => provider.getLyrics(song ?? first));
check('未抛错', true, lyrics ? `长度 ${lyrics.lrc.length}` : '返回 null（B 站标题匹配不到，属预期）');

// ------------------------------------------------------------------ 统计
console.log('\n== 请求汇总 ==');
for (const call of calls) {
    const path = (() => {
        try {
            return new URL(call.url).pathname;
        } catch {
            return call.url;
        }
    })();
    console.log(`    ${String(call.status).padStart(3)}  ${String(call.ms).padStart(5)}ms  ${path}`);
}

process.exit(summary() === 0 ? 0 : 1);
