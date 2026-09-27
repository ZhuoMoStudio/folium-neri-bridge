// lib/self-check.mjs
//
// 自检：把「只有装了真 Folia 的人才能确认」的几件事，变成一条命令的输出。
//
// 背景：契约层的东西都已经验过（上游 manifest.cjs + 打桩宿主，见 test/03-contract.mjs），
// 但下面三件事在无显示器的沙盒里**永远验不了**，而它们恰好是最容易出错的地方：
//   1. `webRequest.onBeforeSendHeaders` 监听器在真 Electron 里到底挂上没挂上；
//   2. `<audio src=CDN 直链>` 是不是真能播（防盗链改写的最终目的）；
//   3. 逐字歌词在真宿主里是否真的走到了渲染。
// 前两件这层能自动判，第三件只能靠人看（见 VERIFY.md）。所以这里输出结构化结果，
// 让人 5 分钟能确认完，而不是让别人照着日志猜。
//
// 这一层刻意做成「注入副作用」的形状：DOM 与网络都由调用方传进来，
// 于是事件接线、超时、错误码映射这些容易错的部分可以在没有宿主的环境里测（test/10）。
//
// 判据来自实测，不是猜的：
//   - `folium.net.fetch` 在**主进程里用 Node 全局 fetch**（modSystem.cjs 的
//     invokeModNetFetch），不经过 Chromium 的会话，所以 Referer 监听器碰不到它 ——
//     这个探针必须自己带 Referer，它证明的是「直链本身还活着、CDN 认这个 Range」。
//   - 真正证明监听器生效的是 `<audio>` 那一行：它走 Chromium 会话，
//     而命令会在探测前后各读一次监听器的改写计数，计数涨了就说明监听器确实在干活。

/** 与 index.cjs 里改写用的 UA 保持一致：接口与 CDN 都对 UA 敏感。 */
export const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const BILIBILI_REFERER = 'https://www.bilibili.com/';

/**
 * Range 取前 1KB。
 *
 * 必须带 Range：`folium.net.fetch` 有 5MB 的响应体上限（NET_FETCH_LIMITS.maxBodyBytes），
 * 而一首歌的音频是几十 MB，不带 Range 的探测会以 `net-body-too-large` 结束，
 * 然后被误读成「CDN 坏了」。
 */
export const RANGE_PROBE_HEADER = 'bytes=0-1023';

/** `<audio>` 元素的探测预算。超过就当作超时（不是失败，是「不知道」）。 */
export const AUDIO_PROBE_TIMEOUT_MS = 10000;

/** MediaError.code 的名字。宿主里只会看到数字，翻译在这里做。 */
const MEDIA_ERROR_NAMES = {
    1: 'MEDIA_ERR_ABORTED（加载被中止）',
    2: 'MEDIA_ERR_NETWORK（网络中断；防盗链被拒通常是这个或 4）',
    3: 'MEDIA_ERR_DECODE（解码失败）',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED（源不可用 —— 403 / 格式不对时最常见的一个）',
};

/** 状态 → 输出前缀。宽度固定，方便人眼扫。 */
const STATUS_TAG = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]', skip: '[skip]' };

/**
 * 直链 Range 探测（走调用方给的 fetcher，通常是 `folium.net.fetch`）。
 * 不抛错：失败也返回一个可展示的结果。
 */
export const probeStreamRange = async ({ url, cookie, fetchImpl, timeoutMs = 10000 } = {}) => {
    if (typeof url !== 'string' || !url) return { ok: false, error: 'no-url' };
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'no-fetch' };
    const startedAt = Date.now();
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            timeoutMs,
            headers: {
                'User-Agent': WEB_UA,
                Referer: BILIBILI_REFERER,
                Range: RANGE_PROBE_HEADER,
                ...(cookie ? { Cookie: cookie } : {}),
            },
        });
        // folium.net.fetch 失败时会抛，所以这里能拿到 response 就是 HTTP 层的答案
        return {
            ok: true,
            status: Number(response?.status) || 0,
            contentRange: response?.headers?.['content-range'] ?? null,
            ms: Date.now() - startedAt,
        };
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error), ms: Date.now() - startedAt };
    }
};

/**
 * `<audio>` 元素探测。这是唯一能证明「防盗链改写 + 播放器路径」通了的一步。
 *
 * @param createAudio 返回一个 MediaElement 形状的对象（有 addEventListener / src / load / removeAttribute）。
 *                    真实调用方传 `() => new Audio()`；测试传假的。
 */
export const probeAudioElement = ({ url, createAudio, timeoutMs = AUDIO_PROBE_TIMEOUT_MS } = {}) =>
    new Promise((resolve) => {
        if (typeof url !== 'string' || !url) {
            resolve({ outcome: 'unsupported', error: 'no-url' });
            return;
        }
        if (typeof createAudio !== 'function') {
            resolve({ outcome: 'unsupported', error: 'no-dom' });
            return;
        }
        let element;
        try {
            element = createAudio();
        } catch (error) {
            resolve({ outcome: 'unsupported', error: String(error?.message ?? error) });
            return;
        }
        if (!element || typeof element.addEventListener !== 'function') {
            resolve({ outcome: 'unsupported', error: 'not-a-media-element' });
            return;
        }

        const startedAt = Date.now();
        let settled = false;
        let timer = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            try {
                element.removeEventListener?.('loadedmetadata', onLoaded);
                element.removeEventListener?.('error', onError);
                // 释放这一份媒体资源，别让探测本身占着一条连接
                element.removeAttribute?.('src');
                element.load?.();
            } catch {
                // 清理失败不影响结论
            }
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            const result = { ...value, ms: Date.now() - startedAt };
            cleanup();
            resolve(result);
        };
        const onLoaded = () =>
            finish({ outcome: 'metadata', durationMs: Number(element.duration) * 1000 || 0, readyState: element.readyState });
        const onError = () =>
            finish({ outcome: 'error', errorCode: element.error?.code ?? null, errorMessage: element.error?.message ?? null });

        element.addEventListener('loadedmetadata', onLoaded, { once: true });
        element.addEventListener('error', onError, { once: true });

        timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);

        try {
            element.preload = 'metadata';
            element.src = url;
            element.load?.();
        } catch (error) {
            finish({ outcome: 'unsupported', error: String(error?.message ?? error) });
        }
    });

/* ------------------------------------------------------------------ 结论 */

const section = (id, label, status, detail) => ({ id, label, status, detail });

const describeHost = (host) => {
    const version = host?.folium ? `folium ${host.folium.major}.${host.folium.minor}` : 'folium 版本未知';
    const folia = host?.folia ? `folia ${host.folia}` : 'folia 版本未知';
    const context = host?.context ? `context ${host.context}` : 'context 未知';
    return `${version} / ${folia} / ${context}`;
};

const contractSection = (host) => {
    const surfaces = host?.surfaces ?? {};
    const missing = [];
    if (surfaces.providers !== true) missing.push('omni.providers');
    if (surfaces.hooks !== true) missing.push('omni.hooks');
    const detail = missing.length === 0
        ? '实验接口 omni.providers + omni.hooks 都在（清单里声明过）'
        : `缺 ${missing.join(' / ')} —— 要么宿主没给，要么 mod.json 的 experimental 没声明`;
    if (surfaces.providers !== true) return section('contract', '契约版本', 'fail', detail);
    // omni.hooks 缺失只影响逐字歌词，LRC 回退照常 —— 所以是 warn 不是 fail
    return section('contract', '契约版本', missing.length === 0 ? 'ok' : 'warn', detail);
};

const refererSection = (referer) => {
    // 主进程没回答（rpc 不可用、或 diagnose 抛了）：这条要单独说清楚，
    // 否则会被读成「监听器装失败了」，而实际是根本没问到
    if (!referer) {
        return section(
            'referer',
            'Referer 监听器',
            'fail',
            '主进程没有回答（bili.diagnose 不可用）：拿不到监听器状态，CDN 直链会不会被 403 也无从判断',
        );
    }
    const state = referer.state;
    const rewrites = Number(referer.rewrites) || 0;
    if (state === 'installed') {
        const host = referer.lastRewriteHost ? `；最近改写 ${referer.lastRewriteHost}` : '';
        return section('referer', 'Referer 监听器', 'ok', `已装上（本次会话改写 ${rewrites} 次${host}）`);
    }
    if (state === 'unavailable') {
        return section(
            'referer',
            'Referer 监听器',
            'fail',
            `没装上：Electron 的 session.defaultSession.webRequest 不可用 ⇒ CDN 直链在 Folia 的页面来源下会 403`,
        );
    }
    if (state === 'failed') {
        return section('referer', 'Referer 监听器', 'fail', `装上失败：${referer.error ?? 'unknown'}`);
    }
    return section('referer', 'Referer 监听器', 'warn', `主进程回了，但状态不认识：${JSON.stringify(state ?? null)}`);
};

const sessionSection = (session) => {
    if (!session?.ok) return section('session', '登录态', 'warn', `读不到：${session?.error ?? 'unknown'}`);
    const quality = session.quality;
    const cap = quality?.capped ? '音质受限' : '音质按账号权限';
    const who = session.loggedIn ? `已登录（uid ${session.session?.userId ?? '?'}${session.session?.hasCsrf ? '' : '，缺 bili_jct'}）` : '未登录';
    return section('session', '登录态', session.loggedIn ? 'ok' : 'warn', `${who}；${cap}：${quality?.message ?? '（无说明）'}`);
};

const wordTimingSection = (wordTiming) => {
    if (!wordTiming) {
        return section('words', '逐字歌词索引', 'warn', 'omni.hooks 不可用，逐字歌词整条链路已降级（LRCLIB 行级歌词不受影响）');
    }
    if (!wordTiming.available) {
        return section('words', '逐字歌词索引', 'warn', '本地没有索引缓存，也没有取到；下一次播放会重试（要联网拉 1.6MB）');
    }
    const source = wordTiming.source === 'memory' ? '内存' : '数据文件';
    const age = Number.isFinite(wordTiming.ageMs) ? `，${Math.round(wordTiming.ageMs / 3600000)} 小时前更新` : '';
    const size = Number.isFinite(wordTiming.bytes) && wordTiming.bytes > 0
        ? `，约 ${Math.round(wordTiming.bytes / 1024)}KB（数据文件上限 1024KB）`
        : '';
    return section('words', '逐字歌词索引', 'ok', `可用（${source}）：${wordTiming.entries ?? 0} 条${size}${age}`);
};

const mediaSections = (media) => {
    const sections = [];
    const target = media?.requestedId ?? null;
    if (!target) {
        const why = media?.streamError ? `（取流失败：${media.streamError}）` : '';
        sections.push(
            section(
                'range',
                'CDN 直链 Range',
                'skip',
                `没有可探测的目标${why}：先播一首 B 站的歌，或给命令一个 bili:BV... 参数`,
            ),
        );
        sections.push(section('audio', '<audio> 播放', 'skip', '同上：没有目标就无从探测'));
        return sections;
    }

    // 取流这一步就失败了（cid 解析不了 / playurl 非 0）：两条探测根本没跑，
    // 说清楚是哪一步断的，别让它显示成「Range 请求失败：unknown」
    if (media?.streamError) {
        sections.push(section('range', 'CDN 直链 Range', 'fail', `取流失败，探测没跑起来：${media.streamError}`));
        sections.push(section('audio', '<audio> 播放', 'skip', '取流失败，没有地址可探'));
        return sections;
    }

    // ---- Range
    const range = media?.range;
    if (!range?.ok) {
        sections.push(section('range', 'CDN 直链 Range', 'fail', `请求失败：${range?.error ?? 'unknown'}`));
    } else if (range.status === 206) {
        sections.push(
            section('range', 'CDN 直链 Range', 'ok', `HTTP 206${range.contentRange ? `（${range.contentRange}）` : ''} · ${range.ms}ms`),
        );
    } else if (range.status === 200) {
        sections.push(section('range', 'CDN 直链 Range', 'warn', `HTTP 200：服务端忽略了 Range（能播，但探测没拿到 206） · ${range.ms}ms`));
    } else if (range.status === 403) {
        sections.push(section('range', 'CDN 直链 Range', 'fail', 'HTTP 403：这个直链已被拒 —— 要么过期了（deadline），要么 Referer/Cookie 不对'));
    } else {
        sections.push(section('range', 'CDN 直链 Range', 'fail', `HTTP ${range.status}（既不是 206 也不是 200）`));
    }

    // ---- <audio>：唯一能证明监听器生效的一步
    const audio = media?.audio;
    if (audio?.outcome === 'metadata') {
        sections.push(
            section('audio', '<audio> 播放', 'ok', `拿到元数据（时长 ${Math.round((audio.durationMs ?? 0) / 1000)}s） · ${audio.ms}ms ← 这一步走 Chromium 会话，成功即证明防盗链改写通了`),
        );
    } else if (audio?.outcome === 'error') {
        const name = MEDIA_ERROR_NAMES[audio.errorCode] ?? `未知错误码 ${audio.errorCode}`;
        sections.push(section('audio', '<audio> 播放', 'fail', `MediaError ${audio.errorCode}：${name}`));
    } else if (audio?.outcome === 'timeout') {
        sections.push(section('audio', '<audio> 播放', 'warn', `${AUDIO_PROBE_TIMEOUT_MS}ms 内既没 metadata 也没 error：可能是网络慢，重跑一次再看`));
    } else {
        sections.push(section('audio', '<audio> 播放', 'skip', `这个环境里没有 DOM/音频元素（${audio?.error ?? 'unknown'}），只能在主窗口跑`));
    }

    // ---- 监听器改写计数：<audio> 探测前后各读一次，涨了就说明监听器确实在干活
    const before = Number(media?.rewritesBefore);
    const after = Number(media?.rewritesAfter);
    if (Number.isFinite(before) && Number.isFinite(after)) {
        const delta = after - before;
        sections.push(
            delta > 0
                ? section('rewrite', '监听器实测', 'ok', `<audio> 探测期间改写计数 ${before} → ${after}（+${delta}）⇒ webRequest 监听器确实拦到了这个请求`)
                : section('rewrite', '监听器实测', 'warn', `改写计数没动（${before} → ${after}）：<audio> 要么根本没发出请求，要么没被监听器拦到 —— 逐字歌词之外，播放本身也会 403`),
        );
    }

    return sections;
};

/**
 * 事实 → 结论。**纯函数**：输入里没有任何东西会自己动。
 *
 * @param facts.host        { folium, folia, context, surfaces: { providers, hooks } }
 * @param facts.referer     index.cjs 的 bili.diagnose 返回的 referer 段
 * @param facts.session     index.cjs 的 bili.session.status 的返回值
 * @param facts.wordTiming  amll.stats() 的返回值（null 表示 omni.hooks 不可用）
 * @param facts.media       见 mediaSections
 * @returns {{ sections: object[], message: string, warnings: string[] }}
 */
export const summarizeSelfCheck = (facts = {}) => {
    const sections = [
        contractSection(facts.host),
        refererSection(facts.referer),
        sessionSection(facts.session),
        ...mediaSections(facts.media),
        wordTimingSection(facts.wordTiming),
    ];

    const failures = sections.filter((entry) => entry.status === 'fail');
    const warnings = sections.filter((entry) => entry.status === 'warn');
    const skips = sections.filter((entry) => entry.status === 'skip');
    const verdict = failures.length > 0
        ? `${failures.length} 项失败 —— 看下面带 [fail] 的行，那是真的挡住了功能`
        : warnings.length > 0
            ? `没有失败项；${warnings.length} 项需要留意（[warn]）`
            : '全部通过';

    const lines = [
        `folium-neri-bridge 自检 · ${describeHost(facts.host)}`,
        ...sections.map((entry) => `${STATUS_TAG[entry.status] ?? '[????]'} ${entry.label}：${entry.detail}`),
        `结论：${verdict}${skips.length > 0 ? `（另有 ${skips.length} 项跳过）` : ''}`,
    ];

    return {
        sections,
        message: lines.join('\n'),
        // 宿主的命令卡片会把 warnings 单独列出来，把要留意的那几行放进去
        warnings: [...failures, ...warnings].map((entry) => `${entry.label}：${entry.detail}`),
    };
};

/** 日志用的短摘要（一行）。 */
export const summarizeSelfCheckBriefly = (report) =>
    (report?.sections ?? [])
        .map((entry) => `${entry.id}=${entry.status}`)
        .join(' ');

/* ------------------------------------------------- 「列出分 P」命令的输出 */

/**
 * 分 P 列表 → 可读文本。纯函数，离线可测。
 *
 * 为什么要有这个命令：多 P 视频的分 P 本来是「粘 BV 号进搜索框」才看得到
 * （见 providers/bilibili.mjs 的 searchVideoRef），而在搜索框里粘一个 250 P 的
 * 合集，你会得到 250 条结果。命令面板里能先看一眼再决定，体验好得多。
 */
export const formatPartList = (songs, { limit = 12 } = {}) => {
    const items = Array.isArray(songs) ? songs : [];
    if (items.length === 0) return '没拿到分 P：BV 号不对，或者这个稿件没有可播放的分 P。';

    const shown = items.slice(0, limit);
    const lines = [
        `共 ${items.length} 个分 P${items.length > shown.length ? `（只列前 ${shown.length} 个）` : ''}`,
        ...shown.map((song, index) => {
            const seconds = Math.round((Number(song?.durationMs) || 0) / 1000);
            const duration = seconds > 0
                ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                : '?:??';
            return `${String(index + 1).padStart(2, ' ')}. ${duration}  ${song?.title ?? ''}\n    ${song?.id ?? ''}`;
        }),
    ];
    if (items.length > shown.length) {
        lines.push(`……另有 ${items.length - shown.length} 个分 P 未列出：把 BV 号粘进搜索框可以逐条点播。`);
    } else {
        lines.push('把任意一行末尾的 id 或 BV 号粘进搜索框即可点播。');
    }
    return lines.join('\n');
};
