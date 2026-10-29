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

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXPORT_DIR = path.join(ROOT, 'exports');
const GLOSSARY_DIR = path.join(ROOT, 'glossaries');
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_LAUNCHER = path.join(os.homedir(), 'Desktop', 'FreeLLMAPI 启动器.vbs');
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const documents = new Map();
const jobs = new Map();

fs.mkdirSync(EXPORT_DIR, { recursive: true });
fs.mkdirSync(GLOSSARY_DIR, { recursive: true });

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
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_tokens: config.maxTokens,
      messages: [
        {
          role: 'system',
          content: '你是严谨的中文小说校对编辑。只做校对，不改写情节。必须按指定 JSON 结构返回全部章节。',
        },
        { role: 'user', content: buildPrompt(batch, config.rules, config.glossary) },
      ],
    }),
  }, config.timeoutMs, job.controller.signal);
  const responseText = await response.text();
  if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status} - ${responseText.slice(0, 220)}`);

  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new Error('模型接口没有返回 OpenAI 兼容 JSON。');
  }
  const content = envelope?.choices?.[0]?.message?.content;
  const parsed = extractJsonFromModel(content);
  if (!Array.isArray(parsed.chapters)) throw new Error('模型结果缺少 chapters 数组。');

  const byId = new Map(parsed.chapters.map((chapter) => [String(chapter.id ?? chapter.number), chapter]));
  return batch.map((sourceChapter) => {
    const candidate = byId.get(String(sourceChapter.number));
    if (!candidate || typeof candidate.content !== 'string') {
      throw new Error(`模型结果缺少第 ${sourceChapter.number} 章。`);
    }
    const candidateLength = candidate.content.trim().length;
    if (candidateLength < Math.max(100, sourceChapter.body.length * 0.55)) {
      throw new Error(`第 ${sourceChapter.number} 章输出明显过短，已拒绝截断结果。`);
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
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0.1,
      max_tokens: config.maxTokens,
      messages,
    }),
  }, config.timeoutMs, options.signal || null);
  const responseText = await response.text();
  if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status} - ${responseText.slice(0, 220)}`);
  let envelope;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new Error('模型接口没有返回 OpenAI 兼容 JSON。');
  }
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
    glossary: saved,
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

async function waitWhilePaused(job) {
  while (job.status === 'paused' && !job.controller.signal.aborted) await sleep(250);
}

function addJobLog(job, message, level = 'info') {
  job.logs.push({ time: new Date().toISOString(), level, message });
  if (job.logs.length > 200) job.logs.shift();
  job.updatedAt = new Date().toISOString();
}

async function runModelBatch(batch, job) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (job.controller.signal.aborted) throw new Error('任务已取消。');
    try {
      return await callProofreader(batch, job.secretConfig, job);
    } catch (error) {
      lastError = error;
      if (job.controller.signal.aborted) throw error;
      const delay = attempt * 1500;
      addJobLog(job, `第 ${batch[0].number}-${batch[batch.length - 1].number} 章第 ${attempt} 次请求失败：${error.message}`, 'warning');
      if (attempt < 3) await sleep(delay);
    }
  }
  throw lastError;
}

function jobSnapshot(job) {
  const totalChapters = job.totalChapters || 0;
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
    totalChapters,
    completedChapters: job.completedChapters,
    totalBatches: job.totalBatches,
    completedBatches: job.completedBatches,
    failedChapters: job.failedChapters,
    progress: totalChapters ? Math.round((job.completedChapters / totalChapters) * 100) : 0,
    activeBatches: Array.from(job.activeBatches.values()),
    reviewedChapters: Array.from(job.results.values(), (chapter) => ({
      number: chapter.number,
      title: chapter.title,
      fallback: job.failedChapters.some((item) => item.number === chapter.number),
    })).sort((a, b) => a.number - b.number),
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

async function processJob(job, document, selected, cleaned, batches) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  addJobLog(job, `开始处理 ${cleaned.length} 章，共 ${batches.length} 批。`);
  let nextBatchIndex = 0;

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
      if (job.mode === 'rules') {
        results = batch;
        await sleep(30);
      } else {
        try {
          results = await runModelBatch(batch, job);
        } catch (batchError) {
          addJobLog(job, `${rangeLabel}批量处理失败，自动降为逐章重试。`, 'warning');
          for (const chapter of batch) {
            try {
              const individual = await runModelBatch([chapter], job);
              results.push(individual[0]);
            } catch (chapterError) {
              job.failedChapters.push({ number: chapter.number, error: chapterError.message });
              results.push(chapter);
              addJobLog(job, `第 ${chapter.number} 章模型校对失败，已保留规则清理版。`, 'error');
            }
          }
        }
      }

      for (const result of results) job.results.set(result.number, result);
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
      job.completedChapters += batch.length;
      job.completedBatches += 1;
      job.activeBatches.delete(workerIndex);
      addJobLog(job, `${rangeLabel}处理完成。`);
    }
  };

  try {
    const workers = Array.from({ length: Math.min(job.publicConfig.concurrency, Math.max(1, batches.length)) }, (_, index) => worker(index));
    await Promise.all(workers);
    if (job.controller.signal.aborted) {
      job.status = 'canceled';
      job.completedAt = new Date().toISOString();
      addJobLog(job, '任务已取消。', 'warning');
      return;
    }

    const ordered = cleaned.map((chapter) => job.results.get(chapter.number) || chapter);
    const title = parseTitle(document.fileName, document.preamble);
    const author = parseAuthor(document.preamble);
    const stem = safeFilePart(path.basename(document.fileName, path.extname(document.fileName)));
    const stamp = timestampForFile();
    const textPath = path.join(EXPORT_DIR, `${stem}_第${ordered[0]?.number || ''}-${ordered[ordered.length - 1]?.number || ''}章_校对版_${stamp}.txt`);
    const reportPath = path.join(EXPORT_DIR, `${stem}_校对报告_${stamp}.json`);
    fs.writeFileSync(textPath, renderNovel(ordered, { title, author }), 'utf8');
    fs.writeFileSync(reportPath, JSON.stringify({
      sourceFile: document.fileName,
      generatedAt: new Date().toISOString(),
      mode: job.mode,
      range: { start: ordered[0]?.number || null, end: ordered[ordered.length - 1]?.number || null, chapters: ordered.length },
      config: job.publicConfig,
      sourceParseStats: document.stats,
      sourceWarnings: document.warnings,
      cleanupStats: aggregateStats(cleaned),
      failedChapters: job.failedChapters,
      glossary: {
        enabled: Boolean(job.publicConfig.useGlossary),
        entryCount: normalizeGlossary(job.publicConfig.glossary).entries.length,
        autoGrowEnabled: Boolean(job.publicConfig.glossaryAutoGrow),
        autoAddedCount: job.autoAddedGlossary.length,
        autoAdded: job.autoAddedGlossary,
        finalGlossary: normalizeGlossary(job.publicConfig.glossary).entries,
      },
      note: '源文件未被覆盖；模型失败的章节自动保留规则清理版，并在 failedChapters 中列出。',
    }, null, 2), 'utf8');
    saveGlossary(document.id, normalizeGlossary(job.publicConfig.glossary));
    if (job.failedChapters.length) {
      addJobLog(job, `有 ${job.failedChapters.length} 章模型校对失败，已保留规则清理版；请检查模型、密钥或并发设置。`, 'warning');
    }
    job.output = { textPath, reportPath };
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    addJobLog(job, `全部完成，已自动合并导出 ${path.basename(textPath)}。`);
  } catch (error) {
    job.activeBatches.clear();
    if (job.controller.signal.aborted) {
      job.status = 'canceled';
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = error.message;
      addJobLog(job, `任务失败：${error.message}`, 'error');
    }
    job.completedAt = new Date().toISOString();
  }
}

async function createJob(body) {
  const document = documents.get(body.documentId);
  if (!document) throw Object.assign(new Error('导入的小说已失效，请重新选择 TXT 文件。'), { statusCode: 404 });
  const start = Number(body.start);
  const end = Number(body.end);
  const selected = selectChapters(document.chapters, start, end);
  if (!selected.length) throw Object.assign(new Error('所选范围内没有识别到章节。'), { statusCode: 400 });
  const cleaned = selected.map((chapter) => cleanChapter(chapter));
  const chaptersPerBatch = clamp(body.chaptersPerBatch, 1, 10, 3);
  const concurrency = clamp(body.concurrency, 1, 10, 2);
  const maxCharsPerBatch = clamp(body.maxCharsPerBatch, 4000, 50000, 18000);
  const mode = body.mode === 'rules' ? 'rules' : 'llm';
  const baseUrl = normalizeBaseUrl(body.provider?.baseUrl || 'http://127.0.0.1:3001/v1');
  const model = String(body.provider?.model || 'auto').trim() || 'auto';
  if (mode === 'llm' && !baseUrl) throw Object.assign(new Error('请填写模型 Base URL。'), { statusCode: 400 });
  const batches = createBatches(cleaned, chaptersPerBatch, maxCharsPerBatch);
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job = {
    id,
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
    totalBatches: batches.length,
    completedBatches: 0,
    failedChapters: [],
    results: new Map(),
    activeBatches: new Map(),
    logs: [],
    output: null,
    error: null,
    autoAddedGlossary: [],
    parseStats: document.stats,
    controller,
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
      useGlossary: body.useGlossary !== false,
      glossaryAutoGrow: Boolean(body.glossaryAutoGrow),
      glossary: normalizeGlossary(body.glossary),
    },
  };
  job.secretConfig = { ...job.publicConfig, apiKey: String(body.provider?.apiKey || '') };
  jobs.set(id, job);
  processJob(job, document, selected, cleaned, batches);
  return job;
}

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
    });
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

  if (request.method === 'POST' && pathname === '/api/jobs') {
    const body = await readJson(request);
    const job = await createJob(body);
    sendJson(response, 202, jobSnapshot(job));
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(pause|resume|cancel|download|chapter))?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) throw Object.assign(new Error('任务不存在。'), { statusCode: 404 });
    const action = jobMatch[2];
    if (request.method === 'GET' && !action) {
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'GET' && action === 'chapter') {
      const number = Number(url.searchParams.get('number'));
      const original = documents.get(job.documentId)?.chapters.find((chapter) => chapter.number === number);
      const result = job.results.get(number);
      if (!original || !result) throw Object.assign(new Error('该章节尚未完成或不存在。'), { statusCode: 404 });
      sendJson(response, 200, {
        number, before: { title: original.title, body: original.rawBody },
        after: { title: result.title, body: result.body },
        fallback: job.failedChapters.some((item) => item.number === number),
      });
      return;
    }
    if (request.method === 'POST' && action === 'pause') {
      if (job.status === 'running') {
        job.status = 'paused';
        addJobLog(job, '任务已暂停，新批次暂不启动。', 'warning');
      }
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'resume') {
      if (job.status === 'paused') {
        job.status = 'running';
        addJobLog(job, '任务已继续。');
      }
      sendJson(response, 200, jobSnapshot(job));
      return;
    }
    if (request.method === 'POST' && action === 'cancel') {
      if (!['completed', 'failed', 'canceled'].includes(job.status)) job.controller.abort(new Error('用户取消任务'));
      sendJson(response, 200, jobSnapshot(job));
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

server.listen(PORT, HOST, () => {
  console.log(`电子书校对已启动：http://${HOST}:${PORT}`);
  console.log(`自动导出目录：${EXPORT_DIR}`);
});
