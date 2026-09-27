// client.mjs
//
// 模组的渲染端入口。注册四样东西：
//   - 音源（通过实验接口 omni.providers，不在 registries 下）
//   - 逐字歌词的 omni.lyricsResolved 钩子（实验接口 omni.hooks）
//   - 两个设置面板，管 B 站登录态与音源开关
//   - 几个命令，方便从命令面板直接触发
//
// 登录态只有一份，存在主进程侧的 storage 里（与 main 入口共用同一个数据文件）。
// 渲染端只读它，用来给请求带 Cookie；真正的读写都由 main 入口做，
// 因为只有 Node 侧的 headers.getSetCookie() 能可靠拿到多个 Set-Cookie。

import { shiftLyricLines } from './lib/lyric-align.mjs';
import { createWordTimingRelay, planWordTimingInstall } from './lib/word-timing.mjs';
import { createHttp } from './lib/http.mjs';
import { formatPartList, probeAudioElement, probeStreamRange, summarizeSelfCheck, summarizeSelfCheckBriefly } from './lib/self-check.mjs';
import { parseVideoRef } from './lib/bili-video-ref.mjs';
import { createBilibiliProvider } from './providers/bilibili.mjs';
import { createAmllBackend } from './providers/lyrics/amll.mjs';
import { createLrclibBackend } from './providers/lyrics/lrclib.mjs';
import { createYoutubeProvider } from './providers/youtube.mjs';

const MOD_ID = 'neri-bridge';
const BILIBILI_PROVIDER_NAME = 'bilibili';
/**
 * 宿主给外部 provider 的 id 前缀。
 * `omniProviders.ts` 的 `foliumProviderId(id) = `folium.${id.replace(':', '.')}``，
 * 而注册用的是 `neri-bridge:bilibili`，所以这里的 providerId 是 `folium.neri-bridge.bilibili`。
 * 注册句柄的 `id` 是 `neri-bridge:bilibili`（没有 folium. 前缀），别拿它来比。
 */
const BILIBILI_PROVIDER_ID = `folium.${MOD_ID}.${BILIBILI_PROVIDER_NAME}`;
const SONG_ID_PREFIX = 'bili:';
const YOUTUBE_SONG_ID_PREFIX = 'yt:';
const COOKIE_STORAGE_KEY = 'bilibiliCookie';
const LOGIN_WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

const LABEL = (zh, en) => ({ 'zh-CN': zh, en });

const call = async (folium, name, ...args) => {
    try {
        return await folium.rpc.call(name, ...args);
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
    }
};

const toast = (folium, message, type = 'info') => {
    try {
        folium.ui?.toast?.(message, { type });
    } catch {
        // 导出窗口里 ui 不可用，忽略
    }
};

/** 设置面板：状态 + 按钮 + 手动粘贴。用原生 DOM 画，模组拿不到宿主的组件库。 */
const mountLoginPanel = (folium, container, ctx, refreshProviderSession) => {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:4px 0;font-size:13px;';

    const status = document.createElement('div');
    status.textContent = '读取登录态…';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    const button = (text, onClick) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = text;
        element.style.cssText =
            'padding:4px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font-size:12px;';
        element.addEventListener('click', () => {
            element.disabled = true;
            Promise.resolve(onClick()).finally(() => {
                element.disabled = false;
            });
        });
        return element;
    };

    const paste = document.createElement('textarea');
    paste.rows = 3;
    paste.placeholder = '也可以直接粘贴：SESSDATA=…; bili_jct=…; DedeUserID=…';
    paste.style.cssText =
        'width:100%;font-family:ui-monospace,monospace;font-size:11px;padding:6px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;resize:vertical;';

    let pollTimer = null;
    const stopPolling = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
    };

    const render = async () => {
        const state = await call(folium, 'bili.session.status');
        if (!state?.ok) {
            status.textContent = `登录态读取失败：${state?.error ?? 'unknown'}`;
            return;
        }
        // 音质上限跟着登录态一起显示：以前它只写在日志里，用户看到的是
        // 「库里明明是 192K 的条目却放不出更高的档」，只会以为是模组的问题。
        const quality = state.quality?.message;
        status.textContent = state.loggedIn
            ? `已登录（uid ${state.session?.userId ?? '?'}${state.session?.hasCsrf ? '' : '，缺 bili_jct'}）${quality ? ` · ${quality}` : ''}`
            : `未登录 — ${quality ?? '未登录也能搜索与播放，但部分音质与会员内容不可用'}`;
    };

    const startPolling = () => {
        stopPolling();
        const startedAt = Date.now();
        pollTimer = setInterval(async () => {
            if (Date.now() - startedAt > LOGIN_WINDOW_TIMEOUT_MS) {
                stopPolling();
                toast(folium, '登录窗口等待超时', 'error');
                return;
            }
            const state = await call(folium, 'bili.session.status');
            if (state?.loggedIn) {
                stopPolling();
                await refreshProviderSession();
                await render();
                toast(folium, 'Bilibili 登录成功', 'success');
            }
        }, 2000);
    };

    row.append(
        button('打开登录窗口', async () => {
            const result = await call(folium, 'bili.login.openWindow');
            if (!result?.ok) {
                toast(folium, `打开失败：${result?.error ?? 'unknown'}`, 'error');
                return;
            }
            toast(folium, '在弹出的窗口里登录，成功后会自动收起', 'info');
            startPolling();
        }),
        button('从应用会话读取', async () => {
            const result = await call(folium, 'bili.session.read');
            if (!result?.ok) {
                toast(folium, `未读到登录态：${result?.error ?? 'unknown'}`, 'error');
                return;
            }
            await refreshProviderSession();
            await render();
            toast(folium, '已导入登录态', 'success');
        }),
        button('应用粘贴内容', async () => {
            const text = paste.value.trim();
            if (!text) {
                toast(folium, '先粘贴 Cookie', 'error');
                return;
            }
            const result = await call(folium, 'bili.session.set', text);
            if (!result?.ok) {
                toast(folium, `无效：${result?.error ?? 'unknown'}`, 'error');
                return;
            }
            paste.value = '';
            await refreshProviderSession();
            await render();
            toast(folium, '登录态已保存', 'success');
        }),
        button('退出登录', async () => {
            stopPolling();
            await call(folium, 'bili.session.clear');
            await refreshProviderSession();
            await render();
            toast(folium, '已清除登录态', 'info');
        }),
    );

    root.append(status, row, paste);
    container.appendChild(root);

    // 面板一打开就把应用会话里的登录态认过来（可在设置里关掉）
    const autoImport = ctx?.params?.get?.()?.autoImportOnOpen !== false;
    (async () => {
        if (autoImport) {
            const result = await call(folium, 'bili.session.read');
            if (result?.ok) {
                await refreshProviderSession();
                toast(folium, '已从应用会话导入登录态', 'success');
            }
        }
        await render();
    })();

    return () => {
        stopPolling();
        root.remove();
    };
};

export default function activate(folium) {
    const log = folium.log;
    const omniProviders = folium.experimental?.['omni.providers'];

    if (!omniProviders?.register) {
        log?.error?.('omni.providers is unavailable; check the manifest experimental list');
        return undefined;
    }
    if (!folium.net?.fetch) {
        log?.error?.('net.fetch is unavailable; the net.fetch permission is required');
        return undefined;
    }

    // 渲染端缓存一份 Cookie，供 provider 发请求时同步读取（provider 的方法是 async 的，
    // 但每次 await 一次 storage 没必要，改动由 refreshProviderSession 推进来）
    let cookieHeader = '';
    const refreshProviderSession = async () => {
        try {
            const stored = await folium.storage?.get?.(COOKIE_STORAGE_KEY);
            cookieHeader = typeof stored === 'string' ? stored : '';
        } catch (error) {
            log?.warn?.('failed to read stored session', { message: String(error?.message ?? error) });
            cookieHeader = '';
        }
    };

    const http = createHttp(folium, log);
    const lrclib = createLrclibBackend(http);

    // ------------------------------------------------------------ 逐字歌词
    //
    // 分两半，中间靠 relay 传递，原因是宿主的时间预算：
    //   - provider 的 getLyrics：没有预算限制，**联网取 TTML 在这一步做完**；
    //   - omni.lyricsResolved 钩子：每个处理器只有 1500ms（events.ts 的 ASYNC_TIMEOUT_MS），
    //     超时后对 event.lines 的赋值不再生效 —— 所以钩子里只做内存查表与换算。
    //
    // omni.hooks 是实验接口，没声明就拿不到；拿不到时整个逐字链路降级掉（不报错），
    // LRC 回退照常工作。
    const amll = createAmllBackend({ http, log, storage: folium.storage });
    const wordTimingRelay = createWordTimingRelay();
    const omniHooks = folium.experimental?.['omni.hooks'];
    const wordTiming = omniHooks?.on
        ? {
            /** 预热索引：在取流时顺手触发，和播放启动的耗时重叠。 */
            warm() {
                void amll.warm();
            },
            /** 取逐字歌词并放进 relay。查不到也记一条空条目，钩子那边就不再重复问。 */
            async prepare({ key, title, artists, durationMs }) {
                if (!key) return;
                const found = await amll.lookup({ title, artists, durationMs });
                wordTimingRelay.put(
                    key,
                    found
                        ? // titleScore 也带上：钩子在「没有参照时轴」的情况下要用它判断
                          // 这份逐字歌词是否可信（见 lib/word-timing.mjs 里的规则）
                          { lines: found.lines, source: found.source, titleScore: found.titleScore }
                        : { lines: [] },
                );
            },
        }
        : null;

    const provider = createBilibiliProvider({
        http,
        lrclib,
        log,
        getCookie: () => cookieHeader,
        wordTiming,
    });

    const disposers = [];
    const handle = omniProviders.register(provider);
    log?.info?.(`${MOD_ID}: registered provider ${handle?.id ?? provider.id}`);

    if (wordTiming) {
        try {
            const disposeHook = omniHooks.on('lyricsResolved', (event) => {
                const songId = typeof event?.song?.id === 'string' ? event.song.id : '';
                // 只处理本模组的歌：其它来源（本地、内置在线源）的歌词不归这里管。
                // source 是宿主加的 `folium.<modid>.<name>`，id 前缀则是我们自己拼的，两重都认。
                const isOurs =
                    event?.song?.source === BILIBILI_PROVIDER_ID ||
                    songId.startsWith(SONG_ID_PREFIX) ||
                    songId.startsWith(YOUTUBE_SONG_ID_PREFIX);
                if (!isOurs) return;

                const cached = wordTimingRelay.take(songId);
                if (!cached?.lines?.length) return;

                // 宿主可能已经给了逐字（例如别的模组先动过手），那就别覆盖
                const alreadyWordTimed = (Array.isArray(event.lines) ? event.lines : []).some((line) =>
                    (line?.words ?? []).some((word) => (word?.syllables?.length ?? 0) > 1),
                );
                if (alreadyWordTimed) return;

                // 装不装、偏多少，全交给这个纯函数判（规则与理由见 lib/word-timing.mjs）
                const plan = planWordTimingInstall({
                    referenceLines: event.lines,
                    candidateLines: cached.lines,
                    titleScore: cached.titleScore ?? 0,
                });
                if (!plan.install) {
                    log?.info?.(`${MOD_ID}: word-by-word lyrics skipped`, {
                        reason: plan.reason,
                        referenceLines: Array.isArray(event.lines) ? event.lines.length : 0,
                        candidateLines: cached.lines.length,
                        titleScore: cached.titleScore ?? 0,
                    });
                    return;
                }

                event.lines = shiftLyricLines(cached.lines, plan.offset ?? 0);
                log?.info?.(`${MOD_ID}: word-by-word lyrics installed`, {
                    lines: event.lines.length,
                    offsetMs: Math.round((plan.offset ?? 0) * 1000),
                    aligned: plan.aligned === true,
                    titleScore: cached.titleScore ?? 0,
                    source: cached.source,
                });
            });
            disposers.push(() => disposeHook?.());
        } catch (error) {
            log?.warn?.('failed to register the omni.lyricsResolved hook', { message: String(error?.message ?? error) });
        }
    } else {
        log?.warn?.('omni.hooks is unavailable; word-by-word lyrics are disabled (LRC fallback still works)');
    }

    // 启动时先把登录态读进来，免得第一首歌漏带 Cookie
    refreshProviderSession();

    /** 设置分区。两个：登录一个、音源开关一个。注册句柄的 params 能直接读值。 */
    /** @type {{ params?: { get?: () => Record<string, unknown> } } | null} */
    let sourcesSection = null;
    try {
        const section = folium.registries.settingsSections.register({
            id: 'bilibili-login',
            label: LABEL('Bilibili 登录', 'Bilibili login'),
            description: LABEL(
                '登录后可用更高音质与会员内容。登录态只保存在本机。',
                'Sign in for higher quality. The session stays on this machine.',
            ),
            settings: [
                {
                    key: 'autoImportOnOpen',
                    type: 'boolean',
                    label: LABEL('打开面板时自动认领会话', 'Adopt the app session on open'),
                    description: LABEL(
                        '如果你已经在别处用 Folia 登录过 B 站，展开这个面板就会把那份登录态认过来。',
                        'Reuse a Bilibili session that already exists in the app.',
                    ),
                    defaultValue: true,
                },
            ],
            settingsPanel: (container, ctx) =>
                mountLoginPanel(folium, container, ctx, refreshProviderSession),
        });
        disposers.push(() => section?.unregister?.());
    } catch (error) {
        log?.warn?.('failed to register settings section', { message: String(error?.message ?? error) });
    }

    try {
        sourcesSection = folium.registries.settingsSections.register({
            id: 'sources',
            label: LABEL('音源', 'Sources'),
            description: LABEL(
                '逐字歌词与额外音源的开关。Bilibili 逐字歌词来自 AMLL TTDB（CC0）。',
                'Word-by-word lyrics and extra sources. Bilibili word timing comes from AMLL TTDB (CC0).',
            ),
            settings: [
                {
                    key: 'enableYoutube',
                    type: 'boolean',
                    label: LABEL('启用 YouTube Music 搜索', 'Enable YouTube Music search'),
                    description: LABEL(
                        '只提供搜索与元数据：匿名 InnerTube 拿不到播放地址（需要 PO Token），所以这些歌放不了。默认关闭。改动需要重新启用模组才生效。',
                        'Search and metadata only: anonymous InnerTube returns no playback URL (PO Token required), so these songs cannot play. Off by default; re-enable the mod after changing.',
                    ),
                    defaultValue: false,
                },
            ],
        });
        disposers.push(() => sourcesSection?.unregister?.());
    } catch (error) {
        log?.warn?.('failed to register the sources settings section', { message: String(error?.message ?? error) });
    }

    // YouTube Music：匿名 InnerTube 搜索可用、匿名播放不可用（见 providers/youtube.mjs
    // 顶部的实测记录）。所以这个 provider 只声明 search / getSong / getLyrics，不声明播放，
    // 而且默认关闭 —— 一个放不了的音源出现在选择器里只会让人以为坏了。
    const youtubeEnabled = sourcesSection?.params?.get?.()?.enableYoutube === true;
    if (!youtubeEnabled) {
        log?.info?.(`${MOD_ID}: YouTube Music search is off (enable it in the mod settings)`);
    } else {
        try {
            const youtube = createYoutubeProvider({ http, log, wordTiming });
            const youtubeHandle = omniProviders.register(youtube);
            log?.info?.(`${MOD_ID}: registered provider ${youtubeHandle?.id ?? youtube.id}`);
            disposers.push(() => youtubeHandle?.unregister?.());
        } catch (error) {
            log?.warn?.('failed to register the YouTube provider', { message: String(error?.message ?? error) });
        }
    }

    // ------------------------------------------------------------------ 自检
    //
    // 这个命令要回答的，是「无显示器环境里永远验不了」的那几件事（见 lib/self-check.mjs 顶部）。
    // 主进程侧的事实走 rpc（监听器状态只有那里知道），DOM 侧的探测在这里做。
    const probeMedia = async (targetId) => {
        const before = Number((await call(folium, 'bili.diagnose'))?.referer?.rewrites);
        const stream = await provider.getAudioUrl({ id: targetId, title: '', artists: [] }, 'hires');
        if (!stream?.url) {
            return { requestedId: targetId, streamError: 'getAudioUrl 没给出地址（cid 解析不了或取流被拒）' };
        }

        // 直链 Range：走 folium.net.fetch。它在主进程里用 Node 全局 fetch，
        // **不经过 Chromium 会话**，所以防护链路的 Referer 改写碰不到它 ——
        // 这里证明的是「这条直链还活着、CDN 认这个 Range」。
        const range = await probeStreamRange({
            url: stream.url,
            cookie: cookieHeader,
            fetchImpl: (url, init) => folium.net.fetch(url, init),
        });

        // <audio>：真正的证明。它走 Chromium 会话，成功就意味着监听器确实生效了。
        const audio = await probeAudioElement({
            url: stream.url,
            createAudio: typeof Audio === 'function' ? () => new Audio() : undefined,
        });

        const after = Number((await call(folium, 'bili.diagnose'))?.referer?.rewrites);
        log?.info?.(`${MOD_ID}: self-check media probe`, {
            song: targetId,
            range: range.status ?? range.error,
            audio: audio.outcome,
            rewrites: `${before} → ${after}`,
        });
        return { requestedId: targetId, range, audio, rewritesBefore: before, rewritesAfter: after };
    };

    const runSelfCheck = async (songId) => {
        const host = folium.host ?? null;
        const diagnose = await call(folium, 'bili.diagnose');
        const session = await call(folium, 'bili.session.status');

        // 探测目标：命令参数优先，否则用当前正在播的那首（当前那首不是本模组的就跳过）
        let targetId = String(songId ?? '').trim();
        if (!targetId) {
            try {
                const state = folium.playback?.getState?.();
                const current = state?.song?.id;
                if (typeof current === 'string' && (current.startsWith(SONG_ID_PREFIX) || current.startsWith(YOUTUBE_SONG_ID_PREFIX))) {
                    targetId = current;
                }
            } catch {
                // 导出窗口或宿主未就绪时拿不到播放状态，跳过即可
            }
        } else {
            // 允许直接粘 BV 号 / 视频链接：解析成带 cid 的 id 再探测，
            // 否则 parseSongId 会把链接当成一个奇怪的 bvid
            const ref = parseVideoRef(targetId);
            if (ref) targetId = `bili:${ref.bvid}${ref.cid ? `:${ref.cid}` : ''}`;
        }

        const report = summarizeSelfCheck({
            host: {
                folium: host?.folium ?? null,
                folia: host?.folia ?? null,
                context: folium.env?.context ?? null,
                surfaces: { providers: Boolean(omniProviders?.register), hooks: Boolean(omniHooks?.on) },
            },
            referer: diagnose?.referer ?? null,
            session,
            wordTiming: amll?.stats ? await amll.stats().catch(() => null) : null,
            media: targetId ? await probeMedia(targetId) : { requestedId: null },
        });
        log?.info?.(`${MOD_ID}: self-check`, { result: summarizeSelfCheckBriefly(report) });
        return report;
    };

    const commands = [
        {
            id: 'selfcheck',
            label: LABEL('Bilibili：自检', 'Bilibili: self-check'),
            description: LABEL(
                '检查 Referer 监听器、CDN 直链、登录态与逐字歌词索引。装的模组是不是真在干活，看这一条。',
                'Checks the Referer listener, a CDN direct link, the session and the word-timing index.',
            ),
            keywords: ['bilibili', 'selfcheck', 'diagnose', '自检', '诊断'],
            params: [
                {
                    key: 'songId',
                    type: 'text',
                    label: LABEL('要探测的曲目', 'Song to probe'),
                    description: LABEL(
                        `留空则用当前正在播的歌。也可以给 BV 号、视频链接或 bili:BV…:cid —— 会取它的直链做 Range 与 <audio> 探测。`,
                        'Empty uses the current song. A BV id, a video URL or bili:BV...:cid also works.',
                    ),
                    placeholder: 'bili:BV1Ps411F7sL:53972318',
                },
            ],
            async run(ctx) {
                const report = await runSelfCheck(ctx?.values?.songId);
                return { message: report.message, warnings: report.warnings };
            },
        },
        {
            id: 'parts',
            label: LABEL('Bilibili：列出分 P', 'Bilibili: list parts'),
            description: LABEL(
                '给一个 BV 号或视频链接，列出它的每个分 P（各自的 id 与时长）。分 P 是独立曲目，粘进搜索框就能点播。',
                'Lists a video\'s parts with their ids and durations; each part is its own track.',
            ),
            keywords: ['bilibili', 'parts', '分P', '合集'],
            params: [
                {
                    key: 'video',
                    type: 'text',
                    label: LABEL('BV 号或视频链接', 'BV id or video URL'),
                    description: LABEL('例如 BV1Ps411F7sL 或 https://www.bilibili.com/video/BV1Ps411F7sL', 'e.g. BV1Ps411F7sL'),
                    defaultValue: '',
                    placeholder: 'BV1Ps411F7sL',
                },
            ],
            async run(ctx) {
                const video = String(ctx?.values?.video ?? '').trim();
                if (!video) return { message: '先给一个 BV 号或视频链接。' };
                const page = await provider.search(video, { limit: 50, offset: 0 });
                return { message: formatPartList(page?.items ?? []) };
            },
        },
        {
            id: 'login',
            label: LABEL('Bilibili：登录', 'Bilibili: sign in'),
            keywords: ['bilibili', 'login', '登录', '扫码'],
            async run() {
                const result = await call(folium, 'bili.login.openWindow');
                return { message: result?.ok ? '已打开登录窗口' : `失败：${result?.error ?? 'unknown'}` };
            },
        },
        {
            id: 'status',
            label: LABEL('Bilibili：登录状态', 'Bilibili: session status'),
            keywords: ['bilibili', 'session', '状态'],
            async run() {
                const state = await call(folium, 'bili.session.status');
                if (!state?.ok) return { message: `读取失败：${state?.error ?? 'unknown'}` };
                const who = state.loggedIn ? `已登录，uid ${state.session?.userId ?? '?'}` : '未登录';
                // 音质上限是这条命令存在的一半理由：让「未登录所以只有匿名档位」可见
                return { message: `${who}\n${state.quality?.message ?? ''}`.trim() };
            },
        },
        {
            id: 'logout',
            label: LABEL('Bilibili：退出登录', 'Bilibili: sign out'),
            keywords: ['bilibili', 'logout', '退出'],
            async run() {
                await call(folium, 'bili.session.clear');
                await refreshProviderSession();
                return { message: '已清除登录态' };
            },
        },
    ];
    for (const def of commands) {
        try {
            const commandHandle = folium.registries.commands.register(def);
            disposers.push(() => commandHandle?.unregister?.());
        } catch (error) {
            log?.warn?.('failed to register command', { id: def.id, message: String(error?.message ?? error) });
        }
    }

    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            } catch {
                // 宿主停用时也会撤下，这里失败不影响
            }
        }
        try {
            handle?.unregister?.();
        } catch (error) {
            log?.warn?.('failed to unregister provider', { message: String(error?.message ?? error) });
        }
    };
}
