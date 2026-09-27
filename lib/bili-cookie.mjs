// lib/bili-cookie.mjs
//
// B 站登录态的规范化。纯函数，可以在没有宿主的环境里测。
//
// 为什么要单独一层：登录态在三个地方流动，各有各的形状
//   - 用户粘贴：一整条 `SESSDATA=xxx; bili_jct=yyy` 字符串（可能带换行、可能带 `Cookie:` 前缀）
//   - Chromium 会话：{ name, value, domain, ... } 的对象数组
//   - 请求头：一条 `k=v; k=v` 字符串
// 三个地方都自己拼一遍必然出错，所以统一走这里。
//
// 安全约定：任何要写进日志的路径都必须过 redactCookie()。SESSDATA 等价于账号本身。

/** 真正影响权限的字段。缺了 SESSDATA 就等于没登录。 */
const REQUIRED_FIELDS = ['SESSDATA'];
/** 有则更好：bili_jct 是写操作的 csrf，DedeUserID 用来显示当前用户。 */
const OPTIONAL_FIELDS = ['bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'];

/** B 站的登录 cookie 在 `.bilibili.com` 域下。 */
export const COOKIE_DOMAIN = 'bilibili.com';

/**
 * 把用户粘贴的任意文本解析成字段表。
 *
 * 容忍：`Cookie: ` 前缀、换行/分号混用、多余空格、值里带 `=`（如 base64 的 SESSDATA）。
 * 不做 URL 解码 —— 原样透传给服务端最安全。
 */
export const parseCookieHeader = (raw) => {
    const fields = new Map();
    if (typeof raw !== 'string') return fields;

    const withoutPrefix = raw.replace(/^\s*cookie\s*:\s*/i, '');
    for (const part of withoutPrefix.split(/[;\n\r]+/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const separator = trimmed.indexOf('=');
        if (separator <= 0) continue;
        const name = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        // cookie 名不可能是这些字符，出现就说明这行不是 cookie 而是别的文本
        if (!/^[A-Za-z0-9_$-]+$/.test(name)) continue;
        if (!value) continue;
        fields.set(name, value);
    }
    return fields;
};

/** 把字段表序列化回请求头。顺序固定，便于比较与测试。 */
export const serializeCookieHeader = (fields) => {
    if (!fields || fields.size === 0) return '';
    const names = [...new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])].filter((name) => fields.has(name));
    const extras = [...fields.keys()].filter((name) => !names.includes(name));
    return [...names, ...extras].map((name) => `${name}=${fields.get(name)}`).join('; ');
};

/** 从 Chromium 的 cookies.get() 结果里提取字段表。后写入的同名值优先。 */
export const cookieFieldsFromSession = (cookies) => {
    const fields = new Map();
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
        if (!cookie?.name || typeof cookie.value !== 'string' || !cookie.value) continue;
        if (!String(cookie.domain ?? '').endsWith(COOKIE_DOMAIN)) continue;
        fields.set(cookie.name, cookie.value);
    }
    return fields;
};

/** 够不够用：至少要有一个 SESSDATA。 */
export const isValidSession = (fields) => Boolean(fields?.get?.('SESSDATA'));

/** 日志用的脱敏形式。永远不要直接打 cookie。 */
export const redactCookie = (fields) => {
    if (!fields || fields.size === 0) return 'none';
    const names = [...fields.keys()];
    const sessdata = fields.get('SESSDATA') ?? '';
    // 只留长度与前 4 位：足以确认是同一个账号，不足以复用它
    const shape = sessdata ? `SESSDATA=${sessdata.slice(0, 4)}…(${sessdata.length})` : 'SESSDATA 缺失';
    return `${shape} fields=[${names.join(',')}]`;
};

/** 会话的过期时间怎么判：B 站不返回，只能靠服务端 401 反推。这里只做形状校验。 */
export const describeSession = (fields) => ({
    loggedIn: isValidSession(fields),
    userId: fields?.get?.('DedeUserID') ?? null,
    hasCsrf: Boolean(fields?.get?.('bili_jct')),
    fieldCount: fields?.size ?? 0,
});

/**
 * 音质上限的**可读说法**。
 *
 * 以前这件事只写进日志（providers/bilibili.mjs 里的 `not signed in; Bilibili caps audio quality`），
 * 用户看不到：库里明明有 192K 的条目却放不出更高的档，会以为是模组的问题。
 *
 * 事实依据（2026-09-27 实测，见 test/02-live.mjs 第 10 节）：匿名请求
 * `/x/player/wbi/playurl` 对 15 个音乐稿件取样，返回的音频轨道 id 并集恰好是
 * {30216 (64K), 30232 (132K), 30280 (192K)}；同时 `dash.flac.display === true` 却
 * `dash.flac.audio === null` —— 稿件确实有 Hi-Res FLAC，但匿名拿不到流。
 * 所以「未登录拿不到什么」是有观测支撑的，「登录后一定能拿到」则没有（本仓库从不保存凭据），
 * 措辞上不要越界。
 */
export const describeQualityCap = (loggedIn) => (loggedIn
    ? {
        capped: false,
        level: 'account',
        message: '已登录：按账号权限取流（192K / 杜比 / Hi-Res 是否可用取决于账号与稿件）',
    }
    : {
        capped: true,
        level: 'anonymous',
        message: '未登录：只拿得到匿名档位（实测 64K / 132K / 192K 三档里的可用项），'
            + '杜比与 Hi-Res FLAC 拿不到流（playurl 里 flac.display 为 true 而 flac.audio 为 null），会员内容同样不可用',
    });
