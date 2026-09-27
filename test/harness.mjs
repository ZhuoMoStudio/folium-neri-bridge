// test/harness.mjs
//
// 把 Node 的 fetch 适配成宿主 FoliumFetchResponse 的形状，这样 lib/ 与 providers/ 里
// 的代码可以一行不改地在宿主之外跑起来。
//
// 这不是模拟：请求打到真实的 B 站与 LRCLIB。模组里唯一被替换掉的是「谁去发这个请求」。

/** FoliumFetchResponse: { ok, status, statusText, headers, text(), json() } */
export const createFakeFolium = () => {
    const calls = [];

    const log = {
        info: (message, details) => console.log(`    · ${message}`, details ?? ''),
        warn: (message, details) => console.log(`    ! ${message}`, details ?? ''),
        error: (message, details) => console.log(`    ✗ ${message}`, details ?? ''),
    };

    const netFetch = async (url, init = {}) => {
        const startedAt = Date.now();
        const response = await fetch(url, {
            method: init.method ?? 'GET',
            headers: init.headers,
            body: init.body,
            redirect: 'follow',
        });
        const text = await response.text();
        calls.push({ url, status: response.status, ms: Date.now() - startedAt });

        const headers = {};
        response.headers.forEach((value, name) => {
            headers[name] = value;
        });

        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            text: () => text,
            json: () => JSON.parse(text),
        };
    };

    return { folium: { log, net: { fetch: netFetch } }, calls };
};

export const results = [];

export const check = (label, passed, detail) => {
    results.push({ label, passed, detail });
    const mark = passed ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${label}${detail ? `  — ${detail}` : ''}`);
    return passed;
};

export const summary = () => {
    const failed = results.filter((entry) => !entry.passed);
    console.log('');
    console.log('='.repeat(72));
    console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    for (const entry of failed) console.log(`  FAIL  ${entry.label}  ${entry.detail ?? ''}`);
    console.log('='.repeat(72));
    return failed.length;
};
