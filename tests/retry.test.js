'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('规则回退可关闭，失败章节可重试且保留其他章节', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-retry-'));
  for (const file of ['server.js', 'core', 'public']) fs.cpSync(path.join(__dirname, '..', file), path.join(root, file), { recursive: true });
  let allowRetry = false;
  const compatibilityRequests = [];
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.model === 'compat' || request.model === 'other-error') {
      compatibilityRequests.push(request);
      if (request.model === 'other-error') { res.writeHead(400); res.end(JSON.stringify({ error: { param: 'model', message: 'unknown model' } })); return; }
      if ('max_tokens' in request) { res.writeHead(400); res.end(JSON.stringify({ error: { param: 'max_tokens', message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } })); return; }
      if ('temperature' in request) { res.writeHead(400); res.end(JSON.stringify({ error: { param: 'temperature', message: 'Only the default temperature is supported.' } })); return; }
      assert.equal(request.max_completion_tokens, 20000);
      if (!request.messages[1].content.includes('\n\n输入章节：')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: [] }) } }] })); return;
      }
    }
    const chapters = JSON.parse(request.messages[1].content.split('\n\n输入章节：')[1]);
    if (!allowRetry && chapters.some((c) => c.number === 2)) { res.writeHead(500); res.end('failed'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ chapters: chapters.map((c) => ({ id: c.id, title: c.title, content: c.content.replace('原文', '校对') })) }) } }] }));
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SCHEDULER_MAX_ATTEMPTS: '2', SCHEDULER_BACKOFF_BASE_MS: '10', COMPENSATION_DELAYS_MS: '800,1500', COMPENSATION_TICK_MS: '150' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  async function req(url, body) {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error); return payload;
  }
  async function done(id) {
    for (let i = 0; i < 400; i++) { const job = await req(`/api/jobs/${id}`); if (['completed', 'failed', 'canceled'].includes(job.status)) return job; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('任务超时');
  }
  try {
    for (let i = 0; i < 100; i++) { try { await req('/api/defaults'); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    const text = `第1章 开始\n${'原文内容。'.repeat(50)}\n第2章 继续\n${'原文内容。'.repeat(50)}`;
    const doc = await req('/api/documents/analyze', { fileName: '测试.txt', text });
    const config = { documentId: doc.id, start: 1, end: 2, mode: 'llm', chaptersPerBatch: 1, concurrency: 2, autoRetryRounds: 0, provider: { baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'mock' } };
    const jobs = await Promise.all([req('/api/jobs', { ...config, ruleFallback: true }), req('/api/jobs', { ...config, ruleFallback: false })]);
    const initial = await Promise.all(jobs.map((j) => done(j.id)));
    assert.equal(initial[0].status, 'completed'); assert.equal(initial[0].failedChapters.length, 1); assert.equal(initial[0].reviewedChapters.find((c) => c.number === 2).fallback, true);
    assert.equal(initial[1].status, 'failed'); assert.equal(initial[1].output, null); assert.deepEqual(initial[1].reviewedChapters.map((c) => c.number), [1]);
    const before = await req(`/api/jobs/${jobs[1].id}/chapter?number=1`);
    allowRetry = true;
    await Promise.all(jobs.map((j) => req(`/api/jobs/${j.id}/retry`, {})));
    const retried = await Promise.all(jobs.map((j) => done(j.id)));
    for (const job of retried) { assert.equal(job.status, 'completed'); assert.equal(job.failedChapters.length, 0); assert.ok(job.output); }
    const after = await req(`/api/jobs/${jobs[1].id}/chapter?number=1`);
    const corrected = await req(`/api/jobs/${jobs[1].id}/chapter?number=2`);
    assert.deepEqual(after, before); assert.match(corrected.after.body, /校对/); assert.equal(corrected.fallback, false);
    const compatProvider = { ...config.provider, model: 'compat' };
    const compatJob = await req('/api/jobs', { ...config, start: 1, end: 1, provider: compatProvider });
    const compatible = await done(compatJob.id);
    assert.equal(compatible.status, 'completed'); assert.equal(compatible.failedChapters.length, 0);
    const extracted = await req('/api/glossary/extract', { documentId: doc.id, start: 1, end: 1, glossary: { entries: [] }, provider: compatProvider });
    assert.equal(extracted.added, 0);
    assert.deepEqual(compatibilityRequests.map((r) => 'max_tokens' in r ? 'old' : 'temperature' in r ? 'new' : 'default'), ['old', 'new', 'default', 'old', 'new', 'default']);
    await assert.rejects(req('/api/glossary/extract', { documentId: doc.id, start: 1, end: 1, provider: { ...compatProvider, model: 'other-error' } }), /unknown model/);
    assert.equal(compatibilityRequests.filter((r) => r.model === 'other-error').length, 1);
  } finally {
    if (server.exitCode === null) { server.kill(); await new Promise((resolve) => server.once('exit', resolve)); }
    await new Promise((resolve) => model.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});
