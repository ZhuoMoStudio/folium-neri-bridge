// test/01-offline.mjs —— 不联网的纯函数检查
import { createHmac } from 'node:crypto';
import { check, summary } from './harness.mjs';
import { md5, utf8Bytes } from '../lib/md5.mjs';
import {
    extractPlainLyricsFromCollapsedTimeline,
    hasLrcTimestamp,
    isUsableTimedLyricTimeline,
} from '../lib/lrc.mjs';
import {
    cleanTrackName,
    isArtistCompatible,
    isDurationCompatible,
    isTitleCompatible,
    normalizeText,
    primaryArtist,
    stripHtml,
} from '../lib/match.mjs';
import {
    cookieFieldsFromSession,
    describeSession,
    isValidSession,
    parseCookieHeader,
    redactCookie,
    serializeCookieHeader,
} from '../lib/bili-cookie.mjs';
import { buildWebTicketUrl, createWbiSigner, deriveMixinKey, hmacSha256Hex } from '../lib/wbi.mjs';
import {
    artistCandidatesFromDescription,
    artistCandidatesFromTitle,
    extractArtistCandidates,
} from '../lib/artist-candidates.mjs';
import { createLrclibBackend } from '../providers/lyrics/lrclib.mjs';

console.log('\n== lib/md5.mjs：RFC 1321 标准测试向量 ==');
check('md5("")', md5('') === 'd41d8cd98f00b204e9800998ecf8427e', md5(''));
check('md5("abc")', md5('abc') === '900150983cd24fb0d6963f7d28e17f72', md5('abc'));
check(
    'md5("The quick brown fox jumps over the lazy dog")',
    md5('The quick brown fox jumps over the lazy dog') === '9e107d9d372bb6826bd81d3542a419d6',
);
check(
    'md5(80 字符长串，跨越 2 个 512-bit 分块)',
    md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890') ===
        '57edf4a22be3c955ac49da2e2107b67a',
);
check('utf8Bytes("中") == [228,184,173]', JSON.stringify(utf8Bytes('中')) === '[228,184,173]');
check('utf8Bytes 处理代理对（emoji）', utf8Bytes('🎵').length === 4, JSON.stringify(utf8Bytes('🎵')));

console.log('\n== lib/lrc.mjs：塌缩时间轴判定 ==');
const normalLrc = ['[00:12.34]第一行', '[00:18.00]第二行', '[00:25.10]第三行'].join('\n');
const collapsedLrc = ['[00:00.00]第一行', '[00:00.00]第二行', '[00:00.00]第三行'].join('\n');
const twoLineCollapsed = ['[00:00.00]第一行', '[00:00.00]第二行'].join('\n');
const plainText = ['第一行', '第二行', '第三行'].join('\n');
check('正常 LRC 判定为可用', isUsableTimedLyricTimeline(normalLrc));
check('全同行时间戳判定为不可用', !isUsableTimedLyricTimeline(collapsedLrc));
check('两行同戳不算塌缩（下限为 3 行）', isUsableTimedLyricTimeline(twoLineCollapsed));
check('无时间戳判定为不可用', !isUsableTimedLyricTimeline(plainText));
check('hasLrcTimestamp 正确识别', hasLrcTimestamp(normalLrc) && !hasLrcTimestamp(plainText));
check(
    '塌缩歌词可降级出纯文本',
    extractPlainLyricsFromCollapsedTimeline(collapsedLrc) === '第一行\n第二行\n第三行',
    JSON.stringify(extractPlainLyricsFromCollapsedTimeline(collapsedLrc)),
);
check('非塌缩歌词不降级', extractPlainLyricsFromCollapsedTimeline(normalLrc) === null);

console.log('\n== lib/match.mjs：文本清洗与身份判定 ==');
check(
    'stripHtml 去标签与实体',
    stripHtml('<em class="keyword">夜</em>に駆ける &amp; more') === '夜に駆ける & more',
    stripHtml('<em class="keyword">夜</em>に駆ける &amp; more'),
);
check(
    'cleanTrackName 去掉 (Official Video)',
    cleanTrackName('夜に駆ける (Official Video)') === '夜に駆ける',
    cleanTrackName('夜に駆ける (Official Video)'),
);
check(
    'cleanTrackName 去掉【】包裹的中文标记',
    cleanTrackName('【MV】夜に駆ける') === '夜に駆ける',
    cleanTrackName('【MV】夜に駆ける'),
);
check('primaryArtist 取 feat. 之前', primaryArtist('YOASOBI feat. 幾田りら') === 'YOASOBI', primaryArtist('YOASOBI feat. 幾田りら'));
check('primaryArtist 取 "&" 之前', primaryArtist('A & B') === 'A', primaryArtist('A & B'));
check('normalizeText 全角转半角', normalizeText('ＡＢＣ') === 'abc', normalizeText('ＡＢＣ'));
check(
    'normalizeText 去掉标点只留字母数字与 CJK',
    normalizeText('夜に駆ける - YOASOBI!!') === '夜に駆ける yoasobi',
    normalizeText('夜に駆ける - YOASOBI!!'),
);

// 时长容差：max(7s, 预期*6%) 再封顶 15s（对齐 ExternalLyricMatchPolicy.kt）
// 240s → 6% = 14.4s，落在 7s..15s 之间，所以容差就是 14.4s
check('240s 歌：差 3s 通过', isDurationCompatible(240_000, 243_000));
check('240s 歌：差 14s 通过（14.4s 容差内）', isDurationCompatible(240_000, 254_000));
check('240s 歌：差 20s 拒绝（越过 14.4s）', !isDurationCompatible(240_000, 260_000));
// 100s → 6% = 6s < 7s，地板 7s 生效
check('100s 歌：地板 7s 生效，差 5s 通过', isDurationCompatible(100_000, 105_000));
check('100s 歌：差 10s 拒绝（越过 7s）', !isDurationCompatible(100_000, 110_000));
// 600s → 6% = 36s，但被 15s 封顶，所以容差是 15s 而不是 36s
check('600s 歌：封顶 15s 生效，差 10s 通过', isDurationCompatible(600_000, 610_000));
check('600s 歌：差 20s 拒绝（被 15s 封顶，不是 6%）', !isDurationCompatible(600_000, 620_000));
check('零时长拒绝', !isDurationCompatible(0, 240_000));

check('title 完全相同通过', isTitleCompatible('夜に駆ける', '夜に駆ける'));
check('title 带 (Official Video) 仍通过', isTitleCompatible('夜に駆ける', '夜に駆ける (Official Video)'));
check('title 明显不同应拒绝', !isTitleCompatible('夜に駆ける', '残酷な天使のテーゼ'));
check('artist 相同通过', isArtistCompatible('YOASOBI', 'YOASOBI'));
check('artist feat. 差异通过', isArtistCompatible('YOASOBI feat. 幾田りら', 'YOASOBI'));

console.log('\n== lib/bili-cookie.mjs：登录态规范化 ==');
const SESS = 'abcdef0123456789%2Fxyz==';
check(
    '解析标准 Cookie 串',
    parseCookieHeader(`SESSDATA=${SESS}; bili_jct=deadbeef; DedeUserID=12345`).get('SESSDATA') === SESS,
);
check('容忍 Cookie: 前缀', parseCookieHeader(`Cookie: SESSDATA=${SESS}`).get('SESSDATA') === SESS);
check('容忍换行分隔', parseCookieHeader(`SESSDATA=${SESS}\nbili_jct=x`).get('bili_jct') === 'x');
check(
    '容忍值里含 =（base64 的 SESSDATA）',
    parseCookieHeader('SESSDATA=a=b=c').get('SESSDATA') === 'a=b=c',
);
check('忽略空段与畸形段', parseCookieHeader(';; bad ;=x; SESSDATA=ok').size === 1);
check('不是 cookie 的文本被丢弃', parseCookieHeader('这不是 cookie 文本').size === 0);
check('非字符串输入返回空表', parseCookieHeader(null).size === 0 && parseCookieHeader(123).size === 0);

const fields = parseCookieHeader(`DedeUserID=99; SESSDATA=${SESS}; bili_jct=csrf`);
const header = serializeCookieHeader(fields);
check('序列化后必需的字段在前', header.startsWith(`SESSDATA=${SESS};`), header.slice(0, 40));
check(
    '序列化可往返',
    serializeCookieHeader(parseCookieHeader(header)) === header,
);
check('空表序列化为空串', serializeCookieHeader(new Map()) === '' && serializeCookieHeader(null) === '');

check('有 SESSDATA 才算已登录', isValidSession(parseCookieHeader(`SESSDATA=${SESS}`)));
check('缺 SESSDATA 视为未登录', !isValidSession(parseCookieHeader('bili_jct=csrf')));
check('空表视为未登录', !isValidSession(new Map()));

const sessionCookies = cookieFieldsFromSession([
    { name: 'SESSDATA', value: SESS, domain: '.bilibili.com' },
    { name: 'bili_jct', value: 'csrf', domain: '.bilibili.com' },
    { name: 'SESSDATA', value: 'should-be-overwritten', domain: 'passport.bilibili.com' },
    { name: 'ga', value: 'x', domain: '.google.com' },
]);
check('只收 bilibili.com 域的 cookie', !sessionCookies.has('ga'), JSON.stringify([...sessionCookies.keys()]));
check('同名以最后一次为准', sessionCookies.get('SESSDATA') === 'should-be-overwritten');
check('空输入不炸', cookieFieldsFromSession(null).size === 0 && cookieFieldsFromSession([]).size === 0);
check('缺 domain 的条目被跳过', cookieFieldsFromSession([{ name: 'SESSDATA', value: 'x' }]).size === 0);

const redacted = redactCookie(parseCookieHeader(`SESSDATA=${SESS}; bili_jct=csrf`));
check('脱敏后不含完整 SESSDATA', !redacted.includes(SESS), redacted);
check('脱敏后仍能看出字段构成', redacted.includes('bili_jct'), redacted);
check('空值脱敏为 none', redactCookie(new Map()) === 'none');

const described = describeSession(fields);
check('describeSession 报出登录态', described.loggedIn && described.userId === '99' && described.hasCsrf);

console.log('\n== lib/wbi.mjs：两条密钥路径 ==');
// 真实的一对 wbi 图像 URL。mixin key 是它们唯一确定的函数值，
// 这里写死为回归值 —— 重排表或取值方式一变就会红。
const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
const EXPECTED_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

const hmacMessage = 'ts1790481594';
const webCryptoHmac = await hmacSha256Hex('XgwSnGZ1p', hmacMessage);
// 用 Node 的 crypto 独立算一遍：两条实现一致才能说明 WebCrypto 那条没错
const nodeHmac = createHmac('sha256', 'XgwSnGZ1p').update(hmacMessage).digest('hex');
check('HMAC-SHA256 与 Node crypto 一致', webCryptoHmac === nodeHmac, String(webCryptoHmac));
check('hexsign 是 64 位小写十六进制', /^[0-9a-f]{64}$/.test(webCryptoHmac ?? ''), String(webCryptoHmac));
check('拿不到 crypto.subtle 时返回 null（不抛错、不返回垃圾）', (await hmacSha256Hex('XgwSnGZ1p', hmacMessage, {})) === null);
check('subtle 抛错时也返回 null', (await hmacSha256Hex('k', 'm', { importKey: () => { throw new Error('nope'); } })) === null);

const ticketUrl = buildWebTicketUrl(EXPECTED_MIXIN_KEY, 1790481594, 'csrf-token');
check('ticket URL 指向 GenWebTicket', ticketUrl.startsWith('https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?'));
check('ticket URL 带 key_id=ec02', ticketUrl.includes('key_id=ec02'));
check('ticket URL 的 context[ts] 被正确编码', ticketUrl.includes('context%5Bts%5D=1790481594'), ticketUrl);
check('ticket URL 带 csrf（有 bili_jct 时）', ticketUrl.includes('csrf=csrf-token'));
check('没有 bili_jct 时不带 csrf', !buildWebTicketUrl('x', 1).includes('csrf'));

/** 造一个记录所有请求的假传输。 */
const createTransport = ({ handler }) => {
    const calls = [];
    const getJson = async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers });
        return handler(url, init);
    };
    return { calls, getJson };
};

const navPayload = { code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } };
const ticketPayload = { code: 0, data: { nav: { img: WBI_IMG, sub: WBI_SUB } } };

const navOnly = createTransport({ handler: async (url) => (url.includes('/nav') ? navPayload : null) });
const navSigner = createWbiSigner(navOnly.getJson);
const navSigned = await navSigner.sign('https://api.bilibili.com/x/player/pagelist', { bvid: 'BV1' });
check('nav 路径能签名', navSigned.includes('w_rid='), navSigned.slice(0, 120));
check('签名结果是合法的 URL', new URL(navSigned).searchParams.get('wts') !== null);
check('mixin key 与独立算出的已知值一致', deriveMixinKey(WBI_IMG, WBI_SUB) === EXPECTED_MIXIN_KEY, deriveMixinKey(WBI_IMG, WBI_SUB));
check('mixin key 长度 32', deriveMixinKey(WBI_IMG, WBI_SUB).length === 32);
check('太短的 mixin url 抛错', (() => {
    try {
        deriveMixinKey('https://x/a.png', 'https://x/b.png');
        return false;
    } catch {
        return true;
    }
})());
check('密钥有缓存（第二次不重新拉 nav）', (() => {
    const before = navOnly.calls.length;
    return before === 1;
})());

// nav 返回了东西但形状不对（例如未登录时 data 里没有 wbi_img）→ 应当走 ticket
const navBroken = createTransport({
    handler: async (url, init) => (url.includes('/nav') ? { code: -3, data: {} } : url.includes('GenWebTicket') ? ticketPayload : null),
});
const warnings = [];
const fallbackSigner = createWbiSigner(navBroken.getJson, { log: { warn: (m) => warnings.push(m), info: () => {} } });
const fallbackSigned = await fallbackSigner.sign('https://api.bilibili.com/x/player/pagelist', { bvid: 'BV1' });
check('nav 失败时改用 ticket', navBroken.calls.some((call) => call.url.includes('GenWebTicket')), navBroken.calls.map((c) => new URL(c.url).pathname).join(' → '));
check('ticket 请求是 POST', navBroken.calls.find((call) => call.url.includes('GenWebTicket'))?.method === 'POST');
check(
    'ticket 请求用 Firefox UA（与普通接口不同）',
    navBroken.calls.find((call) => call.url.includes('GenWebTicket'))?.headers?.['User-Agent']?.includes('Firefox/115.0'),
    navBroken.calls.find((call) => call.url.includes('GenWebTicket'))?.headers?.['User-Agent'],
);
check('ticket 路径也能签名', fallbackSigned.includes('w_rid='));
check('降级时有警告日志（不静默）', warnings.some((message) => message.includes('ticket')), warnings.join(' | '));
// ticket 的 hexsign 必须由「秒级时间戳」算出，不是别的东西
const ticketCall = navBroken.calls.find((call) => call.url.includes('GenWebTicket'));
const ticketParams = new URL(ticketCall.url).searchParams;
check('ticket 的 context[ts] 与 hexsign 对得上', (() => {
    const ts = Number(ticketParams.get('context[ts]'));
    if (!Number.isFinite(ts)) return false;
    return ticketParams.get('hexsign') === createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex');
})(), ticketParams.get('hexsign'));

// 有 bili_jct 时应当带上 csrf
const withCsrf = createTransport({
    handler: async (url) => (url.includes('/nav') ? null : ticketPayload),
});
await createWbiSigner(withCsrf.getJson, { getCsrf: () => 'csrf-abc' }).sign('https://api.bilibili.com/x/x', { a: '1' });
check('有 bili_jct 时 ticket 带上 csrf', new URL(withCsrf.calls.find((c) => c.url.includes('GenWebTicket')).url).searchParams.get('csrf') === 'csrf-abc');

// 环境没有 crypto.subtle 时的降级：必须给出可读的原因
const noCrypto = createTransport({ handler: async (url) => (url.includes('/nav') ? null : ticketPayload) });
const noCryptoWarnings = [];
const noCryptoSigner = createWbiSigner(noCrypto.getJson, {
    hmac: async () => null,
    log: { warn: (m) => noCryptoWarnings.push(m), info: () => {} },
});
try {
    await noCryptoSigner.sign('https://api.bilibili.com/x/x', { a: '1' });
    check('没有 crypto.subtle 时抛错', false, '没有抛错');
} catch (error) {
    check('没有 crypto.subtle 时抛错并指明原因', String(error.message).includes('crypto.subtle'), String(error.message));
}
check('缺少 crypto.subtle 会打警告（不静默失败）', noCryptoWarnings.some((m) => m.includes('crypto.subtle')), noCryptoWarnings.join(' | '));

// 两条都失败：错误里要同时给出两条的原因
const bothFail = createTransport({ handler: async () => null });
try {
    await createWbiSigner(bothFail.getJson, { hmac: async () => null }).sign('https://api.bilibili.com/x/x', {});
    check('两条路径都失败时抛错', false, '没有抛错');
} catch (error) {
    check('两条路径都失败时抛错，且原因里两条都在', String(error.message).includes('nav:') && String(error.message).includes('ticket'), String(error.message));
}

// 签名本身：参数排序、filterValue、w_rid
const signParams = createTransport({ handler: async () => navPayload });
const signer = createWbiSigner(signParams.getJson);
const signedUrl = new URL(await signer.sign('https://api.bilibili.com/x/x', { b: '2', a: "1!'()*3" }));
check('参数值里的 !\'()* 被去掉', signedUrl.searchParams.get('a') === '13', signedUrl.searchParams.get('a'));
check('带上 w_rid', (signedUrl.searchParams.get('w_rid') ?? '').length === 32);

console.log('\n== lib/artist-candidates.mjs：从标题/简介提艺术家 ==');
// 下面每一条标题都是实测的 B 站搜索结果原文
const artistCases = [
    ['YOASOBI 夜に駆ける (Yoru ni Kakeru) Official Music Video', 'Ayase-YOASOBI', '', ['YOASOBI']],
    ['[Hi-Res 48kHz/24bit][中字]YOASOBI - 夜に駆ける', '云妮洁', '', ['YOASOBI']],
    ['【布茸｜手书】夜に駆ける', '来吧马猴', '', ['来吧马猴']],
    ['【4K60无损】高桥洋子 残酷天使的行动纲领 中日字幕配罗马音 残酷な天使のテーゼ 新世纪福音战士 EVA', '4K音楽館', '', ['高桥洋子']],
    ['【4K顶级画质】高桥洋子《残酷な天使のテーゼ》万人现场，最经典的OP神曲！！！', '蚕豆音乐侠', '', ['高桥洋子']],
    ['YOASOBI - IDOL', 'Browin_Bear', '', ['YOASOBI']],
    ['【𝐇𝐢-𝐑𝐞𝐬无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’', 'VV音乐局', '', ['周杰伦']],
    ['【4K修复】周杰伦 - 晴天MV 2160P修复版', 'zyl2012_音乐无限', '', ['周杰伦']],
    ['周杰伦 - 晴天', '怪束黍', '', ['周杰伦']],
    ['【4K Hi-Res】晴天-周杰伦', '如歌如梦', '', ['周杰伦']],
];
for (const [title, owner, desc, expected] of artistCases) {
    const candidates = extractArtistCandidates({ title, ownerName: owner, desc });
    check(
        `「${title.slice(0, 24)}…」提出 ${expected.join('/')}`,
        expected.every((name) => candidates.includes(name)),
        JSON.stringify(candidates),
    );
}
check('找不到线索时退回 UP 主', JSON.stringify(extractArtistCandidates({ title: '残酷天使的恐怖纲领', ownerName: '屎急少女' })) === '["屎急少女"]');
check('无任何线索时返回空数组', extractArtistCandidates({}).length === 0);
check('去重（同一个名字不会出现两次）', (() => {
    const candidates = extractArtistCandidates({ title: 'YOASOBI - Song', ownerName: 'YOASOBI' });
    return candidates.filter((name) => name === 'YOASOBI').length === 1;
})());
check('候选数量有上限', extractArtistCandidates({ title: 'A - B / C/ D/ E/ F/ G/ H/ I/ J', ownerName: 'K' }).length <= 8);
check('带句子标点的片段被丢弃', extractArtistCandidates({ title: '【4K顶级画质】高桥洋子《残酷な天使のテーゼ》万人现场，最经典的OP神曲！！！' }).every((name) => !/[，。！？]/.test(name)));
check('url 与长数字被丢弃', !extractArtistCandidates({ desc: '歌手：http://example.com/12345' }).some((name) => name.includes('http')));
check('staff 名字排在前面', extractArtistCandidates({ title: 'Song - Artist', staff: [{ name: '署名的人' }] })[0] === '署名的人');
check('简介里的「歌手：」优先于标题', (() => {
    const candidates = extractArtistCandidates({ title: 'A - B', desc: '歌手：真正的人\n作词：另一个人' });
    return candidates.indexOf('真正的人') < candidates.indexOf('A');
})());
check('简介里的「主唱：x / y」会拆开', (() => {
    const candidates = artistCandidatesFromDescription('主唱：ikura/幾田りら');
    return candidates.includes('ikura') && candidates.includes('幾田りら');
})());
check('纯空白的标题不炸', artistCandidatesFromTitle('').length === 0 && artistCandidatesFromTitle(null).length === 0);
check('纯空白的简介不炸', artistCandidatesFromDescription('   ').length === 0);
check(
    '实心连字符的短名字也拆得开（「晴天-周杰伦」）',
    (() => {
        const candidates = artistCandidatesFromTitle('【4K Hi-Res】晴天-周杰伦');
        return candidates.includes('晴天') && candidates.includes('周杰伦');
    })(),
);
check('「Ayase-YOASOBI」两边都留下', (() => {
    const candidates = artistCandidatesFromTitle('Ayase-YOASOBI');
    return candidates.includes('Ayase') && candidates.includes('YOASOBI');
})());

console.log('\n== providers/lyrics/lrclib.mjs：多候选与关键词兜底 ==');
// 候选艺术家是从 B 站标题/简介里猜的，可能是错的。用错的那个去拼搜索关键词，
// 原本能命中的歌会一条都搜不出来 —— 实测在真实网络上就是这样丢的。
const createLrclibHttp = (handler) => {
    const calls = [];
    return {
        calls,
        json: async (url, init) => {
            calls.push(url);
            return handler(url, init);
        },
    };
};
const synced = (trackName, artistName, duration = 259) => ({
    trackName,
    artistName,
    duration,
    syncedLyrics: '[00:01.00]第一行歌词\n[00:12.00]第二行歌词',
    plainLyrics: '第一行歌词\n第二行歌词',
});

const fallbackHttp = createLrclibHttp((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/get')) return null;
    if (parsed.pathname.endsWith('/search')) {
        // 带坏候选的关键词搜不到；纯标题能搜到
        return parsed.searchParams.get('q').includes('坏候选') ? [] : [synced('夜に駆ける', 'YOASOBI')];
    }
    return null;
});
const fallbackHit = await createLrclibBackend(fallbackHttp).lookup({
    title: '夜に駆ける',
    artists: ['坏候选', 'YOASOBI'],
    durationMs: 259_000,
    relaxedDuration: true,
});
const searchKeywords = fallbackHttp.calls
    .filter((url) => url.includes('/search'))
    .map((url) => new URL(url).searchParams.get('q'));
check('第一个候选搜不到时会退到纯标题搜索', Boolean(fallbackHit?.lrc), JSON.stringify(fallbackHit));
check(
    '两次关键词的顺序是「标题+首个候选」→「纯标题」',
    searchKeywords.length === 2 && searchKeywords[0].includes('坏候选') && searchKeywords[1] === '夜に駆ける',
    JSON.stringify(searchKeywords),
);

// 退到纯标题不等于放宽身份判定：艺术家对不上的候选仍然要被挡掉
const strictHttp = createLrclibHttp((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/get')) return null;
    if (parsed.pathname.endsWith('/search')) return [synced('夜に駆ける', '完全不相干的歌手')];
    return null;
});
const strictHit = await createLrclibBackend(strictHttp).lookup({
    title: '夜に駆ける',
    artists: ['YOASOBI'],
    durationMs: 259_000,
    relaxedDuration: true,
});
check('退到纯标题后仍然按全部候选做艺术家判定', strictHit === null);

// 第一个候选就能命中时不该多发第二次搜索
const directHttp = createLrclibHttp((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/get')) return null;
    if (parsed.pathname.endsWith('/search')) return [synced('夜に駆ける', 'YOASOBI')];
    return null;
});
const directHit = await createLrclibBackend(directHttp).lookup({
    title: '夜に駆ける',
    artists: ['YOASOBI'],
    durationMs: 259_000,
    relaxedDuration: true,
});
check('首候选就命中时只发一次搜索（关键词里没有艺术家就只搜一次）', Boolean(directHit?.lrc) && directHttp.calls.filter((url) => url.includes('/search')).length === 1, String(directHttp.calls.length));

// 精确接口命中时不该走搜索
const exactHttp = createLrclibHttp((url) => (url.includes('/get') ? synced('夜に駆ける', 'YOASOBI') : []));
const exactHit = await createLrclibBackend(exactHttp).lookup({
    title: '夜に駆ける',
    artists: ['YOASOBI'],
    durationMs: 259_000,
    relaxedDuration: true,
});
check('精确接口命中时不再搜索', Boolean(exactHit?.lrc) && !exactHttp.calls.some((url) => url.includes('/search')), JSON.stringify(exactHttp.calls.map((u) => new URL(u).pathname)));

process.exit(summary() === 0 ? 0 : 1);
