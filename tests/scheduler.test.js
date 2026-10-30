'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RequestScheduler,
  SchedulerError,
  classifyHttpError,
  RETRYABLE_HTTP_STATUS,
  FATAL_HTTP_STATUS,
} = require('../core/request-scheduler');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('错误分类：限流与上游故障可重试，鉴权与参数错误停止', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(classifyHttpError(status, 'boom', null, 'm').retryable, true, `HTTP ${status} 应可重试`);
    assert.ok(RETRYABLE_HTTP_STATUS.has(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyHttpError(status, 'boom', null, 'm').retryable, false, `HTTP ${status} 不应重试`);
    assert.ok(FATAL_HTTP_STATUS.has(status));
  }
});

test('错误分类：遵守 Retry-After 头与响应体 retryAtMs', () => {
  const byHeader = classifyHttpError(429, '{}', '2', 'm');
  assert.equal(byHeader.retryAfterMs, 2000);

  const future = Date.now() + 60000;
  const byBody = classifyHttpError(429, JSON.stringify({ retryAtMs: future }), null, 'm');
  assert.ok(byBody.retryAfterMs > 50000 && byBody.retryAfterMs <= 60000, '应从响应体解析 retryAtMs');

  const freePool = classifyHttpError(429, JSON.stringify({ error: { message: 'Soonest cooldown reset ~89s.' } }), null, 'm');
  assert.equal(freePool.retryAfterMs, 89000);

  const noHint = classifyHttpError(502, 'bad gateway', null, 'm');
  assert.equal(noHint.retryAfterMs, null);
});

test('全局并发闸门：在飞请求永不超过上限', async () => {
  const gate = new RequestScheduler({ maxGlobal: 4, initialConcurrency: 4, maxConcurrency: 4, rampUpAfter: 1000 });
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 24 }, () => gate.run(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await tick(15);
    inFlight -= 1;
    return 'ok';
  }, { model: 'mock' }));
  await Promise.all(tasks);
  assert.equal(peak, 4, `峰值并发应为 4，实际 ${peak}`);
  assert.equal(gate.snapshot().inFlight, 0);
});

test('动态并发：窗口成功率达标后升，连续 429 后降', async () => {
  const gate = new RequestScheduler({
    maxGlobal: 100, initialConcurrency: 2, maxConcurrency: 6, minConcurrency: 1,
    rampUpWindow: 10, rampUpRate: 0.7, rampUpAfter: 2, rampDownAfter: 2, maxAttempts: 1,
  });
  assert.equal(gate.currentLimit, 2);
  // 12 次连续成功：第 10 次窗口满且达标 → 升到 3；第 12 次 → 升到 4
  for (let i = 0; i < 12; i += 1) {
    await gate.run(async () => 'ok', { model: 'mock' });
  }
  assert.equal(gate.currentLimit, 4, '窗口成功率 100% 应逐步升到 4');

  // 混入 4 次失败（窗口成功率降到 8/12≈67% < 70%）后不应继续升
  for (let i = 0; i < 4; i += 1) {
    await gate.run(async () => { throw classifyHttpError(503, 'x', null, 'mock'); }, { model: 'mock' }).catch(() => {});
  }
  for (let i = 0; i < 6; i += 1) {
    await gate.run(async () => 'ok', { model: 'mock' });
  }
  assert.equal(gate.currentLimit, 4, '成功率回落后不应继续升档');

  const limited = () => gate.run(async () => {
    throw classifyHttpError(429, '{"error":{"message":"rate limited"}}', null, 'mock');
  }, { model: 'mock' }).catch(() => 'failed');
  await limited();
  assert.equal(gate.currentLimit, 4, '单次 429 只累计，不立即降');
  await limited();
  assert.equal(gate.currentLimit, 3, '连续第二次 429 后降一档');
});

test('退避重试：可重试错误按指数退避重试，致命错误立即抛出', async () => {
  const gate = new RequestScheduler({ maxGlobal: 4, initialConcurrency: 4, backoffBaseMs: 10, backoffCapMs: 40, maxAttempts: 4 });
  let calls = 0;
  const started = Date.now();
  await assert.rejects(() => gate.run(async () => {
    calls += 1;
    throw classifyHttpError(503, 'unavailable', null, 'mock');
  }, { model: 'mock' }), /HTTP 503/);
  assert.equal(calls, 4, '应尝试 4 次');
  assert.ok(Date.now() - started >= 10 + 20 + 40, '退避应约为 10ms + 20ms + 40ms');

  let fatalCalls = 0;
  await assert.rejects(() => gate.run(async () => {
    fatalCalls += 1;
    throw classifyHttpError(401, 'unauthorized', null, 'mock');
  }, { model: 'mock' }), /HTTP 401/);
  assert.equal(fatalCalls, 1, '401 不应重试');
});

test('调度统计：按模型记录成功率与最近请求', async () => {
  const gate = new RequestScheduler({ maxGlobal: 4, initialConcurrency: 4, backoffBaseMs: 5, maxAttempts: 1 });
  await gate.run(async () => 'ok', { model: 'model-a' });
  await gate.run(async () => 'ok', { model: 'model-a' }).catch(() => {});
  await gate.run(async () => {
    throw classifyHttpError(500, 'oops', null, 'model-b');
  }, { model: 'model-b' }).catch(() => {});
  const snap = gate.snapshot();
  assert.equal(snap.stats.byModel['model-a'].succeeded, 2);
  assert.equal(snap.stats.byModel['model-b'].failed, 1);
  assert.equal(snap.stats.succeeded, 2);
  assert.equal(snap.stats.failed, 1);
  assert.equal(snap.recent.length, 3);
});

test('取消信号：中止后不再发起新尝试', async () => {
  const gate = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 50, maxAttempts: 4 });
  const controller = new AbortController();
  let calls = 0;
  const running = gate.run(async () => {
    calls += 1;
    if (calls === 1) {
      controller.abort(new Error('已取消'));
      throw classifyHttpError(502, 'bad gateway', null, 'mock');
    }
    return 'ok';
  }, { model: 'mock', signal: controller.signal }).catch((error) => error.message);
  const message = await running;
  assert.match(String(message), /已取消/);
  assert.equal(calls, 1);
});

test('退避重试：优先遵守 Retry-After，并受上限约束', async () => {
  // 上游 Retry-After: 8 秒，上限 20 秒 → 等待 8 秒（不叠加抖动）
  const gate = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 10, retryAfterCapMs: 20000, maxAttempts: 3 });
  const controller = new AbortController();
  const delays = [];
  await gate.run(async () => {
    throw classifyHttpError(429, '{}', '8', 'mock');
  }, {
    model: 'mock', signal: controller.signal,
    onRetry: (attempt, error, delay) => { delays.push(delay); controller.abort(new Error('已取消')); },
  }).catch(() => 'aborted');
  assert.equal(delays.length, 1);
  assert.equal(delays[0], 8000, '应遵守 8 秒 Retry-After 且不加抖动');

  // 上游 Retry-After: 90 秒，上限 5 秒 → 裁剪到 5 秒
  const gate2 = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 10, retryAfterCapMs: 5000, maxAttempts: 3 });
  const controller2 = new AbortController();
  const delays2 = [];
  await gate2.run(async () => {
    throw classifyHttpError(429, '{}', '90', 'mock');
  }, {
    model: 'mock', signal: controller2.signal,
    onRetry: (attempt, error, delay) => { delays2.push(delay); controller2.abort(new Error('已取消')); },
  }).catch(() => 'aborted');
  assert.equal(delays2[0], 5000, '超长 Retry-After 应被上限裁剪');

  // 响应体 retryAtMs（FreeLLMAPI 风格）同样生效
  const gate3 = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 10, retryAfterCapMs: 60000, maxAttempts: 3 });
  const controller3 = new AbortController();
  const delays3 = [];
  const retryAt = Date.now() + 30000;
  await gate3.run(async () => {
    throw classifyHttpError(429, JSON.stringify({ retryAtMs: retryAt }), null, 'mock');
  }, {
    model: 'mock', signal: controller3.signal,
    onRetry: (attempt, error, delay) => { delays3.push(delay); controller3.abort(new Error('已取消')); },
  }).catch(() => 'aborted');
  assert.ok(delays3[0] >= 25000 && delays3[0] <= 30000, `应遵守 retryAtMs，实际 ${delays3[0]}`);
});

test('SchedulerError 携带分类信息', () => {
  const error = new SchedulerError('网络失败', { kind: 'network', retryable: true, model: 'm1' });
  assert.equal(error.kind, 'network');
  assert.equal(error.retryable, true);
  assert.equal(error.model, 'm1');
  assert.equal(error.status, null);
});

test('onRetry 可覆盖等待时长：模型链轮换后立即重试', async () => {
  // 429 带 8 秒 Retry-After，但 onRetry 返回 0（刚切换到新模型，旧冷却不适用）→ 实际不等待
  const gate = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 10, retryAfterCapMs: 60000, maxAttempts: 2 });
  const waits = [];
  const started = Date.now();
  await gate.run(async () => {
    throw classifyHttpError(429, '{}', '8', 'mock');
  }, {
    model: 'mock',
    onRetry: (attempt, error, delay) => { waits.push({ attempt, delay }); return 0; },
  }).catch(() => 'failed');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].delay, 8000, '调度器计算的等待应仍是 8 秒');
  assert.ok(Date.now() - started < 1000, `覆盖为 0 后应立即重试，实际耗时 ${Date.now() - started}ms`);
});

test('onRetry 返回非数字时按调度器等待执行', async () => {
  const gate = new RequestScheduler({ maxGlobal: 2, initialConcurrency: 2, backoffBaseMs: 10, retryAfterCapMs: 60000, maxAttempts: 2 });
  const waits = [];
  const started = Date.now();
  await gate.run(async () => {
    throw classifyHttpError(429, '{}', '2', 'mock');
  }, {
    model: 'mock',
    onRetry: (attempt, error, delay) => { waits.push(delay); return null; },
  }).catch(() => 'failed');
  assert.equal(waits[0], 2000, '无覆盖时应遵守 Retry-After');
  assert.ok(Date.now() - started >= 1900, `应实际等待约 2 秒，实际 ${Date.now() - started}ms`);
});


test('退避等待不占用全局请求名额', async () => {
  const gate = new RequestScheduler({ maxGlobal: 1, initialConcurrency: 1, maxConcurrency: 1, backoffBaseMs: 100 });
  let retried = false;
  let waiting;
  const retryScheduled = new Promise((resolve) => { waiting = resolve; });
  const first = gate.run(async (attempt) => {
    if (attempt === 1) throw new SchedulerError('temporary', { status: 503, retryable: true });
    retried = true;
  }, { onRetry: () => { waiting(); return 300; } });
  await retryScheduled;
  await gate.run(async () => assert.equal(retried, false), { maxAttempts: 1 });
  await first;
});
