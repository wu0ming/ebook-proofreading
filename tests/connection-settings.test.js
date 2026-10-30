'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('本地模型配置保存、载入和清除', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const code = app.slice(app.indexOf('const CONNECTION_SETTINGS_KEY'), app.indexOf('function renderProviderPresets'));
  const fields = Object.fromEntries(['baseUrl', 'modelName', 'apiKey', 'launcherPath', 'connectionSaveStatus'].map((name) => [name, { value: '', textContent: '' }]));
  const storage = new Map();
  const ctx = { elements: fields, localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }, $$: () => [], toast: () => {} };
  vm.runInNewContext(code, ctx);
  fields.baseUrl.value = 'http://localhost:1234/v1'; fields.modelName.value = 'custom-model'; fields.apiKey.value = 'fake-secret'; fields.launcherPath.value = 'launcher.vbs';
  ctx.saveConnectionSettings();
  for (const field of Object.values(fields)) field.value = '';
  ctx.loadConnectionSettings();
  assert.equal(fields.baseUrl.value, 'http://localhost:1234/v1'); assert.equal(fields.modelName.value, 'custom-model');
  assert.equal(fields.apiKey.value, 'fake-secret'); assert.equal(fields.launcherPath.value, 'launcher.vbs');
  fields.baseUrl.value = 'https://example.test/v2/chat/completions';
  ctx.saveConnectionSettings();
  ctx.loadConnectionSettings();
  assert.equal(fields.baseUrl.value, 'https://example.test/v2');
  ctx.clearConnectionSettings(); assert.equal(storage.size, 0); assert.equal(fields.apiKey.value, 'fake-secret');
});
