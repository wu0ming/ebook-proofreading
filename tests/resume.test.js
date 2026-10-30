'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function startWorkbench(root) {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), SCHEDULER_MAX_ATTEMPTS: '2', SCHEDULER_BACKOFF_BASE_MS: '10', COMPENSATION_DELAYS_MS: '800,1500', COMPENSATION_TICK_MS: '150' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/api/defaults`)).ok) break; } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return { base, child, port };
}

test('任务中断后重启工作台可载入进度并继续', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-resume-'));
  for (const file of ['server.js', 'core', 'public']) {
    fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  }
  let failChapter3 = true;
  const model = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const chapters = JSON.parse(request.messages[1].content.split('\n\n输入章节：')[1]);
    if (chapters.some((chapter) => chapter.number === 3) && failChapter3) {
      res.writeHead(500);
      res.end('model down');
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
  const text = [1, 2, 3, 4].map((n) => `第${n}章 标题${n}\n${`原文${n}。`.repeat(60)}`).join('\n');

  const first = await startWorkbench(root);
  let jobId;
  try {
    const document = await (await fetch(`${first.base}/api/documents/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: '测试.txt', text }),
    })).json();
    const created = await (await fetch(`${first.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id, start: 1, end: 4, mode: 'llm', chaptersPerBatch: 1, concurrency: 1,
        autoRetryRounds: 0, ruleFallback: false, provider: { baseUrl: modelUrl, model: 'mock' },
      }),
    })).json();
    jobId = created.id;
    for (let i = 0; i < 300; i += 1) {
      const job = await (await fetch(`${first.base}/api/jobs/${created.id}`)).json();
      if (['completed', 'failed'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const failedJob = await (await fetch(`${first.base}/api/jobs/${created.id}`)).json();
    assert.equal(failedJob.status, 'failed');
    assert.deepEqual(failedJob.failedChapters.map((item) => item.number), [3]);
  } finally {
    if (first.child.exitCode === null) {
      first.child.kill(); // 模拟工作台被关闭/崩溃
      await new Promise((resolve) => first.child.once('exit', resolve));
    }
  }

  const stateFiles = fs.readdirSync(path.join(root, '.jobs')).filter((file) => file.endsWith('.json'));
  assert.equal(stateFiles.length, 1, '应保留一个未完成任务的进度文件');

  failChapter3 = false;
  const second = await startWorkbench(root);
  try {
    const resumable = await (await fetch(`${second.base}/api/jobs/resumable`)).json();
    assert.equal(resumable.jobs.length, 1);
    assert.equal(resumable.jobs[0].id, jobId);
    assert.equal(resumable.jobs[0].completedChapters, 3, '应记住已完成的 3 章（其中第 3 章为回退）');

    const resumed = await (await fetch(`${second.base}/api/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { baseUrl: modelUrl, model: 'mock' } }),
    })).json();
    assert.equal(resumed.completedChapters >= 3, true);

    let finalJob = resumed;
    for (let i = 0; i < 300; i += 1) {
      finalJob = await (await fetch(`${second.base}/api/jobs/${jobId}`)).json();
      if (['completed', 'failed'].includes(finalJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finalJob.status, 'completed');
    assert.equal(finalJob.failedChapters.length, 0);
    assert.equal(finalJob.succeededChapters, 4);
    assert.ok(finalJob.output?.textUrl);
    const exported = await (await fetch(`${second.base}${finalJob.output.textUrl}`)).text();
    assert.match(exported, /第4章 标题4/);
    assert.doesNotMatch(exported, /原文4/);
  } finally {
    if (second.child.exitCode === null) {
      second.child.kill();
      await new Promise((resolve) => second.child.once('exit', resolve));
    }
    await new Promise((resolve) => model.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
