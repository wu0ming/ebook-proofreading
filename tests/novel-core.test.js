'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chineseNumeralToNumber,
  cleanBody,
  sanitizeScrapeArtifacts,
  splitNovel,
} = require('../core/novel-core');

test('中文章节号转换', () => {
  assert.equal(chineseNumeralToNumber('二百四十'), 240);
  assert.equal(chineseNumeralToNumber('九百六十三'), 963);
  assert.equal(chineseNumeralToNumber('２４０'), 240);
});

test('重复章节标题合并且保留正文', () => {
  const parsed = splitNovel('第一章 开始\n正文一\n第1章 开始\n正文二\n第二章 继续\n正文三');
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.stats.duplicateHeaders, 1);
  assert.match(parsed.chapters[0].rawBody, /正文一/);
  assert.match(parsed.chapters[0].rawBody, /正文二/);
});

test('远距离跳号按异书噪声忽略并恢复主线', () => {
  const parsed = splitNovel('第349章 主线\n主线甲\n第402章 异书\n异书内容\n第350章 主线续\n主线乙');
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.number), [349, 350]);
  assert.doesNotMatch(parsed.chapters[0].rawBody, /异书内容/);
});

test('结合后续编号修正误标章节号', () => {
  const parsed = splitNovel('第914章 A\na\n第918章 B\nb\n第916章 C\nc\n第917章 D\nd\n第918章 E\ne');
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.number), [914, 915, 916, 917, 918]);
  assert.equal(parsed.stats.correctedHeaders, 1);
});

test('清理翻页噪声与高置信错字', () => {
  const cleaned = cleanBody('　　他童孔一缩，勐的噼向石门……\n　　本章未完，点击下一页继续阅读。下一句');
  assert.match(cleaned.text, /瞳孔一缩，猛地劈向/);
  assert.doesNotMatch(cleaned.text, /本章未完|点击下一页/);
});

test('移除已确认的异书混入块', () => {
  const input = [
    '第914章 主线',
    '主线开始',
    '秦素烟听季子璃给她说了很多关于慕少恭的事情',
    '异书片段',
    '李庸笑着解释道，随着李庸的开口，众人回神',
    '主线恢复',
  ].join('\n');
  const result = sanitizeScrapeArtifacts(input);
  assert.equal(result.stats.knownIntrusionLinesRemoved, 3);
  assert.doesNotMatch(result.text, /异书片段/);
  assert.match(result.text, /主线恢复/);
});
