// test/03-contract.mjs —— 用上游自己的代码校验契约，而不是靠人读文档
//
// 需要 Folia 源码可读：FOLIA_SRC=/path/to/folia-major-main
//
// 第 6–8 节把打桩宿主补上了实验接口与设置分区的 params，
// 于是「钩子按正确的名字注册」与「设置开关真的控制 provider 注册」也能在这里验。
// 第 9 节直接构造 main 入口（没有 electron，所以监听器一定装不上，但 rpc 注册
// 与登录态逻辑不依赖 electron）：客户端会调的每个名字都必须在那边存在。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { check, summary } from './harness.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const foliaSrc = process.env.FOLIA_SRC ?? '/workspace/extract/folia-major-main';

const manifestModulePath = join(foliaSrc, 'electron/modSystem/manifest.cjs');

console.log('\n== 1. 用 folia-major 的 validateManifest 校验 mod.json ==');
let validateManifest;
try {
    ({ validateManifest } = require(manifestModulePath));
    check('能加载上游 manifest.cjs', true, manifestModulePath);
} catch (error) {
    check('能加载上游 manifest.cjs', false, `${manifestModulePath} → ${error.message}`);
}

if (validateManifest) {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'mod.json'), 'utf8'));
    const result = validateManifest(raw);
    check('mod.json 通过上游校验', result.ok === true, result.ok ? '' : JSON.stringify(result.errors));
    if (result.ok) {
        console.log('    归一化后的清单:', JSON.stringify(result.value));
        check('permissions 被上游接受', JSON.stringify(result.value.permissions) === '["net.fetch","filesystem.data"]');
        check('experimental 含 omni.providers', result.value.experimental.includes('omni.providers'));
        check('experimental 含 omni.hooks（逐字歌词要用）', result.value.experimental.includes('omni.hooks'), JSON.stringify(result.value.experimental));
        check('main 被识别为 index.cjs', result.value.main === 'index.cjs');
        check('client 被识别为 client.mjs', result.value.client === 'client.mjs');
    }
}

console.log('\n== 2. 两个入口文件确实存在且扩展名合规 ==');
const rawManifest = JSON.parse(readFileSync(join(repoRoot, 'mod.json'), 'utf8'));
for (const field of ['main', 'client']) {
    const name = rawManifest[field];
    try {
        readFileSync(join(repoRoot, name), 'utf8');
        check(`${field} = ${name} 可读`, true);
    } catch (error) {
        check(`${field} = ${name} 可读`, false, error.message);
    }
}

console.log('\n== 3. index.cjs：Referer 改写判定 ==');
const mainEntry = require(join(repoRoot, 'index.cjs'));
const {
    needsHeaderRewrite,
    applyBilibiliHeaders,
    isBilibiliCdn,
    cookieFieldsFromTicketUrl,
    MEDIA_URL_FILTERS,
    BILIBILI_REFERER,
} = mainEntry;

check('入口导出 activate 函数', typeof mainEntry === 'function');
check('过滤域名不含 api.bilibili.com', !MEDIA_URL_FILTERS.some((f) => f.includes('api.bilibili')), JSON.stringify(MEDIA_URL_FILTERS));
check('过滤域名覆盖 bilivideo 与 akamaized', MEDIA_URL_FILTERS.some((f) => f.includes('bilivideo')) && MEDIA_URL_FILTERS.some((f) => f.includes('akamaized')));
check('常量 Referer 就是实测可用的那一个', BILIBILI_REFERER === 'https://www.bilibili.com/', BILIBILI_REFERER);

console.log('\n== 3b. isBilibiliCdn：共享域名上的精确判定 ==');
const MEDIA_URL = 'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/61/80/293298061/293298061_nb2-1-30280.m4s?deadline=1';
check('bilivideo 取流地址 → 是', isBilibiliCdn(MEDIA_URL));
check('bilivideo 上非 upgcxcode 的路径 → 仍是（域名本身专用）', isBilibiliCdn('https://upos-sz-mirrorcosov.bilivideo.com/other/path'));
check('hdslb 封面 → 是', isBilibiliCdn('https://i2.hdslb.com/bfs/archive/abc.jpg'));
check(
    'akamaized 上的 B 站取流地址 → 是',
    isBilibiliCdn('https://upos-hz-mirrorakam.akamaized.net/upgcxcode/61/80/293298061/x.m4s'),
);
check(
    'akamaized 上的无关请求 → 否（这是加路径判定的原因）',
    !isBilibiliCdn('https://some-other-service.akamaized.net/api/v1/thing'),
);
check('完全无关的域名 → 否', !isBilibiliCdn('https://example.com/upgcxcode/x'));
check('空值/非法 URL → 否', !isBilibiliCdn('') && !isBilibiliCdn('not a url'));
check('子域名混淆 akamaized.net.evil.com → 否', !isBilibiliCdn('https://akamaized.net.evil.com/upgcxcode/x'));

console.log('\n== 3c. Referer 改写（未登录）==');
// 实测规则：只有带 B 站 Referer 才在所有 CDN 上稳定 206。
// 注意「不带 Referer」是 CDN 相关的（bilivideo 上 403、akamaized 上 206），所以不能靠它。
check('已是对的值 → 不改写', !needsHeaderRewrite({ Referer: BILIBILI_REFERER }));
check('完全没有 Referer → 要改写', needsHeaderRewrite({ 'User-Agent': 'x' }));
check('Referer 为空字符串 → 要改写', needsHeaderRewrite({ Referer: '' }));
check('Referer 是 localhost → 要改写（Folia 开发模式）', needsHeaderRewrite({ Referer: 'http://localhost:3000/' }));
check('Referer 是 file:// → 要改写（Folia 生产模式）', needsHeaderRewrite({ Referer: 'file:///' }));
check('只有 Origin 没有 Referer → 要改写', needsHeaderRewrite({ Origin: 'http://localhost:3000' }));
check('已有正确 Referer 但带 Origin → 仍要改写', needsHeaderRewrite({ Referer: BILIBILI_REFERER, Origin: 'http://localhost:3000' }));
check('大小写混合的 referer 键名也认得', !needsHeaderRewrite({ referer: BILIBILI_REFERER }));
check('大小写混合的错误值也认得', needsHeaderRewrite({ REFERER: 'http://localhost:3000/' }));

const rewritten = applyBilibiliHeaders({ Referer: 'http://localhost:3000/', Origin: 'http://localhost:3000', Range: 'bytes=0-1' });
check('改写后 Referer 值正确', rewritten?.Referer === BILIBILI_REFERER);
check('改写后 Origin 被移除（它只会带来 403）', rewritten && !Object.keys(rewritten).some((k) => k.toLowerCase() === 'origin'));
check('改写后没有残留的旧 referer 键', Object.keys(rewritten ?? {}).filter((k) => k.toLowerCase() === 'referer').length === 1);
check('改写不影响其它请求头', rewritten?.Range === 'bytes=0-1');
check('无 Referer 的请求会被补上', applyBilibiliHeaders({ Range: 'bytes=0-1' })?.Referer === BILIBILI_REFERER);
check('不需要改写时返回 null（调用方跳过）', applyBilibiliHeaders({ Referer: BILIBILI_REFERER }) === null);
// 未登录时不接管浏览器原有的 Cookie —— 那里面可能带着匿名指纹 buvid3
check('未登录时不碰 Cookie', applyBilibiliHeaders({ Cookie: 'buvid3=abc' })?.Cookie === 'buvid3=abc');

console.log('\n== 3d. 登录态的注入 ==');
const SESSION = 'SESSDATA=sess; bili_jct=csrf';
check('已登录时写入 Cookie', applyBilibiliHeaders({}, SESSION)?.Cookie === SESSION);
check('已登录时覆盖浏览器原有的 Cookie', applyBilibiliHeaders({ Cookie: 'buvid3=abc' }, SESSION)?.Cookie === SESSION);
check('已登录且头都对 → 不改写', applyBilibiliHeaders({ Referer: BILIBILI_REFERER, Cookie: SESSION }, SESSION) === null);
check('已登录但 Cookie 不对 → 要改写', needsHeaderRewrite({ Referer: BILIBILI_REFERER, Cookie: 'old' }, SESSION));
check('退出登录后回到不接管 Cookie 的状态', applyBilibiliHeaders({ Cookie: 'buvid3=abc' }, '')?.Cookie === 'buvid3=abc');

console.log('\n== 3e. 2026-08 的 crossDomain 票据链接 ==');
// B 站改了登录成功响应的形状：data.url 不再是带 cookie 参数的地址，而是一个票据链接。
// 只解析查询串的实现会「报成功但存到空凭据」，所以两条路都要能被识别。
const legacy = 'https://passport.bilibili.com/login?SESSDATA=legacy_sess&bili_jct=legacy_csrf&DedeUserID=42&gourl=https%3A%2F%2Fwww.bilibili.com';
const legacyFields = cookieFieldsFromTicketUrl(legacy);
check('Legacy 链接能解析出 SESSDATA', legacyFields.get('SESSDATA') === 'legacy_sess');
check('Legacy 链接能解析出 bili_jct 与 DedeUserID', legacyFields.get('bili_jct') === 'legacy_csrf' && legacyFields.get('DedeUserID') === '42');
check('Legacy 链接里无关的参数不进字段表', !legacyFields.has('gourl'), JSON.stringify([...legacyFields.keys()]));

const ticket = 'https://passport.biligame.com/crossDomain?DedeUserID=&DedeUserID__ckMd5=&Expires=1&gourl=https%3A%2F%2Fwww.bilibili.com';
const ticketFields = cookieFieldsFromTicketUrl(ticket);
check('票据链接不会凭空造出 SESSDATA', !ticketFields.has('SESSDATA'), JSON.stringify([...ticketFields.keys()]));
check('票据链接里的空值参数也会被带出（由上层判定有效性）', ticketFields.get('DedeUserID') === '');
check('空串与非法输入不炸', cookieFieldsFromTicketUrl('').size === 0 && cookieFieldsFromTicketUrl(null).size === 0);

console.log('\n== 4. client.mjs：用打桩宿主端到端跑一遍 ==');
const { default: activate } = await import('../client.mjs');
const { createFakeFolium } = await import('./harness.mjs');

/** 打一个只记录注册调用的宿主。形状对齐 api.md 里的 FoliumRegistries 与实验接口。 */
const createStubHost = ({ settings = {}, withHooks = true } = {}) => {
    const { folium } = createFakeFolium();
    const state = {
        providers: [],
        sections: [],
        commands: [],
        unregistered: [],
        hooks: new Map(),
        calls: [],
    };
    folium.storage = {
        get: async (key) => state.calls.push(['storage.get', key]) && undefined,
        set: async (key) => state.calls.push(['storage.set', key]),
    };
    folium.ui = { toast: (message) => state.calls.push(['toast', message]) };
    folium.rpc = { call: async (name, ...args) => (state.calls.push(['rpc', name, ...args]), { ok: true, loggedIn: false }) };
    // 设置分区注册后能读到默认值合并过的 params（宿主契约如此）
    const paramsOf = (def) =>
        Object.fromEntries((def.settings ?? []).map((entry) => [entry.key, settings[entry.key] ?? entry.defaultValue]));
    folium.experimental = {
        'omni.providers': Object.freeze({
            register: (def) => {
                state.providers.push(def);
                return { id: `neri-bridge:${def.id}`, unregister: () => state.unregistered.push(`provider:${def.id}`) };
            },
        }),
        ...(withHooks
            ? {
                'omni.hooks': Object.freeze({
                    on: (type, handler, options) => {
                        state.hooks.set(type, { handler, options });
                        return () => state.hooks.delete(type);
                    },
                }),
            }
            : {}),
    };
    folium.registries = {
        settingsSections: {
            register: (def) => {
                state.sections.push(def);
                return {
                    id: `neri-bridge:${def.id}`,
                    params: { get: () => paramsOf(def) },
                    unregister: () => state.unregistered.push(`section:${def.id}`),
                };
            },
        },
        commands: {
            register: (def) => {
                state.commands.push(def);
                return { id: `neri-bridge:${def.id}`, unregister: () => state.unregistered.push(`command:${def.id}`) };
            },
        },
    };
    return { folium, state };
};

const host = createStubHost();
const dispose = activate(host.folium);
const provider = host.state.providers.find((def) => def.id === 'bilibili');

check('activate 注册了 provider', Boolean(provider));
check('provider.id 为 bilibili', provider?.id === 'bilibili', provider?.id);
check('provider 实现了 search / getSong / getAudioUrl / getLyrics',
    typeof provider?.search === 'function' && typeof provider?.getSong === 'function' &&
    typeof provider?.getAudioUrl === 'function' && typeof provider?.getLyrics === 'function');
check('注册通过 omniProvidersRegistry 的第一道校验（至少实现一个方法）', Boolean(provider?.search || provider?.getAudioUrl || provider?.getLyrics));

check('注册了设置分区', host.state.sections.length > 0, host.state.sections.map((section) => section.id).join(','));
check('设置分区的 settings 是数组（契约要求必填）', host.state.sections.every((section) => Array.isArray(section.settings)), JSON.stringify(host.state.sections.map((s) => s.settings?.map((p) => p.key))));
check('设置分区声明了 settingsPanel', host.state.sections.some((section) => typeof section.settingsPanel === 'function'));
check('每个 setting 都有 key/type/label', host.state.sections.every((section) => (section.settings ?? []).every((p) =>
    typeof p.key === 'string' && ['number', 'text', 'boolean', 'select'].includes(p.type) && p.label)));
check('Bilibili 登录分区仍在', host.state.sections.some((section) => section.id === 'bilibili-login'));
check(
    '音源分区带 YouTube 开关（默认关闭）',
    host.state.sections.find((section) => section.id === 'sources')?.settings?.some((p) => p.key === 'enableYoutube' && p.defaultValue === false),
    JSON.stringify(host.state.sections.find((section) => section.id === 'sources')?.settings?.map((p) => [p.key, p.defaultValue])),
);

check('注册了命令', host.state.commands.length > 0, host.state.commands.map((c) => c.id).join(','));
check('每个命令有 id/label/run', host.state.commands.every((c) =>
    typeof c.id === 'string' && c.label && typeof c.run === 'function'));
check('命令 id 不含冒号（宿主会自动加命名空间）', host.state.commands.every((c) => !c.id.includes(':')), host.state.commands.map((c) => c.id).join(','));
check(
    '注册了自检命令，且带一个可选的曲目参数',
    host.state.commands.some((c) => c.id === 'selfcheck' && (c.params ?? []).some((p) => p.key === 'songId' && p.type === 'text')),
    JSON.stringify(host.state.commands.find((c) => c.id === 'selfcheck')?.params?.map((p) => p.key)),
);
check(
    '注册了「列出分 P」命令，带一个视频参数',
    host.state.commands.some((c) => c.id === 'parts' && (c.params ?? []).some((p) => p.key === 'video')),
    JSON.stringify(host.state.commands.find((c) => c.id === 'parts')?.params?.map((p) => p.key)),
);
check(
    '命令的参数 schema 能被上游接受（key/type/label 齐全）',
    host.state.commands.every((c) => (c.params ?? []).every((p) =>
        typeof p.key === 'string' && ['number', 'text', 'boolean', 'select'].includes(p.type) && p.label)),
    JSON.stringify(host.state.commands.map((c) => (c.params ?? []).map((p) => [p.key, p.type]))),
);

check('activate 返回 disposer', typeof dispose === 'function');
if (typeof dispose === 'function') {
    dispose();
    check('disposer 撤下了 provider 与设置分区',
        host.state.unregistered.includes('provider:bilibili') && host.state.unregistered.some((entry) => entry.startsWith('section:')),
        JSON.stringify(host.state.unregistered));
    check('disposer 撤下了所有命令',
        host.state.commands.every((c) => host.state.unregistered.includes(`command:${c.id}`)),
        JSON.stringify(host.state.unregistered));
}

// 命令的 run() 要能在打桩宿主上跑通，否则点下去就报错
console.log('\n== 4b. 命令的 run() 能跑通 ==');
for (const command of host.state.commands) {
    try {
        const result = await command.run({});
        check(`命令 ${command.id} 返回了结果`, Boolean(result?.message), String(result?.message));
    } catch (error) {
        check(`命令 ${command.id} 返回了结果`, false, `抛错: ${error?.message ?? error}`);
    }
}

console.log('\n== 5. 缺少实验接口时应给出可读错误而不是崩掉 ==');
const bare = createFakeFolium();
let bareError = null;
bare.folium.log = { info: () => {}, warn: () => {}, error: (m) => { bareError = m; } };
const bareResult = activate(bare.folium);
check('没有 experimental 时返回 undefined', bareResult === undefined);
check('并写了一条 error 日志', typeof bareError === 'string' && bareError.includes('omni.providers'), String(bareError));

console.log('\n== 6. omni.hooks：逐字歌词的钩子 ==');
const hookHost = createStubHost();
const hookDispose = activate(hookHost.folium);
check('注册了 lyricsResolved 钩子', hookHost.state.hooks.has('lyricsResolved'), [...hookHost.state.hooks.keys()].join(','));
check('钩子的类型名恰好是合约里的那个', [...hookHost.state.hooks.keys()].every((type) => type === 'lyricsResolved'));

const hook = hookHost.state.hooks.get('lyricsResolved')?.handler;
const makeEvent = (song, lines) => ({ song, lines, isPureMusic: false });

// 别人的歌：一个字都不能改
const foreign = makeEvent({ id: 'local:1', source: 'local', title: '本地歌', artist: 'x' }, [{ startTime: 1, endTime: 2, fullText: 'a' }]);
const foreignBefore = foreign.lines;
await hook(foreign);
check('非本模组的歌不动（本地源）', foreign.lines === foreignBefore);
const otherOnline = makeEvent({ id: 'netease:1', source: 'netease', title: '在线歌', artist: 'y' }, [{ startTime: 1, endTime: 2, fullText: 'a' }]);
const otherOnlineBefore = otherOnline.lines;
await hook(otherOnline);
check('非本模组的歌不动（内置在线源）', otherOnline.lines === otherOnlineBefore);

// 本模组但还没预备过逐字：保持原样，不抛错
const ours = makeEvent(
    { id: 'bili:BV1xxxxxxxxx:1', source: 'folium.neri-bridge.bilibili', title: '夜に駆ける', artist: 'YOASOBI' },
    [{ startTime: 1, endTime: 2, fullText: '沈むように' }],
);
const oursBefore = ours.lines;
await hook(ours);
check('没有预备过逐字时保持原样（不抛错）', ours.lines === oursBefore);

// 钩子必须对 event 的缺字段容错 —— 宿主契约如此，但模组不该因此崩掉
let hookThrew = null;
try {
    await hook({ song: undefined, lines: undefined });
} catch (error) {
    hookThrew = error;
}
check('缺 song / lines 时不抛错', hookThrew === null, String(hookThrew));

if (typeof hookDispose === 'function') {
    check('activate 返回的 disposer 能撤下钩子', (() => {
        hookDispose();
        return true;
    })());
}

console.log('\n== 7. 缺 omni.hooks 时逐字歌词降级，但 LRC 回退不受影响 ==');
const noHookHost = createStubHost({ withHooks: false });
const noHookWarnings = [];
noHookHost.folium.log = {
    info: () => {},
    warn: (message) => noHookWarnings.push(String(message)),
    error: () => {},
};
const noHookDispose = activate(noHookHost.folium);
check('没有 omni.hooks 时仍注册了 provider', noHookHost.state.providers.some((def) => def.id === 'bilibili'));
check('没有 omni.hooks 时仍注册了设置分区', noHookHost.state.sections.length > 0);
check('并写了一条可读的降级警告', noHookWarnings.some((message) => message.includes('omni.hooks')), noHookWarnings.join(' | '));
check('降级时歌词能力仍在（getLyrics 在 provider 上）', typeof noHookHost.state.providers.find((def) => def.id === 'bilibili')?.getLyrics === 'function');
if (typeof noHookDispose === 'function') noHookDispose();

console.log('\n== 8. YouTube provider 由设置开关控制 ==');
const offHost = createStubHost({ settings: { enableYoutube: false } });
activate(offHost.folium);
check('开关关闭时不注册 YouTube provider', !offHost.state.providers.some((def) => def.id === 'youtube'), offHost.state.providers.map((def) => def.id).join(','));

const onHost = createStubHost({ settings: { enableYoutube: true } });
activate(onHost.folium);
const youtube = onHost.state.providers.find((def) => def.id === 'youtube');
check('开关打开时注册 YouTube provider', Boolean(youtube));
check('YouTube provider 只声明 search / getSong / getLyrics', Boolean(youtube?.search && youtube?.getSong && youtube?.getLyrics));
check(
    'YouTube provider **没有** getAudioUrl（匿名播放拿不到地址，不假装能放）',
    youtube?.getAudioUrl === undefined,
    String(typeof youtube?.getAudioUrl),
);

console.log('\n== 9. index.cjs 的 main 入口：rpc 名字和方法与客户端对得上 ==');
// 客户端调的每个名字都必须在这里注册过，否则点下去就是 rpc-not-found。
// 没有 electron，所以 Referer 监听器一定装不上（expected: failed），
// 但 RPC 注册与登录态逻辑不依赖 electron，正好在这里验。
const createMainApi = () => {
    const handlers = new Map();
    const warnings = [];
    return {
        api: {
            log: { info: () => {}, warn: (message) => warnings.push(String(message)), error: () => {} },
            storage: { data: { get: async () => undefined, set: async () => undefined } },
            rpc: { handle: (name, fn) => handlers.set(name, fn) },
        },
        handlers,
        warnings,
    };
};

const main = createMainApi();
let mainDispose = null;
let mainError = null;
try {
    mainDispose = mainEntry(main.api);
} catch (error) {
    mainError = error;
}
check('main 入口能在没有 electron 的环境里构造出来', mainError === null, String(mainError?.message ?? ''));

const EXPECTED_RPC = [
    'bili.login.create',
    'bili.login.poll',
    'bili.login.openWindow',
    'bili.session.read',
    'bili.session.status',
    'bili.session.set',
    'bili.session.clear',
    'bili.diagnose',
];
check(
    '注册了客户端会用到的全部 rpc 名字',
    EXPECTED_RPC.every((name) => main.handlers.has(name)),
    `缺 ${EXPECTED_RPC.filter((name) => !main.handlers.has(name)).join(',') || '无'}`,
);
check('每个 rpc 都是函数', [...main.handlers.values()].every((handler) => typeof handler === 'function'));
check(
    '没有 electron 时如实记下监听器装不上（而不是静默）',
    main.warnings.some((message) => message.includes('referer') || message.includes('session unavailable')),
    main.warnings.join(' | '),
);

if (mainError === null) {
    const diagnose = await main.handlers.get('bili.diagnose')();
    check('diagnose 报出监听器状态与改写计数', diagnose?.referer?.state === 'failed' && diagnose.referer.rewrites === 0, JSON.stringify(diagnose?.referer));
    check('失败原因是单行（不会把 require stack 灌进命令面板）', !String(diagnose?.referer?.error ?? '').includes('\n'), JSON.stringify(diagnose?.referer?.error));
    check('diagnose 不泄漏 cookie 值（只给形状）', diagnose?.session?.restored === false && diagnose.session.masked === 'none', JSON.stringify(diagnose?.session));

    const statusBefore = await main.handlers.get('bili.session.status')();
    check('未登录时 session.status 报出音质受限', statusBefore?.loggedIn === false && statusBefore.quality?.capped === true, JSON.stringify(statusBefore?.quality));
    check('未登录时 status 里没有 SESSDATA 明文', !JSON.stringify(statusBefore).includes('SESSDATA='));

    const setResult = await main.handlers.get('bili.session.set')('SESSDATA=FAKE_SESSDATA_FOR_TESTS; bili_jct=FAKE_CSRF_FOR_TESTS');
    check('粘贴 Cookie 能被接受', setResult?.ok === true, JSON.stringify(setResult));
    const statusAfter = await main.handlers.get('bili.session.status')();
    check('登录后音质不再标为受限', statusAfter?.loggedIn === true && statusAfter.quality?.capped === false);
    const diagnoseAfter = await main.handlers.get('bili.diagnose')();
    check('diagnose 只说「cookie 已恢复」与脱敏形状', diagnoseAfter?.session?.restored === true && /SESSDATA=\w{1,4}…/.test(diagnoseAfter.session.masked), diagnoseAfter?.session?.masked);
    check('脱敏里不含完整 SESSDATA', !diagnoseAfter.session.masked.includes('FAKE_SESSDATA_FOR_TESTS'));

    const cleared = await main.handlers.get('bili.session.clear')();
    check('退出登录可用', cleared?.ok === true);
    check('退出后回到未登录', (await main.handlers.get('bili.session.status')())?.loggedIn === false);

    const badCookie = await main.handlers.get('bili.session.set')('buvid3=only-a-fingerprint');
    check('没带 SESSDATA 的粘贴被拒', badCookie?.ok === false && badCookie.error === 'missing-sessdata', JSON.stringify(badCookie));

    const badPoll = await main.handlers.get('bili.login.poll')('');
    check('空 qrcode_key 被挡下（不会真的发请求）', badPoll?.ok === false && badPoll.error === 'missing-key');
}

if (typeof mainDispose === 'function') {
    check('main 入口返回 disposer', (() => {
        try {
            mainDispose();
            return true;
        } catch {
            return false;
        }
    })());
}

process.exit(summary() === 0 ? 0 : 1);
