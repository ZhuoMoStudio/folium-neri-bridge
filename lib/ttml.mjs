// lib/ttml.mjs
//
// AMLL / Apple Music 风格的 TTML 逐字歌词解析。纯函数，不联网，可以在 Node 里直接测。
//
// 输出形状对齐 Folium 的 FoliumLine（src/mods/folium/contract.ts:126）：
//   { startTime, endTime, fullText, words: [{ text, startTime, endTime, syllables: [...] }] }
// 逐字高亮看的是 `words[].syllables[]`，所以转换的关键是把 <span begin end> 那层
// 归到 syllable 上，再按 Folia 自己的规则（src/utils/lyrics/ttmlConversion.ts 的
// buildWordsFromSyllables）把相邻 syllable 合成一个 word。
//
// 之所以自己写而不是 vendor 一个 TTML 解析器：模组的 client 入口不能 import 裸模块名
// （用了就是运行时找不到模块），而这里只需要 TTML 很小的一个子集。
//
// 规范：https://github.com/amll-dev/amll-ttml-db/blob/main/instructions/ttml-specification-en.md
//
// 已知的有意简化（都只影响稀有写法）：
//   - head 里的 Apple Music 风格 <translations><text for="L1"> 不解析：TTDB 里的文件
//     用的是行内 <span ttm:role="x-translation">，实测服务端返回的就是行内那种。
//   - 不处理 ruby（AMLL 的 TTDB 不用）。
//
// 注意：这里产出的行**不带 renderHints**。宿主在 src/mods/folium/dto.ts 的
// fromFoliumLines 里会自己 buildLineRenderHints，模组给的值会被忽略。

/** 时间的 `15.8s` 写法。 */
const SECONDS_SUFFIX = /^(\d+(?:\.\d+)?)s$/i;

/**
 * TTML 时间 → 秒。
 *
 * 小数位规则按规范：点后 1 位是十分之一秒、2 位是百分之一秒、3 位是毫秒 ——
 * 三者恰好都等于直接的十进制小数，所以统一用浮点解析，不做位移。
 *
 * @returns {number|null} 秒；解析不出来返回 null（调用方据此跳过该行）
 */
export const parseTtmlTime = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return null;

    const suffixed = text.match(SECONDS_SUFFIX);
    if (suffixed) {
        const seconds = Number(suffixed[1]);
        return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
    }

    const parts = text.split(':');
    if (parts.length > 3) return null;
    const numbers = [];
    for (let index = 0; index < parts.length; index += 1) {
        const raw = parts[index].trim();
        if (!raw) return null;
        // 小数点只允许出现在最后一段
        if (index < parts.length - 1 && raw.includes('.')) return null;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        numbers.push(parsed);
    }
    // 带冒号的写法里，分与秒必须小于 60（规范明确要求）；只有秒的那段可以超过 60
    for (let index = 0; index < numbers.length - 1; index += 1) {
        if (numbers[index] >= 60) return null;
    }
    if (numbers.length > 1 && Math.floor(numbers[numbers.length - 1]) > 59) return null;

    return numbers.reduce((total, part) => total * 60 + part, 0);
};

// ---------------------------------------------------------------- 极小的 XML 树

const TOKEN_PATTERN =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<\s*([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE_PATTERN = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const decodeEntities = (text) =>
    text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&');

/**
 * 本地名：`ttm:role` → `role`，`span` 原样。
 * 属性前缀没有语义差别（`ttm:role` 与 `role` 在这里等价），统一剥掉省得写两份判断。
 */
export const localName = (name) => {
    const text = String(name ?? '');
    const colon = text.indexOf(':');
    return colon >= 0 ? text.slice(colon + 1) : text;
};

const parseAttributes = (raw) => {
    const attrs = {};
    if (!raw) return attrs;
    for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
        attrs[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? '');
    }
    return attrs;
};

/**
 * 把 XML 文本解析成树。只做 TTML 需要的那一点点，不做严格的良构校验 ——
 * 输入来自歌词库而不是攻击者，容错解析比严格报错更有用。
 */
export const parseXmlTree = (text) => {
    const root = { name: '#root', attrs: {}, children: [] };
    const stack = [root];
    const source = String(text ?? '');
    let lastIndex = 0;

    const pushText = (raw) => {
        if (!raw) return;
        stack[stack.length - 1].children.push({ type: 'text', text: decodeEntities(raw) });
    };

    TOKEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOKEN_PATTERN.exec(source)) !== null) {
        pushText(source.slice(lastIndex, match.index));
        lastIndex = TOKEN_PATTERN.lastIndex;
        const token = match[0];
        if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<![')) continue;

        if (match[1]) {
            // 闭合标签：从栈顶往下找最近的同名元素并弹栈；找不到就忽略（容错）
            const name = localName(match[1]);
            for (let index = stack.length - 1; index > 0; index -= 1) {
                if (stack[index].name === name) {
                    stack.length = index;
                    break;
                }
            }
            continue;
        }

        // 元素名一律存本地名：`amll:meta` → `meta`，否则 findAll 得写两套判断
        const element = { name: localName(match[2]), attrs: parseAttributes(match[3]), children: [] };
        stack[stack.length - 1].children.push(element);
        if (!match[4]) stack.push(element);
    }
    pushText(source.slice(lastIndex));
    return root;
};

const elementsOf = (node, name) =>
    (node?.children ?? []).filter((child) => child.type !== 'text' && (!name || child.name === name));

/** 深度优先收集所有指定名字的元素。 */
const findAll = (node, name, out = []) => {
    for (const child of elementsOf(node)) {
        if (child.name === name) out.push(child);
        findAll(child, name, out);
    }
    return out;
};

const textOf = (node) =>
    (node?.children ?? []).map((child) => (child.type === 'text' ? child.text : textOf(child))).join('');

// ---------------------------------------------------------------- 行 → FoliumLine

const NON_WESTERN = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/u;
const WESTERN_JOINABLE = /[\p{Script=Latin}\p{N}'’`-]/u;

/** 拉丁词的 syllable 片段（`Hel`+`lo`）该合回一个 word；CJK 不该合。 */
const isWesternJoinable = (text) => {
    const trimmed = String(text ?? '').trim();
    return trimmed.length > 0 && !NON_WESTERN.test(trimmed) && WESTERN_JOINABLE.test(trimmed);
};

const ROLE_TRANSLATION = 'x-translation';
const ROLE_ROMAN = 'x-roman';
const ROLE_BACKGROUND = 'x-bg';

/**
 * 这段空白是不是「歌词里的空格」。
 *
 * 规范的写法是把词间空格写在 span 之间（`<span>a</span> <span>b</span>`），
 * 但**格式化过的 TTML 里，元素之间的换行与缩进也是空白文本节点**。
 * 两者必须区分：前者是内容，后者是排版。判别方法是看有没有换行 ——
 * TTDB 的上传规范明确要求文件不要格式化，所以真空格不会跨行。
 * 不区分的话，每一个格式化过的文件都会在每行末尾多出一个空格，
 * `words.map(w=>w.text).join('')` 就会与 fullText 差一个字符，
 * 而宿主偏偏用这条不变量来决定要不要重新对齐词（enhancedLrcSerializer.alignWordSegments）。
 */
const isContentSpace = (text) => /[ \t]/.test(text) && !/[\r\n]/.test(text);

/** 一个元素的 begin/end。缺任一个就返回 null —— 那不是逐字节点。 */
const readSpanTime = (node) => {
    const begin = parseTtmlTime(node.attrs?.begin);
    const end = parseTtmlTime(node.attrs?.end);
    if (begin === null || end === null) return null;
    return { startTime: begin, endTime: Math.max(begin, end) };
};

/**
 * 把一段原始文本规范化成一个 syllable，并把「前缀空白」折算给上一个 syllable 的尾部。
 *
 * 为什么是前缀：实测 TTDB 的空格写在**下一个** span 的开头
 * （`<span>Couldn't</span><span> beat</span>`），规范三种写法里它属于第一种。
 * 为什么折算而不是原样留着：宿主 src/utils/lyrics/enhancedLrcSerializer.ts 的
 * alignWordSegments 明确依赖「words 拼接 === fullText」这条不变量来还原空格，
 * 拼接对不上时它会自己去 fullText 里找词。所以空格必须落在它该在的那个词上，
 * 而且 `words.map(w => w.text).join('') === fullText` 要成立。
 *
 * 纯空白的 span（规范里的第三种写法：`<span begin end> </span>`）不产生 syllable，
 * 只把空格折算给上一个。
 */
const pushSyllable = (syllables, node) => {
    const time = readSpanTime(node);
    if (!time) return;
    const raw = textOf(node);

    const previous = syllables[syllables.length - 1];
    const markPreviousSpace = () => {
        if (!previous) return;
        previous.endsWithSpace = true;
        if (!/\s$/.test(previous.text)) previous.text += ' ';
    };

    // 只有「内容空格」才折算；缩进换行不算
    const leadingRaw = raw.match(/^[ \t]+/)?.[0] ?? '';
    const trailingRaw = raw.match(/[ \t]+$/)?.[0] ?? '';
    if (isContentSpace(leadingRaw)) markPreviousSpace();

    const trimmed = raw.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!trimmed) {
        // 整段是空白（规范里的第三种写法：`<span begin end> </span>`）
        if (isContentSpace(raw)) markPreviousSpace();
        return;
    }

    const syllable = { text: trimmed, startTime: time.startTime, endTime: time.endTime };
    if (isContentSpace(trailingRaw)) {
        syllable.endsWithSpace = true;
        syllable.text += ' ';
    }
    syllables.push(syllable);
};

/**
 * 把一行 <p> 的内容拆成：正文 syllable、翻译、音译、背景人声。
 *
 * 正文里有「元素」和「元素之间的空白文本节点」两类内容，两类都要处理：
 * 规范允许把词间空格写成独立文本节点（推荐写法），也允许写在 span 里。
 */
const readParagraphContent = (paragraph) => {
    const syllables = [];
    const translations = [];
    const romanizations = [];
    const backgrounds = [];
    /** `<p>` 直接包含的文本（行级 TTML 就是这种形状）。 */
    let looseText = '';

    /** 元素之间的空白文本节点：折算成「上一个 syllable 以空格结尾」。 */
    const noteSpace = () => {
        const last = syllables[syllables.length - 1];
        if (!last) return;
        last.endsWithSpace = true;
        if (!/\s$/.test(last.text)) last.text += ' ';
    };

    const collectSyllables = (node) => {
        const nested = elementsOf(node).filter((child) => readSpanTime(child) !== null);
        if (nested.length === 0) {
            pushSyllable(syllables, node);
            return;
        }
        // 一组 syllable（`<span><span/><span/></span>`）：逐个收，跳过外层容器本身
        for (const child of nested) pushSyllable(syllables, child);
    };

    const readBackground = (span) => {
        const time = readSpanTime(span);
        const vocalSyllables = [];
        const vocal = {
            text: textOf(span).replace(/\s+/g, ' ').trim(),
            startTime: time?.startTime ?? null,
            endTime: time?.endTime ?? null,
            syllables: vocalSyllables,
            translations: [],
            romanizations: [],
        };
        for (const child of elementsOf(span)) {
            const role = child.attrs?.role;
            if (role === ROLE_TRANSLATION) {
                const text = textOf(child).trim();
                if (text) vocal.translations.push({ text, language: child.attrs.lang });
                continue;
            }
            if (role === ROLE_ROMAN) {
                const text = textOf(child).trim();
                if (text) vocal.romanizations.push({ text, language: child.attrs.lang });
                continue;
            }
            pushSyllable(vocalSyllables, child);
        }
        return vocal;
    };

    for (const child of paragraph.children ?? []) {
        if (child.type === 'text') {
            looseText += child.text;
            if (isContentSpace(child.text)) noteSpace();
            continue;
        }
        const role = child.attrs?.role;
        if (role === ROLE_TRANSLATION) {
            const text = textOf(child).trim();
            if (text) translations.push({ text, language: child.attrs.lang });
            continue;
        }
        if (role === ROLE_ROMAN) {
            const text = textOf(child).trim();
            if (text) romanizations.push({ text, language: child.attrs.lang });
            continue;
        }
        if (role === ROLE_BACKGROUND) {
            backgrounds.push(readBackground(child));
            continue;
        }
        // 独立成节点的空格（规范里的第三种写法）：无时间标签、整段是空白
        if (readSpanTime(child) === null && /^\s+$/.test(textOf(child))) {
            noteSpace();
            continue;
        }
        collectSyllables(child);
    }

    // 行级 TTML：`<p begin end>正文</p>`，文本是 <p> 的直接子节点，没有 <span>。
    // 这种文件不该拿去当逐字用（hasWordTiming 会是 false），但行本身要能解析出来。
    if (syllables.length === 0) {
        const text = looseText.replace(/\s+/g, ' ').trim();
        const begin = parseTtmlTime(paragraph.attrs?.begin);
        const end = parseTtmlTime(paragraph.attrs?.end);
        if (text && begin !== null && end !== null) {
            syllables.push({ text, startTime: begin, endTime: Math.max(begin, end) });
        }
    }

    return { syllables, translations, romanizations, backgrounds };
};

/**
 * 相邻 syllable 合成 word。规则照抄 Folia 的 buildWordsFromSyllables：
 * 只有在「当前片段不以空格结尾」且两侧都是拉丁片段时才合并，CJK 一律一字一词。
 */
const groupSyllablesIntoWords = (syllables) => {
    const words = [];
    let group = [];

    const flush = () => {
        if (group.length === 0) return;
        const text = group.map((syllable) => syllable.text).join('');
        if (text.trim().length > 0) {
            words.push({
                text,
                startTime: group[0].startTime,
                endTime: group[group.length - 1].endTime,
                syllables: group,
            });
        }
        group = [];
    };

    for (let index = 0; index < syllables.length; index += 1) {
        const current = syllables[index];
        const next = syllables[index + 1];
        group.push(current);
        const mergeWithNext =
            Boolean(next) &&
            !current.endsWithSpace &&
            isWesternJoinable(current.text) &&
            isWesternJoinable(next.text);
        if (!mergeWithNext) flush();
    }
    flush();
    return words;
};

/** 翻译/音译：优先中文，其次第一条。 */
const pickPreferred = (entries) => entries.find((entry) => /^zh/i.test(entry.language ?? '')) ?? entries[0] ?? null;

const CHORUS_PART = 'chorus';
const isChorusPart = (songPart) => String(songPart ?? '').trim().toLowerCase() === CHORUS_PART;

/** 收集带 song-part 的行：`<div itunes:song-part="Chorus">` 里的行算副歌。 */
const paragraphsWithDivs = (tree) => {
    const out = [];
    const walk = (node, div) => {
        for (const child of elementsOf(node)) {
            if (child.name === 'p') out.push({ paragraph: child, div });
            else if (child.name === 'div') walk(child, child);
            else walk(child, div);
        }
    };
    walk(tree, null);
    return out;
};

/**
 * 解析 TTML → FoliumLine[]。
 *
 * @returns {{ lines: object[], metadata: object, hasWordTiming: boolean }}
 *          `hasWordTiming` 为 false 时说明文件里只有行级时间（不该拿去当逐字用）。
 */
export const parseTtml = (text) => {
    const tree = parseXmlTree(text);

    const metadata = { musicName: [], artists: [], album: [], ids: {}, extra: {} };
    for (const meta of findAll(tree, 'meta')) {
        const key = meta.attrs.key;
        const value = String(meta.attrs.value ?? '').trim();
        if (!key || !value) continue;
        if (key === 'musicName') metadata.musicName.push(value);
        else if (key === 'artists') metadata.artists.push(value);
        else if (key === 'album') metadata.album.push(value);
        else if (/Id$/.test(key) || /^isrc$/i.test(key)) metadata.ids[key] = value;
        else metadata.extra[key] = value;
    }

    const lines = [];
    let hasWordTiming = false;

    for (const { paragraph, div } of paragraphsWithDivs(tree)) {
        const content = readParagraphContent(paragraph);
        if (content.syllables.length === 0) continue;

        // 行末的空格没有意义，而且会让 `words.map(w => w.text).join('')` 比 fullText
        // 多出一个字符 —— 实测 Idol 的 91 行里就有 1 行是这样（`Oh my savior`）。
        // 宿主拿那条不变量判断要不要自己去 fullText 里重新对齐词，差一个字符就白跑一趟。
        const lastSyllable = content.syllables[content.syllables.length - 1];
        if (/\s$/.test(lastSyllable.text)) {
            lastSyllable.text = lastSyllable.text.replace(/\s+$/, '');
            delete lastSyllable.endsWithSpace;
        }

        const words = groupSyllablesIntoWords(content.syllables);
        if (words.length === 0) continue;
        if (content.syllables.length > 1) hasWordTiming = true;

        const startTime = parseTtmlTime(paragraph.attrs.begin) ?? content.syllables[0].startTime;
        const rawEnd = parseTtmlTime(paragraph.attrs.end) ?? content.syllables[content.syllables.length - 1].endTime;
        const fullText = content.syllables.map((syllable) => syllable.text).join('').replace(/\s+/g, ' ').trim();
        if (!fullText) continue;

        const translation = pickPreferred(content.translations);
        const romanization = pickPreferred(content.romanizations);
        // 一种语言只留一条正文翻译，其余进 alternateTexts，避免同一段文案出现两次
        const alternates = [
            ...content.translations.filter((entry) => entry !== translation),
            ...content.romanizations.filter((entry) => entry !== romanization),
        ];

        const backgroundVocals = content.backgrounds
            .filter((vocal) => vocal.text)
            .map((vocal) => {
                const vocalTranslation = pickPreferred(vocal.translations);
                const vocalRoman = pickPreferred(vocal.romanizations);
                const from = vocal.startTime ?? startTime;
                const to = vocal.endTime ?? rawEnd;
                const vocalWords = groupSyllablesIntoWords(vocal.syllables);
                return {
                    text: vocal.text,
                    startTime: from,
                    endTime: to,
                    words: vocalWords.length > 0 ? vocalWords : [{ text: vocal.text, startTime: from, endTime: to }],
                    ...(vocalTranslation ? { translation: vocalTranslation.text } : {}),
                    ...(vocalRoman ? { romanization: vocalRoman.text } : {}),
                };
            });

        lines.push({
            startTime,
            endTime: Math.max(startTime, rawEnd),
            fullText,
            words,
            ...(translation ? { translation: translation.text } : {}),
            ...(romanization ? { romanization: romanization.text } : {}),
            ...(alternates.length > 0
                ? {
                    alternateTexts: alternates.map((entry) => ({
                        role: content.translations.includes(entry) ? 'translation' : 'romanization',
                        ...(entry.language ? { language: entry.language } : {}),
                        text: entry.text,
                    })),
                }
                : {}),
            ...(div && isChorusPart(div.attrs?.['song-part']) ? { isChorus: true } : {}),
            ...(backgroundVocals.length > 0 ? { backgroundVocals } : {}),
        });
    }

    // 行必须按时间排好：宿主那边是顺序推进的
    lines.sort((left, right) => left.startTime - right.startTime);

    return { lines, metadata, hasWordTiming };
};

/** 只要判断「有没有逐字时轴」时用的快捷检查，不建树。 */
export const ttmlHasWordTiming = (text) => /<span[^>]*\bbegin\s*=/i.test(String(text ?? ''));
