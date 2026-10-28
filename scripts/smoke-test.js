'use strict';

const fs = require('fs');

const BASE = process.env.WORKBENCH_URL || 'http://127.0.0.1:3210';
const INPUT = process.argv[2];

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function main() {
  if (!INPUT) throw new Error('请传入测试 TXT 路径。');
  const defaults = await request('/api/defaults');
  if (defaults.batching.concurrency !== 2) throw new Error('默认并发数不正确。');

  const text = fs.readFileSync(INPUT, 'utf8');
  const document = await request('/api/documents/analyze', {
    method: 'POST',
    body: JSON.stringify({ fileName: '百世飞升 作者 白眉罗汉.txt', text }),
  });
  if (document.firstChapter !== 1 || document.lastChapter !== 963) throw new Error('章节范围识别异常。');
  if (document.chapterCount < 950) throw new Error('识别章节数异常。');

  let job = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      documentId: document.id,
      start: 240,
      end: 242,
      mode: 'rules',
      chaptersPerBatch: 3,
      concurrency: 2,
      maxCharsPerBatch: 18000,
      rules: defaults.rules,
      provider: defaults.provider,
    }),
  });

  const deadline = Date.now() + 20000;
  while (!['completed', 'failed', 'canceled'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    job = await request(`/api/jobs/${job.id}`);
  }
  if (job.status !== 'completed') throw new Error(`规则任务未完成：${job.status} ${job.error || ''}`);
  if (!job.output?.textUrl || job.completedChapters !== 3) throw new Error('导出结果不完整。');

  const download = await fetch(`${BASE}${job.output.textUrl}`);
  const outputText = await download.text();
  if (!outputText.includes('第240章') || !outputText.includes('第242章')) throw new Error('合并导出缺少章节。');

  console.log(JSON.stringify({
    server: BASE,
    chapters: document.chapterCount,
    range: [document.firstChapter, document.lastChapter],
    correctedHeaders: document.correctedHeaders,
    smokeJob: { status: job.status, completedChapters: job.completedChapters, totalBatches: job.totalBatches },
    output: job.output.textName,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
