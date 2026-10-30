'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('仅星火 MaaS 使用非思考模式和官方输出参数', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const begin = source.indexOf("  if (new URL(baseUrl).hostname === 'maas-api.cn-huabei-1.xf-yun.com'");
  const end = source.indexOf('  // 单次发送', begin);
  assert.ok(begin >= 0 && end > begin);
  function check(baseUrl, model) {
    const ctx = { URL, baseUrl, config: { model }, payload: { temperature: 0.1, max_tokens: 20000 } };
    vm.runInNewContext(source.slice(begin, end), ctx);
    return ctx.payload;
  }
  const spark = check('https://maas-api.cn-huabei-1.xf-yun.com/v2', 'spark-x2.6');
  assert.equal(spark.thinking.type, 'disabled');
  assert.equal(spark.max_completion_tokens, 20000);
  assert.equal('max_tokens' in spark, false);
  assert.equal('temperature' in spark, false);
  const other = check('http://127.0.0.1:3001/v1', 'spark-x2.6');
  assert.equal(other.max_tokens, 20000);
  assert.equal(other.temperature, 0.1);
  assert.equal(other.thinking, undefined);
});
