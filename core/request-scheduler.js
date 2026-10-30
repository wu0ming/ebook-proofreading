'use strict';

// 统一请求调度器
// 职责：全局并发闸门（跨任务共享）· 动态并发（成功升、429降）· 指数退避+随机抖动（遵守 Retry-After/retryAtMs）
//      · 错误分类（429/502/503/504/网络/内容类重试，401/403/400/404 停止同配置重试）· 模型路由与成功率统计

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const FATAL_HTTP_STATUS = new Set([400, 401, 403, 404, 422]);

const DEFAULT_LIMITS = {
  maxGlobal: 8, // 全局同时在飞的模型请求上限（跨任务共享硬顶）
  initialConcurrency: 3, // 动态并发初始值
  maxConcurrency: 10, // 动态并发上限（同时受任务自身 concurrency 设置约束）
  minConcurrency: 1,
  rampUpWindow: 10, // 升档判定窗口：最近这么多次请求
  rampUpRate: 0.7, // 窗口成功率达标才升档
  rampUpAfter: 6, // 两次升档之间的最小请求数
  rampDownAfter: 2, // 连续遇到限流这么多次后，动态并发 -1
  backoffBaseMs: 2000, // 退避基数：第1次重试等 2s、第2次 4s……
  backoffCapMs: 60000, // 指数退避单次上限
  retryAfterCapMs: 300000, // 遵守上游 Retry-After/retryAtMs 的上限（免费池冷却通常 1-5 分钟）
  maxAttempts: 4, // 单个批次的最大尝试次数
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

class SchedulerError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.status = info.status ?? null;
    this.kind = info.kind || 'unknown'; // http | network | content | unknown
    this.retryable = Boolean(info.retryable);
    this.retryAfterMs = info.retryAfterMs ?? null;
    this.model = info.model || null;
    this.durationMs = info.durationMs ?? null;
  }
}

class RequestScheduler {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.inFlight = 0;
    this.currentLimit = this.limits.initialConcurrency;
    this.consecutiveRateLimit = 0;
    this.outcomeWindow = [];
    this.requestsSinceRamp = 0;
    this.waiters = [];
    this.stats = {
      total: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
      byModel: new Map(),
      recent: [],
    };
    this.startedAt = new Date().toISOString();
  }

  snapshot() {
    const byModel = {};
    for (const [model, item] of this.stats.byModel) byModel[model] = item;
    return {
      inFlight: this.inFlight,
      currentLimit: this.currentLimit,
      maxGlobal: this.limits.maxGlobal,
      maxConcurrency: this.limits.maxConcurrency,
      limits: this.limits,
      stats: {
        total: this.stats.total,
        succeeded: this.stats.succeeded,
        failed: this.stats.failed,
        retried: this.stats.retried,
        successRate: this.stats.total ? Math.round((this.stats.succeeded / this.stats.total) * 1000) / 10 : null,
        byModel,
      },
      recent: this.stats.recent.slice(-30),
      startedAt: this.startedAt,
    };
  }

  noteResult(model, ok, info = {}) {
    const entry = this.stats.byModel.get(model) || { total: 0, succeeded: 0, failed: 0, lastError: null, lastUsedAt: null };
    entry.total += 1;
    if (ok) entry.succeeded += 1;
    else {
      entry.failed += 1;
      entry.lastError = info.error ? String(info.error).slice(0, 160) : null;
    }
    entry.lastUsedAt = new Date().toISOString();
    this.stats.byModel.set(model, entry);
    this.stats.recent.push({
      time: entry.lastUsedAt,
      model,
      ok,
      status: info.status ?? null,
      durationMs: info.durationMs ?? null,
      error: ok ? null : (info.error ? String(info.error).slice(0, 160) : null),
    });
    if (this.stats.recent.length > 200) this.stats.recent.shift();
  }

  adjustConcurrency(outcome) {
    // outcome: { ok, status }
    this.outcomeWindow.push(Boolean(outcome.ok));
    if (this.outcomeWindow.length > 20) this.outcomeWindow.shift();
    this.requestsSinceRamp += 1;

    if (!outcome.ok) {
      // 只有连续限流才降并发；其他失败仅中断升档节奏。
      if (outcome.status === 429) {
        this.consecutiveRateLimit += 1;
        if (this.consecutiveRateLimit >= this.limits.rampDownAfter && this.currentLimit > this.limits.minConcurrency) {
          this.currentLimit -= 1;
          this.consecutiveRateLimit = 0;
        }
      }
      return;
    }

    this.consecutiveRateLimit = 0;
    // 升档：最近一个窗口内成功率达标，且距上次升档已有足够请求数。
    const window = this.outcomeWindow.slice(-this.limits.rampUpWindow);
    if (window.length < this.limits.rampUpWindow) return;
    if (this.requestsSinceRamp < this.limits.rampUpAfter) return;
    const rate = window.filter(Boolean).length / window.length;
    if (rate >= this.limits.rampUpRate && this.currentLimit < this.limits.maxConcurrency) {
      this.currentLimit += 1;
      this.requestsSinceRamp = 0;
    }
  }

  async acquire(signal) {
    while (this.inFlight >= this.currentLimit || this.inFlight >= this.limits.maxGlobal) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          this.waiters = this.waiters.filter((item) => item !== entry);
          reject(signal?.reason || new Error('已取消'));
        };
        const entry = { resolve, onAbort };
        this.waiters.push(entry);
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (signal?.aborted) throw signal.reason || new Error('已取消');
    }
    this.inFlight += 1;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    while (this.waiters.length && this.inFlight < this.currentLimit && this.inFlight < this.limits.maxGlobal) {
      const entry = this.waiters.shift();
      entry.resolve();
    }
  }

  async run(task, options = {}) {
    const { signal = null, onRetry = null } = options;
    const maxAttempts = options.maxAttempts || this.limits.maxAttempts;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error('已取消');
      await this.acquire(signal);
      const startedAt = Date.now();
      let retryDelay = null;
      try {
        const result = await task(attempt);
        const durationMs = Date.now() - startedAt;
        this.stats.total += 1;
        this.stats.succeeded += 1;
        const usedModel = (typeof options.getModel === 'function' && options.getModel()) || options.model || 'unknown';
        this.noteResult(usedModel, true, { status: 200, durationMs });
        this.adjustConcurrency({ ok: true });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        lastError = error;
        this.stats.total += 1;
        this.stats.failed += 1;
        const status = error instanceof SchedulerError ? error.status : null;
        const model = (error instanceof SchedulerError && error.model)
          || (typeof options.getModel === 'function' && options.getModel())
          || options.model
          || 'unknown';
        this.noteResult(model, false, { status, durationMs, error: error.message });
        this.adjustConcurrency({ ok: false, status });

        const retryable = error instanceof SchedulerError ? error.retryable : true;
        const aborted = Boolean(signal?.aborted) || /已取消|取消/.test(String(error.message || ''));
        if (aborted) throw signal?.reason || new Error('已取消');
        if (!retryable || attempt >= maxAttempts) throw error;

        const retryAfterMs = (error instanceof SchedulerError && error.retryAfterMs) || null;
        const exponential = Math.min(this.limits.backoffCapMs, this.limits.backoffBaseMs * 2 ** (attempt - 1));
        const jitter = Math.random() * this.limits.backoffBaseMs;
        // 上游明确给出 Retry-After/retryAtMs 时优先遵守（上限 retryAfterCapMs），否则用指数退避加抖动。
        let delay = retryAfterMs != null
          ? Math.min(this.limits.retryAfterCapMs, Math.max(1000, retryAfterMs))
          : exponential + jitter;
        this.stats.retried += 1;
        if (onRetry) {
          try {
            // onRetry 可返回数字覆盖本次等待时长（如模型链刚轮换、旧模型的 Retry-After 不再适用时立即重试）
            const override = onRetry(attempt, error, delay);
            if (typeof override === 'number' && Number.isFinite(override)) {
              delay = Math.max(0, Math.min(this.limits.retryAfterCapMs, override));
            }
          } catch { /* 日志回调失败不影响调度 */ }
        }
        retryDelay = delay;
      } finally {
        this.release();
      }
      if (retryDelay !== null) await sleep(retryDelay, signal);
    }
    throw lastError;
  }
}

function limitsFromEnv() {
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxGlobal: num(process.env.SCHEDULER_MAX_GLOBAL, DEFAULT_LIMITS.maxGlobal),
    initialConcurrency: num(process.env.SCHEDULER_INITIAL_CONCURRENCY, DEFAULT_LIMITS.initialConcurrency),
    maxConcurrency: num(process.env.SCHEDULER_MAX_CONCURRENCY, DEFAULT_LIMITS.maxConcurrency),
    backoffBaseMs: num(process.env.SCHEDULER_BACKOFF_BASE_MS, DEFAULT_LIMITS.backoffBaseMs),
    retryAfterCapMs: num(process.env.SCHEDULER_RETRY_AFTER_CAP_MS, DEFAULT_LIMITS.retryAfterCapMs),
    maxAttempts: num(process.env.SCHEDULER_MAX_ATTEMPTS, DEFAULT_LIMITS.maxAttempts),
  };
}

const scheduler = new RequestScheduler(limitsFromEnv());

module.exports = {
  RequestScheduler,
  SchedulerError,
  scheduler,
  RETRYABLE_HTTP_STATUS,
  FATAL_HTTP_STATUS,
  DEFAULT_LIMITS,
  classifyHttpError(status, text, retryAfterHeader, model) {
    const message = `模型请求失败：HTTP ${status} - ${String(text || '').slice(0, 220)}`;
    if (FATAL_HTTP_STATUS.has(status)) {
      return new SchedulerError(message, { status, kind: 'http', retryable: false, model });
    }
    if (RETRYABLE_HTTP_STATUS.has(status)) {
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? extractRetryAtMs(text);
      return new SchedulerError(message, { status, kind: 'http', retryable: true, model, retryAfterMs });
    }
    // 未分类状态码：保守起见可重试，但连续失败会耗尽尝试次数后抛出。
    return new SchedulerError(message, { status, kind: 'http', retryable: true, model });
  },
};

function extractRetryAtMs(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const retryAtMs = parsed?.retryAtMs ?? parsed?.error?.retryAtMs;
    if (Number.isFinite(retryAtMs)) return Math.max(0, retryAtMs - Date.now());
    const cooldown = String(parsed?.error?.message || '').match(/cooldown reset\s*~?(\d+)s/i);
    if (cooldown) return Number(cooldown[1]) * 1000;
  } catch { /* 非 JSON，忽略 */ }
  return null;
}
