// test/09-youtube.mjs —— 打真实网络，验证 YouTube Music（InnerTube）的能力边界
//
// 这个脚本有两件事：
//   1. 验证**搜索**确实可用（匿名，无需 cookie），这是本 provider 提供的全部能力；
//   2. 当**金丝雀**：player 端点只要开始返回可播放的音频格式，就说明匿名播放放开了，
//      那时应该回来把 getAudioUrl 实现掉。所以这里断言的是「仍然拿不到」，
//      一旦拿到就会红 —— 一个红的测试在这里是**好消息**，注释里写清楚了怎么处理。
//
// 实测背景（2026-09-27）见 providers/youtube.mjs 顶部。
import { check, summary } from './harness.mjs';
import { createHttp } from '../lib/http.mjs';
import {
    cleanChannelName,
    collectRenderers,
    createYoutubeProvider,
    parseSearchItem,
} from '../providers/youtube.mjs';

const CHROMIUM_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const log = {
    info: (message, details) => console.log(`    · ${message}`, details ? JSON.stringify(details) : ''),
    warn: (message, details) => console.log(`    ! ${message}`, details ? JSON.stringify(details) : ''),
    error: (message, details) => console.log(`    ✗ ${message}`, details ? JSON.stringify(details) : ''),
};

const netFetch = async (url, init = {}) => {
    const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        redirect: 'follow',
    });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers, text: () => text, json: () => JSON.parse(text) };
};

const http = createHttp({ log, net: { fetch: netFetch } }, log);
const provider = createYoutubeProvider({ http, log, lrclib: null, wordTiming: null });

console.log('\n== 1. 匿名搜索（本 provider 的主力能力）==');
const keyword = process.argv[2] ?? 'yoru ni kakeru';
const page = await provider.search(keyword, { limit: 20, offset: 0 });
console.log(`    首条：${JSON.stringify(page.items[0] ?? null)}`);
check('搜索返回结构正确', Array.isArray(page.items) && typeof page.hasMore === 'boolean');
check('搜索有结果', page.items.length > 0, `拿到 ${page.items.length} 条`);
check('每条都有 yt: 前缀的 id', page.items.every((item) => item.id.startsWith('yt:') && item.id.length > 5));
check('每条都有标题', page.items.every((item) => typeof item.title === 'string' && item.title.length > 0));
check('至少一条带艺术家', page.items.some((item) => item.artists.length > 0), JSON.stringify(page.items.find((item) => item.artists.length > 0)?.artists));
check('至少一条带时长（解析自 "艺术家 • 专辑 • 4:22"）', page.items.some((item) => Number(item.durationMs) > 0), String(page.items.find((item) => item.durationMs)?.durationMs));
check('时长按毫秒返回', page.items.every((item) => item.durationMs === undefined || item.durationMs > 1000));
check(
    '搜 YOASOBI 的歌能搜到 YOASOBI 的歌',
    page.items.some((item) => item.artists.some((name) => /yoasobi/i.test(name))),
    JSON.stringify(page.items.slice(0, 3).map((item) => item.artists)),
);

console.log('\n== 2. 频道名清洗 ==');
check('去掉 " - Topic"（自动生成频道）', cleanChannelName('YOASOBI - Topic') === 'YOASOBI', cleanChannelName('YOASOBI - Topic'));
check('不在中间误伤', cleanChannelName('Topic Records') === 'Topic Records');
check('不在中间误伤（含词但在中间）', cleanChannelName('A - Topic Band') === 'A - Topic Band');
check('普通名字不动', cleanChannelName('周杰伦') === '周杰伦');

console.log('\n== 3. 翻页 ==');
const secondPage = await provider.search(keyword, { limit: 20, offset: page.items.length });
check('第二页返回结构正确', Array.isArray(secondPage.items));
if (page.hasMore) {
    check('声称有下一页时真的拿到内容', secondPage.items.length > 0, `${secondPage.items.length} 条`);
    check('第二页不是第一页的复制', secondPage.items[0]?.id !== page.items[0]?.id, `${secondPage.items[0]?.id} vs ${page.items[0]?.id}`);
} else {
    console.log('    ℹ 本次没有翻页令牌（InnerTube 有时不给），跳过');
}

console.log('\n== 4. getSong：只读 videoDetails，不碰 streamingData ==');
const firstItem = page.items[0];
const song = await provider.getSong(firstItem.id);
check('getSong 返回歌曲', Boolean(song?.id), JSON.stringify(song));
check('id 与请求的一致', song?.id === firstItem.id);
check('标题非空', typeof song?.title === 'string' && song.title.length > 0, song?.title);
check('时长是有限正数', Number(song?.durationMs) > 0, String(song?.durationMs));
check('艺术家里没有 " - Topic"', !(song?.artists ?? []).some((name) => /- Topic/i.test(name)), JSON.stringify(song?.artists));
check('非法 id 返回 null', (await provider.getSong('yt:!!')) === null && (await provider.getSong('')) === null);

console.log('\n== 5. 能力声明：不声明播放（拿不到就不假装）==');
check('provider 没有 getAudioUrl', provider.getAudioUrl === undefined);
check('provider 有 search / getSong / getLyrics', Boolean(provider.search && provider.getSong && provider.getLyrics));

console.log('\n== 6. 金丝雀：匿名播放仍然不可用 ==');
// 这一段是**故意**断言「拿不到」的。哪天它红了：
//   1. 先看下面打印的 status / audioFormatCount；
//   2. 如果 audioFormatCount > 0，说明 YouTube 放开了匿名播放 —— 那就去实现 getAudioUrl
//      （providers/youtube.mjs 里的 fetchPlayerStatus 已经在读 adaptiveFormats 了）；
//   3. 然后把这条断言反过来，并在 README 里把「播放不可用」那段删掉。
const status = await (async () => {
    const response = await netFetch('https://music.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': CHROMIUM_UA,
            Origin: 'https://music.youtube.com',
            'X-Goog-Api-Format-Version': '2',
        },
        body: JSON.stringify({
            context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en', gl: 'US' } },
            videoId: firstItem.id.replace('yt:', ''),
            contentCheckOk: true,
            racyCheckOk: true,
        }),
    });
    const payload = JSON.parse(response.text());
    const adaptive = (payload?.streamingData?.adaptiveFormats ?? []).filter((format) => String(format?.mimeType ?? '').startsWith('audio'));
    return {
        playability: String(payload?.playabilityStatus?.status ?? 'unknown'),
        reason: String(payload?.playabilityStatus?.reason ?? ''),
        hasDetails: Boolean(payload?.videoDetails),
        audioFormatCount: adaptive.length,
    };
})();
console.log(`    status=${status.playability} · ${status.reason}`);
console.log(`    videoDetails=${status.hasDetails} · 可播放音频格式=${status.audioFormatCount}`);
check('player 端点确实认识这个视频（说明请求本身没问题）', status.hasDetails === true);
check(
    '★ 仍然拿不到匿名播放地址（拿到就说明该实现 getAudioUrl 了）',
    status.audioFormatCount === 0,
    `status=${status.playability} formats=${status.audioFormatCount}`,
);

console.log('\n== 7. 解析器对上游形状变化的容错 ==');
check('缺 playlistItemData 的条目被跳过', parseSearchItem({ flexColumns: [] }) === null);
check('缺标题的条目被跳过', parseSearchItem({ playlistItemData: { videoId: 'x' }, flexColumns: [] }) === null);
check('只有时长没有艺术家时仍解析出条目', (() => {
    const item = parseSearchItem({
        playlistItemData: { videoId: 'abcdefghijk' },
        flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Song' }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '3:21' }] } } }],
    });
    return item?.durationMs === 201000 && item.artists.length === 0;
})());
check('收集 renderer 能穿透任意层级', collectRenderers({ a: { b: { musicResponsiveListItemRenderer: { n: 1 } } } }, 'musicResponsiveListItemRenderer').length === 1);
check('收集 renderer 对空输入安全', collectRenderers(null, 'x').length === 0 && collectRenderers({}, 'x').length === 0);

process.exit(summary() === 0 ? 0 : 1);
