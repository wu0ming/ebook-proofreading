'use strict';

const state = {
  defaults: null,
  document: null,
  sourceFile: null,
  job: null,
  pollTimer: null,
  reviewPage: 0,
  reviewFilter: 'all',
  resumableJobs: [],
};

const REVIEW_PAGE_SIZE = 48;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  fileInput: $('#fileInput'),
  dropZone: $('#dropZone'),
  fileLine: $('#fileLine'),
  fileName: $('#fileName'),
  fileSize: $('#fileSize'),
  analysisState: $('#analysisState'),
  analysisCard: $('#analysisCard'),
  configurationArea: $('#configurationArea'),
  rulesCard: $('#rulesCard'),
  actionCard: $('#actionCard'),
  progressCard: $('#progressCard'),
  chapterCount: $('#chapterCount'),
  chapterRange: $('#chapterRange'),
  averageChars: $('#averageChars'),
  duplicateHeaders: $('#duplicateHeaders'),
  noiseCount: $('#noiseCount'),
  warningStrip: $('#warningStrip'),
  warningText: $('#warningText'),
  toggleChapterList: $('#toggleChapterList'),
  chapterTableWrap: $('#chapterTableWrap'),
  chapterTableBody: $('#chapterTableBody'),
  startChapter: $('#startChapter'),
  endChapter: $('#endChapter'),
  selectedCount: $('#selectedCount'),
  selectedChars: $('#selectedChars'),
  baseUrl: $('#baseUrl'),
  modelName: $('#modelName'),
  apiKey: $('#apiKey'),
  launcherPath: $('#launcherPath'),
  saveConnectionButton: $('#saveConnectionButton'),
  clearConnectionButton: $('#clearConnectionButton'),
  connectionSaveStatus: $('#connectionSaveStatus'),
  providerTestStatus: $('#providerTestStatus'),
  testProviderButton: $('#testProviderButton'),
  startFreeLlmButton: $('#startFreeLlmButton'),
  freeLlmStatus: $('#freeLlmStatus'),
  chaptersPerBatch: $('#chaptersPerBatch'),
  concurrency: $('#concurrency'),
  maxCharsPerBatch: $('#maxCharsPerBatch'),
  ruleFallback: $('#ruleFallback'),
  autoRetryRounds: $('#autoRetryRounds'),
  retryArea: $('#retryArea'),
  resumeCard: $('#resumeCard'),
  resumeTitle: $('#resumeTitle'),
  resumeDescription: $('#resumeDescription'),
  resumeJobButton: $('#resumeJobButton'),
  discardJobButton: $('#discardJobButton'),
  reviewFilters: $('#reviewFilters'),
  reviewPager: $('#reviewPager'),
  progressLive: $('#progressLive'),
  retrySummary: $('#retrySummary'),
  retryFailedButton: $('#retryFailedButton'),
  compensationArea: $('#compensationArea'),
  compensationSummary: $('#compensationSummary'),
  schedulerPanel: $('#schedulerPanel'),
  schedulerState: $('#schedulerState'),
  schedulerInFlight: $('#schedulerInFlight'),
  schedulerLimit: $('#schedulerLimit'),
  schedulerSuccessRate: $('#schedulerSuccessRate'),
  schedulerTotal: $('#schedulerTotal'),
  schedulerModels: $('#schedulerModels'),
  batchFigure: $('#batchFigure'),
  concurrencyFigure: $('#concurrencyFigure'),
  inFlightFigure: $('#inFlightFigure'),
  batchRecommendation: $('#batchRecommendation'),
  rulesEditor: $('#rulesEditor'),
  rulesCount: $('#rulesCount'),
  resetRulesButton: $('#resetRulesButton'),
  providerPresets: $('#providerPresets'),
  presetNote: $('#presetNote'),
  fetchModelsButton: $('#fetchModelsButton'),
  modelOptions: $('#modelOptions'),
  glossaryCard: $('#glossaryCard'),
  glossaryCount: $('#glossaryCount'),
  glossarySourceSplit: $('#glossarySourceSplit'),
  glossaryInjectState: $('#glossaryInjectState'),
  glossaryExtractScope: $('#glossaryExtractScope'),
  useGlossary: $('#useGlossary'),
  glossaryAutoGrow: $('#glossaryAutoGrow'),
  useWebSearch: $('#useWebSearch'),
  extractGlossaryButton: $('#extractGlossaryButton'),
  saveGlossaryButton: $('#saveGlossaryButton'),
  toggleGlossaryJson: $('#toggleGlossaryJson'),
  glossaryStatus: $('#glossaryStatus'),
  glossaryChips: $('#glossaryChips'),
  glossaryEditorWrap: $('#glossaryEditorWrap'),
  glossaryEditor: $('#glossaryEditor'),
  jobSummary: $('#jobSummary'),
  startJobButton: $('#startJobButton'),
  progressSubtitle: $('#progressSubtitle'),
  progressPercent: $('#progressPercent'),
  progressRing: $('#progressRing'),
  progressChapterLabel: $('#progressChapterLabel'),
  progressBatchLabel: $('#progressBatchLabel'),
  progressBar: $('#progressBar'),
  laneGrid: $('#laneGrid'),
  logPanel: $('#logPanel'),
  pauseJobButton: $('#pauseJobButton'),
  cancelJobButton: $('#cancelJobButton'),
  resultPanel: $('#resultPanel'),
  resultDescription: $('#resultDescription'),
  downloadTextLink: $('#downloadTextLink'),
  downloadReportLink: $('#downloadReportLink'),
  reviewList: $('#reviewList'),
  compareDialog: $('#compareDialog'),
  compareHeading: $('#compareHeading'),
  compareStats: $('#compareStats'),
  compareNote: $('#compareNote'),
  compareBefore: $('#compareBefore'),
  compareAfter: $('#compareAfter'),
  closeCompare: $('#closeCompare'),
  toastRegion: $('#toastRegion'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function toast(message, type = 'info', timeout = 4200) {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  elements.toastRegion.appendChild(item);
  setTimeout(() => item.remove(), timeout);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
  return payload;
}

function updateStep(step) {
  $$('.step').forEach((item) => item.classList.toggle('active', Number(item.dataset.step) === step));
}

function setFreeLlmStatus(status) {
  const dot = elements.freeLlmStatus.querySelector('.dot');
  dot.className = 'dot';
  if (status.running) {
    dot.classList.add(status.needsKey ? 'warn' : 'ok');
    elements.freeLlmStatus.lastChild.textContent = status.needsKey ? ' FreeLLM 运行中 · 需要密钥' : ' FreeLLM 已连接';
  } else {
    dot.classList.add('bad');
    elements.freeLlmStatus.lastChild.textContent = ' FreeLLM 未运行';
  }
}

async function checkFreeLlm() {
  try {
    const status = await api('/api/freellm/status', { method: 'GET', headers: {} });
    setFreeLlmStatus(status);
  } catch {
    setFreeLlmStatus({ running: false });
  }
}

async function initialize() {
  state.defaults = await api('/api/defaults', { method: 'GET', headers: {} });
  elements.rulesEditor.value = state.defaults.rules;
  elements.baseUrl.value = state.defaults.provider.baseUrl;
  elements.modelName.value = state.defaults.provider.model;
  elements.launcherPath.value = state.defaults.launcherPath;
  elements.chaptersPerBatch.value = state.defaults.batching.chaptersPerBatch;
  elements.concurrency.value = state.defaults.batching.concurrency;
  elements.maxCharsPerBatch.value = state.defaults.batching.maxCharsPerBatch;
  if (elements.autoRetryRounds) elements.autoRetryRounds.value = 1;
  renderProviderPresets();
  loadConnectionSettings();
  setGlossary(state.defaults.glossary);
  updateRuleCount();
  updateBatchVisual();
  await loadResumableJobs();
  // 服务重启后，只有已保存的匹配连接才用于自动续跑。
  const jobs = await api('/api/jobs', { method: 'GET', headers: {} });
  const active = (jobs.jobs || []).find((job) => ['running', 'paused'].includes(job.status));
  if (active) {
    state.job = await api(`/api/jobs/${encodeURIComponent(active.id)}`, { method: 'GET', headers: {} });
    elements.progressCard.classList.remove('hidden');
    renderJob(state.job);
    schedulePoll(200);
  } else {
    const saved = (() => { try { return JSON.parse(localStorage.getItem(CONNECTION_SETTINGS_KEY) || 'null'); } catch { return null; } })();
    const target = state.resumableJobs.find((job) => ['interrupted', 'completed'].includes(job.status) && (job.mode === 'rules' || (saved && saved.baseUrl === job.baseUrl && saved.model === job.model)));
    if (target) await resumePersistedJob(target.id, true);
  }
  await checkFreeLlm();
  refreshScheduler();
  setInterval(refreshScheduler, 3000);
}

async function refreshScheduler() {
  try {
    const snapshot = await api('/api/scheduler', { method: 'GET', headers: {} });
    renderScheduler(snapshot);
  } catch { /* 调度面板非关键，静默失败 */ }
}

function renderScheduler(snapshot) {
  if (!snapshot) return;
  const busy = snapshot.inFlight > 0;
  elements.schedulerState.textContent = busy ? '运行中' : '空闲';
  elements.schedulerState.classList.toggle('live', busy);
  elements.schedulerInFlight.textContent = `${snapshot.inFlight} / ${snapshot.maxGlobal}`;
  elements.schedulerLimit.textContent = `${snapshot.currentLimit}（上限 ${snapshot.maxConcurrency}）`;
  elements.schedulerSuccessRate.textContent = snapshot.stats.successRate == null ? '—' : `${snapshot.stats.successRate}%`;
  elements.schedulerTotal.textContent = formatNumber(snapshot.stats.total);
  const models = Object.entries(snapshot.stats.byModel || {})
    .sort((a, b) => (b[1].total || 0) - (a[1].total || 0))
    .slice(0, 6);
  if (!models.length) {
    elements.schedulerModels.innerHTML = '<span class="scheduler-empty">暂无请求记录</span>';
    return;
  }
  elements.schedulerModels.innerHTML = models.map(([model, item]) => {
    const rate = item.total ? Math.round((item.succeeded / item.total) * 100) : 0;
    const state = item.failed && item.succeeded === 0 ? 'bad' : item.failed ? 'warn' : 'good';
    return `<div class="scheduler-model ${state}"><strong>${escapeHtml(model)}</strong><span>${formatNumber(item.succeeded)} / ${formatNumber(item.total)} · ${rate}%</span></div>`;
  }).join('');
}

const CONNECTION_SETTINGS_KEY = 'ebook-proofreading.connection.v1';

function loadConnectionSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONNECTION_SETTINGS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.baseUrl === 'string') elements.baseUrl.value = saved.baseUrl;
    if (typeof saved.model === 'string') elements.modelName.value = saved.model;
    if (typeof saved.apiKey === 'string') elements.apiKey.value = saved.apiKey;
    if (typeof saved.launcherPath === 'string') elements.launcherPath.value = saved.launcherPath;
    $$('#providerPresets .preset').forEach((button) => button.classList.toggle('active', button.dataset.base === elements.baseUrl.value && button.dataset.model === elements.modelName.value));
    elements.connectionSaveStatus.textContent = '已载入本机配置';
  } catch { elements.connectionSaveStatus.textContent = '读取失败'; }
}

function saveConnectionSettings() {
  try {
    localStorage.setItem(CONNECTION_SETTINGS_KEY, JSON.stringify({ baseUrl: elements.baseUrl.value.trim(), model: elements.modelName.value.trim(), apiKey: elements.apiKey.value, launcherPath: elements.launcherPath.value.trim() }));
    elements.connectionSaveStatus.textContent = '已保存到本机浏览器';
    toast('模型配置已保存。', 'success');
  } catch { toast('保存失败，请检查浏览器的本地存储设置。', 'error'); }
}

function clearConnectionSettings() {
  try {
    localStorage.removeItem(CONNECTION_SETTINGS_KEY);
    elements.connectionSaveStatus.textContent = '已清除本机保存的配置';
    toast('已清除保存的配置；当前输入保持不变。', 'success');
  } catch { toast('清除失败，请检查浏览器的本地存储设置。', 'error'); }
}

function renderProviderPresets() {
  const presets = state.defaults?.providerPresets?.presets || [];
  elements.providerPresets.innerHTML = presets.map((preset, index) => `
    <button class="preset${index === 0 ? ' active' : ''}" data-base="${escapeHtml(preset.baseUrl)}" data-model="${escapeHtml(preset.model)}" data-note="${escapeHtml(preset.note || '')}">${escapeHtml(preset.label)}</button>`).join('');
  elements.presetNote.textContent = presets.find((preset) => preset.id === 'freellm')?.note
    || '默认连接本机 FreeLLMAPI，模型可填 auto / auto:smart / auto:fast。';
  $$('#providerPresets .preset').forEach((button) => button.addEventListener('click', () => {
    $$('#providerPresets .preset').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    elements.baseUrl.value = button.dataset.base;
    elements.modelName.value = button.dataset.model;
    if (button.dataset.note) elements.presetNote.textContent = button.dataset.note;
  }));
}

function normalizeGlossaryInput(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value || '{"version":1,"entries":[]}');
    } catch {
      throw new Error('词表 JSON 格式无效，请检查后重试。');
    }
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return {
    version: 1,
    entries: entries.map((entry) => ({
      name: String(entry?.name || '').trim(),
      type: ['character', 'term', 'place', 'organization'].includes(entry?.type) ? entry.type : 'term',
      aliases: Array.isArray(entry?.aliases) ? entry.aliases.filter(Boolean) : [],
      note: String(entry?.note || ''),
      source: entry?.source === 'auto' ? 'auto' : 'manual',
      originChapter: Number(entry?.originChapter) || null,
    })).filter((entry) => entry.name),
  };
}

function setGlossary(glossary) {
  state.glossary = normalizeGlossaryInput(glossary);
  renderGlossary();
}

function renderGlossary() {
  const glossary = state.glossary || { entries: [] };
  elements.glossaryCard.classList.remove('hidden');
  elements.glossaryCount.textContent = `${formatNumber(glossary.entries.length)} 条`;
  const manual = glossary.entries.filter((entry) => entry.source !== 'auto').length;
  elements.glossarySourceSplit.textContent = `${formatNumber(manual)} / ${formatNumber(glossary.entries.length - manual)}`;
  elements.glossaryInjectState.textContent = elements.useGlossary.checked ? '已启用' : '已停用';
  elements.glossaryEditor.value = JSON.stringify(glossary, null, 2);
  elements.glossaryChips.innerHTML = glossary.entries.slice(0, 60).map((entry) => {
    const label = `${entry.name}${entry.aliases?.length ? ` · ${entry.aliases.slice(0, 3).join('、')}` : ''}`;
    return `<span class="chip${entry.source === 'auto' ? ' auto' : ''}" title="${escapeHtml(entry.note || '')}"><b>${escapeHtml(label)}</b></span>`;
  }).join('') || '<span class="chip">暂无词条</span>';
}

async function loadSavedGlossary(documentId) {
  try {
    const result = await api(`/api/glossary?documentId=${encodeURIComponent(documentId)}`, { method: 'GET', headers: {} });
    if (result.glossary?.entries?.length) {
      setGlossary(result.glossary);
      elements.glossaryStatus.textContent = '已载入已保存词表';
      elements.glossaryStatus.className = 'inline-status success';
    }
  } catch {
    // 没有已保存词表时保持默认词表即可。
  }
}

async function extractGlossary() {
  if (!state.document) {
    toast('请先导入 TXT 文件。', 'error');
    return;
  }
  let glossary;
  try {
    glossary = normalizeGlossaryInput(elements.glossaryEditor.value);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  elements.extractGlossaryButton.disabled = true;
  elements.glossaryStatus.textContent = '正在聚合章节并提取词表…';
  elements.glossaryStatus.className = 'inline-status';
  try {
    const result = await api('/api/glossary/extract', {
      method: 'POST',
      body: JSON.stringify({
        documentId: state.document.id,
        start: Number(elements.startChapter.value),
        end: Number(elements.endChapter.value),
        charLimit: state.defaults.glossaryOptions?.extractionCharLimit || 120000,
        useWebSearch: elements.useWebSearch.checked,
        glossary,
        provider: providerPayload(),
      }),
    });
    setGlossary(result.glossary);
    elements.glossaryStatus.textContent = `新增 ${result.added} 条，扫描 ${result.scannedChapters} 章`;
    elements.glossaryStatus.className = 'inline-status success';
    toast(`词表提取完成：新增 ${result.added} 条，共 ${result.glossary.entries.length} 条。`, 'success');
  } catch (error) {
    elements.glossaryStatus.textContent = '提取失败';
    elements.glossaryStatus.className = 'inline-status error';
    toast(error.message, 'error', 7000);
  } finally {
    elements.extractGlossaryButton.disabled = false;
  }
}

async function saveGlossary() {
  if (!state.document) {
    toast('请先导入 TXT 文件。', 'error');
    return;
  }
  try {
    const glossary = normalizeGlossaryInput(elements.glossaryEditor.value);
    state.glossary = glossary;
    const result = await api('/api/glossary/save', {
      method: 'POST',
      body: JSON.stringify({ documentId: state.document.id, glossary }),
    });
    renderGlossary();
    elements.glossaryStatus.textContent = `已保存 ${result.entryCount} 条`;
    elements.glossaryStatus.className = 'inline-status success';
    toast('词表已保存到工作台。', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function fetchModels() {
  elements.fetchModelsButton.disabled = true;
  elements.providerTestStatus.textContent = '正在拉取模型列表…';
  elements.providerTestStatus.className = 'inline-status';
  try {
    const result = await api('/api/provider/models', { method: 'POST', body: JSON.stringify(providerPayload()) });
    const models = result.models || [];
    elements.modelOptions.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
    elements.providerTestStatus.textContent = models.length ? `发现 ${models.length} 个模型` : '接口可用但未返回模型列表';
    elements.providerTestStatus.className = 'inline-status success';
    if (!models.length) toast('接口可连通，但没有返回模型列表；可手动填写模型名。', 'info');
  } catch (error) {
    elements.providerTestStatus.textContent = '拉取失败';
    elements.providerTestStatus.className = 'inline-status error';
    toast(error.message, 'error', 7000);
  } finally {
    elements.fetchModelsButton.disabled = false;
  }
}

async function readTextFile(file) {
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buffer);
  const replacementCount = (text.match(/�/g) || []).length;
  if (replacementCount > Math.max(8, text.length * 0.0005)) {
    try {
      const gbText = new TextDecoder('gb18030').decode(buffer);
      const gbReplacementCount = (gbText.match(/�/g) || []).length;
      if (gbReplacementCount < replacementCount) text = gbText;
    } catch {
      // Current browser may not expose the GB18030 decoder. Keep the UTF-8 attempt.
    }
  }
  return text;
}

async function analyzeFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.txt')) {
    toast('请选择 TXT 文件。', 'error');
    return;
  }
  if (file.size > 55 * 1024 * 1024) {
    toast('文件超过 55 MB，建议先拆分后导入。', 'error');
    return;
  }

  state.sourceFile = file;
  elements.fileLine.classList.remove('hidden');
  elements.fileName.textContent = file.name;
  elements.fileSize.textContent = formatBytes(file.size);
  elements.analysisState.textContent = '正在读取与拆章…';
  elements.analysisState.className = 'analysis-state';
  elements.startJobButton.disabled = true;

  try {
    const text = await readTextFile(file);
    const documentInfo = await api('/api/documents/analyze', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, text }),
    });
    state.document = documentInfo;
    renderAnalysis(documentInfo);
    await loadSavedGlossary(documentInfo.id);
    elements.analysisState.textContent = '分析完成';
    elements.analysisState.className = 'analysis-state done';
    elements.startJobButton.disabled = false;
    toast(`已识别 ${documentInfo.chapterCount} 章。`, 'success');
    updateStep(2);
  } catch (error) {
    elements.analysisState.textContent = '分析失败';
    elements.analysisState.className = 'analysis-state error';
    toast(error.message, 'error', 7000);
  }
}

function renderAnalysis(info) {
  elements.analysisCard.classList.remove('hidden');
  elements.configurationArea.classList.remove('hidden');
  elements.rulesCard.classList.remove('hidden');
  elements.actionCard.classList.remove('hidden');
  elements.chapterCount.textContent = formatNumber(info.chapterCount);
  elements.chapterRange.textContent = `第 ${info.firstChapter}-${info.lastChapter} 章`;
  elements.averageChars.textContent = formatNumber(info.averageChars);
  elements.duplicateHeaders.textContent = formatNumber(info.duplicateHeaders);
  elements.noiseCount.textContent = formatNumber(info.suspiciousHeaders + info.knownIntrusionLinesRemoved);

  elements.startChapter.min = info.firstChapter;
  elements.startChapter.max = info.lastChapter;
  elements.startChapter.value = Math.max(240, info.firstChapter);
  elements.endChapter.min = info.firstChapter;
  elements.endChapter.max = info.lastChapter;
  elements.endChapter.value = info.lastChapter;

  if (info.missingNumbers.length || info.warningCount) {
    elements.warningStrip.classList.remove('hidden');
    const missing = info.missingNumbers.length ? `缺失章节号：${info.missingNumbers.slice(0, 30).join('、')}${info.missingNumbers.length > 30 ? '…' : ''}。` : '';
    elements.warningText.textContent = `${missing} 共有 ${info.warningCount} 条解析提醒，自动修正误标 ${info.correctedHeaders || 0} 处。`;
  } else {
    elements.warningStrip.classList.add('hidden');
  }

  elements.chapterTableBody.innerHTML = info.chapters.map((chapter) => `
    <tr>
      <td>第 ${chapter.number} 章</td>
      <td title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title || '未命名')}</td>
      <td>${formatNumber(chapter.chars)}</td>
      <td>${formatNumber(chapter.sourceLine)}</td>
      <td><span class="status-mark ${chapter.corrected ? 'corrected' : ''}">${chapter.corrected ? '号序修正' : '正常'}</span></td>
    </tr>`).join('');

  elements.chaptersPerBatch.value = info.recommendation.chaptersPerBatch;
  elements.concurrency.value = info.recommendation.concurrency;
  elements.maxCharsPerBatch.value = info.recommendation.maxCharsPerBatch;
  updateBatchVisual();
  updateRangeSummary();
}

function selectedChapters() {
  if (!state.document) return [];
  const start = Number(elements.startChapter.value);
  const end = Number(elements.endChapter.value);
  return state.document.chapters.filter((chapter) => chapter.number >= start && chapter.number <= end);
}

function updateRangeSummary() {
  const chapters = selectedChapters();
  const chars = chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
  elements.selectedCount.textContent = `${formatNumber(chapters.length)} 章`;
  elements.selectedChars.textContent = `约 ${formatNumber(chars)} 字符`;
  elements.glossaryExtractScope.textContent = chapters.length
    ? `第 ${elements.startChapter.value}-${elements.endChapter.value} 章`
    : '按当前章节范围';
  const mode = document.querySelector('input[name="mode"]:checked')?.value === 'rules' ? '仅规则整理' : '模型智能校对';
  const glossaryHint = elements.useGlossary.checked ? ` · 词表 ${state.glossary?.entries?.length || 0} 条` : ' · 未注入词表';
  const batches = Math.max(1, Math.ceil(chapters.length / Math.max(1, Number(elements.chaptersPerBatch.value))));
  elements.jobSummary.textContent = `${mode} · 第 ${elements.startChapter.value}-${elements.endChapter.value} 章 · 约 ${batches} 批${glossaryHint} · 完成后自动合并导出。`;
}

function updateBatchVisual() {
  const batch = Math.min(10, Math.max(1, Number(elements.chaptersPerBatch.value) || 3));
  const concurrency = Math.min(10, Math.max(1, Number(elements.concurrency.value) || 2));
  const maxChars = Math.min(50000, Math.max(4000, Number(elements.maxCharsPerBatch.value) || 18000));
  elements.batchFigure.textContent = batch;
  elements.concurrencyFigure.textContent = concurrency;
  elements.inFlightFigure.textContent = batch * concurrency;

  const average = state.document?.averageChars || 4700;
  const estimatedChars = average * batch;
  let message = `估算每批约 ${formatNumber(estimatedChars)} 字符，字符上限 ${formatNumber(maxChars)}；实际可能自动提前切批。`;
  if (batch * concurrency > 12) message += ' 当前并发负载较高，免费模型容易限流。';
  else if (estimatedChars > maxChars) message += ' 当前章节数会触发字符安全上限。';
  else message += ' 当前配置较稳妥。';
  elements.batchRecommendation.querySelector('span').textContent = message;
  updateRangeSummary();
}

function updateRuleCount() {
  elements.rulesCount.textContent = `${formatNumber(elements.rulesEditor.value.length)} 字`;
}

function providerPayload() {
  return {
    baseUrl: elements.baseUrl.value.trim(),
    model: elements.modelName.value.trim(),
    apiKey: elements.apiKey.value,
    timeoutMs: state.defaults?.provider.timeoutMs || 120000,
    maxTokens: state.defaults?.provider.maxTokens || 20000,
  };
}

async function testProvider() {
  elements.testProviderButton.disabled = true;
  elements.providerTestStatus.textContent = '正在测试…';
  elements.providerTestStatus.className = 'inline-status';
  try {
    const result = await api('/api/provider/test', { method: 'POST', body: JSON.stringify(providerPayload()) });
    const modelHint = result.models.length ? `，发现 ${result.models.length} 个模型` : '';
    elements.providerTestStatus.textContent = `连接成功${modelHint}`;
    elements.providerTestStatus.className = 'inline-status success';
    toast('模型接口连接成功。', 'success');
  } catch (error) {
    elements.providerTestStatus.textContent = '连接失败';
    elements.providerTestStatus.className = 'inline-status error';
    toast(error.message, 'error', 7000);
  } finally {
    elements.testProviderButton.disabled = false;
  }
}

async function startFreeLlm() {
  elements.startFreeLlmButton.disabled = true;
  try {
    await api('/api/freellm/start', {
      method: 'POST',
      body: JSON.stringify({ launcherPath: elements.launcherPath.value.trim() }),
    });
    toast('已调用 FreeLLMAPI 启动器。', 'success');
    setTimeout(checkFreeLlm, 2500);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    elements.startFreeLlmButton.disabled = false;
  }
}

async function startJob() {
  if (!state.document) {
    toast('请先导入 TXT 文件。', 'error');
    return;
  }
  const start = Number(elements.startChapter.value);
  const end = Number(elements.endChapter.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    toast('章节范围无效。', 'error');
    return;
  }
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'llm';
  if (mode === 'llm' && !elements.baseUrl.value.trim()) {
    toast('请填写模型 Base URL。', 'error');
    return;
  }
  let glossary;
  try {
    glossary = normalizeGlossaryInput(elements.glossaryEditor.value);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  state.glossary = glossary;

  elements.startJobButton.disabled = true;
  elements.resultPanel.classList.add('hidden');
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        documentId: state.document.id,
        start,
        end,
        mode,
        chaptersPerBatch: Number(elements.chaptersPerBatch.value),
        concurrency: Number(elements.concurrency.value),
        maxCharsPerBatch: Number(elements.maxCharsPerBatch.value),
        ruleFallback: elements.ruleFallback.checked,
        autoRetryRounds: Number(elements.autoRetryRounds.value || 1),
        rules: elements.rulesEditor.value,
        useGlossary: elements.useGlossary.checked,
        glossaryAutoGrow: elements.glossaryAutoGrow.checked,
        glossary,
        provider: providerPayload(),
      }),
    });
    state.job = job;
    elements.progressCard.classList.remove('hidden');
    elements.progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updateStep(3);
    renderJob(job);
    schedulePoll(200);
  } catch (error) {
    toast(error.message, 'error', 7000);
    elements.startJobButton.disabled = false;
  }
}

function schedulePoll(delay = 850) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(pollJob, delay);
}

async function pollJob() {
  if (!state.job) return;
  try {
    const job = await api(`/api/jobs/${state.job.id}`, { method: 'GET', headers: {} });
    state.job = job;
    renderJob(job);
    if (!['completed', 'failed', 'canceled'].includes(job.status)) schedulePoll();
  } catch (error) {
    toast(`进度刷新失败：${error.message}`, 'error');
    schedulePoll(1600);
  }
}

function renderJob(job) {
  const statusLabels = {
    queued: '正在排队',
    running: '批量校对进行中',
    paused: '任务已暂停，进度已保存',
    interrupted: '任务中断，进度已保存',
    completed: '全部处理完成',
    failed: '任务失败',
    canceled: '任务已取消',
    discarded: '任务已放弃',
  };
  elements.progressSubtitle.textContent = `${statusLabels[job.status] || job.status} · ${job.mode === 'rules' ? '仅规则整理' : `${job.config.model} @ ${job.config.baseUrl}`}`;
  elements.progressPercent.textContent = `${job.progress}%`;
  elements.progressRing.style.background = `conic-gradient(var(--accent) ${job.progress * 3.6}deg, #e8e5dc 0deg)`;
  elements.progressBar.style.width = `${job.progress}%`;
  const succeeded = job.succeededChapters ?? job.completedChapters ?? 0;
  elements.progressChapterLabel.textContent = `${formatNumber(succeeded)} / ${formatNumber(job.totalChapters)} 章`;
  elements.progressBatchLabel.textContent = `${formatNumber(job.completedBatches)} / ${formatNumber(job.totalBatches)} 批`;
  if (elements.progressLive) {
    const liveText = job.currentChapter
      ? `正在处理第 ${job.currentChapter} 章`
      : job.latestCompletedChapter ? `最新完成：第 ${job.latestCompletedChapter} 章` : '尚未开始';
    const failedText = job.failedCount ? ` · 失败 ${formatNumber(job.failedCount)} 章` : '';
    elements.progressLive.textContent = `${liveText}${failedText}`;
  }

  renderReviewList(job);

  const laneCount = Math.max(1, job.config.concurrency);
  const lanes = Array.from({ length: laneCount }, (_, index) => job.activeBatches.find((item) => item.worker === index + 1));
  elements.laneGrid.style.gridTemplateColumns = `repeat(${Math.min(3, laneCount)}, minmax(0, 1fr))`;
  elements.laneGrid.innerHTML = lanes.map((lane, index) => lane
    ? `<div class="lane"><strong>通道 ${index + 1}</strong><span>${escapeHtml(lane.range)} · 第 ${lane.batch} 批</span></div>`
    : `<div class="lane idle"><strong>通道 ${index + 1}</strong><span>${job.status === 'paused' ? '暂停中' : '等待任务'}</span></div>`).join('');

  elements.logPanel.innerHTML = job.logs.map((log) => {
    const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false });
    return `<div class="log-row ${escapeHtml(log.level)}"><time>${time}</time><span class="level">${escapeHtml(log.level)}</span><span>${escapeHtml(log.message)}</span></div>`;
  }).join('');
  elements.logPanel.scrollTop = elements.logPanel.scrollHeight;

  if (job.glossary?.autoAddedEntries?.length) {
    const chips = job.glossary.autoAddedEntries.slice(-12).map((entry) => `<span class="chip auto"><b>${escapeHtml(entry.name)}</b> · 第 ${entry.chapter} 章</span>`).join('');
    elements.logPanel.insertAdjacentHTML('beforeend', `<div class="log-row"><time>词表</time><span class="level">AUTO</span><span>自升级新增：${chips}</span></div>`);
  }

  elements.pauseJobButton.disabled = !['running', 'paused'].includes(job.status);
  elements.pauseJobButton.textContent = job.status === 'paused' ? '继续' : '暂停';
  elements.cancelJobButton.disabled = ['completed', 'failed', 'canceled', 'discarded'].includes(job.status);
  const canRetry = ['completed', 'failed', 'interrupted'].includes(job.status) && job.failedCount > 0;
  elements.retryArea.classList.toggle('hidden', !canRetry);
  elements.retrySummary.textContent = canRetry ? `${formatNumber(job.failedCount)} 章${job.config.ruleFallback ? '使用规则回退' : '等待校对'}。可调整模型连接和规则后重试。` : '';

  // 三级自动补偿状态
  const compensation = job.compensation || { pending: 0, items: [] };
  if (compensation.pending > 0) {
    const nextDue = compensation.items.reduce((earliest, item) => {
      const time = new Date(item.dueAt).getTime();
      return earliest === null || time < earliest ? time : earliest;
    }, null);
    const dueText = nextDue ? `，下次约 ${new Date(nextDue).toLocaleTimeString('zh-CN', { hour12: false })}` : '';
    elements.compensationSummary.textContent = `${formatNumber(compensation.pending)} 章正在自动补偿队列中（5 分钟 / 30 分钟 / 2 小时各试一次${dueText}），成功后会自动替换规则回退版。`;
    elements.compensationArea.classList.remove('hidden');
  } else {
    elements.compensationArea.classList.add('hidden');
  }
  if (job.status !== 'completed') elements.resultPanel.classList.add('hidden');

  if (job.status === 'completed' && job.output) {
    elements.resultPanel.classList.remove('hidden');
    elements.downloadTextLink.href = job.output.textUrl;
    elements.downloadReportLink.href = job.output.reportUrl;
    elements.resultDescription.textContent = `${job.output.textName}；失败待重试 ${job.failedCount} 章。`;
    elements.startJobButton.disabled = false;
    updateStep(4);
  } else if (job.status === 'failed') {
    elements.startJobButton.disabled = false;
    toast(`任务失败：${job.error}`, 'error', 8000);
  } else if (job.status === 'interrupted') {
    elements.startJobButton.disabled = false;
    toast('任务中断，进度已保存；重新导入原稿后可继续。', 'info');
  } else if (job.status === 'canceled') {
    elements.startJobButton.disabled = false;
    toast('任务已取消，已完成结果保留在当前会话。', 'info');
  }
}

function filteredChapters(job) {
  const all = job.chapterStates || [];
  if (state.reviewFilter === 'done') return all.filter((chapter) => chapter.status === 'done');
  if (state.reviewFilter === 'fallback') return all.filter((chapter) => ['fallback', 'failed'].includes(chapter.status));
  if (state.reviewFilter === 'pending') return all.filter((chapter) => chapter.status === 'pending');
  return all;
}

function renderReviewList(job) {
  const chapters = filteredChapters(job);
  const totalPages = Math.max(1, Math.ceil(chapters.length / REVIEW_PAGE_SIZE));
  if (state.reviewPage >= totalPages) state.reviewPage = totalPages - 1;
  if (state.reviewPage < 0) state.reviewPage = 0;
  const start = state.reviewPage * REVIEW_PAGE_SIZE;
  const pageItems = chapters.slice(start, start + REVIEW_PAGE_SIZE);
  const html = pageItems.map((chapter) => {
    const statusText = chapter.status === 'done' ? '<em>模型校对完成</em>' : chapter.status === 'fallback' ? '<em>规则回退 · 待重试</em>' : chapter.status === 'failed' ? '<em>失败 · 待重试</em>' : '<em class="muted">等待处理</em>';
    const clickable = chapter.status === 'done' || chapter.status === 'fallback';
    return `<button class="review-chapter ${chapter.status}" data-number="${chapter.number}"${clickable ? '' : ' disabled'}><strong>第 ${chapter.number} 章</strong><span>${escapeHtml(chapter.title || '未命名')}</span>${statusText}</button>`;
  }).join('') || '<span>当前筛选下没有章节。</span>';
  if (elements.reviewList.innerHTML !== html) elements.reviewList.innerHTML = html;

  if (elements.reviewPager) {
    const doneCount = (job.chapterStates || []).filter((chapter) => chapter.status === 'done').length;
    const fallbackCount = (job.chapterStates || []).filter((chapter) => ['fallback', 'failed'].includes(chapter.status)).length;
    elements.reviewPager.classList.remove('hidden');
    elements.reviewPager.innerHTML = `
      <span>共 ${formatNumber((job.chapterStates || []).length)} 章 · 模型成功 ${formatNumber(doneCount)} · 待重试 ${formatNumber(fallbackCount)} · 每页 ${REVIEW_PAGE_SIZE} 章</span>
      <span>第 ${state.reviewPage + 1} / ${totalPages} 页</span>
      <div class="pager-actions">
        <button class="button ghost compact" data-page="first">« 首页</button>
        <button class="button ghost compact" data-page="prev">上一页</button>
        <button class="button ghost compact" data-page="next">下一页</button>
        <button class="button ghost compact" data-page="last">末页 »</button>
        <button class="button ghost compact" data-page="latest">跳到最新完成</button>
      </div>`;
  }
}

function changeReviewPage(action) {
  const job = state.job;
  if (!job) return;
  const chapters = filteredChapters(job);
  const totalPages = Math.max(1, Math.ceil(chapters.length / REVIEW_PAGE_SIZE));
  if (action === 'first') state.reviewPage = 0;
  else if (action === 'prev') state.reviewPage = Math.max(0, state.reviewPage - 1);
  else if (action === 'next') state.reviewPage = Math.min(totalPages - 1, state.reviewPage + 1);
  else if (action === 'last') state.reviewPage = totalPages - 1;
  else if (action === 'latest') {
    const latest = job.latestCompletedChapter || job.currentChapter;
    const index = chapters.findIndex((chapter) => chapter.number === latest);
    state.reviewPage = index < 0 ? totalPages - 1 : Math.floor(index / REVIEW_PAGE_SIZE);
  }
  renderReviewList(job);
}

async function retryFailedChapters() {
  if (!state.job) return;
  elements.retryFailedButton.disabled = true;
  try {
    state.job = await api(`/api/jobs/${state.job.id}/retry`, {
      method: 'POST', body: JSON.stringify({ provider: providerPayload(), rules: elements.rulesEditor.value }),
    });
    elements.startJobButton.disabled = true;
    renderJob(state.job);
    schedulePoll(200);
  } catch (error) { toast(`无法重试：${error.message}`, 'error', 7000); }
  finally { elements.retryFailedButton.disabled = false; }
}

async function openComparison(number) {
  const jobId = state.job?.id;
  if (!jobId) return;
  try {
    const chapter = await api(`/api/jobs/${encodeURIComponent(jobId)}/chapter?number=${encodeURIComponent(number)}`, { method: 'GET', headers: {} });
    if (state.job?.id !== jobId) return;
    const beforeCount = Array.from(chapter.before.body).length;
    const afterCount = Array.from(chapter.after.body).length;
    const delta = afterCount - beforeCount;
    elements.compareHeading.textContent = `第 ${chapter.number} 章 · 校对前后`;
    elements.compareStats.textContent = `正文：校对前 ${formatNumber(beforeCount)} 字符 · 校对后 ${formatNumber(afterCount)} 字符 · ${delta >= 0 ? '+' : '−'}${formatNumber(Math.abs(delta))} 字符（含空格和换行）`;
    elements.compareNote.textContent = `${chapter.fallback ? '模型校对失败，此章展示规则清理回退结果。' : '红色标出删除内容，绿色标出新增内容。'} 校对前为拆章后的原文，拆章前已清除的已知混入内容不在此对比中。`;
    const renderDiff = (before, after) => {
      const parts = compareText(before, after);
      return ['before', 'after'].map((side) => parts.filter((part) => part.type === 'same' || part.type === (side === 'before' ? 'removed' : 'added'))
        .map((part) => part.type === 'same' ? escapeHtml(part.value) : `<mark class="${part.type}">${escapeHtml(part.value)}</mark>`).join(''));
    };
    const titles = renderDiff(chapter.before.title, chapter.after.title);
    const bodies = renderDiff(chapter.before.body, chapter.after.body);
    elements.compareBefore.innerHTML = `<strong>${titles[0]}</strong>\n\n${bodies[0]}`;
    elements.compareAfter.innerHTML = `<strong>${titles[1]}</strong>\n\n${bodies[1]}`;
    if (!elements.compareDialog.open) elements.compareDialog.showModal();
  } catch (error) { toast(`无法打开章节：${error.message}`, 'error'); }
}

async function pauseOrResumeJob() {
  if (!state.job) return;
  if (state.job.status === 'paused') {
    await resumePersistedJob(state.job.id);
    return;
  }
  try {
    state.job = await api(`/api/jobs/${state.job.id}/pause`, { method: 'POST', body: '{}' });
    renderJob(state.job);
    schedulePoll(200);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function resumePersistedJob(jobId, automatic = false) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: 'POST',
      body: JSON.stringify({
        ...(state.document ? { documentId: state.document.id } : {}),
        provider: { apiKey: elements.apiKey.value },
      }),
    });
    state.job = job;
    elements.resumeCard.classList.add('hidden');
    elements.progressCard.classList.remove('hidden');
    renderJob(job);
    schedulePoll(200);
    toast('已继续未完成任务。', 'success');
  } catch (error) {
    toast(`无法继续任务：${error.message}`, 'error', 7000);
  }
}

async function discardResumableJob() {
  const target = state.resumableJobs[0];
  if (!target) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(target.id)}/discard`, { method: 'POST', body: '{}' });
    state.resumableJobs = state.resumableJobs.filter((item) => item.id !== target.id);
    renderResumableBanner();
    toast('已放弃该未完成任务。', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadResumableJobs() {
  try {
    const result = await api('/api/jobs/resumable', { method: 'GET', headers: {} });
    state.resumableJobs = result.jobs || [];
    renderResumableBanner();
  } catch {
    state.resumableJobs = [];
  }
}

function renderResumableBanner() {
  const target = state.resumableJobs[0];
  if (!target) {
    elements.resumeCard.classList.add('hidden');
    return;
  }
  elements.resumeCard.classList.remove('hidden');
  elements.resumeTitle.textContent = `未完成任务：${target.fileName}`;
  elements.resumeDescription.textContent = `第 ${target.range?.[0] ?? '?'} - ${target.range?.[1] ?? '?'} 章，已有结果 ${formatNumber(target.completedChapters)} / ${formatNumber(target.totalChapters)} 章，其中 ${formatNumber(target.failedCount)} 章待重试。`;
}

async function cancelJob() {
  if (!state.job) return;
  try {
    state.job = await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST', body: '{}' });
    renderJob(state.job);
    schedulePoll(200);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function bindEvents() {
  elements.fileInput.addEventListener('change', () => analyzeFile(elements.fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragging');
  }));
  elements.dropZone.addEventListener('drop', (event) => analyzeFile(event.dataTransfer.files[0]));
  elements.toggleChapterList.addEventListener('click', () => {
    const hidden = elements.chapterTableWrap.classList.toggle('hidden');
    elements.toggleChapterList.textContent = hidden ? '查看章节清单' : '收起章节清单';
  });
  [elements.startChapter, elements.endChapter].forEach((input) => input.addEventListener('input', updateRangeSummary));
  [elements.chaptersPerBatch, elements.concurrency, elements.maxCharsPerBatch].forEach((input) => input.addEventListener('input', updateBatchVisual));
  $$('input[name="mode"]').forEach((input) => input.addEventListener('change', updateRangeSummary));
  elements.rulesEditor.addEventListener('input', updateRuleCount);
  elements.fetchModelsButton.addEventListener('click', fetchModels);
  elements.extractGlossaryButton.addEventListener('click', extractGlossary);
  elements.saveGlossaryButton.addEventListener('click', saveGlossary);
  elements.toggleGlossaryJson.addEventListener('click', () => {
    const hidden = elements.glossaryEditorWrap.classList.toggle('hidden');
    elements.toggleGlossaryJson.textContent = hidden ? '编辑 JSON' : '收起 JSON';
  });
  [elements.useGlossary, elements.glossaryAutoGrow].forEach((input) => input.addEventListener('change', () => {
    renderGlossary();
    updateRangeSummary();
  }));
  elements.resetRulesButton.addEventListener('click', () => {
    elements.rulesEditor.value = state.defaults.rules;
    updateRuleCount();
    toast('已恢复推荐校对规则。', 'success');
  });
  elements.testProviderButton.addEventListener('click', testProvider);
  elements.saveConnectionButton.addEventListener('click', saveConnectionSettings);
  elements.clearConnectionButton.addEventListener('click', clearConnectionSettings);
  elements.startFreeLlmButton.addEventListener('click', startFreeLlm);
  elements.startJobButton.addEventListener('click', startJob);
  elements.pauseJobButton.addEventListener('click', pauseOrResumeJob);
  elements.cancelJobButton.addEventListener('click', cancelJob);
  elements.retryFailedButton.addEventListener('click', retryFailedChapters);
  if (elements.reviewFilters) {
    elements.reviewFilters.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      state.reviewFilter = button.dataset.filter;
      state.reviewPage = 0;
      Array.from(elements.reviewFilters.children).forEach((item) => item.classList.toggle('active', item === button));
      if (state.job) renderReviewList(state.job);
    });
  }
  if (elements.reviewPager) {
    elements.reviewPager.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-page]');
      if (button) changeReviewPage(button.dataset.page);
    });
  }
  if (elements.resumeJobButton) elements.resumeJobButton.addEventListener('click', () => resumePersistedJob(state.resumableJobs[0]?.id));
  if (elements.discardJobButton) elements.discardJobButton.addEventListener('click', discardResumableJob);
  elements.reviewList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-number]');
    if (button && !button.disabled) openComparison(button.dataset.number);
  });
  elements.closeCompare.addEventListener('click', () => elements.compareDialog.close());
}

bindEvents();
initialize().catch((error) => toast(`工作台初始化失败：${error.message}`, 'error', 8000));
