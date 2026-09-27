// test/01-offline.mjs —— 不联网的纯函数检查
import { check, summary } from './harness.mjs';
import { md5, utf8Bytes } from '../lib/md5.mjs';
import {
    extractPlainLyricsFromCollapsedTimeline,
    hasLrcTimestamp,
    isUsableTimedLyricTimeline,
} from '../lib/lrc.mjs';
import {
    cleanTrackName,
    isArtistCompatible,
    isDurationCompatible,
    isTitleCompatible,
    normalizeText,
    primaryArtist,
    stripHtml,
} from '../lib/match.mjs';

console.log('\n== lib/md5.mjs：RFC 1321 标准测试向量 ==');
check('md5("")', md5('') === 'd41d8cd98f00b204e9800998ecf8427e', md5(''));
check('md5("abc")', md5('abc') === '900150983cd24fb0d6963f7d28e17f72', md5('abc'));
check(
    'md5("The quick brown fox jumps over the lazy dog")',
    md5('The quick brown fox jumps over the lazy dog') === '9e107d9d372bb6826bd81d3542a419d6',
);
check(
    'md5(80 字符长串，跨越 2 个 512-bit 分块)',
    md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890') ===
        '57edf4a22be3c955ac49da2e2107b67a',
);
check('utf8Bytes("中") == [228,184,173]', JSON.stringify(utf8Bytes('中')) === '[228,184,173]');
check('utf8Bytes 处理代理对（emoji）', utf8Bytes('🎵').length === 4, JSON.stringify(utf8Bytes('🎵')));

console.log('\n== lib/lrc.mjs：塌缩时间轴判定 ==');
const normalLrc = ['[00:12.34]第一行', '[00:18.00]第二行', '[00:25.10]第三行'].join('\n');
const collapsedLrc = ['[00:00.00]第一行', '[00:00.00]第二行', '[00:00.00]第三行'].join('\n');
const twoLineCollapsed = ['[00:00.00]第一行', '[00:00.00]第二行'].join('\n');
const plainText = ['第一行', '第二行', '第三行'].join('\n');
check('正常 LRC 判定为可用', isUsableTimedLyricTimeline(normalLrc));
check('全同行时间戳判定为不可用', !isUsableTimedLyricTimeline(collapsedLrc));
check('两行同戳不算塌缩（下限为 3 行）', isUsableTimedLyricTimeline(twoLineCollapsed));
check('无时间戳判定为不可用', !isUsableTimedLyricTimeline(plainText));
check('hasLrcTimestamp 正确识别', hasLrcTimestamp(normalLrc) && !hasLrcTimestamp(plainText));
check(
    '塌缩歌词可降级出纯文本',
    extractPlainLyricsFromCollapsedTimeline(collapsedLrc) === '第一行\n第二行\n第三行',
    JSON.stringify(extractPlainLyricsFromCollapsedTimeline(collapsedLrc)),
);
check('非塌缩歌词不降级', extractPlainLyricsFromCollapsedTimeline(normalLrc) === null);

console.log('\n== lib/match.mjs：文本清洗与身份判定 ==');
check(
    'stripHtml 去标签与实体',
    stripHtml('<em class="keyword">夜</em>に駆ける &amp; more') === '夜に駆ける & more',
    stripHtml('<em class="keyword">夜</em>に駆ける &amp; more'),
);
check(
    'cleanTrackName 去掉 (Official Video)',
    cleanTrackName('夜に駆ける (Official Video)') === '夜に駆ける',
    cleanTrackName('夜に駆ける (Official Video)'),
);
check(
    'cleanTrackName 去掉【】包裹的中文标记',
    cleanTrackName('【MV】夜に駆ける') === '夜に駆ける',
    cleanTrackName('【MV】夜に駆ける'),
);
check('primaryArtist 取 feat. 之前', primaryArtist('YOASOBI feat. 幾田りら') === 'YOASOBI', primaryArtist('YOASOBI feat. 幾田りら'));
check('primaryArtist 取 "&" 之前', primaryArtist('A & B') === 'A', primaryArtist('A & B'));
check('normalizeText 全角转半角', normalizeText('ＡＢＣ') === 'abc', normalizeText('ＡＢＣ'));
check(
    'normalizeText 去掉标点只留字母数字与 CJK',
    normalizeText('夜に駆ける - YOASOBI!!') === '夜に駆ける yoasobi',
    normalizeText('夜に駆ける - YOASOBI!!'),
);

// 时长容差：max(7s, 预期*6%) 再封顶 15s（对齐 ExternalLyricMatchPolicy.kt）
// 240s → 6% = 14.4s，落在 7s..15s 之间，所以容差就是 14.4s
check('240s 歌：差 3s 通过', isDurationCompatible(240_000, 243_000));
check('240s 歌：差 14s 通过（14.4s 容差内）', isDurationCompatible(240_000, 254_000));
check('240s 歌：差 20s 拒绝（越过 14.4s）', !isDurationCompatible(240_000, 260_000));
// 100s → 6% = 6s < 7s，地板 7s 生效
check('100s 歌：地板 7s 生效，差 5s 通过', isDurationCompatible(100_000, 105_000));
check('100s 歌：差 10s 拒绝（越过 7s）', !isDurationCompatible(100_000, 110_000));
// 600s → 6% = 36s，但被 15s 封顶，所以容差是 15s 而不是 36s
check('600s 歌：封顶 15s 生效，差 10s 通过', isDurationCompatible(600_000, 610_000));
check('600s 歌：差 20s 拒绝（被 15s 封顶，不是 6%）', !isDurationCompatible(600_000, 620_000));
check('零时长拒绝', !isDurationCompatible(0, 240_000));

check('title 完全相同通过', isTitleCompatible('夜に駆ける', '夜に駆ける'));
check('title 带 (Official Video) 仍通过', isTitleCompatible('夜に駆ける', '夜に駆ける (Official Video)'));
check('title 明显不同应拒绝', !isTitleCompatible('夜に駆ける', '残酷な天使のテーゼ'));
check('artist 相同通过', isArtistCompatible('YOASOBI', 'YOASOBI'));
check('artist feat. 差异通过', isArtistCompatible('YOASOBI feat. 幾田りら', 'YOASOBI'));

process.exit(summary() === 0 ? 0 : 1);
