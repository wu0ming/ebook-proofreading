'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  aggregateStats,
  cleanBody,
  cleanChapter,
  cleanTitle,
  renderNovel,
  sanitizeScrapeArtifacts,
  selectChapters,
  splitNovel,
} = require('./core/novel-core');
const PROVIDER_PRESETS = require('./core/provider-presets.json');
const DEFAULT_GLOSSARY = require('./core/default-glossary.json');
const { scheduler, SchedulerError, classifyHttpError } = require('./core/request-scheduler');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXPORT_DIR = path.join(ROOT, 'exports');
const GLOSSARY_DIR = path.join(ROOT, 'glossaries');
const JOB_DIR = path.join(ROOT, '.jobs');
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_LAUNCHER = path.join(os.homedir(), 'Desktop', 'FreeLLMAPI 启动器.vbs');
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// 模型链轮换后的重试等待：旧模型的 Retry-After 冷却不适用于新模型，短暂等待后立即再试
const MODEL_ROTATE_RETRY_DELAY_MS = Number(process.env.MODEL_ROTATE_RETRY_DELAY_MS || 2000);
const documents = new Map();
const jobs = new Map();

fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(GLOSSARY_DIR, { recursive: true });
fs.mkdirSync(JOB_DIR, { recursive: true });

const DEFAULT_RULES = `你是中文网络小说校对编辑。请在不改动情节、人物关系、世界观、功法名、专有名词和叙事视角的前提下进行校对：
1. 修正明显错别字、拼音输入错误、形近字和重复字词。
2. 清除网页抓取残留、乱码、翻页提示、站点广告和重复章节标题。删除与小说情节无关的阅读或听书 App、网站、服务推广，包括推荐语、下载地址、换源、朗读功能介绍及安卓苹果下载提示，即使广告嵌在正文中或带【】等括号，也只删除广告及其专用括号，保留相邻正文。不要把故事人物的对话、情节或正文中提到的应用误当广告；无法确定时保留原文。
3. 修正明显的标点、引号、段落缩进和断行错误。
4. 被翻页提示截断的同一句应重新拼接，但不要合并本来独立的段落。
5. 保留作者原有文风、语气、对话节奏和信息量，不扩写、不缩写、不总结。
6. 无法确定是否错误的专名、术语和表达保持原样。
7. 每个输入章节必须返回且只返回一次，章节编号和顺序不得改变。
8. 统一使用简体中文；仅做繁转简，不改动专名。`;

const EXTRACTION_RULES = `你是中文长篇小说的设定编纂者。请从给定章节中抽取“人名 / 称谓 / 功法 / 法宝 / 地点 / 势力 / 灵物 / 术语”词条，用于后续校对时保护专名不被误改。
要求：
1. 只输出高频或关键条目，不要收录一次性路人。
2. 同一实体的别称、尊号、化名、简称都放进 aliases。
3. note 用一句话说明它是什么，或说明容易写错成什么。
4. 不要臆造原文没有的实体；置信度低的条目不要输出。
5. 输出严格 JSON，不要 Markdown 代码块，不要解释。格式：
{"entries":[{"name":"赵升","type":"character","aliases":["赵清阳"],"note":"主角"}]}`;

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function safeFilePart(value) {
  return String(value || '小说')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || '小说';
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseAuthor(preamble) {
  const match = String(preamble || '').match(/作者[：:]\s*([^\n]{1,40})/);
  return match ? match[1].trim() : '';
}

function parseTitle(fileName, preamble) {
  const firstLine = String(preamble || '').split('\n').map((line) => line.trim()).find(Boolean);
  if (firstLine && !/^作者[：:]/.test(firstLine) && firstLine.length <= 50) return firstLine;
  return path.basename(fileName || '小说', path.extname(fileName || '')).trim() || '小说';
}

function missingChapterNumbers(chapters) {
  const missing = [];
  for (let index = 1; index < chapters.length; index += 1) {
    const previous = chapters[index - 1].number;
    const current = chapters[index].number;
    for (let number = previous + 1; number < current && missing.length < 1000; number += 1) missing.push(number);
  }
  return missing;
}

function sendJson(response, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  const data = Buffer.from(text);
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  response.end(data);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求内容过大，单次最多 64MB。'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(Object.assign(new Error('JSON 请求格式无效。'), { statusCode: 400, cause: error }));
      }
    });
    request.on('error', reject);
  });
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
  }[extension] || 'application/octet-stream';
}

function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(response, 404, 'Not found');
    return;
  }
  const data = fs.readFileSync(filePath);
  response.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Content-Length': data.length,
    'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=300',
  });
  response.end(data);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal.reason || new Error('任务已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
  }
}

async function requestChat(messages, config, signal, temperature) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const payload = { model: config.model, temperature, max_tokens: config.maxTokens, messages };
  // 单次发送：网络失败与 HTTP 错误统一走调度器错误分类；
  // 400 且属于参数名不支持时，原地做兼容性调整后立即重发（不算退避重试）。
  const send = async () => {
    for (let compat = 0; compat < 3; compat += 1) {
      let response;
      let text;
      try {
        response = await fetchWithTimeout(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload) }, config.timeoutMs, signal);
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new SchedulerError(`模型网络请求失败：${error.message}`, { kind: 'network', retryable: true, model: config.model });
      }
      if (response.ok) return { response, text };
      if (response.status !== 400) {
        throw classifyHttpError(response.status, text, response.headers.get('retry-after'), config.model);
      }
      let error;
      try { error = JSON.parse(text)?.error; } catch { /* 保留原始错误 */ }
      if ('max_tokens' in payload && error?.param === 'max_tokens' && /max_completion_tokens/i.test(String(error.message || ''))) {
        delete payload.max_tokens;
        payload.max_completion_tokens = config.maxTokens;
        continue;
      }
      if ('temperature' in payload && error?.param === 'temperature' && /unsupported|not supported|only the default/i.test(String(error.message || ''))) {
        delete payload.temperature;
        continue;
      }
      throw classifyHttpError(400, text, response.headers.get('retry-after'), config.model);
    }
    throw classifyHttpError(400, '参数兼容性重试次数已用尽', null, config.model);
  };
  const result = await send();
  try { return JSON.parse(result.text); } catch { throw new SchedulerError('模型接口没有返回 OpenAI 兼容 JSON。', { kind: 'parse', retryable: true, model: config.model }); }
}

async function testProvider(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
  const headers = { Accept: 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetchWithTimeout(`${baseUrl}/models`, { method: 'GET', headers }, 10000);
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`连接失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
    error.statusCode = 502;
    throw error;
  }
  let models = [];
  try {
    const parsed = JSON.parse(body);
    models = Array.isArray(parsed.data) ? parsed.data.map((item) => item.id).filter(Boolean).slice(0, 30) : [];
  } catch {
    models = [];
  }
  return { ok: true, httpStatus: response.status, models };
}

function createBatches(chapters, chaptersPerBatch, maxCharsPerBatch) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const chapter of chapters) {
    const chapterChars = chapter.body.length + chapter.title.length + 50;
    const reachedCount = current.length >= chaptersPerBatch;
    const reachedChars = current.length > 0 && currentChars + chapterChars > maxCharsPerBatch;
    if (reachedCount || reachedChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chapter);
    currentChars += chapterChars;
  }
  if (current.length) batches.push(current);
  return batches;
}

function extractJsonFromModel(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回可识别的 JSON。');
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeGlossary(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const name = String(entry?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.map((alias) => String(alias || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    normalized.push({
      name,
      type: ['character', 'term', 'place', 'organization'].includes(entry?.type) ? entry.type : 'term',
      aliases,
      note: String(entry?.note || '').slice(0, 200),
      source: entry?.source === 'auto' ? 'auto' : 'manual',
      originChapter: Number(entry?.originChapter) || null,
    });
  }
  return { version: 1, updatedAt: new Date().toISOString(), entries: normalized };
}

function mergeGlossaryEntries(glossary, newEntries) {
  const existing = normalizeGlossary(glossary);
  const byName = new Map(existing.entries.map((entry) => [entry.name, entry]));
  let added = 0;
  for (const entry of newEntries) {
    const name = String(entry?.name || '').trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      name,
      type: ['character', 'term', 'place', 'organization'].includes(entry?.type) ? entry.type : 'term',
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map((alias) => String(alias || '').trim()).filter(Boolean).slice(0, 12) : [],
      note: String(entry?.note || '').slice(0, 200),
      source: 'auto',
      originChapter: Number(entry?.originChapter) || null,
    });
    added += 1;
  }
  return {
    glossary: { version: 1, updatedAt: new Date().toISOString(), entries: Array.from(byName.values()) },
    added,
  };
}

function renderGlossaryForPrompt(glossary) {
  const normalized = normalizeGlossary(glossary);
  if (!normalized.entries.length) return '';
  const lines = normalized.entries.slice(0, 400).map((entry) => {
    const aliases = entry.aliases.length ? `（别名/称谓：${entry.aliases.join('、')}）` : '';
    const note = entry.note ? `：${entry.note}` : '';
    return `- ${entry.name}${aliases}${note}`;
  });
  return `\n\n【本书固定词表】以下人名、称谓、功法、法宝、地点、势力和术语必须原样保留，禁止改成同音字、形近字或常见词：\n${lines.join('\n')}\n如果正文出现的写法与词表不一致，以词表为准并统一；无法判断时保持原文。`;
}

function buildPrompt(batch, rules, glossary) {
  const payload = batch.map((chapter) => ({
    id: String(chapter.number),
    number: chapter.number,
    title: chapter.title,
    content: chapter.body,
  }));
  return `${rules}${renderGlossaryForPrompt(glossary)}\n\n请严格返回 JSON，不要使用 Markdown 代码块，不要解释。格式必须为：\n{"chapters":[{"id":"章节编号","title":"校对后标题","content":"校对后正文"}],"notes":["本批次重要说明"],"glossary_add":[{"name":"新发现的关键专名","type":"character","aliases":[],"note":"一句话说明"}]}\n\n输入章节：\n${JSON.stringify(payload)}`;
}

async function callProofreader(batch, config, job) {
  const envelope = await requestChat([
        {
          role: 'system',
          content: '你是严谨的中文小说校对编辑。只做校对，不改写情节。必须按指定 JSON 结构返回全部章节。',
        },
        { role: 'user', content: buildPrompt(batch, config.rules, config.glossary) },
  ], config, job.controller.signal, 0.1);
  const content = envelope?.choices?.[0]?.message?.content;
  const parsed = extractJsonFromModel(content);
  if (!Array.isArray(parsed.chapters)) throw new SchedulerError('模型结果缺少 chapters 数组。', { kind: 'content', retryable: true, model: config.model });

  const byId = new Map(parsed.chapters.map((chapter) => [String(chapter.id ?? chapter.number), chapter]));
  return batch.map((sourceChapter) => {
    const candidate = byId.get(String(sourceChapter.number));
    if (!candidate || typeof candidate.content !== 'string') {
      throw new SchedulerError(`模型结果缺少第 ${sourceChapter.number} 章。`, { kind: 'content', retryable: true, model: config.model });
    }
    const candidateLength = candidate.content.trim().length;
    if (candidateLength < Math.max(100, sourceChapter.body.length * 0.55)) {
      throw new SchedulerError(`第 ${sourceChapter.number} 章输出明显过短，已拒绝截断结果。`, { kind: 'content', retryable: true, model: config.model });
    }
    const withoutRepeatedHeader = candidate.content.replace(/^\s*第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章回节][^\n]*\n?/, '');
    const cleaned = cleanBody(withoutRepeatedHeader);
    return {
      ...sourceChapter,
      title: cleanTitle(candidate.title || sourceChapter.title),
      body: cleaned.text,
      modelNotes: Array.isArray(parsed.notes) ? parsed.notes : [],
      glossaryAdd: Array.isArray(parsed.glossary_add) ? parsed.glossary_add : [],
    };
  });
}

function glossaryPath(documentId) {
  return path.join(GLOSSARY_DIR, `${documentId}.json`);
}

function saveGlossary(documentId, glossary) {
  fs.writeFileSync(glossaryPath(documentId), JSON.stringify(glossary, null, 2), 'utf8');
}

function loadGlossary(documentId) {
  const filePath = glossaryPath(documentId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeGlossary(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

async function callModelRaw(messages, config, options = {}) {
  const envelope = await requestChat(messages, config, options.signal || null, config.temperature ?? 0.1);
  return String(envelope?.choices?.[0]?.message?.content || '');
}

function aggregateExcerpt(chapters, limit) {
  const selected = [];
  let total = 0;
  if (!chapters.length) return { text: '', usedChapters: [] };
  const evenStep = Math.max(1, Math.floor(chapters.length / 40));
  const sampled = chapters.filter((chapter, index) => index % evenStep === 0).slice(0, 40);
  for (const chapter of sampled) {
    const block = `第${chapter.number}章 ${chapter.title}\n${chapter.body.slice(0, 4000)}`;
    if (total + block.length > limit) break;
    selected.push(chapter);
    total += block.length;
  }
  return { text: selected.map((chapter) => `第${chapter.number}章 ${chapter.title}\n${chapter.body.slice(0, 4000)}`).join('\n\n'), usedChapters: selected.map((chapter) => chapter.number) };
}

async function extractGlossary(body) {
  const document = documents.get(body.documentId);
  if (!document) throw Object.assign(new Error('导入的小说已失效，请重新选择 TXT 文件。'), { statusCode: 404 });
  const scope = selectChapters(document.chapters, body.start, body.end);
  if (!scope.length) throw Object.assign(new Error('所选范围内没有识别到章节。'), { statusCode: 400 });
  const cleaned = scope.map((chapter) => cleanChapter(chapter));
  const limit = clamp(body.charLimit, 20000, 400000, 120000);
  const excerpt = aggregateExcerpt(cleaned, limit);
  const config = {
    baseUrl: normalizeBaseUrl(body.provider?.baseUrl || 'http://127.0.0.1:3001/v1'),
    model: String(body.provider?.model || 'auto').trim() || 'auto',
    apiKey: String(body.provider?.apiKey || ''),
    timeoutMs: clamp(body.provider?.timeoutMs, 60000, 600000, 300000),
    maxTokens: clamp(body.provider?.maxTokens, 2000, 64000, 20000),
    temperature: 0.2,
  };
  let rules = EXTRACTION_RULES;
  if (body.useWebSearch) {
    rules += '\n\n如果当前环境具备联网检索或搜索工具，请先核对低置信条目再输出；不具备联网能力时，严格只依据给定原文，不要臆造。';
  }
  const existing = normalizeGlossary(body.glossary);
  const content = await callModelRaw([
    { role: 'system', content: '你是严谨的中文小说设定编纂者，只输出 JSON。' },
    { role: 'user', content: `${rules}\n\n已有词表（不要重复输出其中的条目）：\n${JSON.stringify(existing.entries.slice(0, 300))}\n\n章节内容：\n${excerpt.text}` },
  ], config);
  let parsed;
  try {
    parsed = extractJsonFromModel(content);
  } catch {
    throw new Error('词表提取失败：模型没有返回可识别的 JSON。');
  }
  if (!Array.isArray(parsed.entries)) throw new Error('词表提取失败：模型结果缺少 entries 数组。');
  const merged = mergeGlossaryEntries(existing, parsed.entries);
  saveGlossary(document.id, merged.glossary);
  document.glossary = merged.glossary;
  return {
    glossary: merged.glossary,
    added: merged.added,
    modelEntries: parsed.entries.length,
    scannedChapters: excerpt.usedChapters.length,
    scannedChars: excerpt.text.length,
    usedWebSearchHint: Boolean(body.useWebSearch),
    savedTo: `glossaries/${document.id}.json`,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jobStatePath(jobId) {
  return path.join(JOB_DIR, `${jobId}.json`);
}

function persistJob(job) {
  if (!job?.id) return;
  const failedMap = new Map(job.failedChapters.map((item) => [item.number, item.error]));
  const payload = {
    version: 1,
    id: job.id,
    documentId: job.documentId,
    documentFile: job.fileName,
    preamble: documents.get(job.documentId)?.preamble ?? job.preamble ?? '',
    compensationQueue: compensationQueue.filter((item) => item.jobId === job.id).map(({running, ...item}) => item),
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: new Date().toISOString(),
    startedAt: job.startedAt,
    totalChapters: job.totalChapters,
    totalBatches: job.totalBatches,
    completedBatches: job.completedBatches,
    publicConfig: job.publicConfig,
    glossary: job.publicConfig.glossary,
    autoAddedGlossary: job.autoAddedGlossary,
    failedChapters: job.failedChapters,
    logs: job.logs.slice(-80),
    output: job.output ? { textPath: job.output.textPath, reportPath: job.output.reportPath } : null,
    chapters: job.cleanedChapters.map((chapter) => {
      const result = job.results.get(chapter.number);
      return {
        number: chapter.number,
        title: chapter.title,
        resultTitle: result?.title ?? chapter.title,
        rawBody: chapter.rawBody,
        sourceBody: chapter.body,
        body: result?.body ?? '',
        hasResult: Boolean(result),
        done: Boolean(result) && !failedMap.has(chapter.number),
        fallback: failedMap.has(chapter.number),
        error: failedMap.get(chapter.number) || null,
      };
    }),
  };
  const filePath = jobStatePath(job.id);
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`任务进度保存失败：${error.message}`);
  }
}

function loadPersistedJobs() {
  const loaded = [];
  for (const file of fs.readdirSync(JOB_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(JOB_DIR, file), 'utf8'));
      const failedMap = new Map((payload.failedChapters || []).map((item) => [item.number, item.error]));
      const cleanedChapters = (payload.chapters || []).map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        rawBody: chapter.rawBody,
        // 续跑/重试时作为模型输入：优先用规则清理后的源正文，兼容旧进度文件时退回原始正文。
        body: chapter.sourceBody ?? chapter.rawBody ?? '',
        stats: {},
      }));
      const job = {
        id: payload.id,
        documentId: payload.documentId,
        fileName: payload.documentFile || '未命名小说.txt',
        preamble: payload.preamble || '',
        status: ['completed', 'failed', 'canceled', 'paused'].includes(payload.status) ? payload.status : 'interrupted',
        mode: payload.mode,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        startedAt: payload.startedAt || null,
        completedAt: null,
        totalChapters: payload.totalChapters,
        completedChapters: payload.chapters.filter((chapter) => chapter.hasResult ?? (chapter.done || (chapter.fallback && Boolean(chapter.body)))).length,
        totalBatches: payload.totalBatches,
        completedBatches: payload.completedBatches || 0,
        failedChapters: payload.failedChapters || [],
        results: new Map(),
        cleanedChapters,
        retryPending: new Set(),
        activeBatches: new Map(),
        logs: payload.logs || [],
        output: payload.output && fs.existsSync(payload.output.textPath) ? payload.output : null,
        error: null,
        autoAddedGlossary: payload.autoAddedGlossary || [],
        parseStats: null,
        publicConfig: payload.publicConfig,
        secretConfig: { ...payload.publicConfig, apiKey: '' },
        controller: new AbortController(),
        resumable: !['completed', 'canceled'].includes(payload.status) || failedMap.size > 0,
        restored: true,
      };
      for (const chapter of payload.chapters || []) {
        if (!(chapter.hasResult ?? (chapter.done || (chapter.fallback && Boolean(chapter.body))))) continue;
        job.results.set(chapter.number, {
          number: chapter.number,
          title: chapter.resultTitle ?? chapter.title,
          body: chapter.body || chapter.rawBody,
          stats: {},
        });
      }
      documents.set(job.documentId, { id: job.documentId, fileName: job.fileName, preamble: job.preamble, chapters: cleanedChapters, warnings: [], stats: {}, glossary: job.publicConfig.glossary });
      for (const item of payload.compensationQueue || []) {
        if (job.failedChapters.some((failure) => failure.number === item.number)) compensationQueue.push({ ...item, jobId: job.id, running: false });
      }
      jobs.set(job.id, job);
      loaded.push(job.id);
    } catch (error) {
      console.error(`读取任务进度失败（${file}）：${error.message}`);
    }
  }
  return loaded;
}

function deletePersistedJob(jobId) {
  try {
    fs.rmSync(jobStatePath(jobId), { force: true });
  } catch {
    // 忽略删除失败，不影响主流程。
  }
}

async function waitWhilePaused(job) {
  while (job.status === 'paused' && !job.controller.signal.aborted) await sleep(250);
}

function addJobLog(job, message, level = 'info') {
  job.logs.push({ time: new Date().toISOString(), level, message });
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = new Date().toISOString();
}

function modelChain(model) {
  return String(model || 'auto').split(',').map((item) => item.trim()).filter(Boolean);
}

async function runModelBatch(batch, job) {
  const models = modelChain(job.secretConfig.model);
  if (!models.length) models.push('auto');
  let modelIndex = 0;
  // 刚刚因为暂不可用切换了模型：旧模型的 Retry-After 冷却不适用于新模型，缩短等待立即再试
  let justRotated = false;
  const rangeLabel = `第 ${batch[0].number}-${batch[batch.length - 1].number} 章`;
  const currentModel = () => models[Math.min(modelIndex, models.length - 1)];
  return scheduler.run(async () => {
    const config = { ...job.secretConfig, model: currentModel() };
    try {
      return await callProofreader(batch, config, job);
    } catch (error) {
      // 限流/上游暂不可用 → 切换到模型链上的下一个再试（FreeLLMAPI 免费额度常见）
      const status = error instanceof SchedulerError ? error.status : null;
      const rotatable = status === 429 || status === 502 || status === 503 || status === 504
        || (error instanceof SchedulerError && error.kind === 'network');
      if (rotatable && modelIndex < models.length - 1) {
        modelIndex += 1;
        justRotated = true;
        addJobLog(job, `${rangeLabel}：模型 ${models[modelIndex - 1]} 暂不可用，切换为 ${models[modelIndex]}。`, 'warning');
      }
      throw error;
    }
  }, {
    signal: job.controller.signal,
    model: models[0],
    getModel: currentModel,
    onRetry: (attempt, error, delay) => {
      // 模型链刚轮换 → 用短延迟覆盖旧模型的 Retry-After；链已耗尽仍不可用 → 按调度器计算的冷却等待
      const override = justRotated && error.retryAfterMs == null && error.status !== 429 ? MODEL_ROTATE_RETRY_DELAY_MS : null;
      justRotated = false;
      addJobLog(job, `${rangeLabel}第 ${attempt} 次请求失败（${String(error.message).slice(0, 120)}），${override != null ? Math.round(override / 1000) : Math.round(delay / 1000)} 秒后${override != null ? '切换模型重试' : '重试'}。`, 'warning');
      return override;
    },
  });
}

function jobSnapshot(job) {
  const totalChapters = job.totalChapters || 0;
  const failedNumbers = new Set(job.failedChapters.map((item) => item.number));
  const succeeded = job.cleanedChapters.filter((chapter) => job.results.has(chapter.number) && !failedNumbers.has(chapter.number));
  const activeChapters = Array.from(job.activeBatches.values()).flatMap((item) => {
    const match = String(item.range || '').match(/\d+/g) || [];
    return match.map(Number);
  });
  return {
    id: job.id,
    documentId: job.documentId,
    fileName: job.fileName,
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    restored: Boolean(job.restored),
    resumable: Boolean(job.resumable) || ['interrupted', 'paused', 'failed'].includes(job.status),
    totalChapters,
    completedChapters: job.completedChapters,
    succeededChapters: succeeded.length,
    failedCount: job.failedChapters.length,
    totalBatches: job.totalBatches,
    completedBatches: job.completedBatches,
    failedChapters: job.failedChapters.slice(-200),
    compensation: {
      pending: compensationSnapshotFor(job.id).length,
      items: compensationSnapshotFor(job.id).slice(0, 50),
    },
    progress: totalChapters ? Math.round((succeeded.length / totalChapters) * 100) : 0,
    currentChapter: activeChapters.length ? Math.max(...activeChapters) : null,
    latestCompletedChapter: succeeded.length ? Math.max(...succeeded.map((chapter) => chapter.number)) : null,
    activeBatches: Array.from(job.activeBatches.values()),
    chapterStates: job.cleanedChapters.map((chapter) => ({
      number: chapter.number,
      title: job.results.get(chapter.number)?.title || chapter.title,
      status: failedNumbers.has(chapter.number) ? (job.results.has(chapter.number) ? 'fallback' : 'failed') : job.results.has(chapter.number) ? 'done' : 'pending',
    })),
    reviewedChapters: job.cleanedChapters
      .filter((chapter) => job.results.has(chapter.number))
      .map((chapter) => ({
        number: chapter.number,
        title: job.results.get(chapter.number).title || chapter.title,
        fallback: failedNumbers.has(chapter.number),
      }))
      .sort((a, b) => a.number - b.number),
    logs: job.logs.slice(-40),
    output: job.output ? {
      textName: path.basename(job.output.textPath),
      reportName: path.basename(job.output.reportPath),
      textUrl: `/api/jobs/${job.id}/download?type=text`,
      reportUrl: `/api/jobs/${job.id}/download?type=report`,
    } : null,
    config: job.publicConfig,
    parseStats: job.parseStats,
    glossary: {
      enabled: Boolean(job.publicConfig.useGlossary),
      entryCount: normalizeGlossary(job.publicConfig.glossary).entries.length,
      autoGrowEnabled: Boolean(job.publicConfig.glossaryAutoGrow),
      autoAdded: job.autoAddedGlossary.length,
      autoAddedEntries: job.autoAddedGlossary.slice(-20),
    },
    error: job.error || null,
  };
}

async function processJob(job, document, batches) {
  job.status = 'running';
  if (!job.startedAt) job.startedAt = new Date().toISOString();
  let nextBatchIndex = 0;
  const pending = new Set(batches.flat().map((chapter) => chapter.number));

  const worker = async (workerIndex) => {
    while (true) {
      await waitWhilePaused(job);
      if (job.controller.signal.aborted) return;
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      const rangeLabel = batch.length === 1 ? `第 ${batch[0].number} 章` : `第 ${batch[0].number}-${batch[batch.length - 1].number} 章`;
      job.activeBatches.set(workerIndex, { worker: workerIndex + 1, batch: batchIndex + 1, range: rangeLabel });
      addJobLog(job, `通道 ${workerIndex + 1} 正在处理${rangeLabel}。`);

      let results = [];
      const failed = new Set();
      if (job.mode === 'rules') {
        results = batch;
        await sleep(30);
      } else {
        try {
          results = await runModelBatch(batch, job);
        } catch (batchError) {
          if (job.controller.signal.aborted) return;
          if (batchError instanceof SchedulerError && !batchError.retryable) {
            job.fatalError = batchError;
            job.controller.abort(batchError);
            throw batchError;
          }
          const defer = batchError instanceof SchedulerError && (batchError.status === 429 || !batchError.retryable);
          addJobLog(job, defer ? `${rangeLabel}请求受限或配置错误，暂缓重试。` : `${rangeLabel}批量处理失败，自动降为逐章重试。`, 'warning');
          for (const chapter of batch) {
            try {
              await waitWhilePaused(job);
              if (defer || batch.length === 1) throw batchError;
              const individual = await runModelBatch([chapter], job);
              results.push(individual[0]);
            } catch (chapterError) {
              if (job.controller.signal.aborted) return;
              failed.add(chapter.number);
              job.failedChapters = job.failedChapters.filter((item) => item.number !== chapter.number);
              job.failedChapters.push({ number: chapter.number, error: chapterError.message });
              if (job.publicConfig.ruleFallback) results.push(chapter);
              addJobLog(job, `第 ${chapter.number} 章模型校对失败，${job.publicConfig.ruleFallback ? '已保留规则清理版' : '等待重试'}。`, 'error');
            }
          }
        }
      }

      for (const result of results) {
        job.results.set(result.number, result);
        if (!failed.has(result.number)) job.failedChapters = job.failedChapters.filter((item) => item.number !== result.number);
      }
      if (job.publicConfig.glossaryAutoGrow) {
        const discovered = results.flatMap((result) => (result.glossaryAdd || [])
          .map((entry) => ({ ...entry, originChapter: result.number })));
        if (discovered.length) {
          const merged = mergeGlossaryEntries(job.publicConfig.glossary, discovered);
          job.publicConfig.glossary = merged.glossary;
          job.secretConfig.glossary = merged.glossary;
          document.glossary = merged.glossary;
          for (const entry of discovered) {
            if (merged.glossary.entries.some((item) => item.name === String(entry.name || '').trim() && item.source === 'auto')) {
              job.autoAddedGlossary.push({ name: String(entry.name || '').trim(), type: entry.type || 'term', chapter: entry.originChapter });
            }
          }
          if (merged.added) addJobLog(job, `词表自升级：新增 ${merged.added} 个词条。`, 'warning');
        }
      }
      for (const chapter of batch) {
        job.retryPending.delete(chapter.number);
        pending.delete(chapter.number);
      }
      job.completedChapters = job.cleanedChapters.filter((chapter) => job.results.has(chapter.number)).length;
      job.completedBatches += 1;
      job.activeBatches.delete(workerIndex);
      addJobLog(job, `${rangeLabel}处理完成。`);
      persistJob(job);
    }
  };

  try {
    const workers = Array.from({ length: Math.min(job.publicConfig.concurrency, Math.max(1, batches.length)) }, (_, index) => worker(index));
    await Promise.all(workers);
    if (job.controller.signal.aborted) {
      job.status = 'interrupted';
      job.completedAt = new Date().toISOString();
      addJobLog(job, '任务已中断，进度已保存，可在下次启动后继续。', 'warning');
      persistJob(job);
      return;
    }

    if (job.failedChapters.length && job.publicConfig.autoRetryRounds > 0) {
      const before = job.failedChapters.length;
      addJobLog(job, `第一轮结束：${before} 章失败，自动进入失败章节重试轮。`, 'warning');
      await runRetryPass(job);
      if (job.controller.signal.aborted) {
        job.status = 'interrupted';
        job.completedAt = new Date().toISOString();
        persistJob(job);
        return;
      }
      const recovered = before - job.failedChapters.length;
      addJobLog(job, recovered > 0 ? `失败章节重试轮恢复 ${recovered} 章。` : '失败章节重试轮没有恢复任何章节。', recovered > 0 ? 'info' : 'warning');
    }

    // 仍失败的章节进入三级自动补偿队列（5 分钟 / 30 分钟 / 2 小时），不阻塞导出。
    if (job.failedChapters.length) enqueueCompensation(job);

    const remaining = job.cleanedChapters.filter((chapter) => !job.results.has(chapter.number));
    if (remaining.length || (job.failedChapters.length && !job.publicConfig.ruleFallback)) {
      job.status = 'failed';
      job.error = job.publicConfig.ruleFallback
        ? `有 ${remaining.length} 章仍未处理，请重试失败章节。`
        : `有 ${job.failedChapters.length} 章校对失败，未启用规则回退；请重试失败章节。`;
      job.completedAt = new Date().toISOString();
      addJobLog(job, job.error, 'error');
      persistJob(job);
      return;
    }
    finalizeJob(job, document);
  } catch (error) {
    job.activeBatches.clear();
    if (job.fatalError) {
      job.status = 'failed';
      job.error = job.fatalError.message;
      addJobLog(job, `配置错误，已停止任务：${job.error}`, 'error');
    } else if (job.controller.signal.aborted) {
      job.status = 'interrupted';
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = error.message;
      addJobLog(job, `任务失败：${error.message}`, 'error');
    }
    job.completedAt = new Date().toISOString();
    persistJob(job);
  }
}

function buildJobReport(job, document, ordered) {
  return {
    sourceFile: document.fileName,
    generatedAt: new Date().toISOString(),
    mode: job.mode,
    range: { start: ordered[0]?.number || null, end: ordered[ordered.length - 1]?.number || null, chapters: ordered.length },
    config: job.publicConfig,
    sourceParseStats: document.stats,
    sourceWarnings: document.warnings,
    cleanupStats: aggregateStats(job.cleanedChapters),
    failedChapters: job.failedChapters,
    glossary: {
      enabled: Boolean(job.publicConfig.useGlossary),
      entryCount: normalizeGlossary(job.publicConfig.glossary).entries.length,
      autoGrowEnabled: Boolean(job.publicConfig.glossaryAutoGrow),
      autoAddedCount: job.autoAddedGlossary.length,
      autoAdded: job.autoAddedGlossary,
      finalGlossary: normalizeGlossary(job.publicConfig.glossary).entries,
    },
    note: '源文件未被覆盖；模型失败的章节及其处理状态在 failedChapters 中列出。',
  };
}

// 导出并标记完成；补偿校对成功后也会调用它来收尾。
function finalizeJob(job, document) {
  const ordered = job.cleanedChapters.map((chapter) => job.results.get(chapter.number));
  if (ordered.some((item) => !item)) return false;
  const title = parseTitle(document.fileName, document.preamble);
  const author = parseAuthor(document.preamble);
  const stem = safeFilePart(path.basename(document.fileName, path.extname(document.fileName)));
  const stamp = timestampForFile();
  const textPath = job.output?.textPath || path.join(EXPORT_DIR, `${stem}_第${ordered[0]?.number || ''}-${ordered[ordered.length - 1]?.number || ''}章_校对版_${stamp}.txt`);
  const reportPath = job.output?.reportPath || path.join(EXPORT_DIR, `${stem}_校对报告_${stamp}.json`);
  fs.writeFileSync(textPath, renderNovel(ordered, { title, author }), 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify(buildJobReport(job, document, ordered), null, 2), 'utf8');
  saveGlossary(document.id, normalizeGlossary(job.publicConfig.glossary));
  if (job.failedChapters.length) {
    addJobLog(job, `有 ${job.failedChapters.length} 章模型校对失败，已保留规则清理版；可点击“重试失败章节”或检查模型、密钥与并发设置。`, 'warning');
  }
  job.output = { textPath, reportPath };
  job.resumable = false;
  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  addJobLog(job, `全部完成，已自动合并导出 ${path.basename(textPath)}。`);
  persistJob(job);
  return true;
}

function synchronizeJobConfig(job) {
  job.secretConfig = { ...job.publicConfig, apiKey: job.apiKey || '' };
  return job;
}

async function buildJobFromBody(body, document) {
  const selected = selectChapters(document.chapters, Number(body.start), Number(body.end));
  if (!selected.length) throw Object.assign(new Error('所选范围内没有识别到章节。'), { statusCode: 400 });
  const cleaned = selected.map((chapter) => cleanChapter(chapter));
  const chaptersPerBatch = clamp(body.chaptersPerBatch, 1, 10, 3);
  const concurrency = clamp(body.concurrency, 1, 10, 2);
  const maxCharsPerBatch = clamp(body.maxCharsPerBatch, 4000, 50000, 18000);
  const mode = body.mode === 'rules' ? 'rules' : 'llm';
  const baseUrl = normalizeBaseUrl(body.provider?.baseUrl || 'http://127.0.0.1:3001/v1');
  const model = String(body.provider?.model || 'auto').trim() || 'auto';
  if (mode === 'llm' && !baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
  return {
    id: crypto.randomUUID(),
    documentId: document.id,
    fileName: document.fileName,
    status: 'queued',
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    totalChapters: cleaned.length,
    completedChapters: 0,
    totalBatches: 0,
    completedBatches: 0,
    failedChapters: [],
    results: new Map(),
    cleanedChapters: cleaned,
    retryPending: new Set(),
    activeBatches: new Map(),
    logs: [],
    output: null,
    error: null,
    autoAddedGlossary: [],
    parseStats: document.stats,
    controller: new AbortController(),
    resumable: false,
    publicConfig: {
      start: selected[0].number,
      end: selected[selected.length - 1].number,
      chaptersPerBatch,
      concurrency,
      maxCharsPerBatch,
      estimatedInFlightChapters: chaptersPerBatch * concurrency,
      baseUrl,
      model,
      timeoutMs: clamp(body.provider?.timeoutMs, 15000, 300000, 120000),
      maxTokens: clamp(body.provider?.maxTokens, 1000, 64000, 20000),
      rules: String(body.rules || DEFAULT_RULES),
      ruleFallback: body.ruleFallback !== false,
      autoRetryRounds: clamp(body.autoRetryRounds, 0, 3, 1),
      useGlossary: body.useGlossary !== false,
      glossaryAutoGrow: Boolean(body.glossaryAutoGrow),
      glossary: normalizeGlossary(body.glossary),
    },
    apiKey: String(body.provider?.apiKey || ''),
  };
}

async function createJob(body) {
  const document = documents.get(body.documentId);
  if (!document) throw Object.assign(new Error('导入的小说已失效，请重新选择 TXT 文件。'), { statusCode: 404 });
  const job = await buildJobFromBody(body, document);
  jobs.set(job.id, job);
  persistJob(job);
  resumeJob(job, document, { restart: false });
  return job;
}

function pendingChapters(job) {
  const failedNumbers = new Set(job.failedChapters.map((item) => item.number));
  const pending = job.cleanedChapters.filter((chapter) => !job.results.has(chapter.number) && !failedNumbers.has(chapter.number));
  const retry = job.cleanedChapters.filter((chapter) => failedNumbers.has(chapter.number));
  return pending.concat(retry);
}

function resumeJob(job, document, options = {}) {
  const restart = Boolean(options.restart);
  const pending = restart && job.status === 'completed' ? job.cleanedChapters : pendingChapters(job);
  if (!pending.length) {
    if (job.status !== 'completed') {
      job.status = 'completed';
      addJobLog(job, '所有章节都已处理完成。');
    }
    return job;
  }
  const batches = createBatches(pending, job.publicConfig.chaptersPerBatch, job.publicConfig.maxCharsPerBatch);
  job.totalBatches = batches.length;
  job.completedBatches = 0;
  job.completedAt = null;
  job.error = null;
  job.resumable = false;
  if (!job.startedAt) job.startedAt = new Date().toISOString();
  synchronizeJobConfig(job);
  addJobLog(job, restart
    ? `重新开始处理 ${pending.length} 章，共 ${batches.length} 批。`
    : `继续处理剩余 ${pending.length} 章，共 ${batches.length} 批；已完成 ${job.results.size} 章。`);
  processJob(job, document, batches);
  return job;
}

async function runRetryPass(job) {
  const failedNumbers = new Set(job.failedChapters.filter((item) => !/HTTP 429\b/.test(item.error)).map((item) => item.number));
  const retry = job.cleanedChapters.filter((chapter) => failedNumbers.has(chapter.number));
  if (!retry.length) return;
  const batches = createBatches(retry, 1, job.publicConfig.maxCharsPerBatch);
  addJobLog(job, `失败章节重试：${retry.length} 章，共 ${batches.length} 批。`, 'warning');
  for (const batch of batches) {
    await waitWhilePaused(job);
    if (job.controller.signal.aborted) return;
    try {
      const results = await runModelBatch(batch, job);
      for (const result of results) {
        job.results.set(result.number, result);
        job.failedChapters = job.failedChapters.filter((item) => item.number !== result.number);
        addJobLog(job, `第 ${result.number} 章重试成功。`, 'info');
        persistJob(job);
      }
    } catch (error) {
      addJobLog(job, `第 ${batch[0].number} 章重试仍然失败：${error.message}`, 'error');
    }
  }
}

// ---------- 三级自动补偿队列 ----------
// 主流程 + 逐章重试轮都失败的章节进入这里：5 分钟第 1 次、30 分钟第 2 次、2 小时第 3 次。
// 补偿成功则替换规则回退版并更新导出；仍失败则保留并标记。不阻塞任何正常章节。
const COMPENSATION_DELAYS_MS = (process.env.COMPENSATION_DELAYS_MS || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
if (!COMPENSATION_DELAYS_MS.length) COMPENSATION_DELAYS_MS.push(5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000);
const COMPENSATION_TICK_MS = Number(process.env.COMPENSATION_TICK_MS) > 0 ? Number(process.env.COMPENSATION_TICK_MS) : 20000;
const compensationQueue = [];
const exportRefreshTimers = new Map();

function compensationKey(jobId, number) {
  return `${jobId}:${number}`;
}

function enqueueCompensation(job) {
  const existing = new Set(compensationQueue.map((item) => compensationKey(item.jobId, item.number)));
  let added = 0;
  for (const failed of job.failedChapters) {
    if (existing.has(compensationKey(job.id, failed.number))) continue;
    compensationQueue.push({
      jobId: job.id,
      number: failed.number,
      attempt: 0,
      dueAt: Date.now() + COMPENSATION_DELAYS_MS[0],
      lastError: failed.error || null,
    });
    added += 1;
  }
  if (added) {
    addJobLog(job, `${added} 个失败章节进入自动补偿队列：5 分钟 / 30 分钟 / 2 小时后各重试一次。`, 'warning');
    persistJob(job);
  }
}

function compensationSnapshotFor(jobId) {
  return compensationQueue
    .filter((item) => item.jobId === jobId)
    .map((item) => ({ number: item.number, attempt: item.attempt, dueAt: new Date(item.dueAt).toISOString(), lastError: item.lastError }))
    .sort((a, b) => a.number - b.number);
}

// 补偿成功后防抖刷新导出：60 秒内多次成功只重写一次，队列清空时立即刷新。
function scheduleExportRefresh(job) {
  job.exportDirty = true;
  if (exportRefreshTimers.has(job.id)) return;
  const timer = setTimeout(() => {
    exportRefreshTimers.delete(job.id);
    flushExportRefresh(job);
  }, 60000);
  timer.unref();
  exportRefreshTimers.set(job.id, timer);
}

function flushExportRefresh(job) {
  if (!job.exportDirty) return;
  job.exportDirty = false;
  const document = documents.get(job.documentId);
  if (!document || !job.output) return;
  const ordered = job.cleanedChapters.map((candidate) => job.results.get(candidate.number));
  if (ordered.some((entry) => !entry)) return;
  try {
    const title = parseTitle(document.fileName, document.preamble);
    const author = parseAuthor(document.preamble);
    fs.writeFileSync(job.output.textPath, renderNovel(ordered, { title, author }), 'utf8');
    fs.writeFileSync(job.output.reportPath, JSON.stringify(buildJobReport(job, document, ordered), null, 2), 'utf8');
    addJobLog(job, '导出文件已更新（包含补偿校对结果）。', 'info');
  } catch (error) {
    job.exportDirty = true;
    addJobLog(job, `导出刷新失败：${error.message}`, 'warning');
  }
}

async function runCompensationItem(item) {
  const job = jobs.get(item.jobId);
  if (!job) return 'dropped';
  const stillFailed = job.failedChapters.some((failed) => failed.number === item.number);
  if (!stillFailed) return 'dropped';
  const chapter = job.cleanedChapters.find((candidate) => candidate.number === item.number);
  if (!chapter) return 'dropped';
  try {
    const results = await runModelBatch([chapter], job);
    const result = results[0];
    job.results.set(item.number, result);
    job.failedChapters = job.failedChapters.filter((failed) => failed.number !== item.number);
    job.completedChapters = job.cleanedChapters.filter((candidate) => job.results.has(candidate.number)).length;
    addJobLog(job, `第 ${item.number} 章补偿校对成功，已替换规则回退版。`, 'info');
    persistJob(job);
    if (!job.failedChapters.length) {
      const document = documents.get(job.documentId);
      if (document) {
        if (job.output) {
          // 已导出过的任务：防抖刷新导出文件，避免逐章重写大文件。
          scheduleExportRefresh(job);
        } else {
          finalizeJob(job, document);
        }
      }
    } else if (job.output) {
      scheduleExportRefresh(job);
    }
    return 'recovered';
  } catch (error) {
    item.lastError = error.message;
    item.attempt += 1;
    addJobLog(job, `第 ${item.number} 章第 ${item.attempt} 次补偿失败：${error.message}`, 'warning');
    if (item.attempt < COMPENSATION_DELAYS_MS.length) {
      item.dueAt = Date.now() + COMPENSATION_DELAYS_MS[item.attempt];
      return 'retry-later';
    }
    addJobLog(job, `第 ${item.number} 章三次补偿均失败，保留规则清理版，可手动重试。`, 'error');
    return 'gave-up';
  }
}

const compensationTimer = setInterval(() => {
  const now = Date.now();
  // ponytail: 同时补偿最多 3 章；如补偿吞吐成为瓶颈，可改为独立可配置配额。
  let slots = Math.max(0, 3 - compensationQueue.filter((item) => item.running).length);
  for (const item of compensationQueue) {
    const job = jobs.get(item.jobId);
    if (!slots || item.running || item.dueAt > now || !job || job.restored || ['running', 'paused', 'interrupted'].includes(job.status)) continue;
    slots -= 1;
    item.running = true;
    runCompensationItem(item).then((outcome) => {
      item.running = false;
      if (outcome !== 'retry-later') {
        const index = compensationQueue.indexOf(item);
        if (index >= 0) compensationQueue.splice(index, 1);
      }
      if (!compensationQueue.some((entry) => entry.jobId === item.jobId) && job.exportDirty) flushExportRefresh(job);
      persistJob(job);
    }).catch((error) => {
      item.running = false;
      item.dueAt = Date.now() + COMPENSATION_DELAYS_MS[0];
      item.lastError = error.message;
      persistJob(job);
    });
  }
}, COMPENSATION_TICK_MS);
compensationTimer.unref();

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (request.method === 'GET' && pathname === '/api/defaults') {
    sendJson(response, 200, {
      rules: DEFAULT_RULES,
      extractionRules: EXTRACTION_RULES,
      provider: { baseUrl: 'http://127.0.0.1:3001/v1', model: 'auto', timeoutMs: 120000, maxTokens: 20000 },
      batching: { chaptersPerBatch: 3, concurrency: 2, maxCharsPerBatch: 18000 },
      glossary: DEFAULT_GLOSSARY,
      glossaryOptions: { useGlossary: true, glossaryAutoGrow: false, extractionCharLimit: 120000, useWebSearch: false },
      providerPresets: PROVIDER_PRESETS,
      launcherPath: DEFAULT_LAUNCHER,
      scheduler: scheduler.snapshot(),
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/scheduler') {
    sendJson(response, 200, scheduler.snapshot());
    return;
  }

  if (request.method === 'GET' && pathname === '/api/freellm/status') {
    try {
      const probe = await fetchWithTimeout('http://127.0.0.1:3001/v1/models', { method: 'GET' }, 3000);
      sendJson(response, 200, { running: true, httpStatus: probe.status, needsKey: probe.status === 401 });
    } catch (error) {
      sendJson(response, 200, { running: false, error: error.message });
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/api/freellm/start') {
    const body = await readJson(request);
    const requestedPath = String(body.launcherPath || DEFAULT_LAUNCHER);
    const bundledPath = path.join(ROOT, 'assets', 'FreeLLMAPI 启动器.vbs');
    const launcherPath = fs.existsSync(requestedPath) ? requestedPath : bundledPath;
    if (!fs.existsSync(launcherPath)) throw Object.assign(new Error('找不到 FreeLLMAPI 启动脚本。'), { statusCode: 404 });
    const wscriptPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
    const executable = fs.existsSync(wscriptPath) ? wscriptPath : 'wscript.exe';
    const child = spawn(executable, [launcherPath], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    sendJson(response, 200, { ok: true, launcherPath });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/provider/models') {
    const body = await readJson(request);
    const result = await testProvider(body);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/glossary/extract') {
    const body = await readJson(request);
    sendJson(response, 200, await extractGlossary(body));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/glossary/save') {
    const body = await readJson(request);
    const document = documents.get(body.documentId);
    if (!document) throw Object.assign(new Error('导入的小说已失效，请重新选择 TXT 文件。'), { statusCode: 404 });
    const glossary = normalizeGlossary(body.glossary);
    saveGlossary(document.id, glossary);
    document.glossary = glossary;
    sendJson(response, 200, { ok: true, entryCount: glossary.entries.length, savedTo: `glossaries/${document.id}.json` });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/glossary') {
    const documentId = url.searchParams.get('documentId');
    if (!documentId) throw Object.assign(new Error('缺少 documentId。'), { statusCode: 400 });
    const glossary = loadGlossary(documentId) || DEFAULT_GLOSSARY;
    sendJson(response, 200, { glossary });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/provider/test') {
    const body = await readJson(request);
    sendJson(response, 200, await testProvider(body));
    return;
  }

  if (request.method === 'POST' && pathname === '/api/documents/analyze') {
    const body = await readJson(request);
    const text = String(body.text || '');
    if (!text.trim()) throw Object.assign(new Error('TXT 文件内容为空。'), { statusCode: 400 });
    const sanitized = sanitizeScrapeArtifacts(text);
    const parsed = splitNovel(sanitized.text);
    if (!parsed.chapters.length) throw Object.assign(new Error('未识别到章节标题，请检查是否使用“第N章”一类标题。'), { statusCode: 400 });
    const id = crypto.randomUUID();
    const document = {
      id,
      fileName: String(body.fileName || '未命名小说.txt'),
      preamble: parsed.preamble,
      chapters: parsed.chapters,
      warnings: parsed.warnings,
      stats: { ...parsed.stats, ...sanitized.stats },
      createdAt: new Date().toISOString(),
    };
    documents.set(id, document);
    const lengths = parsed.chapters.map((chapter) => chapter.rawBody.length);
    const averageChars = Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length);
    const missing = missingChapterNumbers(parsed.chapters);
    sendJson(response, 200, {
      id,
      fileName: document.fileName,
      chapterCount: parsed.chapters.length,
      firstChapter: parsed.chapters[0].number,
      lastChapter: parsed.chapters[parsed.chapters.length - 1].number,
      averageChars,
      minChars: Math.min(...lengths),
      maxChars: Math.max(...lengths),
      duplicateHeaders: parsed.stats.duplicateHeaders,
      correctedHeaders: parsed.stats.correctedHeaders,
      suspiciousHeaders: parsed.stats.suspiciousHeaders,
      knownIntrusionLinesRemoved: sanitized.stats.knownIntrusionLinesRemoved,
      missingNumbers: missing.slice(0, 200),
      warningCount: parsed.warnings.length,
      warnings: parsed.warnings.slice(0, 30),
      chapters: parsed.chapters.map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        chars: chapter.rawBody.length,
        sourceLine: chapter.sourceLine,
        corrected: chapter.corrected,
      })),
      recommendation: {
        chaptersPerBatch: averageChars > 6500 ? 2 : 3,
        concurrency: 2,
        maxCharsPerBatch: 18000,
      },
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/jobs') {
    const list = Array.from(jobs.values())
      .filter((job) => job.status !== 'completed' || job.failedChapters.length)
      .map((job) => ({
        id: job.id,
        documentId: job.documentId,
        fileName: job.fileName,
        status: job.status,
        mode: job.mode,
        updatedAt: job.updatedAt,
        totalChapters: job.totalChapters,
        completedChapters: job.completedChapters,
        failedCount: job.failedChapters.length,
        range: [job.publicConfig.start, job.publicConfig.end],
        baseUrl: job.publicConfig.baseUrl,
        model: job.publicConfig.model,
        output: job.output ? {
          textName: path.basename(job.output.textPath),
          textUrl: `/api/jobs/${job.id}/download?type=text`,
          reportUrl: `/api/jobs/${job.id}/download?type=report`,
        } : null,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(response, 200, { jobs: list });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/jobs/resumable') {
    const list = Array.from(jobs.values())
      .filter((job) => job.resumable || ['interrupted', 'paused'].includes(job.status))
      .map((job) => ({
        id: job.id,
        documentId: job.documentId,
        fileName: job.fileName,
        status: job.status,
        mode: job.mode,
        updatedAt: job.updatedAt,
        totalChapters: job.totalChapters,
        completedChapters: job.completedChapters,
        failedCount: job.failedChapters.length,
        range: [job.publicConfig.start, job.publicConfig.end],
        baseUrl: job.publicConfig.baseUrl,
        model: job.publicConfig.model,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(response, 200, { jobs: list });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/jobs') {
    const body = await readJson(request);
    const job = await createJob(body);
    if (process.env.DEBUG_JOBS) {
      try { jobSnapshot(job); } catch (error) { console.error('snapshot debug:', error.stack); }
    }
    sendJson(response, 202, jobSnapshot(job));
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(pause|resume|cancel|discard|download|chapter|retry))?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) throw Object.assign(new Error('任务不存在。'), { statusCode: 404 });
    const action = jobMatch[2];
    if (request.method === 'GET' && !action) {
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'retry') {
      if (job.status === 'running') throw Object.assign(new Error('任务正在运行，请先暂停或等待结束。'), { statusCode: 409 });
      if (!job.failedChapters.length) throw Object.assign(new Error('当前没有需要重试的失败章节。'), { statusCode: 409 });
      const document = documents.get(job.documentId);
      if (!document) throw Object.assign(new Error('原稿已失效，请重新导入该小说。'), { statusCode: 404 });
      const body = await readJson(request);
      const provider = body.provider || {};
      if (provider.baseUrl !== undefined) job.publicConfig.baseUrl = normalizeBaseUrl(provider.baseUrl);
      if (provider.model !== undefined) job.publicConfig.model = String(provider.model).trim();
      if (provider.apiKey !== undefined) job.apiKey = String(provider.apiKey);
      if (provider.timeoutMs !== undefined) job.publicConfig.timeoutMs = clamp(provider.timeoutMs, 15000, 300000, 120000);
      if (provider.maxTokens !== undefined) job.publicConfig.maxTokens = clamp(provider.maxTokens, 1000, 64000, 20000);
      if (body.rules !== undefined) job.publicConfig.rules = String(body.rules || DEFAULT_RULES);
      if (job.mode === 'llm' && (!job.publicConfig.baseUrl || !job.publicConfig.model)) {
        throw Object.assign(new Error('请填写模型 Base URL 和模型名称。'), { statusCode: 400 });
      }
      job.controller = new AbortController();
      const failedNumbers = new Set(job.failedChapters.map((item) => item.number));
      const retry = job.cleanedChapters.filter((chapter) => failedNumbers.has(chapter.number));
      const batches = createBatches(retry, 1, job.publicConfig.maxCharsPerBatch);
      job.totalBatches = batches.length;
      job.completedBatches = 0;
      job.completedAt = null;
      job.error = null;
      job.resumable = false;
      synchronizeJobConfig(job);
      addJobLog(job, `手动重试 ${retry.length} 个失败章节，共 ${batches.length} 批。`, 'warning');
      processJob(job, document, batches);
      sendJson(response, 202, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'pause') {
      if (job.status === 'running') {
        job.status = 'paused';
        addJobLog(job, '任务已暂停，新批次暂不启动；进度已保存。', 'warning');
        persistJob(job);
      }
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'resume') {
      const body = await readJson(request);
      const targetDocument = documents.get(body.documentId || job.documentId);
      if (!targetDocument) throw Object.assign(new Error('请重新导入该小说原稿，再继续未完成任务。'), { statusCode: 404 });
      if (body.provider) {
        if (body.provider.baseUrl !== undefined) job.publicConfig.baseUrl = normalizeBaseUrl(body.provider.baseUrl);
        if (body.provider.model !== undefined) job.publicConfig.model = String(body.provider.model).trim();
        if (body.provider.apiKey !== undefined) job.apiKey = String(body.provider.apiKey);
        if (body.provider.timeoutMs !== undefined) job.publicConfig.timeoutMs = clamp(body.provider.timeoutMs, 15000, 300000, 120000);
        if (body.provider.maxTokens !== undefined) job.publicConfig.maxTokens = clamp(body.provider.maxTokens, 1000, 64000, 20000);
      }
      if (body.rules !== undefined) job.publicConfig.rules = String(body.rules || DEFAULT_RULES);
      if (body.concurrency !== undefined) job.publicConfig.concurrency = clamp(body.concurrency, 1, 10, job.publicConfig.concurrency);
      if (body.chaptersPerBatch !== undefined) job.publicConfig.chaptersPerBatch = clamp(body.chaptersPerBatch, 1, 10, job.publicConfig.chaptersPerBatch);
      if (job.mode === 'llm' && !job.publicConfig.baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
      if (job.status === 'running') throw Object.assign(new Error('任务正在运行。'), { statusCode: 409 });
      if (job.status === 'paused' && !job.restored) {
        synchronizeJobConfig(job);
        job.status = 'running';
        addJobLog(job, '已继续暂停的任务。');
        persistJob(job);
      } else {
        job.controller = new AbortController();
        job.fatalError = null;
        job.documentId = targetDocument.id;
        job.restored = false;
        synchronizeJobConfig(job);
        if (job.status === 'completed' && compensationQueue.some((item) => item.jobId === job.id) && !body.restart) {
          addJobLog(job, '已恢复自动补偿队列。');
          persistJob(job);
        } else {
          for (let i = compensationQueue.length - 1; i >= 0; i--) if (compensationQueue[i].jobId === job.id) compensationQueue.splice(i, 1);
          resumeJob(job, targetDocument, { restart: Boolean(body.restart) });
        }
      }
      sendJson(response, 202, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'discard') {
      if (job.status === 'running') job.controller.abort(new Error('用户放弃任务'));
      job.status = 'discarded';
      job.resumable = false;
      jobs.delete(job.id);
      deletePersistedJob(job.id);
      sendJson(response, 200, { ok: true, id: job.id });
      return;
    }
    if (request.method === 'POST' && action === 'cancel') {
      if (!['completed', 'failed', 'canceled'].includes(job.status)) job.controller.abort(new Error('用户取消任务'));
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'GET' && action === 'chapter') {
      const number = Number(url.searchParams.get('number'));
      const chapter = job.cleanedChapters.find((item) => item.number === number);
      const result = job.results.get(number);
      if (!chapter || !result) throw Object.assign(new Error('该章节尚未完成或不存在。'), { statusCode: 404 });
      sendJson(response, 200, {
        number,
        before: { title: chapter.title, body: chapter.rawBody },
        after: { title: result.title, body: result.body },
        fallback: job.failedChapters.some((item) => item.number === number),
      });
      return;
    }
    if (request.method === 'GET' && action === 'download') {
      if (!job.output) throw Object.assign(new Error('任务尚未生成导出文件。'), { statusCode: 409 });
      const type = url.searchParams.get('type') === 'report' ? 'report' : 'text';
      const filePath = type === 'report' ? job.output.reportPath : job.output.textPath;
      const data = fs.readFileSync(filePath);
      const encoded = encodeURIComponent(path.basename(filePath));
      response.writeHead(200, {
        'Content-Type': type === 'report' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Length': data.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      });
      response.end(data);
      return;
    }
  }

  throw Object.assign(new Error('API endpoint not found'), { statusCode: 404 });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else serveStatic(url.pathname, response);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message || '服务器错误' });
    else response.end();
  }
});

const restoredJobs = loadPersistedJobs();

server.listen(PORT, HOST, () => {
  console.log(`电子说校对工作台已启动：http://${HOST}:${PORT}`);
  console.log(`自动导出目录：${EXPORT_DIR}`);
  if (restoredJobs.length) console.log(`已载入 ${restoredJobs.length} 个未完成任务，可在页面顶部继续。`);
});

// 优雅关闭：中止在途请求并保存所有未完成任务的进度，重启后可继续。
function gracefulShutdown(reason) {
  for (const job of jobs.values()) {
    if (!['running', 'paused', 'queued'].includes(job.status)) continue;
    job.controller.abort(new Error(`工作台收到 ${reason}，进度保存中`));
  }
  setTimeout(() => {
    for (const job of jobs.values()) {
      if (['running', 'paused', 'queued', 'interrupted'].includes(job.status)) {
        job.status = 'interrupted';
        job.completedAt = new Date().toISOString();
        addJobLog(job, `工作台关闭（${reason}），进度已保存，下次启动后可继续。`, 'warning');
        persistJob(job);
      }
    }
    process.exit(0);
  }, 1500);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => gracefulShutdown(signal));
}
