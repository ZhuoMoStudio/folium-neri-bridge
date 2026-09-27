// index.cjs —— 模组的 main 入口（主进程，Node 环境）
//
// 这里做两件事，都必须在主进程才能做：
//
// 1. 【防盗链】让 B 站 CDN 上的音频能被 <audio> 播出来。
//    实测两个 CDN 家族策略不同：
//      upos-sz-mirrorcosov.bilivideo.com   带 B 站 Referer → 206   不带 → 403
//      upos-hz-mirrorakam.akamaized.net    带 B 站 Referer → 206   不带 → 206
//    而 Folia 的页面来源（dev localhost:3000 / 生产 file://）两种都被 403，
//    且 <audio> 无法自定义请求头，所以只能在这一层改写 Referer。
//
// 2. 【登录】用 Electron 的会话 cookie 做登录态。
//    folium.net.fetch 拿不到可靠的 Set-Cookie —— modSystem.cjs:935 用
//    `headers.forEach((v,k)=>obj[k]=v)` 归一化，undici 会把多个 Set-Cookie
//    用逗号合并，而 cookie 的 Expires 自身含逗号，信息就丢了。
//    所以登录走 BrowserWindow + session.cookies，不经过 folium.net.fetch。
//
// 为什么不会误伤接口请求：folium.net.fetch 在主进程里用 Node 全局 fetch
// （modSystem.cjs:874 的注释与 :910 的调用），不经过 Chromium 的 session，
// 本文件注册的 webRequest 监听器碰不到它。

/** 只在这几个域上动手。api.bilibili.com 不在其中，接口调用不受影响。 */
const MEDIA_URL_FILTERS = [
    '*://*.bilivideo.com/*',
    '*://*.bilivideo.cn/*',
    // akamaized.net 是共享域名，真正的把关在 isBilibiliCdn 里
    '*://*.akamaized.net/*',
    '*://*.hdslb.com/*',
];

const BILIBILI_REFERER = 'https://www.bilibili.com/';
const BILIBILI_ORIGIN = 'https://www.bilibili.com';
const BILIBILI_MEDIA_PATH = /\/upgcxcode\//;
const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LOGIN_URL = 'https://passport.bilibili.com/login';
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const LOGIN_REFERER = 'https://passport.bilibili.com/login';

const STORAGE_KEY = 'bilibiliCookie';
/** 登录窗口关掉后多久放弃等待，避免轮询永远跑着。 */
const LOGIN_WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

const hostOf = (url) => {
    try {
        return new URL(String(url)).host.toLowerCase();
    } catch {
        return '';
    }
};

const isHost = (host, base) => host === base || host.endsWith(`.${base}`);

/**
 * 这个 URL 是不是 B 站的媒体资源。
 *
 * 前三家域名本身就是 B 站专用，只看域名就够；akamaized.net 是 Akamai 的共享域名，
 * 上面跑着无数别家的东西，所以额外要求路径里出现 B 站取流地址特有的 /upgcxcode/。
 */
const isBilibiliCdn = (url) => {
    const host = hostOf(url);
    if (!host) return false;
    if (isHost(host, 'bilivideo.com') || isHost(host, 'bilivideo.cn') || isHost(host, 'hdslb.com')) {
        return true;
    }
    return isHost(host, 'akamaized.net') && BILIBILI_MEDIA_PATH.test(String(url));
};

const headerValue = (headers, wanted) => {
    if (!headers) return '';
    for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === wanted) return String(headers[name] ?? '');
    }
    return '';
};

const hasHeader = (headers, wanted) => {
    if (!headers) return false;
    return Object.keys(headers).some((name) => name.toLowerCase() === wanted);
};

/** 这个请求需不需要改写。已经是正确 Referer 且没有多余头时就不用动。 */
const needsHeaderRewrite = (requestHeaders, cookie) => {
    if (headerValue(requestHeaders, 'referer') !== BILIBILI_REFERER) return true;
    if (hasHeader(requestHeaders, 'origin')) return true;
    if (cookie && headerValue(requestHeaders, 'cookie') !== cookie) return true;
    return false;
};

/** 返回改写后的头对象；不需要改写时返回 null，调用方据此跳过。 */
const applyBilibiliHeaders = (requestHeaders, cookie) => {
    if (!needsHeaderRewrite(requestHeaders, cookie)) return null;
    const next = { ...requestHeaders };
    for (const name of Object.keys(next)) {
        const lower = name.toLowerCase();
        if (lower === 'referer' || lower === 'origin') delete next[name];
        // Cookie 只在登录后接管：没登录时保留浏览器原本的（可能带着匿名指纹 buvid3）
        if (lower === 'cookie' && cookie) delete next[name];
    }
    next.Referer = BILIBILI_REFERER;
    if (cookie) next.Cookie = cookie;
    return next;
};

/** 响应上的 Set-Cookie。Node 18+ 的 undici 才有 getSetCookie，所以要留退路。 */
const readSetCookie = (response) => {
    const headers = response?.headers;
    if (!headers) return [];
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const single = headers.get?.('set-cookie');
    return single ? [single] : [];
};

// 登录成功凭据的三条来源、以及 Legacy 票据链接的解析，都在 lib/bili-login.cjs 里。
// 拆出去的理由是可测：真机扫码在沙盒里做不了，但那份判断可以拿 fixture 离线重放（test/10）。
// 用 require 而不是动态 import，是因为 rpc 处理器里要同步取到它。
const loginLib = require('./lib/bili-login.cjs');
const { cookieFieldsFromTicketUrl } = loginLib;

const activate = (api) => {
    const log = api.log;
    let detachWebRequest = null;
    let loginWindow = null;
    let loginPoller = null;

    /**
     * Referer 监听器的状态。这三项是「自检」命令要读的东西 ——
     * 没有它们，用户能看到的只有播放失败，看不到失败发生在哪一层。
     *
     * `refererRewrites` 是**真的能证明监听器在干活**的计数器：`<audio>` 探测前后各读一次，
     * 涨了就说明这次请求确实是从监听器里过的，而不是「装上了但从没被调用过」。
     */
    let refererState = 'unavailable';
    let refererError = null;
    let refererRewrites = 0;
    let refererLastHost = null;

    const storageGet = async (key) => {
        try {
            return await api.storage.data.get(key);
        } catch (error) {
            log?.warn?.('storage read failed', { message: String(error?.message ?? error) });
            return undefined;
        }
    };
    const storageSet = async (key, value) => {
        try {
            await api.storage.data.set(key, value);
        } catch (error) {
            log?.warn?.('storage write failed', { message: String(error?.message ?? error) });
        }
    };

    // bili-cookie.mjs 是 ESM，index.cjs 是 CJS。ESM 动态 import 两边都能用，
    // 这样规范化逻辑只有一份，不在这里抄一遍。webRequest 监听器是同步的，
    // 但它只读下面这两个已经缓存的字符串，不需要 await。
    let cookieLib = null;
    const loadCookieLib = async () => {
        cookieLib ??= await import('./lib/bili-cookie.mjs');
        return cookieLib;
    };

    /** 当前登录态。两个缓存变量是为了让同步的 webRequest 监听器能读到。 */
    let cookieHeader = '';
    let cookieDescription = 'none';

    const applyCookieHeader = async (header) => {
        cookieHeader = typeof header === 'string' ? header : '';
        const lib = await loadCookieLib();
        const fields = lib.parseCookieHeader(cookieHeader);
        cookieDescription = lib.redactCookie(fields);
        return fields;
    };

    const persistCookie = async (fields) => {
        const lib = await loadCookieLib();
        const header = lib.serializeCookieHeader(fields);
        await applyCookieHeader(header);
        await storageSet(STORAGE_KEY, header);
        return header;
    };

    const clearCookie = async () => {
        cookieHeader = '';
        cookieDescription = 'none';
        await storageSet(STORAGE_KEY, '');
    };

    const biliFetch = (url, init = {}) =>
        fetch(url, {
            ...init,
            headers: {
                'User-Agent': WEB_UA,
                Referer: LOGIN_REFERER,
                Origin: BILIBILI_ORIGIN,
                ...(init.headers ?? {}),
            },
        });

    // ---------------------------------------------------------------- 登录流程

    /** 生成扫码登录会话。返回的 qrContent 交给渲染端去画二维码。 */
    const loginCreate = async () => {
        const response = await biliFetch(QR_GENERATE_URL);
        const payload = await response.json().catch(() => null);
        if (payload?.code !== 0) {
            return { ok: false, error: `generate-failed:${payload?.code ?? response.status}` };
        }
        const key = String(payload?.data?.qrcode_key ?? '').trim();
        const qrContent = String(payload?.data?.url ?? '').trim();
        if (!key || !qrContent) return { ok: false, error: 'generate-empty' };
        return { ok: true, key, qrContent };
    };

    /**
     * 轮询扫码状态。
     *
     * 2026-08 起 B 站改了成功响应的形状：data.url 不再是「查询串里带 cookie」的地址，
     * 而是一个 crossDomain 票据链接，真正的 SESSDATA / bili_jct / DedeUserID 由
     * 跟随该链接时的 Set-Cookie 下发。只解析 data.url 查询串的实现会「报成功但存到空凭据」。
     * 所以这里三条路都走：poll 响应自身的 Set-Cookie、票据链接跟随后的 Set-Cookie、
     * 以及 Legacy 的查询串解析。三条路的合并顺序由 lib/bili-login.cjs 的
     * resolveLoginCookies 决定（那个函数可以拿 fixture 离线重放，见 test/10-selfcheck.mjs）。
     */
    const loginPoll = async (key) => {
        if (typeof key !== 'string' || !key.trim()) return { ok: false, error: 'missing-key' };
        const lib = await loadCookieLib();

        const response = await biliFetch(`${QR_POLL_URL}?qrcode_key=${encodeURIComponent(key)}`);
        const pollSetCookies = readSetCookie(response);
        const payload = await response.json().catch(() => null);
        if (payload?.code !== 0) {
            return { ok: false, error: `poll-failed:${payload?.code ?? response.status}` };
        }

        const data = payload?.data ?? {};
        const state = Number(data.code);
        const result = { ok: true, state, message: String(data.message ?? '') };
        if (state !== 0) return result;

        const ticketUrl = String(data.url ?? '');

        // 轮询响应自己就带着 SESSDATA 时就不多跳一次（省一次请求，也少一次被风控看到的机会）
        let ticketSetCookies = [];
        if (!loginLib.hasSessionCookie(pollSetCookies) && ticketUrl) {
            try {
                // 用浏览器 UA 跟随票据链接，cookie 在这一跳的响应头上
                const ticketResponse = await biliFetch(ticketUrl);
                ticketSetCookies = readSetCookie(ticketResponse);
            } catch (error) {
                log?.warn?.('ticket follow failed', { message: String(error?.message ?? error) });
            }
        }

        // 三条路（poll 的 Set-Cookie / 票据那一跳的 Set-Cookie / Legacy 查询串）的
        // 合并顺序与优先级由这个纯函数决定，理由见 lib/bili-login.cjs
        const resolved = loginLib.resolveLoginCookies({ pollSetCookies, ticketSetCookies, ticketUrl });
        if (!resolved.hasSession) {
            log?.warn?.('bilibili login returned no usable cookie', {
                state,
                routes: loginLib.describeLoginRoutes(resolved.routes),
                legacy: resolved.legacy,
            });
            return { ok: false, error: 'login-succeeded-but-no-cookie', state, routes: resolved.routes };
        }

        await persistCookie(resolved.fields);
        log?.info?.('bilibili login ok', {
            session: cookieDescription,
            routes: loginLib.describeLoginRoutes(resolved.routes),
        });
        return { ...result, loggedIn: true, session: lib.describeSession(resolved.fields), routes: resolved.routes };
    };

    /**
     * 打开一个真正的浏览器窗口走网页登录。
     *
     * 为什么不用 folium.ui.embed：那是个 iframe，能不能登录取决于目标页是否允许被嵌套；
     * 顶层窗口没有这个限制，而且 cookie 直接落进 defaultSession，我们能读。
     */
    const openLoginWindow = async () => {
        let BrowserWindow;
        let session;
        try {
            ({ BrowserWindow, session } = require('electron'));
        } catch (error) {
            return { ok: false, error: `electron-unavailable:${String(error?.message ?? error)}` };
        }
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.focus();
            return { ok: true, reused: true };
        }

        const lib = await loadCookieLib();
        loginWindow = new BrowserWindow({
            width: 1080,
            height: 760,
            title: 'Bilibili 登录',
            autoHideMenuBar: true,
        });
        await loginWindow.loadURL(LOGIN_URL).catch(() => undefined);

        const startedAt = Date.now();
        const stopPolling = () => {
            if (loginPoller) clearInterval(loginPoller);
            loginPoller = null;
        };
        loginPoller = setInterval(async () => {
            if (!loginWindow || loginWindow.isDestroyed() || Date.now() - startedAt > LOGIN_WINDOW_TIMEOUT_MS) {
                stopPolling();
                return;
            }
            try {
                const cookies = await session.defaultSession.cookies.get({ domain: 'bilibili.com' });
                const fields = lib.cookieFieldsFromSession(cookies);
                if (!lib.isValidSession(fields)) return;
                await persistCookie(fields);
                log?.info?.('bilibili web login ok', { session: cookieDescription });
                stopPolling();
                if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
            } catch (error) {
                log?.warn?.('login poll failed', { message: String(error?.message ?? error) });
            }
        }, 1500);

        loginWindow.on('closed', () => {
            stopPolling();
            loginWindow = null;
        });
        return { ok: true };
    };

    /** 从 Folia 自己的会话里读 cookie（用户可能已经在别处登录过）。 */
    const readFromSession = async () => {
        try {
            const { session } = require('electron');
            const lib = await loadCookieLib();
            const cookies = await session.defaultSession.cookies.get({ domain: 'bilibili.com' });
            const fields = lib.cookieFieldsFromSession(cookies);
            if (!lib.isValidSession(fields)) return { ok: false, error: 'no-session-cookie' };
            await persistCookie(fields);
            log?.info?.('bilibili session imported', { session: cookieDescription });
            return { ok: true, session: lib.describeSession(fields) };
        } catch (error) {
            return { ok: false, error: `read-failed:${String(error?.message ?? error)}` };
        }
    };

    const sessionStatus = async () => {
        const lib = await loadCookieLib();
        const fields = lib.parseCookieHeader(cookieHeader);
        const loggedIn = lib.isValidSession(fields);
        return {
            ok: true,
            loggedIn,
            session: lib.describeSession(fields),
            masked: cookieDescription,
            // 未登录时 B 站只给匿名档位。这条以前只写进日志，用户看不到，
            // 于是「库里 192K 的条目放不出更高的档」会被当成模组的问题。
            quality: lib.describeQualityCap(loggedIn),
        };
    };

    /**
     * 自检要的事实。都在主进程侧 —— 渲染端问不到的东西正是这几样：
     * 监听器到底装上没装上、它被调用过几次、当前登录态是什么。
     */
    const diagnose = async () => {
        let electronAvailable = false;
        try {
            electronAvailable = Boolean(require('electron')?.session);
        } catch {
            electronAvailable = false;
        }
        return {
            ok: true,
            referer: {
                state: refererState,
                error: refererError,
                hosts: MEDIA_URL_FILTERS.length,
                rewrites: refererRewrites,
                lastRewriteHost: refererLastHost,
            },
            electron: { available: electronAvailable },
            // 登录态在渲染端也有一份缓存，这里给的是主进程实际在用的那一份。
            // 只给形状，不给值（SESSDATA 等价于账号本身）。
            session: { restored: Boolean(cookieHeader), masked: cookieDescription },
        };
    };

    const setCookieFromText = async (text) => {
        const lib = await loadCookieLib();
        const fields = lib.parseCookieHeader(text);
        if (!lib.isValidSession(fields)) return { ok: false, error: 'missing-sessdata' };
        await persistCookie(fields);
        log?.info?.('bilibili cookie set manually', { session: cookieDescription });
        return { ok: true, session: lib.describeSession(fields) };
    };

    // ------------------------------------------------------------------ 装配

    try {
        const { session } = require('electron');
        const ses = session?.defaultSession;
        if (!ses?.webRequest?.onBeforeSendHeaders) {
            refererState = 'unavailable';
            log?.warn?.('electron session unavailable; Bilibili media will 403 on a non-Bilibili origin');
        } else {
            const listener = (details, callback) => {
                if (!isBilibiliCdn(details?.url)) {
                    callback({ requestHeaders: details?.requestHeaders });
                    return;
                }
                const rewritten = applyBilibiliHeaders(details?.requestHeaders, cookieHeader);
                if (rewritten) {
                    // 计数是自检的证据：装上不等于生效，被调用过才算
                    refererRewrites += 1;
                    refererLastHost = hostOf(details?.url) || null;
                }
                callback({ requestHeaders: rewritten ?? details?.requestHeaders });
            };
            ses.webRequest.onBeforeSendHeaders({ urls: MEDIA_URL_FILTERS }, listener);
            detachWebRequest = () => {
                try {
                    ses.webRequest.onBeforeSendHeaders({ urls: MEDIA_URL_FILTERS }, null);
                } catch (error) {
                    log?.warn?.('failed to detach referer listener', { message: String(error?.message ?? error) });
                }
            };
            refererState = 'installed';
            log?.info?.('bilibili referer guard installed', { hosts: MEDIA_URL_FILTERS.length });
        }
    } catch (error) {
        refererState = 'failed';
        // 只要第一行：`require('electron')` 失败时 message 里带着整个 require stack，
        // 它会一路显示到命令面板上
        refererError = String(error?.message ?? error).split('\n')[0];
        log?.warn?.('failed to install bilibili referer guard', { message: refererError });
    }

    for (const [name, handler] of Object.entries({
        'bili.login.create': loginCreate,
        'bili.login.poll': loginPoll,
        'bili.login.openWindow': openLoginWindow,
        'bili.session.read': readFromSession,
        'bili.session.status': sessionStatus,
        'bili.session.set': setCookieFromText,
        'bili.session.clear': async () => {
            await clearCookie();
            return { ok: true };
        },
        'bili.diagnose': diagnose,
    })) {
        try {
            api.rpc.handle(name, handler);
        } catch (error) {
            log?.warn?.('failed to register rpc', { name, message: String(error?.message ?? error) });
        }
    }

    // 启动时把上次存下的登录态装回内存，让 webRequest 监听器立刻能用
    storageGet(STORAGE_KEY)
        .then((stored) => (typeof stored === 'string' && stored ? applyCookieHeader(stored) : undefined))
        .then((fields) => {
            if (fields) log?.info?.('bilibili session restored', { session: cookieDescription });
        })
        .catch(() => undefined);

    return () => {
        detachWebRequest?.();
        if (loginPoller) clearInterval(loginPoller);
        if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    };
};

module.exports = activate;
// 导出给测试用（test/03-contract.mjs）
module.exports.applyBilibiliHeaders = applyBilibiliHeaders;
module.exports.needsHeaderRewrite = needsHeaderRewrite;
module.exports.isBilibiliCdn = isBilibiliCdn;
module.exports.cookieFieldsFromTicketUrl = cookieFieldsFromTicketUrl;
module.exports.readSetCookie = readSetCookie;
module.exports.MEDIA_URL_FILTERS = MEDIA_URL_FILTERS;
module.exports.BILIBILI_REFERER = BILIBILI_REFERER;
