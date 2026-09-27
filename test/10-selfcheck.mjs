// test/10-selfcheck.mjs —— 不联网。三件事的离线回归：
//
//   1. 多 P 的入口判定（lib/bili-video-ref.mjs）：什么算「用户要这个视频」；
//   2. 扫码成功后的凭据来源（lib/bili-login.cjs）：三条路 + 样本脱敏断言；
//   3. 自检命令的结论与格式化（lib/self-check.mjs）：含假 DOM 与假 fetcher 的探测。
//
// 为什么这三件放在一起：它们都是「真 Folia 里才能确认」或「真手机扫码才能拿到」的东西，
// 唯独逻辑部分可以在沙盒里钉死。钉不住的部分写在 VERIFY.md 里交给人工。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { check, summary } from './harness.mjs';
import { parseVideoRef, isVideoRef } from '../lib/bili-video-ref.mjs';
import { describeQualityCap } from '../lib/bili-cookie.mjs';
import { formatPartList, probeAudioElement, probeStreamRange, RANGE_PROBE_HEADER, summarizeSelfCheck } from '../lib/self-check.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const login = require('../lib/bili-login.cjs');

// ------------------------------------------------- 1. 视频引用判定
console.log('\n== 1. lib/bili-video-ref.mjs：什么算「一个视频」 ==');

const refCases = [
    ['BV1Ps411F7sL', { bvid: 'BV1Ps411F7sL', cid: null, page: null }],
    ['  BV1Ps411F7sL  ', { bvid: 'BV1Ps411F7sL', cid: null, page: null }],
    ['BV1Ps411F7sL:53978845', { bvid: 'BV1Ps411F7sL', cid: 53978845, page: null }],
    ['bili:BV1Ps411F7sL:53978845', { bvid: 'BV1Ps411F7sL', cid: 53978845, page: null }],
    ['https://www.bilibili.com/video/BV1Ps411F7sL', { bvid: 'BV1Ps411F7sL', cid: null, page: null }],
    ['https://www.bilibili.com/video/BV1Ps411F7sL?p=3', { bvid: 'BV1Ps411F7sL', cid: null, page: 3 }],
    ['https://www.bilibili.com/video/BV1Ps411F7sL/?spm_id_from=333.999&p=2', { bvid: 'BV1Ps411F7sL', cid: null, page: 2 }],
    ['https://m.bilibili.com/video/BV1Ps411F7sL', { bvid: 'BV1Ps411F7sL', cid: null, page: null }],
    ['www.bilibili.com/video/BV1Ps411F7sL', { bvid: 'BV1Ps411F7sL', cid: null, page: null }],
];
for (const [input, expected] of refCases) {
    const got = parseVideoRef(input);
    check(
        `识别 ${JSON.stringify(input)}`,
        JSON.stringify(got) === JSON.stringify(expected),
        `${JSON.stringify(got)} vs ${JSON.stringify(expected)}`,
    );
}

// 关键词不能被劫走：这是「只认 bilibili.com 域名」那条规则的用途
const keywordCases = [
    '夜に駆ける',
    'BV1Ps411F7sL 钢琴版',           // 词里出现 BV 号，但用户是在搜关键词
    'https://example.com/BV1Ps411F7sL', // 别的站点带 BV 号
    'av123456',                      // av 号不做（要 view 换 bvid，而 view 不可靠）
    'https://b23.tv/abcdefg',        // 短链不做（要发跳转请求）
    '',
    null,
];
for (const input of keywordCases) {
    check(`不当成视频引用：${JSON.stringify(input)}`, parseVideoRef(input) === null && !isVideoRef(input));
}
check('p=0 与 p=abc 不产生分 P', parseVideoRef('https://www.bilibili.com/video/BV1Ps411F7sL?p=0')?.page === null
    && parseVideoRef('https://www.bilibili.com/video/BV1Ps411F7sL?p=abc')?.page === null);
check('cid 里的小数被挡下（只看正整数）', parseVideoRef('BV1Ps411F7sL:0')?.cid === null);

// ------------------------------------------------- 2. 音质上限的说法
console.log('\n== 2. lib/bili-cookie.mjs：未登录的音质上限要可见 ==');
const anonymous = describeQualityCap(false);
const signedIn = describeQualityCap(true);
check('未登录时标记为受限', anonymous.capped === true && anonymous.level === 'anonymous');
check('已登录时不标记为受限', signedIn.capped === false);
check('未登录的说法里点出拿不到什么', /杜比/.test(anonymous.message) && /Hi-Res/.test(anonymous.message), anonymous.message);
check('未登录的说法里带上实测的匿名档位', /192K/.test(anonymous.message), anonymous.message);
check('已登录的说法不越界（只说取决于账号与稿件）', /取决于账号与稿件/.test(signedIn.message), signedIn.message);
// 依据来自 test/02-live.mjs 第 10 节的实测；这里只保证措辞与那份观测一致
check('两条说法的措辞不同（不是一个常量复读）', anonymous.message !== signedIn.message);

// ------------------------------------------------- 3. 三条路
console.log('\n== 3. lib/bili-login.cjs：凭据从哪来 ==');

/** 重放 index.cjs 的 loginPoll 所走的同一条流程。 */
const replayFixture = (fixture) => {
    const pollSetCookies = fixture.pollSetCookies ?? [];
    const ticketUrl = String(fixture.ticketUrl ?? '');
    // 这一步与 index.cjs 一致：poll 自己带了 SESSDATA 就不再跟票据链接
    const followTicket = !login.hasSessionCookie(pollSetCookies) && Boolean(ticketUrl);
    const ticketSetCookies = followTicket ? (fixture.ticketSetCookies ?? []) : [];
    return { followTicket, ...login.resolveLoginCookies({ pollSetCookies, ticketSetCookies, ticketUrl }) };
};

const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith('.json')).sort();
check('仓库里有合成样本可重放', fixtureNames.length >= 3, fixtureNames.join(','));

for (const name of fixtureNames) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
    const expect = fixture.expect ?? {};
    const result = replayFixture(fixture);
    const label = `样本 ${name}`;

    check(`${label}：跟不跟票据链接与预期一致`, result.followTicket === expect.followTicket, `followTicket=${result.followTicket}`);
    check(`${label}：拿到了 SESSDATA`, result.hasSession === expect.hasSession, `hasSession=${result.hasSession}`);
    check(
        `${label}：生效的路与预期一致`,
        (expect.routes ?? []).every((route) => result.routes.includes(route)),
        `routes=${login.describeLoginRoutes(result.routes)} 预期含 ${JSON.stringify(expect.routes)}`,
    );
    for (const [field, value] of Object.entries(expect.fields ?? {})) {
        check(`${label}：${field} 来自正确的一跳`, result.fields.get(field) === value, String(result.fields.get(field)));
    }
}

// crossDomain 样本那条空的 DedeUserID= 绝不能盖掉 Set-Cookie 给的真值 ——
// 「无条件合并查询串」正是这一版要修掉的 bug
const crossDomain = JSON.parse(readFileSync(join(fixturesDir, 'login-poll-crossdomain.json'), 'utf8'));
{
    const result = replayFixture(crossDomain);
    check(
        '票据链接里的空 DedeUserID= 不会盖掉 Set-Cookie 里的真值',
        result.fields.get('DedeUserID') === '4242424242',
        String(result.fields.get('DedeUserID')),
    );
    check('样本形状被认成 crossDomain（不是 legacy）', result.legacy === false);
}

// 三条路都不给东西时必须清清楚楚地失败，而不是「报成功但存到空凭据」
{
    const empty = login.resolveLoginCookies({ pollSetCookies: [], ticketSetCookies: [], ticketUrl: '' });
    check('三条路都没给凭据时 hasSession 为 false', empty.hasSession === false);
    check('并且 routes 为空（调用方据此报 login-succeeded-but-no-cookie）', empty.routes.length === 0);
    const legacy = login.resolveLoginCookies({
        ticketUrl: 'https://passport.bilibili.com/login?SESSDATA=FAKE_SESSDATA_FOR_TESTS&gourl=x',
    });
    check('Legacy 一条也能单独成事', legacy.hasSession && legacy.routes.includes('legacy-query'), login.describeLoginRoutes(legacy.routes));
    check('非 URL 输入不炸', login.resolveLoginCookies({ ticketUrl: 'not a url' }).hasSession === false);
}

// 与 index.cjs 导出的那份是同一个函数（别在别处再抄一遍）
{
    const mainEntry = require('../index.cjs');
    check(
        'index.cjs 导出的 cookieFieldsFromTicketUrl 就是 lib 里那一个',
        mainEntry.cookieFieldsFromTicketUrl === login.cookieFieldsFromTicketUrl,
    );
    const legacyFields = mainEntry.cookieFieldsFromTicketUrl(
        'https://passport.bilibili.com/login?SESSDATA=FAKE_SESSDATA_FOR_TESTS&gourl=y&bili_jct=FAKE_CSRF_FOR_TESTS',
    );
    check('Legacy 解析仍然只认会话字段', legacyFields.size === 2 && !legacyFields.has('gourl'), JSON.stringify([...legacyFields.keys()]));
}

// ------------------------------------------------- 4. 样本脱敏
console.log('\n== 4. 提交上去的样本里 SESSDATA 必须被脱敏 ==');

const PLACEHOLDER = /^(FAKE|TEST|REDACTED|PLACEHOLDER|EXAMPLE)[A-Z0-9_]*$/i;
/**
 * 「像真的」的判据。真实的 SESSDATA 形状是 `<base64>%2C<时间戳>%2C<sha256>`，
 * 长度上百；这里放宽一点，只要「长」或者「带 %2C」就算可疑。
 * 宁可误报让人去改样本，也不要漏报放一个真凭据进仓库。
 */
const looksReal = (value) => {
    const text = String(value ?? '');
    if (PLACEHOLDER.test(text)) return false;
    return text.length > 24 || /%2C/i.test(text) || text.includes(',');
};

const SECRET_KEYS = ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4', 'sid'];
const collectSecrets = (fixture) => {
    const found = [];
    const pushHeader = (raw) => {
        const [name, value] = login.firstCookiePair(raw) ?? [];
        if (name && (SECRET_KEYS.includes(name) || name.endsWith('__ckMd5'))) found.push([name, value]);
    };
    for (const raw of [...(fixture.pollSetCookies ?? []), ...(fixture.ticketSetCookies ?? [])]) pushHeader(raw);
    for (const [name, value] of login.cookieFieldsFromTicketUrl(fixture.ticketUrl ?? '')) found.push([name, value]);
    return found;
};

for (const name of fixtureNames) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
    const secrets = collectSecrets(fixture);
    const suspects = secrets.filter(([, value]) => looksReal(value));
    check(
        `样本 ${name}：${secrets.length} 个凭据字段全是占位符（没有真实 SESSDATA）`,
        suspects.length === 0,
        suspects.length === 0 ? secrets.map(([key]) => key).join(',') : `可疑：${JSON.stringify(suspects)}`,
    );
    check(`样本 ${name}：文件里没留下真实 uid`, !/"DedeUserID"\s*:\s*"(?!4242424242)\d{4,}"/.test(readFileSync(join(fixturesDir, name), 'utf8')));
}

// 抓包的人把真样本放进这个文件名：本地会跑，CI 上不存在就跳过
const localFixturePath = join(fixturesDir, 'login-poll-local.json');
if (existsSync(localFixturePath)) {
    console.log('    （发现 login-poll-local.json：真机样本，额外重放一遍）');
    const local = JSON.parse(readFileSync(localFixturePath, 'utf8'));
    const suspects = collectSecrets(local).filter(([, value]) => looksReal(value));
    check('本地样本：凭据已脱敏（没脱敏就别提交）', suspects.length === 0, JSON.stringify(suspects));
    const result = replayFixture(local);
    check('本地样本：重放没抛错，并给出了凭据表', result.fields instanceof Map, `routes=${result.routes.join(' → ')}`);
    check('本地样本：拿到了 SESSDATA', result.hasSession === true, JSON.stringify(result.routes));
} else {
    console.log('    （没有 login-poll-local.json，跳过真机样本；怎么抓见 test/fixtures/CAPTURE.md）');
}

// ------------------------------------------------- 5. 自检的结论
console.log('\n== 5. lib/self-check.mjs：事实 → 结论 ==');

const healthyFacts = {
    host: { folium: { major: 1, minor: 3 }, folia: '0.7.2', context: 'main', surfaces: { providers: true, hooks: true } },
    referer: { state: 'installed', hosts: 4, rewrites: 12, lastRewriteHost: 'upos-sz-mirrorcosov.bilivideo.com' },
    session: { ok: true, loggedIn: true, session: { userId: '4242424242', hasCsrf: true }, quality: describeQualityCap(true) },
    wordTiming: { available: true, entries: 3080, bytes: 463872, source: 'storage', ageMs: 3600_000 },
    media: {
        requestedId: 'bili:BV1Ps411F7sL:53972318',
        range: { ok: true, status: 206, contentRange: 'bytes 0-1023/37896722', ms: 120 },
        audio: { outcome: 'metadata', durationMs: 2_332_000, ms: 300 },
        rewritesBefore: 12,
        rewritesAfter: 13,
    },
};

const healthy = summarizeSelfCheck(healthyFacts);
check('全部正常时没有 fail', !healthy.sections.some((entry) => entry.status === 'fail'), JSON.stringify(healthy.sections.map((s) => s.status)));
check('全部正常时结论是「全部通过」', /结论：全部通过/.test(healthy.message), healthy.message.split('\n').at(-1));
check('结论里带着契约版本', /folium 1\.3/.test(healthy.message));
check('结论里带着 folia 版本与 context', /folia 0\.7\.2/.test(healthy.message) && /context main/.test(healthy.message));
check('warnings 为空', healthy.warnings.length === 0, JSON.stringify(healthy.warnings));
check('每个 section 都有 id/label/status/detail', healthy.sections.every((s) => s.id && s.label && s.status && typeof s.detail === 'string'));

const anonymousFacts = { ...healthyFacts, session: { ok: true, loggedIn: false, session: { userId: null, hasCsrf: false }, quality: describeQualityCap(false) } };
const anonymousReport = summarizeSelfCheck(anonymousFacts);
check('未登录时登录态那行是 warn', anonymousReport.sections.find((s) => s.id === 'session')?.status === 'warn');
check('未登录时输出里看得到音质受限', /音质受限/.test(anonymousReport.message));
check('未登录会出现在 warnings 里', anonymousReport.warnings.some((line) => /音质/.test(line)));

const brokenFacts = {
    ...healthyFacts,
    referer: { state: 'unavailable', hosts: 4, rewrites: 0 },
    media: { ...healthyFacts.media, audio: { outcome: 'error', errorCode: 4 }, rewritesAfter: 12 },
};
const broken = summarizeSelfCheck(brokenFacts);
check('监听器没装上 → fail', broken.sections.find((s) => s.id === 'referer')?.status === 'fail');
check('失败原因里说明后果（会 403）', /403/.test(broken.sections.find((s) => s.id === 'referer')?.detail ?? ''));
check('<audio> 报错 → fail 并翻译错误码', broken.sections.find((s) => s.id === 'audio')?.status === 'fail'
    && /MEDIA_ERR_SRC_NOT_SUPPORTED/.test(broken.sections.find((s) => s.id === 'audio')?.detail ?? ''));
check('改写计数没动 → warn（装上不等于被调用过）', broken.sections.find((s) => s.id === 'rewrite')?.status === 'warn');
check('有失败项时结论指向 fail 行', /2 项失败/.test(broken.message), broken.message.split('\n').at(-1));

const rangeForbidden = summarizeSelfCheck({
    ...healthyFacts,
    media: { ...healthyFacts.media, range: { ok: true, status: 403, ms: 60 } },
});
check('直链 403 → fail 并提到过期', /过期/.test(rangeForbidden.sections.find((s) => s.id === 'range')?.detail ?? ''));

const noTarget = summarizeSelfCheck({ ...healthyFacts, media: { requestedId: null } });
check('没有探测目标时是 skip 不是 fail', noTarget.sections.filter((s) => s.status === 'skip').length === 2);
check('没有目标时告诉用户怎么办', /先播一首/.test(noTarget.message));
check('没有目标时结论仍算通过（并交代跳过数）', /全部通过/.test(noTarget.message) && /跳过/.test(noTarget.message));

// 取流这一步就断了：要说清是哪一步，别显示成「Range 请求失败：unknown」
const noStream = summarizeSelfCheck({
    ...healthyFacts,
    media: { requestedId: 'bili:BV1x:1', streamError: 'getAudioUrl 没给出地址（cid 解析不了或取流被拒）' },
});
check('取流失败时说清是取流失败', /取流失败/.test(noStream.sections.find((s) => s.id === 'range')?.detail ?? ''));
check('取流失败时那条是 fail，但没有编造一个 HTTP 状态', noStream.sections.find((s) => s.id === 'range')?.status === 'fail');
check('取流失败时 <audio> 那行是 skip（没有地址可探）', noStream.sections.find((s) => s.id === 'audio')?.status === 'skip');

const noHooks = summarizeSelfCheck({ ...healthyFacts, host: { ...healthyFacts.host, surfaces: { providers: true, hooks: false } }, wordTiming: null });
check('缺 omni.hooks → 契约那行 warn（不是 fail）', noHooks.sections.find((s) => s.id === 'contract')?.status === 'warn');
check('缺 omni.hooks 时说明逐字降级但行级不受影响', /行级歌词不受影响/.test(noHooks.message));

// 主进程没回答 ≠ 监听器装失败了：这两种情况要分开说，否则会把人指错方向
const noDiagnose = summarizeSelfCheck({ ...healthyFacts, referer: null });
check('拿不到监听器状态时说的是「主进程没回答」而不是「装失败了」', /主进程没有回答/.test(noDiagnose.sections.find((s) => s.id === 'referer')?.detail ?? ''));
const weirdDiagnose = summarizeSelfCheck({ ...healthyFacts, referer: { state: 'wat' } });
check('状态不认识时是 warn 并原样打印', weirdDiagnose.sections.find((s) => s.id === 'referer')?.status === 'warn'
    && /"wat"/.test(weirdDiagnose.sections.find((s) => s.id === 'referer')?.detail ?? ''));

check('空输入不炸', typeof summarizeSelfCheck().message === 'string' && summarizeSelfCheck().sections.length > 0);
check('宿主信息全缺时不炸', typeof summarizeSelfCheck({ host: null }).message === 'string');

// ------------------------------------------------- 6. 直链 Range 探测
console.log('\n== 6. 直链 Range 探测（假 fetcher）==');
{
    const calls = [];
    const ok = await probeStreamRange({
        url: 'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/x.m4s?deadline=1',
        cookie: 'SESSDATA=FAKE',
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return { status: 206, headers: { 'content-range': 'bytes 0-1023/37896722' } };
        },
    });
    check('206 被如实带回', ok.ok && ok.status === 206, JSON.stringify(ok));
    check('带上 content-range', ok.contentRange === 'bytes 0-1023/37896722');
    check('必带 Range 头（不带会撞 5MB 响应体上限）', calls[0]?.init?.headers?.Range === RANGE_PROBE_HEADER, JSON.stringify(calls[0]?.init?.headers));
    check('自己带 B 站 Referer（net.fetch 不走 Chromium 会话）', calls[0]?.init?.headers?.Referer === 'https://www.bilibili.com/');
    check('已登录时带上 Cookie', calls[0]?.init?.headers?.Cookie === 'SESSDATA=FAKE');

    const noCookieCall = [];
    await probeStreamRange({ url: 'https://x/y', fetchImpl: async (u, i) => (noCookieCall.push(i), { status: 200, headers: {} }) });
    check('未登录时不带 Cookie 头', !('Cookie' in noCookieCall[0].headers));

    const thrown = await probeStreamRange({ url: 'https://x/y', fetchImpl: async () => { throw new Error('boom'); } });
    check('fetcher 抛错 → 不抛出去，返回错误字样', thrown.ok === false && thrown.error === 'boom', JSON.stringify(thrown));
    check('没有 url 时不调用 fetcher', (await probeStreamRange({ fetchImpl: async () => ({ status: 200 }) })).ok === false);
    check('没有 fetcher 时不炸', (await probeStreamRange({ url: 'https://x/y' })).error === 'no-fetch');
}

// ------------------------------------------------- 7. <audio> 探测
console.log('\n== 7. <audio> 元素探测（假元素）==');

/** 假 MediaElement：只实现探测用得到的那几个成员。 */
const createFakeAudio = ({ outcome, errorCode = 4, duration = 2332, auto = true }) => {
    const listeners = new Map();
    const element = {
        preload: '',
        src: '',
        duration,
        readyState: 1,
        error: outcome === 'error' ? { code: errorCode, message: 'fake media error' } : null,
        addEventListener(type, handler) { listeners.set(type, handler); },
        removeEventListener(type) { listeners.delete(type); },
        removeAttribute() { element.src = ''; },
        load() {
            if (!auto) return;
            if (outcome === 'metadata') queueMicrotask(() => listeners.get('loadedmetadata')?.());
            if (outcome === 'error') queueMicrotask(() => listeners.get('error')?.());
        },
    };
    return element;
};

{
    const metadata = await probeAudioElement({
        url: 'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/x.m4s',
        createAudio: () => createFakeAudio({ outcome: 'metadata' }),
    });
    check('拿到 metadata → outcome=metadata', metadata.outcome === 'metadata', JSON.stringify(metadata));
    check('带回时长（毫秒）', metadata.durationMs === 2332_000, String(metadata.durationMs));

    const error = await probeAudioElement({
        url: 'https://x/y',
        createAudio: () => createFakeAudio({ outcome: 'error', errorCode: 4 }),
    });
    check('报 error → outcome=error 且带回错误码', error.outcome === 'error' && error.errorCode === 4, JSON.stringify(error));

    const element = createFakeAudio({ outcome: 'metadata' });
    await probeAudioElement({ url: 'https://x/y', createAudio: () => element });
    check('测完放开 src（别让探测占着一条连接）', element.src === '');

    const timedOut = await probeAudioElement({ url: 'https://x/y', createAudio: () => createFakeAudio({ outcome: 'metadata', auto: false }), timeoutMs: 20 });
    check('事件不来就是 timeout，不是失败', timedOut.outcome === 'timeout', JSON.stringify(timedOut));

    const noDom = await probeAudioElement({ url: 'https://x/y' });
    check('没有 DOM 时如实说 unsupported（而不是谎称通过）', noDom.outcome === 'unsupported' && noDom.error === 'no-dom');
    check('createAudio 抛错也不炸', (await probeAudioElement({ url: 'https://x/y', createAudio: () => { throw new Error('nope'); } })).error === 'nope');
    check('没有 url 时直接 unsupported', (await probeAudioElement({ createAudio: () => createFakeAudio({ outcome: 'metadata' }) })).error === 'no-url');
}

// ------------------------------------------------- 8. 分 P 列表输出
console.log('\n== 8. formatPartList：把分 P 列成可读的东西 ==');
{
    const items = [
        { id: 'bili:BV1Ps411F7sL:53972318', title: '整合 - P1', durationMs: 2_332_000 },
        { id: 'bili:BV1Ps411F7sL:53978845', title: '整合 - P2', durationMs: 95_000 },
        { id: 'bili:BV1Ps411F7sL:54605971', title: '整合 - P3', durationMs: 0 },
    ];
    const text = formatPartList(items);
    check('说出总数', /共 3 个分 P/.test(text), text.split('\n')[0]);
    check('每条都带 id（可以粘回搜索框）', items.every((item) => text.includes(item.id)));
    check('时长按 m:ss 显示', /38:52/.test(text) && /1:35/.test(text), text);
    check('时长缺失时用 ?:?? 而不是 0:00', /\?:\?\?/.test(text));
    check('没有多余分 P 时不提「另有」', !/另有/.test(text));
    check('列出了操作方式', /粘进搜索框/.test(text));

    const many = formatPartList(Array.from({ length: 30 }, (_, index) => ({ id: `bili:BV1x:${index}`, title: `P${index}`, durationMs: 1000 })), { limit: 5 });
    check('超出上限时截断并交代还有多少', /只列前 5 个/.test(many) && /另有 25 个/.test(many));
    check('空列表给一句人话', /没拿到分 P/.test(formatPartList([])));
    check('非数组不炸', /没拿到分 P/.test(formatPartList(null)));
}

process.exit(summary() === 0 ? 0 : 1);
