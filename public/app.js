'use strict';

const state = {
  defaults: null,
  document: null,
  sourceFile: null,
  job: null,
  pollTimer: null,
};

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
  providerTestStatus: $('#providerTestStatus'),
  testProviderButton: $('#testProviderButton'),
  startFreeLlmButton: $('#startFreeLlmButton'),
  freeLlmStatus: $('#freeLlmStatus'),
  chaptersPerBatch: $('#chaptersPerBatch'),
  concurrency: $('#concurrency'),
  maxCharsPerBatch: $('#maxCharsPerBatch'),
  batchFigure: $('#batchFigure'),
  concurrencyFigure: $('#concurrencyFigure'),
  inFlightFigure: $('#inFlightFigure'),
  batchRecommendation: $('#batchRecommendation'),
  rulesEditor: $('#rulesEditor'),
  rulesCount: $('#rulesCount'),
  resetRulesButton: $('#resetRulesButton'),
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
  updateRuleCount();
  updateBatchVisual();
  await checkFreeLlm();
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
  const mode = document.querySelector('input[name="mode"]:checked')?.value === 'rules' ? '仅规则整理' : '模型智能校对';
  const batches = Math.max(1, Math.ceil(chapters.length / Math.max(1, Number(elements.chaptersPerBatch.value))));
  elements.jobSummary.textContent = `${mode} · 第 ${elements.startChapter.value}-${elements.endChapter.value} 章 · 约 ${batches} 批 · 完成后自动合并导出。`;
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
        rules: elements.rulesEditor.value,
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
    paused: '任务已暂停',
    completed: '全部处理完成',
    failed: '任务失败',
    canceled: '任务已取消',
  };
  elements.progressSubtitle.textContent = `${statusLabels[job.status] || job.status} · ${job.mode === 'rules' ? '仅规则整理' : `${job.config.model} @ ${job.config.baseUrl}`}`;
  elements.progressPercent.textContent = `${job.progress}%`;
  elements.progressRing.style.background = `conic-gradient(var(--accent) ${job.progress * 3.6}deg, #e8e5dc 0deg)`;
  elements.progressBar.style.width = `${job.progress}%`;
  elements.progressChapterLabel.textContent = `${formatNumber(job.completedChapters)} / ${formatNumber(job.totalChapters)} 章`;
  elements.progressBatchLabel.textContent = `${formatNumber(job.completedBatches)} / ${formatNumber(job.totalBatches)} 批`;

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

  elements.pauseJobButton.disabled = !['running', 'paused'].includes(job.status);
  elements.pauseJobButton.textContent = job.status === 'paused' ? '继续' : '暂停';
  elements.cancelJobButton.disabled = ['completed', 'failed', 'canceled'].includes(job.status);

  if (job.status === 'completed' && job.output) {
    elements.resultPanel.classList.remove('hidden');
    elements.downloadTextLink.href = job.output.textUrl;
    elements.downloadReportLink.href = job.output.reportUrl;
    elements.resultDescription.textContent = `${job.output.textName}；失败回退 ${job.failedChapters.length} 章。`;
    elements.startJobButton.disabled = false;
    updateStep(4);
  } else if (job.status === 'failed') {
    elements.startJobButton.disabled = false;
    toast(`任务失败：${job.error}`, 'error', 8000);
  } else if (job.status === 'canceled') {
    elements.startJobButton.disabled = false;
    toast('任务已取消，已完成结果保留在当前会话。', 'info');
  }
}

async function pauseOrResumeJob() {
  if (!state.job) return;
  const action = state.job.status === 'paused' ? 'resume' : 'pause';
  try {
    state.job = await api(`/api/jobs/${state.job.id}/${action}`, { method: 'POST', body: '{}' });
    renderJob(state.job);
    schedulePoll(200);
  } catch (error) {
    toast(error.message, 'error');
  }
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
  elements.resetRulesButton.addEventListener('click', () => {
    elements.rulesEditor.value = state.defaults.rules;
    updateRuleCount();
    toast('已恢复推荐校对规则。', 'success');
  });
  $$('.preset').forEach((button) => button.addEventListener('click', () => {
    $$('.preset').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    elements.baseUrl.value = button.dataset.base;
    elements.modelName.value = button.dataset.model;
  }));
  elements.testProviderButton.addEventListener('click', testProvider);
  elements.startFreeLlmButton.addEventListener('click', startFreeLlm);
  elements.startJobButton.addEventListener('click', startJob);
  elements.pauseJobButton.addEventListener('click', pauseOrResumeJob);
  elements.cancelJobButton.addEventListener('click', cancelJob);
}

bindEvents();
initialize().catch((error) => toast(`工作台初始化失败：${error.message}`, 'error', 8000));
