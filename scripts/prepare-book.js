'use strict';

const fs = require('fs');
const path = require('path');
const {
  aggregateStats,
  cleanChapter,
  renderNovel,
  sanitizeScrapeArtifacts,
  selectChapters,
  splitNovel,
} = require('../core/novel-core');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input || !args.output) {
    throw new Error('用法: node prepare-book.js --input <源TXT> --output <输出TXT> [--report <报告TXT>] [--json <分析JSON>] [--start 240] [--end 9999]');
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const start = Number(args.start || 240);
  const end = args.end ? Number(args.end) : Infinity;
  const source = fs.readFileSync(inputPath, 'utf8');
  const sanitized = sanitizeScrapeArtifacts(source);
  const parsed = splitNovel(sanitized.text);
  const selected = selectChapters(parsed.chapters, start, end);
  const cleaned = selected.map((chapter) => cleanChapter(chapter));
  const cleanupStats = aggregateStats(cleaned);
  const missingNumbers = [];
  for (let i = 1; i < parsed.chapters.length; i += 1) {
    const previous = parsed.chapters[i - 1].number;
    const current = parsed.chapters[i].number;
    for (let n = previous + 1; n < current && missingNumbers.length < 500; n += 1) missingNumbers.push(n);
  }
  const charCounts = selected.map((chapter) => chapter.rawBody.length);
  const averageChars = charCounts.length ? Math.round(charCounts.reduce((sum, count) => sum + count, 0) / charCounts.length) : 0;
  const maxChars = charCounts.length ? Math.max(...charCounts) : 0;
  const minChars = charCounts.length ? Math.min(...charCounts) : 0;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderNovel(cleaned, { title: '百世飞升', author: '白眉罗汉' }), 'utf8');

  const report = [
    '《百世飞升》从第240章起整理报告',
    '',
    `源文件：${inputPath}`,
    `输出文件：${outputPath}`,
    `识别章节：${formatNumber(parsed.stats.chapterCount)} 章`,
    `整理范围：第 ${selected[0]?.number ?? start} 章至第 ${selected[selected.length - 1]?.number ?? end} 章，共 ${formatNumber(cleaned.length)} 章`,
    `平均章节长度：${formatNumber(averageChars)} 字符；最短 ${formatNumber(minChars)}；最长 ${formatNumber(maxChars)}`,
    '',
    '自动处理统计',
    `- 删除已确认的异书混入片段：${formatNumber(sanitized.stats.knownIntrusionLinesRemoved)} 行`,
    `- 合并重复章节标题：${formatNumber(parsed.stats.duplicateHeaders)} 处`,
    `- 按上下文修正误标章节号：${formatNumber(parsed.stats.correctedHeaders || 0)} 处`,
    `- 忽略疑似目录/倒序标题：${formatNumber(parsed.stats.suspiciousHeaders)} 处`,
    `- 删除整行抓取噪声：${formatNumber(cleanupStats.noiseLinesRemoved)} 处`,
    `- 删除行内翻页/抓取提示：${formatNumber(cleanupStats.inlineNoiseRemoved)} 处`,
    `- 删除疑似章节导航长行：${formatNumber(cleanupStats.suspiciousNavigationLinesRemoved)} 处`,
    `- 拼接被翻页提示截断的句子：${formatNumber(cleanupStats.joinedFragments)} 处`,
    `- 词形与重复标点修正：${formatNumber(Object.values(cleanupStats.replacements).reduce((sum, count) => sum + count, 0))} 处`,
    '',
    '章节完整性',
    missingNumbers.length ? `- 检测到缺失章节号：${missingNumbers.slice(0, 100).join('、')}${missingNumbers.length > 100 ? '……' : ''}` : '- 未检测到章节号缺口。',
    `- 解析警告：${formatNumber(parsed.warnings.length)} 条（详见 JSON 分析文件）。`,
    '',
    '说明',
    '- 本次先执行可验证、可回溯的规则化整理：章节拆分、重复标题合并、网页噪声清除、断句拼接、排版统一和高置信错字修正。',
    '- 为避免批量改写造成情节、人物、功法名误改，没有对无法确认的专名和作者表达做激进替换。工作台已支持接入 FreeLLMAPI 或其他 OpenAI 兼容模型做二次语义校对。',
    '- 建议默认每批 3 章、并发 2 批（同时约 6 章），并设置单批 18,000 字符安全上限。本书单章平均约 4,700 字符；若设为每批 5 章、并发 10 批，会让约 50 章同时在途，容易触发免费模型限流、上下文超限或输出错位。',
  ].join('\n');

  if (args.report) {
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${report}\n`, 'utf8');
  }

  if (args.json) {
    const jsonPath = path.resolve(args.json);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({
      source: inputPath,
      output: outputPath,
      generatedAt: new Date().toISOString(),
      range: {
        requestedStart: start,
        requestedEnd: Number.isFinite(end) ? end : null,
        actualStart: selected[0]?.number ?? null,
        actualEnd: selected[selected.length - 1]?.number ?? null,
        chapterCount: cleaned.length,
      },
      parseStats: parsed.stats,
      prefilterStats: sanitized.stats,
      cleanupStats,
      chapterLength: { average: averageChars, min: minChars, max: maxChars },
      missingNumbers,
      warnings: parsed.warnings,
      chapters: cleaned.map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        sourceLine: chapter.sourceLine,
        chars: chapter.body.length,
        stats: chapter.stats,
      })),
    }, null, 2), 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    inputPath,
    outputPath,
    chaptersParsed: parsed.stats.chapterCount,
    chaptersCleaned: cleaned.length,
    firstChapter: selected[0]?.number ?? null,
    lastChapter: selected[selected.length - 1]?.number ?? null,
    averageChars,
    duplicateHeaders: parsed.stats.duplicateHeaders,
    suspiciousHeaders: parsed.stats.suspiciousHeaders,
    cleanupStats,
    prefilterStats: sanitized.stats,
    missingNumbers: missingNumbers.length,
    warnings: parsed.warnings.length,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
