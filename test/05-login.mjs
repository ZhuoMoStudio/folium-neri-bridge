// test/05-login.mjs —— 验证扫码登录链路本身
//
// 登录的实现在模组的 main 入口里（要用 Electron 的会话），这里测的是它依赖的那几个端点：
// 形状、状态码、以及「能不能拿到 Set-Cookie」。这三件事错了，登录就一定不对。
//
// 最后一步（真的拿手机扫）跑不了，但状态机可以。
import { check, summary } from './harness.mjs';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://passport.bilibili.com/login', Origin: 'https://www.bilibili.com' };

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

/** 文档里的四种状态。收到别的值说明上游改了协议。 */
const KNOWN_STATES = new Set([0, 86038, 86090, 86101]);

console.log('\n== 1. 生成二维码 ==');
const generated = await fetch(GENERATE_URL, { headers: HEADERS });
const generateBody = await generated.json().catch(() => null);
check('generate 返回 2xx', generated.ok, `HTTP ${generated.status}`);
check('code 为 0', generateBody?.code === 0, String(generateBody?.code));

const key = String(generateBody?.data?.qrcode_key ?? '').trim();
const qrContent = String(generateBody?.data?.url ?? '').trim();
check('拿到 qrcode_key', key.length > 0, `${key.slice(0, 12)}…(${key.length})`);
check('拿到二维码内容 URL', qrContent.startsWith('https://'), qrContent.slice(0, 70));
check('二维码 URL 里带着同一个 key', qrContent.includes(key));

console.log('\n== 2. 轮询状态 ==');
const polled = await fetch(`${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`, { headers: HEADERS });
const pollBody = await polled.json().catch(() => null);
check('poll 返回 2xx', polled.ok, `HTTP ${polled.status}`);
check('外层 code 为 0', pollBody?.code === 0, String(pollBody?.code));

const state = Number(pollBody?.data?.code);
check('返回已知状态码', KNOWN_STATES.has(state), `code=${state} message=${pollBody?.data?.message}`);
check('刚生成时应为「未扫码」(86101)', state === 86101, `code=${state}`);
check('带人类可读的 message', typeof pollBody?.data?.message === 'string' && pollBody.data.message.length > 0);

console.log('\n== 3. Set-Cookie 是否可读（登录成功的关键前提）==');
// 未登录时服务端不会下发会话 cookie，这里验的是「能力」而不是「结果」：
// 模组的 main 入口用 Node 的 headers.getSetCookie()，要先确认它在这个运行时里存在。
check('Node 的 fetch 提供了 getSetCookie', typeof polled.headers.getSetCookie === 'function');
check(
    'getSetCookie 返回数组（不是被逗号合并的字符串）',
    Array.isArray(polled.headers.getSetCookie()),
    `未登录时长度 ${polled.headers.getSetCookie().length}`,
);
check(
    '对照：headers.get("set-cookie") 是合并后的单个值或 null',
    polled.headers.get('set-cookie') === null || typeof polled.headers.get('set-cookie') === 'string',
);

console.log('\n== 4. 失败路径 ==');
const badKey = await fetch(`${POLL_URL}?qrcode_key=0000000000000000000000000000ffff`, { headers: HEADERS });
const badBody = await badKey.json().catch(() => null);
check('无效 key 不抛网络错误', badKey.ok, `HTTP ${badKey.status}`);
check(
    '无效 key 返回已知状态或明确的错误码',
    KNOWN_STATES.has(Number(badBody?.data?.code)) || badBody?.code !== 0,
    JSON.stringify(badBody?.data ?? badBody?.message),
);

console.log('\n== 5. legacy 与 crossDomain 两种成功响应的判别 ==');
// 2026-08 起 data.url 变成票据链接，cookie 由 Set-Cookie 下发。
// 判别逻辑很简单：查询串里有没有 SESSDATA。这里用本地样本确认判别式本身没问题。
const isLegacy = (url) => {
    try {
        return new URL(url).searchParams.has('SESSDATA');
    } catch {
        return false;
    }
};
check('legacy 响应被识别为 legacy', isLegacy('https://passport.bilibili.com/login?SESSDATA=x&bili_jct=y'));
check(
    'crossDomain 票据被识别为非 legacy（需要走 Set-Cookie）',
    !isLegacy('https://passport.biligame.com/crossDomain?DedeUserID=&gourl=https%3A%2F%2Fwww.bilibili.com'),
);

process.exit(summary() === 0 ? 0 : 1);
