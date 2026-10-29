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
  const text = fs.readFileSync(INPUT, 'utf8');
  const document = await request('/api/documents/analyze', {
    method: 'POST',
    body: JSON.stringify({ fileName: '百世飞升 作者 白眉罗汉.txt', text }),
  });

  const saved = await request('/api/glossary/save', {
    method: 'POST',
    body: JSON.stringify({
      documentId: document.id,
      glossary: { entries: [{ name: '天柱界', type: 'place', aliases: ['天柱山'], note: '主要世界' }] },
    }),
  });
  if (saved.entryCount !== 1) throw new Error('词表保存结果不正确。');

  const loaded = await request(`/api/glossary?documentId=${encodeURIComponent(document.id)}`);
  if (loaded.glossary.entries.length !== 1) throw new Error('词表读取失败。');

  let job = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      documentId: document.id,
      start: 240,
      end: 241,
      mode: 'llm',
      chaptersPerBatch: 2,
      concurrency: 1,
      maxCharsPerBatch: 18000,
      rules: defaults.rules,
      useGlossary: true,
      glossaryAutoGrow: true,
      glossary: loaded.glossary,
      provider: { baseUrl: 'http://127.0.0.1:3001/v1', model: 'auto', apiKey: 'invalid-smoke-key' },
    }),
  });

  const deadline = Date.now() + 60000;
  while (!['completed', 'failed', 'canceled'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    job = await request(`/api/jobs/${job.id}`);
  }
  if (job.status !== 'completed' && job.status !== 'failed') throw new Error(`模型任务未结束：${job.status}`);
  if (job.glossary?.enabled !== true) throw new Error('任务未启用词表。');
  if (job.glossary?.entryCount < 1) throw new Error('任务未携带词表。');

  console.log(JSON.stringify({
    glossarySaved: saved.entryCount,
    glossaryLoaded: loaded.glossary.entries.length,
    providerPresets: defaults.providerPresets.presets.length,
    job: { status: job.status, chapters: job.completedChapters, glossary: job.glossary, error: job.error },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
