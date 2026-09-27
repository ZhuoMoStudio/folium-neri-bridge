// test/03-contract.mjs —— 用上游自己的代码校验契约，而不是靠人读文档
//
// 需要 Folia 源码可读：FOLIA_SRC=/path/to/folia-major-main
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

/** 打一个只记录注册调用的宿主。形状对齐 api.md 里的 FoliumRegistries。 */
const createStubHost = () => {
    const { folium } = createFakeFolium();
    const state = { provider: null, section: null, commands: [], unregistered: [], calls: [] };
    folium.storage = {
        get: async (key) => state.calls.push(['storage.get', key]) && undefined,
        set: async (key) => state.calls.push(['storage.set', key]),
    };
    folium.ui = { toast: (message) => state.calls.push(['toast', message]) };
    folium.rpc = { call: async (name, ...args) => (state.calls.push(['rpc', name, ...args]), { ok: true, loggedIn: false }) };
    folium.experimental = {
        'omni.providers': Object.freeze({
            register: (def) => {
                state.provider = def;
                return { id: `neri-bridge:${def.id}`, unregister: () => state.unregistered.push('provider') };
            },
        }),
    };
    folium.registries = {
        settingsSections: {
            register: (def) => {
                state.section = def;
                return { id: `neri-bridge:${def.id}`, unregister: () => state.unregistered.push('section') };
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
const provider = host.state.provider;

check('activate 注册了 provider', Boolean(provider));
check('provider.id 为 bilibili', provider?.id === 'bilibili', provider?.id);
check('provider 实现了 search / getSong / getAudioUrl / getLyrics',
    typeof provider?.search === 'function' && typeof provider?.getSong === 'function' &&
    typeof provider?.getAudioUrl === 'function' && typeof provider?.getLyrics === 'function');
check('注册通过 omniProvidersRegistry 的第一道校验（至少实现一个方法）', Boolean(provider?.search || provider?.getAudioUrl || provider?.getLyrics));

check('注册了设置分区', Boolean(host.state.section), host.state.section?.id);
check('设置分区的 settings 是数组（契约要求必填）', Array.isArray(host.state.section?.settings), JSON.stringify(host.state.section?.settings?.map((p) => p.key)));
check('设置分区声明了 settingsPanel', typeof host.state.section?.settingsPanel === 'function');
check('每个 setting 都有 key/type/label', (host.state.section?.settings ?? []).every((p) =>
    typeof p.key === 'string' && ['number', 'text', 'boolean', 'select'].includes(p.type) && p.label));

check('注册了命令', host.state.commands.length > 0, host.state.commands.map((c) => c.id).join(','));
check('每个命令有 id/label/run', host.state.commands.every((c) =>
    typeof c.id === 'string' && c.label && typeof c.run === 'function'));
check('命令 id 不含冒号（宿主会自动加命名空间）', host.state.commands.every((c) => !c.id.includes(':')), host.state.commands.map((c) => c.id).join(','));

check('activate 返回 disposer', typeof dispose === 'function');
if (typeof dispose === 'function') {
    dispose();
    check('disposer 撤下了 provider 与设置分区',
        host.state.unregistered.includes('provider') && host.state.unregistered.includes('section'),
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

process.exit(summary() === 0 ? 0 : 1);
