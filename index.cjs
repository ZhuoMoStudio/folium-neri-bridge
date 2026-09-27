// index.cjs —— 模组的 main 入口（主进程，Node 环境）
//
// 这里只做一件事：让 B 站 CDN 上的音频能被 <audio> 播出来。
//
// 背景（2026-09-27 实测，test/02-live.mjs 与 test/04-cdn.mjs）：
// B 站同时用两个 CDN 家族，防盗链策略不同：
//
//   upos-sz-mirrorcosov.bilivideo.com   带 B 站 Referer → 206   不带 → 403
//   upos-hz-mirrorakam.akamaized.net    带 B 站 Referer → 206   不带 → 206
//
// 也就是说「不带 Referer 也行」是 CDN 相关的：只测一个节点会得出自相矛盾的结论。
// 而 Folia 的页面来源恰好是两种都不行的情况：
//   开发模式 http://localhost:3000（main.cjs:4205 loadURL）→ 403
//   生产模式 file://（main.cjs:4209 loadFile）              → 403
//
// <audio> 元素无法自定义请求头，所以只能在这一层把 Referer 顶掉。
// 做法是「一律改成 https://www.bilibili.com/」，不是「删掉」—— 后者在 bilivideo 上仍 403。
//
// 为什么不走「本地回环代理」：那个方案要占端口、管生命周期、自己实现 Range
// （DASH 的 m4s 分片必须支持断点续传），三个新的出错点换同一个结果。
// webRequest 这一层只改两个请求头，代价小得多。
//
// 为什么不会误伤 API 请求：folium.net.fetch 在主进程里用 Node 的全局 fetch 发请求
// （见 electron/modSystem/modSystem.cjs:874 的注释与 :910 的调用），不经过 Chromium 的
// session，因此本监听器碰不到它。B 站接口需要的 Referer 仍然由 providers 自己带上。

/**
 * 只在这几个域上动手。api.bilibili.com 不在其中，接口调用不受影响。
 *
 * 域名清单来自实测采样（test/04-cdn.mjs，6 次 playurl 共 18 条流）：
 *   upos-sz-mirrorcosov.bilivideo.com   13 条
 *   upos-hz-mirrorakam.akamaized.net     5 条
 */
const MEDIA_URL_FILTERS = [
    '*://*.bilivideo.com/*',
    '*://*.bilivideo.cn/*',
    // akamaized.net 是共享域名，不能只靠域名判定；真正的把关在 isBilibiliCdn 里
    '*://*.akamaized.net/*',
    '*://*.hdslb.com/*',
];

/** 唯一实测可用的 Referer。 */
const BILIBILI_REFERER = 'https://www.bilibili.com/';

/** B 站取流地址里固定出现的路径片段，用来把共享域名上的无关请求排除掉。 */
const BILIBILI_MEDIA_PATH = /\/upgcxcode\//;

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

/** 这个请求需不需要改写。已经是正确 Referer 且没有 Origin 时就不用动。 */
const needsRefererRewrite = (requestHeaders) =>
    headerValue(requestHeaders, 'referer') !== BILIBILI_REFERER ||
    hasHeader(requestHeaders, 'origin');

/** 返回改写后的头对象；不需要改写时返回 null，调用方据此跳过。 */
const applyBilibiliReferer = (requestHeaders) => {
    if (!needsRefererRewrite(requestHeaders)) return null;
    const next = { ...requestHeaders };
    // 先清掉大小写不定的旧值，再统一写入一个
    for (const name of Object.keys(next)) {
        const lower = name.toLowerCase();
        if (lower === 'referer' || lower === 'origin') delete next[name];
    }
    next.Referer = BILIBILI_REFERER;
    return next;
};

const activate = (api) => {
    const log = api.log;
    let detach = null;

    try {
        // main 入口是用 Node 原生 require 加载的（modSystem.cjs:352），所以 electron 拿得到
        const { session } = require('electron');
        const ses = session?.defaultSession;
        if (!ses?.webRequest?.onBeforeSendHeaders) {
            log?.warn?.('electron session unavailable; Bilibili media will 403 on a non-Bilibili origin');
            return undefined;
        }

        const listener = (details, callback) => {
            // 域名过滤之外再过一道路径判定：akamaized.net 上的非 B 站请求一律不碰
            if (!isBilibiliCdn(details?.url)) {
                callback({ requestHeaders: details?.requestHeaders });
                return;
            }
            const rewritten = applyBilibiliReferer(details?.requestHeaders);
            callback({ requestHeaders: rewritten ?? details?.requestHeaders });
        };

        ses.webRequest.onBeforeSendHeaders({ urls: MEDIA_URL_FILTERS }, listener);

        detach = () => {
            try {
                // 传 null 即为注销该 filter 下的监听器
                ses.webRequest.onBeforeSendHeaders({ urls: MEDIA_URL_FILTERS }, null);
            } catch (error) {
                log?.warn?.('failed to detach referer listener', { message: String(error?.message ?? error) });
            }
        };

        log?.info?.('bilibili referer guard installed', { hosts: MEDIA_URL_FILTERS.length });
    } catch (error) {
        // 装不上也不该让整个模组失效：搜索和歌词还能用，只是音频会 403
        log?.warn?.('failed to install bilibili referer guard', { message: String(error?.message ?? error) });
    }

    return () => detach?.();
};

module.exports = activate;
// 导出给测试用（test/03-contract.mjs）
module.exports.needsRefererRewrite = needsRefererRewrite;
module.exports.applyBilibiliReferer = applyBilibiliReferer;
module.exports.isBilibiliCdn = isBilibiliCdn;
module.exports.MEDIA_URL_FILTERS = MEDIA_URL_FILTERS;
module.exports.BILIBILI_REFERER = BILIBILI_REFERER;
