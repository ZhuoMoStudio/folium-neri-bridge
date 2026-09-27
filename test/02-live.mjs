// test/02-live.mjs —— 打真实网络，验证 B 站链路与 LRCLIB
//
// 覆盖 README「首次验证清单」里除了「模组能否被宿主加载」以外的全部步骤。
// 仍无法覆盖的只有两件：宿主是否接受这个 provider 定义、以及 <audio> 元素能否播放。
// 后者用一次带/不带 Referer 的 Range 请求来逼近。
//
// 第 9 节专门验证 WBI 的第二条密钥路径（GenWebTicket）：
// 它把 nav 那条打断，然后拿兜底签名去打真实接口 —— 通了才算数。
import { createFakeFolium, check, summary } from './harness.mjs';
import { createHttp } from '../lib/http.mjs';
import { createBilibiliProvider } from '../providers/bilibili.mjs';
import { createLrclibBackend } from '../providers/lyrics/lrclib.mjs';

const KEYWORD = process.argv[2] ?? '夜に駆ける';

const { folium, calls } = createFakeFolium();
const http = createHttp(folium, folium.log);
const lrclib = createLrclibBackend(http);
const provider = createBilibiliProvider({ http, lrclib, log: folium.log });

const CHROMIUM_UA_FOR_WBI =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
    /**
     * expectOk=false 时只观察不断言（用于预期就该被 CDN 拒绝的探针）。
     * 链路本身被重置（fetch failed）与 HTTP 403 不是一回事：前者不是策略结论，
     * 所以 expectOk 的探针会重试，重试完仍失败才算失败。
     */
    const probe = async (label, headers, expectOk = true) => {
        const tries = expectOk ? 3 : 1;
        let lastError = null;
        for (let tryIndex = 0; tryIndex < tries; tryIndex += 1) {
            const startedAt = Date.now();
            try {
                const response = await fetch(audio.url, { headers });
                const buffer = await response.arrayBuffer();
                const ms = Date.now() - startedAt;
                if (expectOk) {
                    check(
                        label,
                        response.ok,
                        `HTTP ${response.status} ${response.statusText} · ${buffer.byteLength} bytes · ${ms}ms${tryIndex > 0 ? ` · 第 ${tryIndex + 1} 次尝试` : ''}`,
                    );
                } else {
                    console.log(`    （观察）${label} → HTTP ${response.status} · ${ms}ms`);
                }
                return { status: response.status, bytes: buffer.byteLength };
            } catch (error) {
                lastError = error;
                if (tryIndex < tries - 1) await new Promise((resolve) => setTimeout(resolve, 400));
            }
        }
        // 预期就该被拒的探针，网络层失败也算通过 —— 连接被重置和 403 是同一件事：没播成
        if (expectOk) check(label, false, `请求失败: ${lastError?.message ?? lastError}`);
        else console.log(`    （观察）${label} → 请求失败: ${lastError?.message ?? lastError}`);
        return null;
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

// 新增：多个艺术家候选里只有第二个能命中时，也应该能找到
const multiArtist = await attempt('lrclib.lookup(多艺术家候选)', () =>
    lrclib.lookup({ title: '夜に駆ける', artists: ['完全不存在的名字', 'YOASOBI'], durationMs: 259_000, relaxedDuration: true }),
);
check(
    '第一个候选命中不了时会试后面的（多候选的意义所在）',
    Boolean(multiArtist?.lrc),
    multiArtist ? `长度 ${multiArtist.lrc.length}` : 'null',
);

// ------------------------------------------------- 7. provider.getLyrics
console.log('\n== 7. provider.getLyrics（B 站标题 + UP 主 → LRCLIB）==');
const lyrics = await attempt('provider.getLyrics', () => provider.getLyrics(song ?? first));
check('未抛错', true, lyrics ? `长度 ${lyrics.lrc.length}` : '返回 null（B 站标题匹配不到，属预期）');

// ------------------------------------------- 8. 艺术家候选（本仓库新加的能力）
console.log('\n== 8. 艺术家候选：B 站只给 UP 主，这里要提出真正的曲目艺术家 ==');
// 搜索列表保持 B 站自己的字段（UP 主），所以这里断言的是「getSong 里出现了别的候选」
const enriched = await attempt('provider.getSong（艺术家候选）', () => provider.getSong(items[0]?.id));
check('getSong 的 artists 非空', Array.isArray(enriched?.artists) && enriched.artists.length > 0, JSON.stringify(enriched?.artists));
check(
    'getSong 的 artists 里至少有一个不等于 UP 主（说明确实提取到了东西）',
    (enriched?.artists ?? []).some((name) => name !== first?.artists?.[0]),
    `UP主=${JSON.stringify(first?.artists)} → 候选=${JSON.stringify(enriched?.artists)}`,
);
check('艺术家候选有数量上限', (enriched?.artists ?? []).length <= 3);
// 艺术家到位之后歌词命中率应当比只给 UP 主更高 —— 这里至少要求不抛错且结果形状正确
const enrichedLyrics = await attempt('provider.getLyrics（带候选）', () => provider.getLyrics(enriched ?? first));
check(
    '带艺术家候选时歌词结果形状正确',
    enrichedLyrics === null || typeof enrichedLyrics.lrc === 'string',
    enrichedLyrics ? `长度 ${enrichedLyrics.lrc.length}` : 'null',
);

// ------------------------------------ 9. WBI 第二条密钥路径（GenWebTicket 兜底）
console.log('\n== 9. WBI ticket 兜底：nav 被打断时仍要能签名 ==');
// 真实的 nav 请求可能在某天被限流；ticket 那条路是为此准备的。
// 这里用「只让 nav 失败」的传输层把兜底逼出来，然后拿签名去打真实接口 —— 通了才算数。
const { createWbiSigner } = await import('../lib/wbi.mjs');
const navFailures = [];
const fallbackTransport = async (url, init) => {
    if (new URL(url).pathname.includes('/x/web-interface/nav')) {
        navFailures.push(url);
        return null; // 模拟 nav 不可用
    }
    const response = await fetch(url, init ?? { headers: { 'User-Agent': CHROMIUM_UA_FOR_WBI } });
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};
const fallbackSigner = createWbiSigner(fallbackTransport, {
    log: { info: () => {}, warn: (message) => console.log(`    ! ${message}`) },
});
const fallbackSigned = await attempt('ticket 兜底签名', () =>
    fallbackSigner.sign('https://api.bilibili.com/x/player/pagelist', {
        bvid: String(first?.id ?? '').replace('bili:', '').split(':')[0],
    }),
);
check('nav 确实被打断过', navFailures.length > 0);
check('兜底之后仍拿到签名', typeof fallbackSigned === 'string' && fallbackSigned.includes('w_rid='));
if (fallbackSigned) {
    const fallbackPayload = await attempt('用兜底签名请求真实接口', async () => {
        const response = await fetch(fallbackSigned, { headers: { 'User-Agent': CHROMIUM_UA_FOR_WBI } });
        return response.json();
    });
    check('兜底签名被 B 站接受（code 0）', fallbackPayload?.code === 0, `code=${fallbackPayload?.code} ${fallbackPayload?.message ?? ''}`);
}

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
