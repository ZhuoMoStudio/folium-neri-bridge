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
        check('permissions 被上游接受', JSON.stringify(result.value.permissions) === '["net.fetch"]');
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
    needsRefererRewrite,
    applyBilibiliReferer,
    isBilibiliCdn,
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

console.log('\n== 3c. Referer 改写 ==');
// 实测规则：只有带 B 站 Referer 才在所有 CDN 上稳定 206。
// 注意「不带 Referer」是 CDN 相关的（bilivideo 上 403、akamaized 上 206），所以不能靠它。
check('已是对的值 → 不改写', !needsRefererRewrite({ Referer: BILIBILI_REFERER }));
check('完全没有 Referer → 要改写', needsRefererRewrite({ 'User-Agent': 'x' }));
check('Referer 为空字符串 → 要改写', needsRefererRewrite({ Referer: '' }));
check('Referer 是 localhost → 要改写（Folia 开发模式）', needsRefererRewrite({ Referer: 'http://localhost:3000/' }));
check('Referer 是 file:// → 要改写（Folia 生产模式）', needsRefererRewrite({ Referer: 'file:///' }));
check('只有 Origin 没有 Referer → 要改写', needsRefererRewrite({ Origin: 'http://localhost:3000' }));
check('已有正确 Referer 但带 Origin → 仍要改写', needsRefererRewrite({ Referer: BILIBILI_REFERER, Origin: 'http://localhost:3000' }));
check('大小写混合的 referer 键名也认得', !needsRefererRewrite({ referer: BILIBILI_REFERER }));
check('大小写混合的错误值也认得', needsRefererRewrite({ REFERER: 'http://localhost:3000/' }));

const rewritten = applyBilibiliReferer({ Referer: 'http://localhost:3000/', Origin: 'http://localhost:3000', Range: 'bytes=0-1' });
check('改写后 Referer 值正确', rewritten?.Referer === BILIBILI_REFERER);
check('改写后 Origin 被移除（它只会带来 403）', rewritten && !Object.keys(rewritten).some((k) => k.toLowerCase() === 'origin'));
check('改写后没有残留的旧 referer 键', Object.keys(rewritten ?? {}).filter((k) => k.toLowerCase() === 'referer').length === 1);
check('改写不影响其它请求头', rewritten?.Range === 'bytes=0-1');
check('无 Referer 的请求会被补上', applyBilibiliReferer({ Range: 'bytes=0-1' })?.Referer === BILIBILI_REFERER);
check('不需要改写时返回 null（调用方跳过）', applyBilibiliReferer({ Referer: BILIBILI_REFERER }) === null);

console.log('\n== 4. client.mjs：用打桩宿主端到端跑一遍 ==');
const { default: activate } = await import('../client.mjs');
const { createFakeFolium } = await import('./harness.mjs');
const { folium } = createFakeFolium();

let registered = null;
const handleCalls = [];
folium.experimental = {
    'omni.providers': Object.freeze({
        register: (def) => {
            registered = def;
            return {
                id: `neri-bridge:${def.id}`,
                unregister: () => handleCalls.push('unregister'),
            };
        },
    }),
};

const dispose = activate(folium);
check('activate 注册了 provider', Boolean(registered));
check('provider.id 为 bilibili', registered?.id === 'bilibili', registered?.id);
check('provider 有 displayName', typeof registered?.displayName === 'string' && registered.displayName.length > 0);
check('provider 实现了 search', typeof registered?.search === 'function');
check('provider 实现了 getAudioUrl', typeof registered?.getAudioUrl === 'function');
check('provider 实现了 getLyrics', typeof registered?.getLyrics === 'function');
check('provider 实现了 getSong', typeof registered?.getSong === 'function');
check('注册通过 omniProvidersRegistry 的第一道校验（至少实现一个方法）', Boolean(registered?.search || registered?.getAudioUrl || registered?.getLyrics));
check('activate 返回 disposer', typeof dispose === 'function');

if (typeof dispose === 'function') {
    dispose();
    check('disposer 调用了 handle.unregister', handleCalls.includes('unregister'), JSON.stringify(handleCalls));
}

console.log('\n== 5. 缺少实验接口时应给出可读错误而不是崩掉 ==');
const bare = createFakeFolium();
let bareError = null;
bare.folium.log = { info: () => {}, warn: () => {}, error: (m) => { bareError = m; } };
const bareResult = activate(bare.folium);
check('没有 experimental 时返回 undefined', bareResult === undefined);
check('并写了一条 error 日志', typeof bareError === 'string' && bareError.includes('omni.providers'), String(bareError));

process.exit(summary() === 0 ? 0 : 1);
