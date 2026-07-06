// mock/test-port.mjs — 测代理监听端口可配置 + 平台默认 + kill
//
// 运行： node mock/test-port.mjs
// 独立端口 11497（避开其他测试和运行中扩展）。
// 测的点：
//   1. GET /api/port 返回 port + defaultPort，defaultPort 按平台对
//   2. 非法端口（<1024 / >65535 / 非数字）→ 400，不改运行时，代理仍存活
//   3. POST 改端口 → 写回 config.json + kill 监听（放最后，因为会 kill 代理）
//
// 注意：CLI 测试无扩展心跳，不测"kill 后用新端口重启"——那需要扩展宿主，手动验证。

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';

const PROXY_PORT = 11497;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const TEST_CONFIG = 'mock/config.port-test.json';
const TEST_CONFIG_BODY = JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: 'mock-token',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
    API_TIMEOUT_MS: '3000',
    ANTHROPIC_MODEL: 'mock-model',
  },
  effortLevel: 'xhigh',
  proxy: {
    listenHost: '127.0.0.1',
    listenPort: PROXY_PORT,
    maxAttempts: 5,
    backoffSec: 0.1,
    backoffMaxSec: 1,
    passthrough: false,
    retryOnStatus: [408, 429, 500, 502, 504],
    retryOnBodyErrorCode: [10310],
  },
}, null, 2);

let proxyProc;
let passed = 0, failed = 0;
const results = [];

function kill(p) { if (p) { try { p.kill('SIGTERM'); } catch {} } }
function check(name, cond, info = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}${info ? '  ' + info : ''}`); }
  else { failed++; results.push(`  FAIL  ${name}${info ? '  ' + info : ''}`); }
}

async function waitHealth(url, label) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/healthz'); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  throw new Error(`${label} did not become healthy`);
}

async function getPort() { return (await (await fetch(PROXY + '/api/port')).json()); }
async function postPort(port) {
  return (await (await fetch(PROXY + '/api/port', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  })).json());
}

async function isUp() {
  try { const r = await fetch(PROXY + '/healthz'); return r.ok; } catch { return false; }
}

function expectedDefault() {
  switch (process.platform) {
    case 'win32': return 11434;
    case 'darwin': return 11436;
    case 'linux': return 11435;
    default: return 11435;
  }
}

async function main() {
  console.log('Starting proxy (test config)...');
  writeFileSync(TEST_CONFIG, TEST_CONFIG_BODY + '\n', 'utf8');
  proxyProc = spawn('node', ['proxy/server.js'], {
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG }, stdio: 'ignore',
  });
  proxyProc.on('error', (e) => { console.error('proxy spawn failed:', e); process.exit(1); });

  try {
    await waitHealth(PROXY, 'proxy');
    console.log('Proxy ready. Running scenarios...\n');

    // ── 1. GET /api/port ──
    {
      const r = await getPort();
      check('1.1 GET 返回 port', typeof r.port === 'number', `port=${r.port}`);
      check('1.2 GET 返回 defaultPort', typeof r.defaultPort === 'number', `defaultPort=${r.defaultPort}`);
      check('1.3 defaultPort 按平台对', r.defaultPort === expectedDefault(), `got ${r.defaultPort}, expect ${expectedDefault()} (platform=${process.platform})`);
      check('1.4 当前端口 = 配置端口', r.port === PROXY_PORT, `got ${r.port}`);
    }

    // ── 2. 非法端口（不 kill，代理仍存活，放改端口之前）──
    {
      const r1 = await postPort(80);
      check('2.1 端口 80 拒绝', r1.ok === false, JSON.stringify(r1));
      const r2 = await postPort(70000);
      check('2.2 端口 70000 拒绝', r2.ok === false, JSON.stringify(r2));
      const r3 = await postPort('abc');
      check('2.3 端口 abc 拒绝', r3.ok === false, JSON.stringify(r3));
      check('2.4 非法端口后代理仍存活', await isUp(), 'agent died');
      const cfg = JSON.parse(readFileSync(TEST_CONFIG, 'utf8'));
      check('2.5 config.json 未被非法值污染', cfg.proxy.listenPort === PROXY_PORT, `got ${cfg.proxy.listenPort}`);
    }

    // ── 3. POST 改端口（会 kill 监听，放最后）──
    {
      const NEW_PORT = 11597;
      const r = await postPort(NEW_PORT);
      check('3.1 POST 改端口 ok', r.ok === true && r.port === NEW_PORT, JSON.stringify(r));
      const cfg = JSON.parse(readFileSync(TEST_CONFIG, 'utf8'));
      check('3.2 config.json 写回新端口', cfg.proxy.listenPort === NEW_PORT, `got ${cfg.proxy.listenPort}`);
      await sleep(400);
      check('3.3 改端口后 kill 生效（healthz 不通）', !(await isUp()), 'still up');
    }

    console.log('\nResults:');
    for (const r of results) console.log(r);
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    kill(proxyProc);
    try { unlinkSync(TEST_CONFIG); } catch {}
    process.exit(failed === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('test harness error:', e);
  kill(proxyProc);
  try { unlinkSync(TEST_CONFIG); } catch {}
  process.exit(1);
});
