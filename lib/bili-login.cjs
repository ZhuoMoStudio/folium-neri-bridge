// lib/bili-login.cjs
//
// 扫码登录成功后，凭据从哪些地方来。**纯函数**，不联网、不碰 Electron。
//
// 为什么要单独一层：2026-08 起 B 站改了「扫码成功」响应里的 data.url 形状，
// 从「查询串里带 cookie 的地址」变成了 crossDomain 票据链接，真正的
// SESSDATA / bili_jct / DedeUserID 由跟随该链接时的 Set-Cookie 下发。
// 只解析查询串的实现会「报成功但存到空凭据」，症状是用户在模组面板里看到
// 「登录成功」而搜索还是匿名的 —— 这种 bug 只能靠一条固定的回归挡住，
// 而回归要能被离线重放，就必须先把这个判断从 index.cjs 里拆出来。
//
// 为什么是 .cjs 而不是 .mjs：index.cjs（main 入口）是 CommonJS，这段判断要在
// 注册 rpc 处理器时同步可用。lib/ 下其余模块都是 ESM，由 index.cjs 动态 import；
// 这里走 require，所以扩展名必须对上。

/** 值影响权限的字段。缺 SESSDATA 就等于没登录。 */
const SESSION_FIELDS = new Set(['SESSDATA', 'bili_jct', 'DedeUserID']);

/** `DedeUserID__ckMd5` 之类的校验字段，也一并带上（有些接口会看）。 */
const isChecksumField = (name) => name.endsWith('__ckMd5');

/**
 * 从一个 Set-Cookie 值里取第一段 `name=value`。
 *
 * 与 lib/bili-cookie.mjs 的 parseCookieHeader 不是一回事，别合并：那边解析的是
 * 用户粘贴的一整条请求头（要找遍所有 `;` 分隔的段），这里解析的是一条 Set-Cookie
 * （第一段是 cookie 本身，后面全是 Path/Domain/Expires 属性）。
 * 注意 Expires 值里带逗号，所以千万别先把多个 Set-Cookie 拼起来再切。
 */
const firstCookiePair = (setCookie) => {
    if (typeof setCookie !== 'string') return null;
    const head = setCookie.split(';')[0];
    const separator = head.indexOf('=');
    if (separator <= 0) return null;
    return [head.slice(0, separator).trim(), head.slice(separator + 1).trim()];
};

/** 把一组 Set-Cookie 值里的会话字段并进字段表。返回这次新写进去的名字。 */
const mergeSetCookies = (fields, setCookies) => {
    const written = [];
    for (const raw of Array.isArray(setCookies) ? setCookies : []) {
        const pair = firstCookiePair(raw);
        if (!pair) continue;
        const [name, value] = pair;
        fields.set(name, value);
        if (SESSION_FIELDS.has(name) || isChecksumField(name)) written.push(name);
    }
    return written;
};

/**
 * 从 Legacy 的 data.url 里读 cookie 参数（2026-08 之前的行为）。
 *
 * 与票据链接的区别：这里查询串里**有** SESSDATA。空值参数也会被带出来 ——
 * 由调用方判定有效性，这一层只负责搬运（crossDomain 链接里就有
 * `DedeUserID=&DedeUserID__ckMd5=` 这种空值，形状上必须原样保留）。
 */
const cookieFieldsFromTicketUrl = (ticketUrl) => {
    const fields = new Map();
    if (typeof ticketUrl !== 'string' || !ticketUrl) return fields;
    try {
        const url = new URL(ticketUrl, 'https://passport.bilibili.com');
        for (const [name, value] of url.searchParams) {
            if (SESSION_FIELDS.has(name) || isChecksumField(name)) fields.set(name, value);
        }
    } catch {
        // 不是合法 URL 就当作没有
    }
    return fields;
};

/** 这个 data.url 是不是「查询串里直接带 cookie」的老形状。 */
const isLegacyTicketUrl = (ticketUrl) => {
    try {
        return new URL(String(ticketUrl), 'https://passport.bilibili.com').searchParams.has('SESSDATA');
    } catch {
        return false;
    }
};

/** 这组 Set-Cookie 里是不是已经有可用的 SESSDATA —— 决定还要不要多跟一跳票据链接。 */
const hasSessionCookie = (setCookies) => {
    for (const raw of Array.isArray(setCookies) ? setCookies : []) {
        const pair = firstCookiePair(raw);
        if (pair && pair[0] === 'SESSDATA' && pair[1]) return true;
    }
    return false;
};

/**
 * 三条路依次尝试，合并出一份登录凭据。
 *
 * 顺序即优先级，而且**后面的路只在前面的路还没凑出 SESSDATA 时才走** ——
 * crossDomain 链接里带着空的 `DedeUserID=`，无条件合并会用它盖掉 Set-Cookie 给的真实值。
 *
 * @param pollSetCookies   轮询响应自身的 Set-Cookie（字符串数组）
 * @param ticketSetCookies 跟随票据链接那一跳的 Set-Cookie（字符串数组）
 * @param ticketUrl        data.url（票据链接或 Legacy 链接，可能是空串）
 * @returns {{ fields: Map<string, string>, routes: string[], hasSession: boolean, legacy: boolean }}
 *          `routes` 记录实际生效过的路，用于日志与自检输出。
 */
const resolveLoginCookies = ({ pollSetCookies = [], ticketSetCookies = [], ticketUrl = '' } = {}) => {
    const fields = new Map();
    const routes = [];

    const writtenByPoll = mergeSetCookies(fields, pollSetCookies);
    if (writtenByPoll.length > 0) routes.push('poll-set-cookie');

    // 缺少 SESSDATA 时才有必要跟票据链接 —— 拿到了就不再多请求一次
    const writtenByTicket = fields.has('SESSDATA') ? [] : mergeSetCookies(fields, ticketSetCookies);
    if (writtenByTicket.length > 0) routes.push('ticket-set-cookie');

    if (!fields.get('SESSDATA') && ticketUrl) {
        const legacyFields = cookieFieldsFromTicketUrl(ticketUrl);
        if (legacyFields.size > 0) {
            for (const [name, value] of legacyFields) {
                if (!fields.has(name)) fields.set(name, value);
            }
            routes.push('legacy-query');
        }
    }

    return {
        fields,
        routes,
        hasSession: Boolean(fields.get('SESSDATA')),
        legacy: isLegacyTicketUrl(ticketUrl),
    };
};

/** 日志用的一行摘要。不含任何凭据内容。 */
const describeLoginRoutes = (routes) => (routes.length > 0 ? routes.join(' → ') : 'none');

module.exports = {
    cookieFieldsFromTicketUrl,
    resolveLoginCookies,
    describeLoginRoutes,
    isLegacyTicketUrl,
    hasSessionCookie,
    firstCookiePair,
    SESSION_FIELD_NAMES: [...SESSION_FIELDS],
};
