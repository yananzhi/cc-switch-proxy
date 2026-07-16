// 验证 trace 的 model 字段提取：起 mock + 代理，发不同请求，从 /api/traces 检查 model 落盘。
//
// 测的点：
//   A. 正常 JSON 请求带 model → 列表 + 详情都有该 model
//   B. 真实 Claude model 名（带日期后缀）原样落盘（前端才缩短，trace 存原值）
//   C. JSON 请求无 model 字段 → model 为空串
//   D. 非 JSON content-type → model 为空串（不解析）
//   E. 坏 JSON body → model 为空串（不抛、不阻断转发）
//   F. count_tokens 端点的请求 → 也能提取 model
//   G. effort 改写不影响 model 提取（model 取自原始 body，改写后仍正确）

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const PROXY_PORT = 11498;
const MOCK_PORT = 8787;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const TEST_CONFIG = 'mock/config.model-test.json';
writeFileSync(TEST_CONFIG, JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: 'mock-token',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    API_TIMEOUT_MS: '3000',
    ANTHROPIC_MODEL: 'mock-model',
  },
  effortLevel: '', // 不改写，原样透传；场景 G 临时热改
  proxy: {
    listenHost: '127.0.0.1',
    listenPort: PROXY_PORT,
    maxAttempts: 2,
    backoffSec: 0.1,
    backoffMaxSec: 0.5,
    passthrough: true, // 透传，直接落盘，不走重试
    retryOnStatus: [],
    retryOnBodyErrorCode: [],
  },
}, null, 2));

let mockProc, proxyProc;
let passed = 0, failed = 0;
const results = [];

function kill(p) { if (p) try { p.kill('SIGTERM'); } catch {} }
async function waitHealth(url, label) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/healthz'); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`${label} did not become healthy`);
}
function check(name, cond, got) {
  if (cond) { passed++; results.push(`PASS  ${name}`); }
  else { failed++; results.push(`FAIL  ${name}  got=${got}`); }
}

// 取最近一条匹配 path 的 trace 的 model 字段（先查列表，再查详情拿原值）
let sinceTs = 0;
async function lastTraceModel(pathMatch) {
  const r = await fetch(PROXY + `/api/traces?limit=20&since=${encodeURIComponent(new Date(sinceTs).toISOString())}`);
  const j = await r.json();
  const arr = j.items ?? j ?? [];
  for (const t of arr) {
    if (t.path && (pathMatch ? t.path === pathMatch : t.path.includes('messages'))) {
      // 列表摘要已带 model（summarize 抽出），直接用；同时核对详情一致
      const listModel = t.model;
      const rd = await fetch(PROXY + `/api/traces/${t.id}`);
      const jd = await rd.json();
      return { listModel, detailModel: jd.model ?? '', requestBody: jd.requestBody ?? '' };
    }
  }
  return { listModel: '(no trace)', detailModel: '(no trace)', requestBody: '' };
}

async function send(body, headers = {}) {
  return fetch(PROXY + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

try {
  mockProc = spawn('node', ['mock/mock-server.js'], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SEQUENCE: 'success' },
    stdio: 'ignore',
  });
  await waitHealth(MOCK, 'mock');

  proxyProc = spawn('node', ['proxy/server.js'], {
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG },
    stdio: 'inherit',
  });
  await waitHealth(PROXY, 'proxy');

  // 场景 A：正常请求带 model="claude-sonnet-4-6" → 列表 + 详情都有
  sinceTs = Date.now() - 1000;
  await send({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  await sleep(300);
  let m = await lastTraceModel('/v1/messages?beta=true');
  check('A: 列表 model=claude-sonnet-4-6', m.listModel === 'claude-sonnet-4-6', m.listModel);
  check('A: 详情 model=claude-sonnet-4-6', m.detailModel === 'claude-sonnet-4-6', m.detailModel);

  // 场景 B：带日期后缀的真实 model 名 → 原样落盘（trace 存原值，前端缩短是另一回事）
  sinceTs = Date.now() - 1000;
  await send({ model: 'claude-opus-4-8-20250610', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  await sleep(300);
  m = await lastTraceModel('/v1/messages?beta=true');
  check('B: 带 date 后缀原样落盘', m.detailModel === 'claude-opus-4-8-20250610', m.detailModel);

  // 场景 C：JSON 请求无 model 字段 → model 为空串
  sinceTs = Date.now() - 1000;
  await send({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  await sleep(300);
  m = await lastTraceModel('/v1/messages?beta=true');
  check('C: 无 model 字段 → 空串', m.listModel === '' && m.detailModel === '', JSON.stringify(m));

  // 场景 D：非 JSON content-type → 不解析，model 为空串
  sinceTs = Date.now() - 1000;
  await fetch(PROXY + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'plain text body not json',
  });
  await sleep(300);
  m = await lastTraceModel('/v1/messages?beta=true');
  check('D: 非 JSON → model 空串', m.listModel === '', m.listModel);

  // 场景 E：坏 JSON body → 不抛、不阻断，model 空串
  sinceTs = Date.now() - 1000;
  await fetch(PROXY + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  await sleep(300);
  m = await lastTraceModel('/v1/messages?beta=true');
  check('E: 坏 JSON → model 空串', m.listModel === '', m.listModel);

  // 场景 F：count_tokens 端点 → 也能提取 model
  sinceTs = Date.now() - 1000;
  await fetch(PROXY + '/v1/messages/count_tokens?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await sleep(300);
  m = await lastTraceModel('/v1/messages/count_tokens?beta=true');
  check('F: count_tokens 也能提取 model', m.detailModel === 'claude-haiku-4-5', m.detailModel);

  // 场景 G：effort 改写开启时，model 仍取自原始 body 且正确
  sinceTs = Date.now() - 1000;
  await fetch(PROXY + '/api/effort', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'high' }),
  });
  await send({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'low' } });
  await sleep(300);
  m = await lastTraceModel('/v1/messages?beta=true');
  check('G: effort 改写时 model 仍正确', m.detailModel === 'claude-sonnet-4-6', m.detailModel);
  // 同时确认 effort 确实被改写了（model 提取不应破坏改写）
  let effort = '(no output_config.effort)';
  try { effort = JSON.parse(m.requestBody)?.output_config?.effort ?? effort; } catch {}
  check('G: effort 被改写成 high', effort === 'high', effort);

} catch (e) {
  console.error('TEST ERROR:', e);
  failed++;
} finally {
  kill(mockProc); kill(proxyProc);
  if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
}

console.log('\n=== RESULTS ===');
for (const r of results) console.log(r);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
