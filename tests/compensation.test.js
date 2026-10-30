'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function startWorkbench(root, extraEnv = {}) {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      COMPENSATION_DELAYS_MS: '800,1500',
      COMPENSATION_TICK_MS: '150',
      SCHEDULER_MAX_ATTEMPTS: '2',
      SCHEDULER_BACKOFF_BASE_MS: '10',
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/api/defaults`)).ok) break; } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return { base, child, port };
}

// 第 2 章前两次（主流程 + 逐章重试轮关闭时只有主流程）失败，第三次（补偿）成功。
test('失败章节进入三级补偿队列，补偿成功后替换规则回退版并更新导出', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-compensate-'));
  for (const file of ['server.js', 'core', 'public']) {
    fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  }
  let failChapter2 = true;
  const model = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const chapters = JSON.parse(request.messages[1].content.split('\n\n输入章节：')[1]);
    const number = chapters[0].number;
    if (number === 2 && failChapter2) {
      res.writeHead(503);
      res.end('upstream unavailable');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        chapters: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, content: chapter.content.replace(/原文/g, '校对') })),
      }) } }],
    }));
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${model.address().port}`;
  const text = [1, 2].map((n) => `第${n}章 标题${n}\n${`原文${n}。`.repeat(60)}`).join('\n');

  let bench = await startWorkbench(root);
  try {
    const document = await (await fetch(`${bench.base}/api/documents/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: '补偿测试.txt', text }),
    })).json();
    const created = await (await fetch(`${bench.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id, start: 1, end: 2, mode: 'llm', chaptersPerBatch: 1, concurrency: 1,
        autoRetryRounds: 0, ruleFallback: true, provider: { baseUrl: modelUrl, model: 'mock' },
      }),
    })).json();

    let job = created;
    for (let i = 0; i < 200; i += 1) {
      job = await (await fetch(`${bench.base}/api/jobs/${created.id}`)).json();
      if (['completed', 'failed'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, 'completed', '规则回退开启时应完成导出');
    assert.equal(job.failedCount, 1, '第 2 章应标记失败');
    assert.equal(job.compensation.pending, 1, '失败章节应进入补偿队列');
    assert.equal(job.compensation.items[0].number, 2);

    // 重启后队列、补偿时间和源章节应仍在，不必重新导入原稿。
    bench.child.kill();
    await new Promise((resolve) => bench.child.once('exit', resolve));
    bench = await startWorkbench(root);
    job = await (await fetch(`${bench.base}/api/jobs/${created.id}`)).json();
    assert.equal(job.compensation.pending, 1);
    assert.equal(job.compensation.items[0].number, 2);
    failChapter2 = false;
    const resumed = await fetch(`${bench.base}/api/jobs/${created.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: { baseUrl: modelUrl, model: 'mock' } }),
    });
    assert.equal(resumed.status, 202);
    // 队列按保存的时间继续，成功后刷新已生成的导出。
    for (let i = 0; i < 100; i += 1) {
      job = await (await fetch(`${bench.base}/api/jobs/${created.id}`)).json();
      if (job.failedCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(job.failedCount, 0, '补偿应恢复第 2 章');
    assert.equal(job.compensation.pending, 0);
    assert.equal(job.succeededChapters, 2);

    const exported = await (await fetch(`${bench.base}${job.output.textUrl}`)).text();
    assert.match(exported, /第2章 标题2/);
    assert.doesNotMatch(exported, /原文2/, '导出应已被补偿结果替换');
  } finally {
    if (bench.child.exitCode === null) {
      bench.child.kill();
      await new Promise((resolve) => bench.child.once('exit', resolve));
    }
    await new Promise((resolve) => model.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
