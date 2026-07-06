// mock/test.mjs — 自动起 mock + 代理，跑全部故障场景，断言重试行为
//
// 运行： node mock/test.mjs
// 子进程的 stdout 被抑制（只看本脚本的 PASS/FAIL）；
// 代理的详细协议日志在 logs/trace-<date>.log，失败时可查。

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync } from 'node:fs';

const PROXY_PORT = 11499;
const MOCK_PORT = 8787;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

// 测试用独立配置文件，每次运行重写，避免手动热重载污染 mock/config.json
const TEST_CONFIG = 'mock/config.test.json';
const TEST_CONFIG_BODY = JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: 'mock-token-not-checked',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    API_TIMEOUT_MS: '3000',
    ANTHROPIC_MODEL: 'mock-model',
  },
  effortLevel: 'xhigh',
  proxy: {
    listenHost: '127.0.0.1',
    listenPort: PROXY_PORT,
    maxAttempts: 5,
    backoffSec: 0.2,
    backoffMaxSec: 2,
    passthrough: false,
    // 约束：代理只重试 Claude Code 处理不了的——503 + body code 10310（讯飞 system busy）。
    // 其余全部透传交给 Claude Code：429/500/502/504（CC 当 5xx 重试）、网络错误/超时/断连
    // （CC 当 APIConnectionError 重试，代理合成 502 回客户端）。
    // 场景 F/G/K/L/M/N 守门这条约束——任何人改回都会让它们 FAIL。
    retryOnStatus: [],
    retryOnBodyErrorCode: [10310],
  },
}, null, 2);

let mockProc, proxyProc;
let passed = 0, failed = 0;
const results = [];

function kill(p) {
  if (!p) return;
  try { p.kill('SIGTERM'); } catch {}
}

async function waitHealth(url, label) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url + '/healthz');
      if (r.ok) return true;
    } catch {}
    await sleep(100);
  }
  throw new Error(`${label} did not become healthy`);
}

async function mockStatus() {
  const r = await fetch(MOCK + '/__mock/status');
  return r.json();
}

async function setMockSequence(seq) {
  const r = await fetch(MOCK + '/__mock/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: seq }),
  });
  return r.json();
}

async function sendMessages(opts = {}) {
  const { stream = false } = opts;
  const body = {
    model: 'mock-model',
    max_tokens: 16,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const r = await fetch(PROXY + '/v1/messages?beta=true', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text };
}

function check(name, cond, info = '') {
  if (cond) {
    passed++;
    results.push(`  PASS  ${name}${info ? '  ' + info : ''}`);
  } else {
    failed++;
    results.push(`  FAIL  ${name}${info ? '  ' + info : ''}`);
  }
}

async function scenario(name, seq, expects, opts = {}) {
  await setMockSequence(seq);
  const before = await mockStatus();
  const reqCount0 = before.reqCount;
  let res;
  try {
    res = await sendMessages(opts);
  } catch (e) {
    check(`${name}: client got response`, false, `threw: ${e.message}`);
    return;
  }
  const after = await mockStatus();
  const attempts = after.reqCount - reqCount0;

  check(`${name}: status=${expects.status}`, res.status === expects.status, `got ${res.status}`);
  if (expects.bodyContains) {
    check(
      `${name}: body contains "${expects.bodyContains}"`,
      res.body.includes(expects.bodyContains),
      `got: ${res.body.slice(0, 120)}`,
    );
  }
  if (expects.bodyNotContains) {
    check(
      `${name}: body does NOT contain "${expects.bodyNotContains}"`,
      !res.body.includes(expects.bodyNotContains),
      `got: ${res.body.slice(0, 120)}`,
    );
  }
  if (expects.attempts) {
    check(`${name}: attempts=${expects.attempts}`, attempts === expects.attempts, `got ${attempts}`);
  }
  if (expects.attemptsMin) {
    check(`${name}: attempts>=${expects.attemptsMin}`, attempts >= expects.attemptsMin, `got ${attempts}`);
  }
}

async function main() {
  console.log('Starting mock server...');
  mockProc = spawn('node', ['mock/mock-server.js'], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'ignore',
  });
  mockProc.on('error', (e) => { console.error('mock spawn failed:', e); process.exit(1); });

  console.log('Starting proxy (test config)...');
  writeFileSync(TEST_CONFIG, TEST_CONFIG_BODY + '\n', 'utf8');
  proxyProc = spawn('node', ['proxy/server.js'], {
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG },
    stdio: 'ignore',
  });
  proxyProc.on('error', (e) => { console.error('proxy spawn failed:', e); process.exit(1); });

  try {
    await waitHealth(MOCK, 'mock');
    await waitHealth(PROXY, 'proxy');
    console.log('Both ready. Running scenarios...\n');

    // A. 标准瞬时错误 503 → 重试到成功
    await scenario('A 503,503,success (non-stream)',
      ['503', '503', 'success'],
      { status: 200, bodyContains: '"content"', attempts: 3 });

    // B. 假成功 200+busy → 重试到成功（核心难点）
    await scenario('B 200-busy,200-busy,success (non-stream)',
      ['200-busy', '200-busy', 'success'],
      { status: 200, bodyContains: '"content"', attempts: 3 });

    // C. 混合 503 + 200-busy → 成功
    await scenario('C 503,200-busy,success (mixed)',
      ['503', '200-busy', 'success'],
      { status: 200, bodyContains: '"content"', attempts: 3 });

    // D. 不可重试 404 → 直接透传，1 次
    await scenario('D 404 (pass-through)',
      ['404', 'success', 'success'],
      { status: 404, bodyContains: 'no any schema route found', attempts: 1 });

    // E. 不可重试 400 → 直接透传，1 次
    await scenario('E 400 (pass-through)',
      ['400', 'success', 'success'],
      { status: 400, bodyContains: 'invalid_request_error', attempts: 1 });

    // F. 超时 → 不重试，合成 502 交给 Claude Code（原则：CC 能处理网络错误）
    await scenario('F timeout (pass-through, not retried)',
      ['timeout', 'success'],
      { status: 502, bodyContains: 'upstream_unreachable', attempts: 1 });

    // G. 中途断流 → 不重试，合成 502 交给 Claude Code
    await scenario('G drop (pass-through, not retried)',
      ['drop', 'success'],
      { status: 502, bodyContains: 'upstream_unreachable', attempts: 1 });

    // H. 流式：503 → 重试 → SSE 成功
    await scenario('H 503,success (stream)',
      ['503', 'success'],
      { status: 200, bodyContains: 'message_stop', attempts: 2 },
      { stream: true });

    // I. 重试预算用尽：连续 5 次 503 → 透传最后失败
    await scenario('I 503×5 (exhausted)',
      ['503', '503', '503', '503', '503'],
      { status: 503, bodyContains: 'system is busy', attempts: 5 });

    // J. 503 但 body 非 10310（Claude Code 能处理）→ 透传不重试，1 次
    await scenario('J 503-other (pass-through, not retried)',
      ['503-other', '503-other', '503-other'],
      { status: 503, bodyContains: 'non-10310', attempts: 1 });

    // ── 约束守门：以下状态码 Claude Code 自己能处理，代理必须透传不重试 ──
    // retryOnStatus 必须为空。任何人把它改回 [408,429,500,502,504]，这四条全 FAIL。
    // K. 429 限流 → 透传，1 次
    await scenario('K 429 (pass-through, not retried)',
      ['429', '429', '429'],
      { status: 429, bodyContains: 'Claude Code can handle', attempts: 1 });

    // L. 500 → 透传，1 次
    await scenario('L 500 (pass-through, not retried)',
      ['500', '500', '500'],
      { status: 500, bodyContains: 'Claude Code can handle', attempts: 1 });

    // M. 502 → 透传，1 次
    await scenario('M 502 (pass-through, not retried)',
      ['502', '502', '502'],
      { status: 502, bodyContains: 'Claude Code can handle', attempts: 1 });

    // N. 504 → 透传，1 次
    await scenario('N 504 (pass-through, not retried)',
      ['504', '504', '504'],
      { status: 504, bodyContains: 'Claude Code can handle', attempts: 1 });

    console.log('\nResults:');
    for (const r of results) console.log(r);
    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    kill(mockProc);
    kill(proxyProc);
    try { unlinkSync(TEST_CONFIG); } catch {}
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('test harness error:', e);
  kill(mockProc);
  kill(proxyProc);
  process.exit(1);
});
