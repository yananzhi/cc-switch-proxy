// 验证 effort 改写：起 mock + 代理，发不同请求，从 /api/traces 检查发给上游的 effort。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const PROXY_PORT = 11497;
const MOCK_PORT = 8786;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const TEST_CONFIG = 'mock/config.effort-test.json';
writeFileSync(TEST_CONFIG, JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: 'mock-token',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    API_TIMEOUT_MS: '3000',
    ANTHROPIC_MODEL: 'mock-model',
  },
  effortLevel: 'max',
  proxy: {
    listenHost: '127.0.0.1',
    listenPort: PROXY_PORT,
    maxAttempts: 2,
    backoffSec: 0.1,
    backoffMaxSec: 0.5,
    passthrough: true, // 透传，不走重试，直接看 mock 收到啥
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
function extractEffort(bodyStr) {
  try {
    const b = JSON.parse(bodyStr);
    return b?.output_config?.effort ?? '(no output_config.effort)';
  } catch { return '(parse error)'; }
}

// 从代理 trace 拿最近一条匹配 path 的完整 requestBody（=发给上游的 body，已改写）
// /api/traces 列表只给 preview，要用 /api/traces/{id} 拿完整 body
// sinceTs：只取测试开始后的 trace，隔离历史 trace 污染
let sinceTs = 0;
async function lastTraceBody(pathMatch) {
  const r = await fetch(PROXY + `/api/traces?limit=20&since=${encodeURIComponent(new Date(sinceTs).toISOString())}`);
  const j = await r.json();
  // /api/traces 已按 startedAt 降序（最近在前），取第一条匹配 path 的
  const arr = j.items ?? j ?? [];
  for (const t of arr) {
    if (t.path && (pathMatch ? t.path === pathMatch : t.path.includes('messages'))) {
      const id = t.id;
      const rd = await fetch(PROXY + `/api/traces/${id}`);
      const jd = await rd.json();
      return jd.requestBody ?? '';
    }
  }
  return '';
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

  // 记录开始时间，用 since 过滤历史 trace，避免跨测试残留污染断言
  sinceTs = Date.now();

  // 场景 A：effort=high → 应改成 max
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } });
  await sleep(300);
  let body = await lastTraceBody('/v1/messages?beta=true');
  check('A: high → max', extractEffort(body) === 'max', extractEffort(body));

  // 场景 B：effort=xhigh → 应改成 max
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'xhigh' } });
  await sleep(300);
  body = await lastTraceBody('/v1/messages?beta=true');
  check('B: xhigh → max', extractEffort(body) === 'max', extractEffort(body));

  // 场景 C：无 output_config → 原样透传，不应注入 effort
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  await sleep(300);
  body = await lastTraceBody('/v1/messages?beta=true');
  check('C: no output_config → 不注入', extractEffort(body) === '(no output_config.effort)', extractEffort(body));

  // 场景 D：output_config 有 format 但无 effort → 不注入 effort（只改已存在的 effort）
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } });
  await sleep(300);
  body = await lastTraceBody('/v1/messages?beta=true');
  check('D: output_config 有 format 无 effort → 不注入', extractEffort(body) === '(no output_config.effort)', extractEffort(body));

  // 场景 E：count_tokens 端点 → 不应改写（非 /v1/messages 主路径）
  await fetch(PROXY + '/v1/messages/count_tokens?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } }),
  });
  await sleep(300);
  const ctBody = await lastTraceBody('/v1/messages/count_tokens?beta=true');
  const ctEffort = extractEffort(ctBody);
  check('E: count_tokens 不改写（仍 high）', ctEffort === 'high', ctEffort);

  // 场景 F：热重载 API——POST /api/effort {level:'high'}，新请求应改成 high（无需重启）
  sinceTs = Date.now();
  const rf = await fetch(PROXY + '/api/effort', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'high' }),
  });
  const jf = await rf.json();
  check('F: /api/effort 返回 ok+effortLevel', jf.ok && jf.effortLevel === 'high', JSON.stringify(jf));
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'low' } });
  await sleep(300);
  body = await lastTraceBody('/v1/messages?beta=true');
  check('F: 热重载 high 生效（low→high）', extractEffort(body) === 'high', extractEffort(body));

  // 场景 G：/api/config 应返回 effortLevel
  const rc = await fetch(PROXY + '/api/config');
  const jc = await rc.json();
  check('G: /api/config 返回 effortLevel=high', jc.effortLevel === 'high', jc.effortLevel);

  // 场景 H：切到"不改写"（level=''），effort 原样透传不强制改
  sinceTs = Date.now();
  const rh = await fetch(PROXY + '/api/effort', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: '' }),
  });
  const jh = await rh.json();
  check('H: /api/effort level="" 返回 effortLevel=""', jh.effortLevel === '', JSON.stringify(jh));
  await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } });
  await sleep(300);
  body = await lastTraceBody('/v1/messages?beta=true');
  check('H: 不改写时 effort 原样透传（仍 high）', extractEffort(body) === 'high', extractEffort(body));

  // 场景 I：非法 effort 值应被拒绝（400）
  const ri = await fetch(PROXY + '/api/effort', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'ultracode-xhigh+workflows' }),
  });
  check('I: 非法 effort 值拒绝 400', ri.status === 400, `status=${ri.status}`);

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
