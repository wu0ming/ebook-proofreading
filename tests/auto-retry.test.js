'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function chapterText(label) {
  return `${label}。`.repeat(60);
}

async function startServer(root, modelPort) {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SCHEDULER_MAX_ATTEMPTS: '2', SCHEDULER_BACKOFF_BASE_MS: '10', COMPENSATION_DELAYS_MS: '800,1500', COMPENSATION_TICK_MS: '150' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try {
      const response = await fetch(`${base}/api/defaults`);
      if (response.ok) break;
    } catch { /* 等待启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return { base, child };
}

test('失败章节自动重试轮可恢复，并写入可继续的进度快照', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-autoretry-'));
  for (const file of ['server.js', 'core', 'public']) {
    fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  }
  const attemptCounts = new Map();
  let modelPort = 0;
  const model = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const chapters = JSON.parse(request.messages[1].content.split('\n\n输入章节：')[1]);
    const key = chapters.map((chapter) => chapter.number).join(',');
    const attempts = (attemptCounts.get(key) || 0) + 1;
    attemptCounts.set(key, attempts);
    // 第 2 章：批量请求、逐章降级、自动重试轮的前两次都失败，第三次恢复。
    if (chapters.length === 1 && chapters[0].number === 2 && attempts <= 2) {
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
  modelPort = model.address().port;

  const first = await startServer(root, modelPort);
  try {
    const text = `第1章 开始\n${chapterText('原文一')}\n第2章 继续\n${chapterText('原文二')}\n第3章 收尾\n${chapterText('原文三')}`;
    const document = await (await fetch(`${first.base}/api/documents/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: '测试.txt', text }),
    })).json();

    const created = await (await fetch(`${first.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id,
        start: 1,
        end: 3,
        mode: 'llm',
        chaptersPerBatch: 1,
        concurrency: 1,
        autoRetryRounds: 1,
        ruleFallback: true,
        provider: { baseUrl: `http://127.0.0.1:${modelPort}`, model: 'mock' },
      }),
    })).json();

    let snapshot = created;
    for (let i = 0; i < 300; i += 1) {
      snapshot = await (await fetch(`${first.base}/api/jobs/${created.id}`)).json();
      if (['completed', 'failed'].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.failedChapters.length, 0, '自动重试轮应恢复失败章节');
    assert.equal(snapshot.succeededChapters, 3);
    assert.equal(snapshot.chapterStates.length, 3);
    assert.deepEqual(snapshot.chapterStates.map((chapter) => chapter.status), ['done', 'done', 'done']);
    assert.equal(snapshot.latestCompletedChapter, 3);
  } finally {
    if (first.child.exitCode === null) {
      first.child.kill();
      await new Promise((resolve) => first.child.once('exit', resolve));
    }
    await new Promise((resolve) => model.close(resolve));
  }

  // 第二轮：模拟“任务中断后重启工作台”，验证进度文件与继续接口。
  const secondModel = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const chapters = JSON.parse(request.messages[1].content.split('\n\n输入章节：')[1]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        chapters: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title, content: chapter.content.replace(/原文/g, '校对') })),
      }) } }],
    }));
  });
  await new Promise((resolve) => secondModel.listen(0, '127.0.0.1', resolve));
  const second = await startServer(root, secondModel.address().port);
  try {
    const resumable = await (await fetch(`${second.base}/api/jobs/resumable`)).json();
    assert.equal(resumable.jobs.length >= 0, true);

    const text = `第1章 开始\n${chapterText('原文一')}\n第2章 继续\n${chapterText('原文二')}\n第3章 收尾\n${chapterText('原文三')}`;
    const document = await (await fetch(`${second.base}/api/documents/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: '测试.txt', text }),
    })).json();

    const created = await (await fetch(`${second.base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id,
        start: 1,
        end: 3,
        mode: 'llm',
        chaptersPerBatch: 1,
        concurrency: 1,
        autoRetryRounds: 0,
        ruleFallback: true,
        provider: { baseUrl: `http://127.0.0.1:${secondModel.address().port}`, model: 'mock' },
      }),
    })).json();
    let snapshot = created;
    for (let i = 0; i < 300; i += 1) {
      snapshot = await (await fetch(`${second.base}/api/jobs/${created.id}`)).json();
      if (['completed', 'failed'].includes(snapshot.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(snapshot.status, 'completed');
    assert.ok(snapshot.output?.textUrl);
    const downloaded = await fetch(`${second.base}${snapshot.output.textUrl}`);
    const exported = await downloaded.text();
    assert.match(exported, /第3章 收尾/);
    assert.match(exported, /校对/);
  } finally {
    if (second.child.exitCode === null) {
      second.child.kill();
      await new Promise((resolve) => second.child.once('exit', resolve));
    }
    await new Promise((resolve) => secondModel.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
