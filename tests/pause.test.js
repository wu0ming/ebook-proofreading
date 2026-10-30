'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('暂停后继续不会重复启动批次', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-pause-'));
  for (const file of ['server.js', 'core', 'public']) fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  let requests = 0;
  let firstRequest;
  const requestStarted = new Promise((resolve) => { firstRequest = resolve; });
  const model = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const chapters = JSON.parse(JSON.parse(text).messages[1].content.split('\n\n输入章节：')[1]);
    requests++; firstRequest(); await sleep(250);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ chapters: chapters.map((c) => ({ id: c.id, title: c.title, content: c.content })) }) } }] }));
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const api = async (url, body) => { const r = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); };
  try {
    for (let i = 0; i < 100; i++) { try { await api('/api/defaults'); break; } catch { await sleep(50); } }
    const text = [1, 2, 3].map((n) => `第${n}章 测试\n${'正文。'.repeat(80)}`).join('\n');
    const doc = await api('/api/documents/analyze', { fileName: '测试.txt', text });
    const job = await api('/api/jobs', { documentId: doc.id, start: 1, end: 3, mode: 'llm', concurrency: 1, chaptersPerBatch: 1, autoRetryRounds: 0, provider: { baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'mock' } });
    await requestStarted;
    assert.equal((await api(`/api/jobs/${job.id}/pause`, {})).status, 'paused');
    assert.equal((await api(`/api/jobs/${job.id}/resume`, {})).status, 'running');
    let state;
    for (let i = 0; i < 100; i++) { state = await api(`/api/jobs/${job.id}`); if (state.status === 'completed') break; await sleep(100); }
    assert.equal(state.status, 'completed');
    assert.equal(state.succeededChapters, 3);
    assert.equal(requests, 3);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    await new Promise((resolve) => model.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
