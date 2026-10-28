'use strict';

const HEADER_RE = /^\s*第\s*([0-9０-９零〇一二两三四五六七八九十百千万]+)\s*([章回节])\s*(.*?)\s*$/;
const CHAPTER_REF_RE = /第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章回节]/g;

const CN_DIGITS = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
const CN_UNITS = { '十': 10, '百': 100, '千': 1000, '万': 10000 };

function normalizeDigits(value) {
  return value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function chineseNumeralToNumber(value) {
  const normalized = normalizeDigits(String(value || '').trim());
  if (/^\d+$/.test(normalized)) return Number(normalized);

  let section = 0;
  let total = 0;
  let currentDigit = 0;
  for (const char of normalized) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, char)) {
      currentDigit = CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (!unit) return NaN;
    if (unit === 10000) {
      section += currentDigit;
      total += section * unit;
      section = 0;
      currentDigit = 0;
    } else {
      if (currentDigit === 0) currentDigit = 1;
      section += currentDigit * unit;
      currentDigit = 0;
    }
  }
  return total + section + currentDigit;
}

function parseHeader(line) {
  const normalized = String(line || '').replace(/\u00a0/g, ' ');
  const match = normalized.match(HEADER_RE);
  if (!match) return null;
  const number = chineseNumeralToNumber(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  const refs = normalized.match(CHAPTER_REF_RE) || [];
  if (refs.length > 1) return { suspicious: true, number, raw: normalized };
  const title = match[3].trim();
  if (normalized.length > 120 || title.length > 90) {
    return { suspicious: true, number, raw: normalized };
  }
  return { suspicious: false, number, unit: match[2], title, raw: normalized };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ');
}

function sanitizeScrapeArtifacts(text) {
  const lines = normalizeText(text).split('\n');
  const output = [];
  const stats = { knownIntrusionBlocksRemoved: 0, knownIntrusionLinesRemoved: 0 };
  const knownBlocks = [
    {
      start: '秦素烟听季子璃给她说了很多关于慕少恭的事情',
      end: '李庸笑着解释道，随着李庸的开口',
      maxLines: 120,
    },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const block = knownBlocks.find((item) => lines[index].includes(item.start));
    if (!block) {
      output.push(lines[index]);
      continue;
    }

    let endIndex = -1;
    for (let cursor = index; cursor < lines.length && cursor <= index + block.maxLines; cursor += 1) {
      if (lines[cursor].includes(block.end)) {
        endIndex = cursor;
        break;
      }
    }
    if (endIndex < 0) {
      output.push(lines[index]);
      continue;
    }
    stats.knownIntrusionBlocksRemoved += 1;
    stats.knownIntrusionLinesRemoved += endIndex - index + 1;
    index = endIndex;
  }

  return { text: output.join('\n'), stats };
}

function splitNovel(text) {
  const lines = normalizeText(text).split('\n');
  const warnings = [];
  const rawCandidates = [];
  let suspiciousHeaders = 0;
  let duplicateHeaders = 0;
  let correctedHeaders = 0;

  lines.forEach((line, lineIndex) => {
    const parsed = parseHeader(line);
    if (!parsed) return;
    if (parsed.suspicious) {
      suspiciousHeaders += 1;
      warnings.push(`第 ${lineIndex + 1} 行疑似目录或抓取噪声：${line.slice(0, 100)}`);
      rawCandidates.push({ ...parsed, lineIndex, rejected: true, reason: 'suspicious-line' });
      return;
    }
    rawCandidates.push({ ...parsed, lineIndex, rejected: false });
  });

  const accepted = [];
  const rejectedRanges = [];
  const validCandidates = rawCandidates.filter((candidate) => !candidate.rejected);

  const nextDistinctNumber = (index, number) => {
    for (let cursor = index + 1; cursor < validCandidates.length && cursor <= index + 8; cursor += 1) {
      if (validCandidates[cursor].number !== number) return validCandidates[cursor].number;
    }
    return null;
  };

  for (let index = 0; index < validCandidates.length; index += 1) {
    const candidate = validCandidates[index];
    if (!accepted.length) {
      accepted.push({ ...candidate, originalNumber: candidate.number });
      continue;
    }

    const current = accepted[accepted.length - 1];
    if (candidate.number === current.number ||
        (candidate.number === current.originalNumber && candidate.lineIndex - current.lineIndex <= 5)) {
      duplicateHeaders += 1;
      if (!current.title && candidate.title) current.title = candidate.title;
      continue;
    }

    if (candidate.number === current.number + 1) {
      accepted.push({ ...candidate, originalNumber: candidate.number });
      continue;
    }

    const nextDistinct = nextDistinctNumber(index, candidate.number);
    if (candidate.number > current.number + 1) {
      const gap = candidate.number - current.number;
      const looksMisnumbered = gap <= 10 && nextDistinct === current.number + 2;
      if (looksMisnumbered) {
        correctedHeaders += 1;
        warnings.push(`第 ${candidate.lineIndex + 1} 行章节号 ${candidate.number} 疑似误标，按上下文顺序修正为 ${current.number + 1}。`);
        accepted.push({ ...candidate, originalNumber: candidate.number, number: current.number + 1, corrected: true });
      } else if (gap <= 10) {
        warnings.push(`章节号从 ${current.number} 跳到 ${candidate.number}，可能存在缺章。`);
        accepted.push({ ...candidate, originalNumber: candidate.number });
      } else {
        suspiciousHeaders += 1;
        warnings.push(`第 ${candidate.lineIndex + 1} 行章节号从 ${current.number} 跳到 ${candidate.number}，已按异书混入或目录噪声忽略。`);
        rejectedRanges.push({ start: candidate.lineIndex, reason: 'far-jump' });
      }
      continue;
    }

    if (candidate.number < current.number) {
      const looksMisnumbered = nextDistinct === current.number + 2;
      if (looksMisnumbered) {
        correctedHeaders += 1;
        warnings.push(`第 ${candidate.lineIndex + 1} 行倒序章节号 ${candidate.number} 疑似误标，按上下文顺序修正为 ${current.number + 1}。`);
        accepted.push({ ...candidate, originalNumber: candidate.number, number: current.number + 1, corrected: true });
      } else {
        suspiciousHeaders += 1;
        warnings.push(`第 ${candidate.lineIndex + 1} 行出现倒序章节号 ${candidate.number}，已按抓取噪声忽略。`);
      }
    }
  }

  for (const range of rejectedRanges) {
    const nextAccepted = accepted.find((candidate) => candidate.lineIndex > range.start);
    range.end = nextAccepted ? nextAccepted.lineIndex : lines.length;
  }

  const shouldDropLine = (lineIndex) => rejectedRanges.some((range) => lineIndex >= range.start && lineIndex < range.end);
  const chapters = accepted.map((candidate, index) => {
    const nextLine = accepted[index + 1]?.lineIndex ?? lines.length;
    const bodyLines = [];
    for (let lineIndex = candidate.lineIndex + 1; lineIndex < nextLine; lineIndex += 1) {
      if (shouldDropLine(lineIndex)) continue;
      const parsed = parseHeader(lines[lineIndex]);
      if (parsed) continue;
      bodyLines.push(lines[lineIndex]);
    }
    return {
      number: candidate.number,
      originalNumber: candidate.originalNumber,
      title: candidate.title,
      sourceLine: candidate.lineIndex + 1,
      rawBody: bodyLines.join('\n'),
      corrected: Boolean(candidate.corrected),
    };
  });

  return {
    preamble: accepted.length ? lines.slice(0, accepted[0].lineIndex).join('\n').trim() : lines.join('\n').trim(),
    chapters,
    warnings,
    stats: {
      totalLines: lines.length,
      chapterCount: chapters.length,
      duplicateHeaders,
      suspiciousHeaders,
      correctedHeaders,
    },
  };
}

const EXACT_NOISE_PATTERNS = [
  /^百世飞升$/,
  /^作者[：:]\s*白眉罗汉$/,
  /^简介[：:]?$/,
  /^本章未完[！!。.]?$/,
  /^本章未完[，,]\s*请点击下一页继续(?:阅读)?[。.]?$/,
  /^本章未完，请点击下一页继续(?:阅读)?[。.]?$/,
  /^请点击下一页继续(?:阅读)?[。.]?$/,
  /^手机站全新改版升级地址[：:].*$/,
  /^最新网址[：:].*$/,
  /^章节错误.*$/,
  /^无广告清新阅读.*$/,
  /^写不出来了[，,]\s*休息一下[。.]?$/,
  /^[（(]本章完[）)]$/,
  /^(?:作者|白眉).*?(?:请假|休息|抱歉|更新|拉肚|生病|住院).*$/,
];

const INLINE_NOISE_PATTERNS = [
  /本章未完[！!。.]?(?:[，,]\s*)?(?:请)?点击下一页继续(?:阅读)?[。.]?/g,
  /本章未完[！!。.]?/g,
  /(?:请)?点击下一页继续(?:阅读)?[。.]?/g,
  /手机站全新改版升级地址[：:][^\n]*/g,
];

const SAFE_REPLACEMENTS = [
  [/童孔/g, '瞳孔', '童孔→瞳孔'],
  [/眼晴/g, '眼睛', '眼晴→眼睛'],
  [/己经/g, '已经', '己经→已经'],
  [/即然/g, '既然', '即然→既然'],
  [/必竟/g, '毕竟', '必竟→毕竟'],
  [/竟争/g, '竞争', '竟争→竞争'],
  [/无意是/g, '无疑是', '无意是→无疑是'],
  [/勐然/g, '猛然', '勐然→猛然'],
  [/勐地/g, '猛地', '勐地→猛地'],
  [/勐的/g, '猛地', '勐的→猛地'],
  [/噼开/g, '劈开', '噼开→劈开'],
  [/噼出/g, '劈出', '噼出→劈出'],
  [/噼斩/g, '劈斩', '噼斩→劈斩'],
  [/噼下/g, '劈下', '噼下→劈下'],
  [/噼向/g, '劈向', '噼向→劈向'],
  [/前途无亮/g, '前途无量', '前途无亮→前途无量'],
  [/捧跟/g, '捧哏', '捧跟→捧哏'],
  [/晒然一笑/g, '哂然一笑', '晒然一笑→哂然一笑'],
  [/暼(?=[一-龥])/g, '瞥', '暼→瞥'],
  [/暗澹/g, '黯淡', '暗澹→黯淡'],
  [/的的/g, '的', '重复“的”'],
  [/\.\.\.+/g, '……', '英文省略号→中文省略号'],
  [/。。+/g, '。', '重复句号'],
  [/，，+/g, '，', '重复逗号'],
  [/！！+/g, '！', '重复叹号'],
  [/？？+/g, '？', '重复问号'],
];

function cleanTitle(title) {
  return String(title || '')
    .replace(/[（(]\s*(?:求追读|求订阅|求月票|求推荐票|感谢订阅)[^）)]*[）)]/g, '')
    .replace(/^[：:、，,。.!！?？\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBody(rawBody, options = {}) {
  const stats = {
    noiseLinesRemoved: 0,
    inlineNoiseRemoved: 0,
    suspiciousNavigationLinesRemoved: 0,
    joinedFragments: 0,
    replacements: {},
  };
  const preserveBlankLines = Boolean(options.preserveBlankLines);
  const output = [];
  let joinNext = false;

  for (const rawLine of normalizeText(rawBody).split('\n')) {
    let line = rawLine.replace(/[ \t\u3000]+$/g, '').replace(/^[ \t]+/g, '');
    const trimmed = line.trim();
    const chapterRefs = trimmed.match(CHAPTER_REF_RE) || [];

    if ((chapterRefs.length >= 2 && trimmed.length > 25) || trimmed.length > 1200) {
      stats.suspiciousNavigationLinesRemoved += 1;
      continue;
    }
    if (EXACT_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      stats.noiseLinesRemoved += 1;
      continue;
    }

    let removedInline = false;
    for (const pattern of INLINE_NOISE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        removedInline = true;
        pattern.lastIndex = 0;
        line = line.replace(pattern, '');
      }
    }
    if (removedInline) {
      stats.inlineNoiseRemoved += 1;
      if (!/[。！？；：”’…]$/.test(line.trim())) joinNext = true;
    }

    line = line
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/<[^>]{1,200}>/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    for (const [pattern, replacement, label] of SAFE_REPLACEMENTS) {
      if (label === '占位') continue;
      const matches = line.match(pattern);
      if (matches && matches.length) {
        stats.replacements[label] = (stats.replacements[label] || 0) + matches.length;
        line = line.replace(pattern, replacement);
      }
    }

    if (!line) {
      if (preserveBlankLines && output.length && output[output.length - 1] !== '') output.push('');
      continue;
    }

    if (joinNext && output.length) {
      output[output.length - 1] += line.replace(/^　+/, '');
      stats.joinedFragments += 1;
      joinNext = false;
      continue;
    }

    if (/^(?:[—-]{3,}|[·•]{3,}|[…。]{3,})$/.test(line)) {
      output.push('　　……');
    } else {
      output.push(`　　${line.replace(/^　+/, '')}`);
    }
  }

  while (output.length && output[output.length - 1] === '') output.pop();
  return { text: output.join('\n'), stats };
}

function cleanChapter(chapter, options = {}) {
  const body = cleanBody(chapter.rawBody, options);
  return {
    number: chapter.number,
    title: cleanTitle(chapter.title),
    sourceLine: chapter.sourceLine,
    body: body.text,
    stats: body.stats,
  };
}

function aggregateStats(cleanedChapters) {
  const aggregate = {
    noiseLinesRemoved: 0,
    inlineNoiseRemoved: 0,
    suspiciousNavigationLinesRemoved: 0,
    joinedFragments: 0,
    replacements: {},
  };
  for (const chapter of cleanedChapters) {
    const stats = chapter.stats || {};
    for (const key of ['noiseLinesRemoved', 'inlineNoiseRemoved', 'suspiciousNavigationLinesRemoved', 'joinedFragments']) {
      aggregate[key] += stats[key] || 0;
    }
    for (const [label, count] of Object.entries(stats.replacements || {})) {
      aggregate.replacements[label] = (aggregate.replacements[label] || 0) + count;
    }
  }
  return aggregate;
}

function renderNovel(chapters, meta = {}) {
  const chunks = [];
  if (meta.title) chunks.push(meta.title.trim());
  if (meta.author) chunks.push(`作者：${meta.author.trim()}`);
  if (chunks.length) chunks.push('');

  for (const chapter of chapters) {
    chunks.push(`第${chapter.number}章${chapter.title ? ` ${chapter.title}` : ''}`);
    if (chapter.body) chunks.push(chapter.body);
    chunks.push('');
  }
  return `${chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function selectChapters(chapters, start, end) {
  const min = Number.isFinite(Number(start)) ? Number(start) : -Infinity;
  const max = Number.isFinite(Number(end)) ? Number(end) : Infinity;
  return chapters.filter((chapter) => chapter.number >= min && chapter.number <= max);
}

module.exports = {
  aggregateStats,
  chineseNumeralToNumber,
  cleanBody,
  cleanChapter,
  cleanTitle,
  normalizeText,
  parseHeader,
  renderNovel,
  sanitizeScrapeArtifacts,
  selectChapters,
  splitNovel,
};
