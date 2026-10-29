'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareText } = require('../public/diff');

test('章节对比保留两侧原文并标记增删，包括缩进和特殊字符', () => {
  const before = '第一段\n童孔看见 <书>。\n删除广告\n';
  const after = '　　第一段\n　　瞳孔看见 <书>！\n新的一行\n';
  const diff = compareText(before, after);
  assert.equal(diff.filter((x) => x.type !== 'added').map((x) => x.value).join(''), before);
  assert.equal(diff.filter((x) => x.type !== 'removed').map((x) => x.value).join(''), after);
  assert.ok(diff.some((x) => x.type === 'removed' && x.value.includes('童')));
  assert.ok(diff.some((x) => x.type === 'added' && x.value.includes('瞳')));
});

test('超大差异采用整段标记，不丢失内容', () => {
  const before = '甲'.repeat(1000), after = '乙'.repeat(1000);
  const diff = compareText(before, after);
  assert.equal(diff.filter((x) => x.type !== 'added').map((x) => x.value).join(''), before);
  assert.equal(diff.filter((x) => x.type !== 'removed').map((x) => x.value).join(''), after);
});
