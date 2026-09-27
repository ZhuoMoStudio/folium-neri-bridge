// lib/http.mjs
//
// folium.net.fetch 的一层薄封装。三个原则：
//   1. 不抛错。provider 的方法每抛一次，用户看到的就是一次搜索失败或一首歌放不了；
//      provider 侧的失败应该退化成空列表或 null。
//   2. 日志里的 URL 不写全。B 站的取流地址带着 upsig/deadline，写进日志等于把它扩散出去。
//   3. 请求头由调用方按平台给，这里只负责超时与解析。

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;

/** 日志用的安全 URL：只留 origin + path。 */
export const redactUrl = (url) => {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return '[unparsable-url]';
    }
};

export const createHttp = (folium, log) => {
    const send = async (url, init = {}) => {
        const timeoutMs = Math.min(Number(init.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        try {
            return await folium.net.fetch(url, { ...init, timeoutMs });
        } catch (error) {
            log?.warn?.('fetch failed', {
                url: redactUrl(url),
                message: String(error?.message ?? error),
            });
            return null;
        }
    };

    return {
        /** 返回解析好的对象，任何一步失败都返回 null。 */
        async json(url, init) {
            const response = await send(url, init);
            if (!response) return null;
            if (!response.ok) {
                log?.info?.('non-2xx response', { url: redactUrl(url), status: response.status });
                return null;
            }
            try {
                return JSON.parse(response.text());
            } catch {
                log?.warn?.('response is not valid JSON', { url: redactUrl(url) });
                return null;
            }
        },

        /** 返回响应正文，失败返回 null。 */
        async text(url, init) {
            const response = await send(url, init);
            if (!response?.ok) return null;
            return response.text();
        },
    };
};
