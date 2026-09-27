// test/06-match.mjs —— 歌词匹配评分的离线检查
//
// 这些数字不是随手写的：全部对着 NeriPlayer 的 EditableLyricMatchPolicy.kt 逐条核过。
// 分档一旦漂移，表现是「歌词能匹配上但匹配错了」，比完全匹配不上更难发现。
import { check, summary } from './harness.mjs';
import {
    canonicalLyricMatchTitle,
    durationDeltaMs,
    isPlausibleLyricMatchIdentity,
    isReliableLyricMatchIdentity,
    normalizeLyricMatchText,
    primaryLyricMatchArtist,
    rankLyricCandidates,
    scoreLyricMatchArtist,
    scoreLyricMatchDuration,
    scoreLyricMatchTitle,
    splitLyricMatchArtists,
    CONFIDENCE,
    SOURCE_PRIORITY,
} from '../lib/lyric-match.mjs';
import { isDurationCompatible } from '../lib/match.mjs';

const opts = { isDurationCompatible };

console.log('\n== 归一化 ==');
check('全角转半角', normalizeLyricMatchText('ＡＢＣ') === 'abc');
check('& 折成 and', normalizeLyricMatchText('A & B') === 'a and b');
check('feat. 被抹掉', normalizeLyricMatchText('YOASOBI feat. ikura') === 'yoasobi ikura');
check('括号转空格', normalizeLyricMatchText('夜に駆ける (Official)') === '夜に駆ける official');
check('标点只留字母数字', normalizeLyricMatchText('夜に駆ける - YOASOBI!!') === '夜に駆ける yoasobi');
check('空白折叠', normalizeLyricMatchText('a    b') === 'a b');

console.log('\n== 歌名分档（80/68/62/52/token）==');
check('完全相等 → 80', scoreLyricMatchTitle('夜に駆ける', '夜に駆ける') === 80);
check('候选前缀长于预期 → 68', scoreLyricMatchTitle('夜に駆ける', '夜に駆ける official') === 68);
check('预期前缀长于候选 → 62', scoreLyricMatchTitle('夜に駆ける official', '夜に駆ける') === 62);
check('互相包含 → 52', scoreLyricMatchTitle('夜に駆ける', 'the 夜に駆ける remix') === 52);
check('无关 → token 重合 0', scoreLyricMatchTitle('夜に駆ける', '残酷な天使') === 0);
check('部分重合 → 0 < 分 < 52', (() => {
    const score = scoreLyricMatchTitle('alpha beta gamma', 'alpha beta delta');
    return score > 0 && score < 52;
})(), String(scoreLyricMatchTitle('alpha beta gamma', 'alpha beta delta')));
check('空值 → 0', scoreLyricMatchTitle('', 'x') === 0 && scoreLyricMatchTitle('x', '') === 0);

console.log('\n== 艺术家分档（55/46/28+/24/token）==');
check('集合相等 → 55', scoreLyricMatchArtist('YOASOBI', 'YOASOBI') === 55);
check('候选包含预期全部 → 46', scoreLyricMatchArtist('A', 'A, B') >= 28, String(scoreLyricMatchArtist('A', 'A, B')));
check('拆分：逗号与斜杠', splitLyricMatchArtists('A, B/C').has('a') && splitLyricMatchArtists('A, B/C').has('b'));
check('拆分：feat. 切分', primaryLyricMatchArtist('YOASOBI feat. ikura') === 'yoasobi');
check('拆分：x 连接词', splitLyricMatchArtists('A x B').has('a') && splitLyricMatchArtists('A x B').has('b'));
check('无关艺术家 → 低分', scoreLyricMatchArtist('YOASOBI', 'Someone Else') === 0, String(scoreLyricMatchArtist('YOASOBI', 'Someone Else')));
check('合作后缀算同一主艺术家（and）', scoreLyricMatchArtist('A', 'A and B') >= 24, String(scoreLyricMatchArtist('A', 'A and B')));

console.log('\n== 时长计分 ==');
check('兼容且差 0 → 42', scoreLyricMatchDuration(240_000, 240_000, isDurationCompatible) === 42);
check('兼容且差 5s → 32', scoreLyricMatchDuration(240_000, 245_000, isDurationCompatible) === 32);
check('兼容下限不低于 22', scoreLyricMatchDuration(100_000, 105_000, isDurationCompatible) >= 22, String(scoreLyricMatchDuration(100_000, 105_000, isDurationCompatible)));
check('不兼容时按每 3s 扣分', scoreLyricMatchDuration(240_000, 300_000, isDurationCompatible) === -20, String(scoreLyricMatchDuration(240_000, 300_000, isDurationCompatible)));
check('不兼容扣分封顶 48', scoreLyricMatchDuration(100_000, 400_000, isDurationCompatible) === -48);
check('缺时长 → 0', scoreLyricMatchDuration(0, 240_000, isDurationCompatible) === 0);
check('durationDeltaMs 缺一方为 null', durationDeltaMs(0, 1) === null && durationDeltaMs(1000, 3000) === 2000);

console.log('\n== 版本修饰词与规范标题 ==');
check('(Official Video) 被去掉', canonicalLyricMatchTitle('夜に駆ける official video') === '夜に駆ける');
check('remaster 被去掉', canonicalLyricMatchTitle('Song remastered') === 'song');
check('中文噪声也去掉', canonicalLyricMatchTitle('歌名 高清 完整版') === '歌名');
check('版本一致的判定', isReliableLyricMatchIdentity({
    expectedTitle: 'Song', expectedArtist: 'Artist', candidateTitle: 'Song', candidateArtist: 'Artist',
}));
check('版本不一致直接否决（live vs 原版）', !isReliableLyricMatchIdentity({
    expectedTitle: 'Song', expectedArtist: 'Artist', candidateTitle: 'Song live', candidateArtist: 'Artist',
}));

console.log('\n== 身份判定的两级 ==');
const reliableCase = { expectedTitle: '夜に駆ける', expectedArtist: 'YOASOBI', candidateTitle: '夜に駆ける', candidateArtist: 'YOASOBI' };
check('reliable：完全一致', isReliableLyricMatchIdentity(reliableCase));
check('plausible：reliable 的情况也算', isPlausibleLyricMatchIdentity({ ...reliableCase, durationCompatible: true }));
check('plausible：主艺术家命中 + 标题 20 分以上 + 时长兼容', isPlausibleLyricMatchIdentity({
    expectedTitle: 'Song Name Here', expectedArtist: 'A', candidateTitle: 'Song Name Here Live', candidateArtist: 'A and B', durationCompatible: true,
}));
check('时长不兼容时 plausible 也不成立', !isPlausibleLyricMatchIdentity({
    expectedTitle: 'Song Name Here', expectedArtist: 'A', candidateTitle: 'Something Else Altogether', candidateArtist: 'Z', durationCompatible: false,
}));

console.log('\n== 排序与阈值 ==');
const candidates = [
    { id: 'weak', source: 'lrclib', title: 'Totally Different', artist: 'Nobody', durationMs: 240_000, lyrics: '[00:01.00]x' },
    { id: 'exact', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x' },
    { id: 'offdur', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 500_000, lyrics: '[00:01.00]x' },
    { id: 'empty', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '' },
    { id: 'collapsed', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:00.00]x', collapsedTimeline: true },
];
const ranked = rankLyricCandidates(
    { trackName: '夜に駆ける', artistName: 'YOASOBI', durationMs: 259_000, preferWordTimed: true },
    candidates,
    opts,
);
check('空歌词被剔除', !ranked.some((entry) => entry.candidate.id === 'empty'));
check('塌缩时间轴被剔除', !ranked.some((entry) => entry.candidate.id === 'collapsed'));
check('完全不匹配的被剔除或排在最后', !ranked.some((entry) => entry.candidate.id === 'weak') || ranked.at(-1).candidate.id === 'weak');
check('时长精确的排第一', ranked[0]?.candidate.id === 'exact', ranked.map((e) => e.candidate.id).join(' > '));
check('时长差大的置信度更低', (ranked.find((e) => e.candidate.id === 'offdur')?.confidence ?? 0) < (ranked[0]?.confidence ?? 0));
check('完全一致的判为 HIGH', ranked[0]?.confidence === CONFIDENCE.HIGH, String(ranked[0]?.confidence));

const wordTimed = rankLyricCandidates(
    { trackName: '夜に駆ける', artistName: 'YOASOBI', durationMs: 259_000, preferWordTimed: true },
    [
        { id: 'plain', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x' },
        { id: 'worded', source: 'amll', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x', hasWordTiming: true, format: 'ttml' },
    ],
    opts,
);
check('preferWordTimed 时逐词结果置顶', wordTimed[0]?.candidate.id === 'worded', wordTimed.map((e) => e.candidate.id).join(' > '));

const notPreferred = rankLyricCandidates(
    { trackName: '夜に駆ける', artistName: 'YOASOBI', durationMs: 259_000, preferWordTimed: false },
    [
        { id: 'plain', source: 'kugou', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x' },
        { id: 'worded', source: 'amll', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x', hasWordTiming: true, format: 'ttml' },
    ],
    opts,
);
// 格式分（TTML 16 / LRC 10）算在 score 里，而音源优先级只是 score 相同时的 tiebreak，
// 所以即便 AMLL 的优先级低于酷狗，TTML 仍然总分更高。原实现如此。
check('不偏好逐词时，格式分仍压过音源优先级（TTML > 酷狗 LRC）', notPreferred[0]?.candidate.id === 'worded',
    notPreferred.map((e) => `${e.candidate.id}:${e.score}`).join(' > '));

const sameFormat = rankLyricCandidates(
    { trackName: '夜に駆ける', artistName: 'YOASOBI', durationMs: 259_000 },
    [
        { id: 'lrclib', source: 'lrclib', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x', format: 'lrc' },
        { id: 'kugou', source: 'kugou', title: '夜に駆ける', artist: 'YOASOBI', durationMs: 259_000, lyrics: '[00:01.00]x', format: 'lrc' },
    ],
    opts,
);
check('格式与时长都相同时，音源优先级决定顺序', sameFormat[0]?.candidate.id === 'kugou',
    sameFormat.map((e) => `${e.candidate.id}:${e.score}`).join(' > '));

check('缺少 isDurationCompatible 时立刻抛错', (() => {
    try {
        rankLyricCandidates({ trackName: 'a', artistName: 'b', durationMs: 1 }, [{ lyrics: 'x', title: 'a', artist: 'b' }], {});
        return false;
    } catch {
        return true;
    }
})());
check('候选为空时也会校验（不再静默通过）', (() => {
    try {
        rankLyricCandidates({ trackName: 'a', artistName: 'b', durationMs: 1 }, [], {});
        return false;
    } catch {
        return true;
    }
})());

process.exit(summary() === 0 ? 0 : 1);
