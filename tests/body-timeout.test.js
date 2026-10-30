'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('模型返回响应头后正文卡住时仍按超时释放请求', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-body-timeout-'));
  for (const file of ['server.js', 'core', 'public']) fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  const model = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SCHEDULER_MAX_ATTEMPTS: '1', COMPENSATION_DELAYS_MS: '600000' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const api = async (url, body) => { const res = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(res.ok); return res.json(); };
  try {
    for (let i = 0; i < 100; i++) { try { await api('/api/defaults'); break; } catch { await sleep(50); } }
    const doc = await api('/api/documents/analyze', { fileName: '测试.txt', text: `第1章 标题\n${'正文。'.repeat(80)}` });
    const job = await api('/api/jobs', { documentId: doc.id, start: 1, end: 1, mode: 'llm', concurrency: 1, chaptersPerBatch: 1, autoRetryRounds: 0, ruleFallback: false, provider: { baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'mock', timeoutMs: 15000 } });
    let state;
    for (let i = 0; i < 110; i++) { state = await api(`/api/jobs/${job.id}`); if (state.status === 'failed') break; await sleep(200); }
    assert.equal(state.status, 'failed');
    assert.match(state.failedChapters[0].error, /请求超时/);
    assert.equal((await api('/api/scheduler')).inFlight, 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
    model.closeAllConnections(); await new Promise((resolve) => model.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
