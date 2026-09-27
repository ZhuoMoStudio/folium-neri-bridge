// test/07-word-timing.mjs —— 逐字歌词链路的离线检查
//
// 覆盖四段纯逻辑：TTML 解析（lib/ttml.mjs）、AMLL 索引（lib/amll-index.mjs）、
// 时间轴对齐（lib/lyric-align.mjs）与安装决策/中继（lib/word-timing.mjs）。
// 不联网。真实网络的版本在 test/08-amll-live.mjs。
//
// 样本字符串全部来自实测：TTDB 服务返回的真实 TTML、真实标题、以及 Folia 的
// ttmlConversion.ts / enhancedLrcSerializer.ts 对形状的约定。
import { check, summary } from './harness.mjs';
import { localName, parseTtml, parseTtmlTime, parseXmlTree, ttmlHasWordTiming } from '../lib/ttml.mjs';
import {
    AMLL_INDEX_FORMAT,
    compactAmllIndex,
    dedupeAmllEntries,
    expandAmllIndex,
    parseAmllIndex,
} from '../lib/amll-index.mjs';
import { estimateLyricOffset, LYRIC_ALIGN_LIMITS, shiftLyricLines } from '../lib/lyric-align.mjs';
import { createWordTimingRelay, EXACT_TITLE_SCORE, planWordTimingInstall } from '../lib/word-timing.mjs';

console.log('\n== TTML 时间格式 ==');
check('MM:SS.mmm', parseTtmlTime('00:01.737') === 1.737, String(parseTtmlTime('00:01.737')));
check('HH:MM:SS.mmm', parseTtmlTime('00:02:35.500') === 155.5, String(parseTtmlTime('00:02:35.500')));
check('两位小数按百分之一秒', parseTtmlTime('02:35.55') === 155.55, String(parseTtmlTime('02:35.55')));
check('一位小数按十分之一秒', parseTtmlTime('15.1') === 15.1, String(parseTtmlTime('15.1')));
check('只有秒', parseTtmlTime('35') === 35);
check('秒可以超过 60（无冒号时）', parseTtmlTime('95') === 95);
check('`s` 后缀', parseTtmlTime('15.8s') === 15.8 && parseTtmlTime('90s') === 90);
check('带冒号时分秒必须 < 60', parseTtmlTime('01:75.000') === null && parseTtmlTime('99:99.999') === null);
check('小数只能出现在最后一段', parseTtmlTime('01.5:20.000') === null);
check('空值与垃圾返回 null', parseTtmlTime('') === null && parseTtmlTime('abc') === null && parseTtmlTime(null) === null);

console.log('\n== 极小的 XML 解析 ==');
check('命名空间前缀被剥成本地名', localName('ttm:role') === 'role' && localName('span') === 'span');
const tree = parseXmlTree('<tt><head><metadata><amll:meta key="a" value="b"/></metadata></head><body><!--x--><p begin="1s">t</p></body></tt>');
check('根元素解析出来', tree.children[0]?.name === 'tt');
check('自闭合元素不吞掉兄弟节点', (() => {
    const body = parseXmlTree('<body><meta/><p>x</p></body>').children[0];
    return body.children.length === 2 && body.children[1].name === 'p';
})());
check('注释被忽略', parseXmlTree('<a><!-- <b/> --><c/></a>').children[0].children.length === 1);
check('属性解析含实体', parseXmlTree('<p x="a&amp;b"/>').children[0].attrs.x === 'a&b');
check('闭合标签能弹栈', (() => {
    const root = parseXmlTree('<a><b></b><c/></a>');
    return root.children[0].children.length === 2;
})());

console.log('\n== TTML → FoliumLine ==');
// 拉丁词拆成音节：`<span>Hel</span><span>lo</span>` 应合成一个 word（Folia 的约定）
const latin = '<tt><body><p begin="1.000" end="2.000" itunes:key="L1"><span begin="1.000" end="1.500">Hel</span><span begin="1.500" end="2.000">lo</span></p></body></tt>';
const latinParsed = parseTtml(latin);
check('拉丁音节合成一个 word', latinParsed.lines[0]?.words.length === 1, JSON.stringify(latinParsed.lines[0]?.words));
check('合成的 word 带两个 syllable', latinParsed.lines[0]?.words[0]?.syllables.length === 2);
check('word 文本是拼接结果', latinParsed.lines[0]?.words[0]?.text === 'Hello');
check('hasWordTiming 为 true', latinParsed.hasWordTiming === true);

// CJK 一字一词，不合并（Folia 的规则）
const cjk = '<tt><body><p begin="0s" end="2s"><span begin="0s" end="1s">沈</span><span begin="1s" end="2s">む</span></p></body></tt>';
const cjkParsed = parseTtml(cjk);
check('CJK 不合并，一字一词', cjkParsed.lines[0]?.words.length === 2);
check('CJK 每词一个 syllable', cjkParsed.lines[0]?.words.every((word) => word.syllables.length === 1));

// ★ 关键不变量：words 拼接必须等于 fullText。
// 宿主的 enhancedLrcSerializer.alignWordSegments 就是靠这条来判断要不要自己去 fullText 里找词；
// 对不上时它会重新对齐，对得上就直接用 —— 我们的目标就是让它别猜。
const spaced = '<tt><body><p begin="0s" end="3s"><span begin="0s" end="1s">Couldn\'t</span><span begin="1s" end="2s"> beat</span><span begin="2s" end="3s"> her</span></p></body></tt>';
const spacedParsed = parseTtml(spaced);
check(
    '前缀空格折算到上一个 syllable（TTDB 的实际写法）',
    spacedParsed.lines[0]?.words.map((word) => word.text).join('') === spacedParsed.lines[0]?.fullText,
    JSON.stringify(spacedParsed.lines[0]?.words.map((word) => word.text)),
);
check('空格带出 endsWithSpace 标记', spacedParsed.lines[0]?.words[0]?.syllables[0]?.endsWithSpace === true);
const independentSpace = '<tt><body><p begin="0s" end="2s"><span begin="0s" end="1s">a</span> <span begin="1s" end="2s">b</span></p></body></tt>';
check(
    '独立空白文本节点也算空格',
    parseTtml(independentSpace).lines[0].words.map((w) => w.text).join('') === 'a b',
    JSON.stringify(parseTtml(independentSpace).lines[0].words.map((w) => w.text)),
);
// 实测：Idol 的 91 行里有 1 行以空格结尾（`Oh my savior `）。行末空格既没意义，
// 又会破坏 words 拼接 === fullText，所以解析时就该去掉。
const trailingSpace = '<tt><body><p begin="0s" end="3s"><span begin="0s" end="1s">Oh </span><span begin="1s" end="2s">my </span><span begin="2s" end="3s">savior </span></p></body></tt>';
check(
    '行末空格被去掉，不变量仍然成立',
    (() => {
        const line = parseTtml(trailingSpace).lines[0];
        return line.words.map((w) => w.text).join('') === line.fullText && line.fullText === 'Oh my savior';
    })(),
    JSON.stringify(parseTtml(trailingSpace).lines[0].words.map((w) => w.text)),
);
// 格式化过的 TTML：元素之间的换行是排版，不是歌词里的空格
const prettyPrinted = '<tt><body>\n  <p begin="0s" end="2s">\n    <span begin="0s" end="1s">君</span>\n    <span begin="1s" end="2s">の</span>\n  </p>\n</body></tt>';
check(
    '带缩进换行的 TTML 不会每行多出一个空格',
    (() => {
        const line = parseTtml(prettyPrinted).lines[0];
        return line.fullText === '君の' && line.words.map((w) => w.text).join('') === '君の';
    })(),
    JSON.stringify(parseTtml(prettyPrinted).lines[0]?.fullText),
);

// 翻译 / 音译 / 背景人声 / 副歌
const rich = `<tt><head><metadata><amll:meta key="musicName" value="夜に駆ける"/><amll:meta key="artists" value="YOASOBI"/><amll:meta key="ncmMusicId" value="1409311773"/></metadata></head><body>
<div itunes:song-part="Chorus"><p begin="25.100" end="32.500" itunes:key="L1" ttm:agent="v1">
<span begin="25.100" end="25.800">君</span><span begin="25.900" end="26.100">の</span>
<span ttm:role="x-translation" xml:lang="en">The story</span><span ttm:role="x-translation" xml:lang="zh-CN">你所不知道的物语</span>
<span ttm:role="x-roman">kimi no</span>
<span ttm:role="x-bg" begin="30.500" end="32.500"><span begin="30.500" end="31.500">(秘密</span><span begin="31.600" end="32.500">だよ)</span><span ttm:role="x-translation" xml:lang="zh-CN">是秘密哦</span></span>
</p></div></body></tt>`;
const richParsed = parseTtml(rich);
const richLine = richParsed.lines[0];
check('metadata 解析出标题/艺术家/平台 id', richParsed.metadata.musicName[0] === '夜に駆ける' && richParsed.metadata.artists[0] === 'YOASOBI' && richParsed.metadata.ids.ncmMusicId === '1409311773');
check('翻译优先中文', richLine?.translation === '你所不知道的物语', richLine?.translation);
check('其余语言进 alternateTexts', richLine?.alternateTexts?.some((entry) => entry.language === 'en' && entry.role === 'translation'));
check('音译单独成字段', richLine?.romanization === 'kimi no', richLine?.romanization);
check('背景人声被提出', richLine?.backgroundVocals?.length === 1 && richLine.backgroundVocals[0].text.includes('秘密'));
check('背景人声有自己的时间', richLine?.backgroundVocals?.[0]?.startTime === 30.5);
check('背景人声有自己的翻译', richLine?.backgroundVocals?.[0]?.translation === '是秘密哦');
check('Chorus 分区被标成副歌', richLine?.isChorus === true);
check('行时间取 <p> 的 begin/end', richLine?.startTime === 25.1 && richLine?.endTime === 32.5);
check('行的 words 拼接 === fullText', richLine?.words.map((w) => w.text).join('') === richLine?.fullText, JSON.stringify(richLine?.fullText));

// 行级 TTML（没有逐字）不该被当成逐字用
const lineOnly = '<tt><body><p begin="0s" end="2s">一行歌词</p></body></tt>';
check('行级 TTML 的 hasWordTiming 为 false', parseTtml(lineOnly).hasWordTiming === false);
check('行级 TTML 仍产出一行', parseTtml(lineOnly).lines.length === 1);
check('行级 TTML 的词是整行', parseTtml(lineOnly).lines[0].words.length === 1);
check('ttmlHasWordTiming 快捷判定', ttmlHasWordTiming(rich) && !ttmlHasWordTiming(lineOnly));
check('空 TTML 不炸', parseTtml('').lines.length === 0 && parseTtml('not xml').lines.length === 0);

// 行必须按时间排好：宿主是顺序推进的
const outOfOrder = '<tt><body><p begin="5s" end="6s"><span begin="5s" end="6s">后</span></p><p begin="1s" end="2s"><span begin="1s" end="2s">前</span></p></body></tt>';
check('未按时间排序的 TTML 会被排好', parseTtml(outOfOrder).lines.map((line) => line.fullText).join(',') === '前,后');

console.log('\n== AMLL 索引 ==');
const indexSample = [
    '{"metadata":[["album",["夜に駆ける"]],["artists",["YOASOBI"]],["musicName",["夜に駆ける"]],["ncmMusicId",["1409311773"]],["ttmlAuthorGithubLogin",["mizuhara37"]]],"rawLyricFile":"1689400682000-83578994-e3ba9609.ttml"}',
    '{"metadata":[["artists",["A","B"]],["musicName",["Duet"]],["qqMusicId",["123"]],["spotifyId",["sp1"]]],"rawLyricFile":"x-y-z.ttml"}',
    '这是一条坏行',
    '',
    '{"metadata":[["musicName",["无文件"]]]}',
].join('\n');
const entries = parseAmllIndex(indexSample);
check('坏行与缺字段的行被跳过', entries.length === 2, `拿到 ${entries.length} 条`);
check('标题/艺术家/文件名解析正确', entries[0].title === '夜に駆ける' && entries[0].artists[0] === 'YOASOBI' && entries[0].rawLyricFile.endsWith('.ttml'));
check('多个艺术家保留成数组', entries[1].artists.length === 2);
check('多个平台 id 都留下（键名已归一）', entries[1].ids.qqMusicId === '123' && entries[1].ids.spotifyId === 'sp1');
check('不认识的 metadata 不进 ids', entries[0].ids.ttmlAuthorGithubLogin === undefined);
check('空输入返回空数组', parseAmllIndex('').length === 0 && parseAmllIndex(null).length === 0);

const dupes = dedupeAmllEntries(entries);
check('去重保留第一条', dupes.length === 2);
check('同歌不同投稿只留一条', dedupeAmllEntries([...entries, { ...entries[0], rawLyricFile: 'other.ttml' }]).length === 2);

const compact = compactAmllIndex(entries);
check('紧凑形状的键是短名', 't' in compact[0] && 'a' in compact[0] && 'f' in compact[0]);
check('紧凑形状不含 album（请求侧没有专辑名可比）', !('al' in compact[0]));
check('平台 id 也用了短键', compact[1].i?.n === undefined && compact[1].i?.q === '123' && compact[1].i?.s === 'sp1');
const roundTripped = expandAmllIndex(compact);
check('往返完全一致', JSON.stringify(roundTripped) === JSON.stringify(entries), JSON.stringify(roundTripped[1]));
check('往返跳过形状不对的条目', expandAmllIndex([{ t: 'x' }, null, { t: 'y', f: 'z' }]).length === 1);
check('非数组输入返回空数组', expandAmllIndex(null).length === 0);
check('索引格式号是版本化的', AMLL_INDEX_FORMAT >= 1);

console.log('\n== 时间轴对齐 ==');
const referenceLines = [
    { startTime: 10.0, fullText: '第一行歌词' },
    { startTime: 20.0, fullText: '第二行歌词' },
    { startTime: 30.0, fullText: '第三行歌词' },
    { startTime: 40.0, fullText: '第四行歌词' },
    { startTime: 50.0, fullText: '第五行歌词' },
];
const shift = (lines, offset) => lines.map((line) => ({ ...line, startTime: line.startTime + offset }));

check('一致的时轴 → 偏移 0', estimateLyricOffset(referenceLines, referenceLines) === 0);
// 方向约定：返回值是「参照 − 候选」，也就是要**加到候选上**的量。
// shift(referenceLines, -2.5) 让候选整体早 2.5s，所以偏移是 +2.5。
check('候选整体早 2.5s → 偏移 +2.5', estimateLyricOffset(referenceLines, shift(referenceLines, -2.5)) === 2.5, String(estimateLyricOffset(referenceLines, shift(referenceLines, -2.5))));
check('候选整体晚 1.5s → 偏移 -1.5', estimateLyricOffset(referenceLines, shift(referenceLines, 1.5)) === -1.5, String(estimateLyricOffset(referenceLines, shift(referenceLines, 1.5))));
const jittered = shift(referenceLines.map((line, index) => ({ ...line, startTime: line.startTime + (index === 2 ? 0.05 : 0) })), -1.5);
check('带少量抖动也能求出中位数', Math.abs(estimateLyricOffset(referenceLines, jittered) - 1.5) < 0.06, String(estimateLyricOffset(referenceLines, jittered)));
check('配对太少 → null（不敢下手）', estimateLyricOffset(referenceLines, shift(referenceLines, -3).slice(0, 3)) === null);
check('文本完全不同 → null', estimateLyricOffset(referenceLines, [{ startTime: 1, fullText: 'aaaa' }, { startTime: 2, fullText: 'bbbb' }, { startTime: 3, fullText: 'cccc' }, { startTime: 4, fullText: 'dddd' }]) === null);
check('配对发散（不是同一个版本）→ null', estimateLyricOffset(
    referenceLines,
    [
        { startTime: 10, fullText: '第一行歌词' },
        { startTime: 40, fullText: '第二行歌词' },
        { startTime: 32, fullText: '第三行歌词' },
        { startTime: 60, fullText: '第四行歌词' },
        { startTime: 12, fullText: '第五行歌词' },
    ],
) === null);
check('偏移超过上限 → null', estimateLyricOffset(referenceLines, shift(referenceLines, -120)) === null);
check('没有参照行 → null', estimateLyricOffset([], referenceLines) === null);
check('没有候选行 → null', estimateLyricOffset(referenceLines, []) === null);
check('太短的行不参与配对（避免「啊」乱配）', estimateLyricOffset(
    [{ startTime: 1, fullText: '啊' }, { startTime: 2, fullText: '呀' }],
    [{ startTime: 5, fullText: '啊' }, { startTime: 6, fullText: '呀' }],
) === null);
check('副歌重复行取时间最近的那个', (() => {
    const texts = ['甲句歌词甲', '乙句歌词乙', '丙句歌词丙', '丁句歌词丁'];
    const reference = texts.map((text, index) => ({ startTime: 100 + index * 10, fullText: text }));
    // 每一行在候选里出现两次：一次差 0.5s，一次差 100s。
    // 若实现取的不是「最近的那个」，deltas 会落在 -99.5 附近从而被判为配错歌（null）。
    const target = texts.flatMap((text, index) => [
        { startTime: 100 + index * 10 - 0.5, fullText: text },
        { startTime: 200 + index * 10, fullText: text },
    ]);
    return estimateLyricOffset(reference, target) === 0.5;
})());

console.log('\n== 整体平移 ==');
const shifted = shiftLyricLines(
    [{ startTime: 1, endTime: 2, fullText: 'x', words: [{ text: 'x', startTime: 1, endTime: 2, syllables: [{ text: 'x', startTime: 1, endTime: 2 }] }] }],
    1.5,
);
check('行时间被平移', shifted[0].startTime === 2.5 && shifted[0].endTime === 3.5);
check('词与音节同步平移', shifted[0].words[0].startTime === 2.5 && shifted[0].words[0].syllables[0].endTime === 3.5);
check('偏移 0 时原样返回（省一次拷贝）', shiftLyricLines(referenceLines, 0) === referenceLines);
check('非数组输入不炸', shiftLyricLines(null, 1).length === 0);
check('对齐阈值有下限保护', LYRIC_ALIGN_LIMITS.MIN_PAIRS >= 3 && LYRIC_ALIGN_LIMITS.MAX_MAD_SECONDS > 0);

console.log('\n== 逐字歌词中继 ==');
const relay = createWordTimingRelay({ limit: 3 });
relay.put('a', { lines: [1] });
relay.put('b', { lines: [] });
check('取回刚放进去的东西', relay.take('a').lines.length === 1);
check('空结果也记着（表示「这首没有逐字」）', relay.take('b').lines.length === 0);
check('没放过的返回 null', relay.take('zzz') === null);
check('空键不炸', relay.take('') === null && relay.put('', {}) === undefined);
relay.put('c', { lines: [3] });
relay.put('d', { lines: [4] });
check('超出上限时淘汰最旧的', relay.size === 3 && !relay.has('a'), `size=${relay.size}`);
check('take 会刷新 LRU 顺序', (() => {
    relay.take('b');
    relay.put('e', { lines: [5] });
    return relay.has('b') && !relay.has('c');
})());
relay.clear();
check('clear 清空', relay.size === 0);

console.log('\n== 安装决策（钩子唯一需要判断的事）==');
const wordTimedLines = [
    { startTime: 1, endTime: 2, fullText: '甲句歌词甲', words: [{ text: '甲句歌词甲', startTime: 1, endTime: 2, syllables: [{ text: '甲', startTime: 1, endTime: 2 }] }] },
];
const referenceForPlan = [
    { startTime: 1.2, fullText: '甲句歌词甲' },
    { startTime: 11.2, fullText: '乙句歌词乙' },
    { startTime: 21.2, fullText: '丙句歌词丙' },
    { startTime: 31.2, fullText: '丁句歌词丁' },
];
const candidateForPlan = referenceForPlan.map((line) => ({ ...line, startTime: line.startTime - 0.2 }));

check('没有候选行 → 不装', planWordTimingInstall({ referenceLines: referenceForPlan, candidateLines: [] }).install === false);
check('没有候选行时给出原因', planWordTimingInstall({ candidateLines: [] }).reason === 'no-word-timing');
check('有参照且对得上 → 装，并带上偏移', (() => {
    const plan = planWordTimingInstall({ referenceLines: referenceForPlan, candidateLines: candidateForPlan, titleScore: 52 });
    return plan.install === true && Math.abs(plan.offset - 0.2) < 0.01 && plan.aligned === true;
})(), JSON.stringify(planWordTimingInstall({ referenceLines: referenceForPlan, candidateLines: candidateForPlan, titleScore: 52 })));
check('有参照但版本对不上 → 不装（这是「残酷な天使のテーゼ 只有混音版」那个坑）', (() => {
    const plan = planWordTimingInstall({
        referenceLines: referenceForPlan,
        candidateLines: [{ startTime: 90, endTime: 91, fullText: '完全不同的歌词', words: [] }],
        titleScore: 68,
    });
    return plan.install === false && plan.reason === 'timelines-do-not-line-up';
})());
check('没有参照 + 标题完全相等 → 装，偏移 0', (() => {
    const plan = planWordTimingInstall({ referenceLines: [], candidateLines: wordTimedLines, titleScore: EXACT_TITLE_SCORE });
    return plan.install === true && plan.offset === 0 && plan.aligned === false;
})());
check('没有参照 + 标题只是前缀（68）→ 不装', (() => {
    const plan = planWordTimingInstall({ referenceLines: [], candidateLines: wordTimedLines, titleScore: 68 });
    return plan.install === false && plan.reason === 'unverified-title-not-exact';
})());
check('没有参照 + 标题只是包含（52）→ 不装', planWordTimingInstall({ candidateLines: wordTimedLines, titleScore: 52 }).install === false);
check('没有参照 + 没给 titleScore → 保守地不装', planWordTimingInstall({ candidateLines: wordTimedLines }).install === false);
check('参照行不是数组也不炸', planWordTimingInstall({ referenceLines: null, candidateLines: wordTimedLines, titleScore: 80 }).install === true);
check('完全空输入不炸', planWordTimingInstall().install === false);

process.exit(summary() === 0 ? 0 : 1);
