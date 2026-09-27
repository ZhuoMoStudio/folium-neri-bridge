// test/04-cdn.mjs —— B 站音频 CDN 的防盗链策略采样（index.cjs 的设计依据）
//
// 这个脚本回答一个问题：<audio src="取流地址"> 到底需要什么请求头？
//
// 之所以要单独测，是因为答案依赖 CDN 节点，而 B 站会在两个 CDN 家族之间轮换。
// 只测一次会得出自相矛盾的结论 —— 本项目就踩过：先测到「不带 Referer 也行」，
// 据此把 main 入口写成「删掉 Referer」，后来换个节点全部 403。
//
// 判「稳定」只看 HTTP 状态码，不把链路失败算进去：CDN 偶尔重置连接，
// 那是传输层的事，不是防盗链策略的事。
import { createFakeFolium, check, summary } from './harness.mjs';
import { createHttp } from '../lib/http.mjs';
import { createBilibiliProvider } from '../providers/bilibili.mjs';

const BVID = process.env.BILI_BVID ?? 'BV1Ph411C7S5';
const CID = process.env.BILI_CID ?? '293298061';
const SAMPLES = Number(process.env.CDN_SAMPLES ?? 6);
const TRIALS = 3;

const CHROMIUM_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const { folium } = createFakeFolium();
const http = createHttp(folium, folium.log);
const provider = createBilibiliProvider({ http, lrclib: null, log: folium.log });

console.log(`\n== 采样 ${SAMPLES} 次 playurl，收集 CDN 域名 ==`);
const hosts = new Map();
for (let i = 0; i < SAMPLES; i += 1) {
    // 每次都要重新取流：地址带 deadline，重复用同一条会拿到同一个 CDN 节点
    const audio = await provider.getAudioUrl({ id: `bili:${BVID}:${CID}` }, 'high');
    if (!audio?.url) continue;
    const host = new URL(audio.url).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
}
check('采样到了至少一个 CDN 域名', hosts.size > 0, `共 ${hosts.size} 个`);
for (const [host, count] of [...hosts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(2)}  ${host}`);
}

console.log(`\n== 每个域名上跑 ${TRIALS} 次三种请求头，看策略是否一致 ==`);
const VARIANTS = [
    ['带 B 站 Referer', { 'User-Agent': CHROMIUM_UA, Referer: 'https://www.bilibili.com/' }],
    ['不带 Referer', { 'User-Agent': CHROMIUM_UA }],
    ['带 localhost Referer', { 'User-Agent': CHROMIUM_UA, Referer: 'http://localhost:3000/' }],
];

const probe = async (url, headers) => {
    // CDN 偶尔会重置连接（实测三次里有一次）。那是传输层的事，不是防盗链策略的事，
    // 所以这里重试一次再记 ERR —— 策略断言不该被一次 TCP 抖动带红。
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { ...headers, Range: 'bytes=0-2047' } });
            await response.arrayBuffer();
            return response.status;
        } catch {
            if (attempt === 1) return 'ERR';
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    return 'ERR';
};

// 按域名重新取一次流，保证每个域名都有一条新鲜的 URL
const urlsByHost = new Map();
for (let i = 0; i < SAMPLES * 2 && urlsByHost.size < hosts.size; i += 1) {
    const audio = await provider.getAudioUrl({ id: `bili:${BVID}:${CID}` }, 'high');
    if (!audio?.url) continue;
    const host = new URL(audio.url).host;
    if (!urlsByHost.has(host)) urlsByHost.set(host, audio.url);
}

const policies = new Map();
const errorsByHost = new Map();
for (const [host, url] of urlsByHost) {
    console.log(`\n  --- ${host} ---`);
    for (const [label, headers] of VARIANTS) {
        const outcomes = [];
        for (let i = 0; i < TRIALS; i += 1) {
            outcomes.push(await probe(url, headers));
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
        // 「稳定」说的是策略稳定（HTTP 状态码一致），不是链路稳定。
        // CDN 偶尔重置连接，把 ERR 混进来判稳定会让这条断言随机变红。
        const httpOutcomes = outcomes.filter((value) => value !== 'ERR');
        const stable = new Set(httpOutcomes).size <= 1;
        const errored = outcomes.length - httpOutcomes.length;
        console.log(
            `      ${label.padEnd(22)} → ${outcomes.join('  ')}${stable ? '' : '   ← 不稳定'}${errored > 0 ? `   (${errored} 次链路失败，不计入策略判定)` : ''}`,
        );
        policies.set(`${host}|${label}`, httpOutcomes[0] ?? 'ERR');
        errorsByHost.set(`${host}|${label}`, errored);
        if (httpOutcomes.length > 0) {
            check(`${host} 上「${label}」的 HTTP 结果一致`, stable, httpOutcomes.join(','));
        } else {
            console.log(`      ℹ ${label}：三次都是链路失败，跳过策略判定`);
        }
    }
}

console.log('\n== 结论 ==');
for (const [host] of urlsByHost) {
    const bili = policies.get(`${host}|带 B 站 Referer`);
    const none = policies.get(`${host}|不带 Referer`);
    const errored = errorsByHost.get(`${host}|带 B 站 Referer`) ?? 0;
    console.log(`    ${host}`);
    console.log(`        带 B 站 Referer  → ${bili}${errored > 0 ? `（另有 ${errored} 次链路失败）` : ''}`);
    console.log(`        不带 Referer     → ${none}`);
    check(`${host}：带 B 站 Referer 可用`, [200, 206].includes(bili), `status=${bili}`);
}
// 这一条就是 index.cjs 存在的理由：不带 Referer 至少在一个 CDN 上会失败
const failedWithout = [...urlsByHost.keys()].some(
    (host) => ![200, 206].includes(policies.get(`${host}|不带 Referer`)),
);
if (failedWithout) {
    check('存在「不带 Referer 就失败」的 CDN ⇒ 必须主动补 Referer', true);
} else {
    console.log('    ℹ 本次采样里所有 CDN 不带 Referer 也能用；但已在 bilivideo 上复现过 403，');
    console.log('      所以 main 入口仍然要补 Referer（代价为零，且不依赖 CDN 的宽容度）。');
}

process.exit(summary() === 0 ? 0 : 1);
