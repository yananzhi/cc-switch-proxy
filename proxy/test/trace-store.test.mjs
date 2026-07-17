// proxy/test/trace-store.test.mjs — trace-store 写时分流 + 旧格式兼容 + 四档过滤
//
// 运行： node --test proxy/test/trace-store.test.mjs
// 纯文件系统，不起 HTTP，不依赖扩展宿主。用临时目录，测完自清。
//
// 测的点：
//   A. 写时分流：append 写出 idx + body 配对文件；idx 不含 attempts 的 upstream body / 不含完整 body
//   B. list 只读 idx：返回摘要，带 bodyOffset/bodyLen/seq 定位指针；不含大 body 串
//   C. getById 精确读：用 offset+len 读回完整 trace（含 upstreamResponseBody）
//   D. 旧裸格式兼容：无 idx 的 .jsonl → 首次 list 边读边补建 idx；二次 list 走 idx；getById 从旧文件精确读
//   E. 四档过滤（all/retried/failed/llm-error）：用真实形态的样本验证命中数
//   F. since 增量：只返回 startedAt > since 的
//   G. 分片滚动：body 写满 200MB → 序号 +1，idx 跟着同序号配对（用小阈值模拟，不真写 200MB）
//   H. cleanupOld：按天整组删 idx + body + 旧裸文件

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from '../trace-store.js';

// 与 trace-store.dateStr 一致地算出"今天"的中国日期（UTC+8），用于文件名和 startedAt，
// 避免测试写死某日（如 2026-07-08）后，跨天/跨周运行时文件名按运行日期落盘、
// 或 cleanupOld 把 7+ 天前的固定日期文件删掉而误判。
function todayStr() {
  const t = Date.now() + 8 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
const TODAY = todayStr();
// N 天前（中国时间）的日期串，用于 cleanupOld 测试造 8 天前的过期文件
function daysAgoStr(n) {
  const t = Date.now() + 8 * 3600 * 1000 - n * 24 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
const DAY_OLD = daysAgoStr(8);
// 今天 01:00 UTC（中国时间 09:00）作为 startedAt 锚点，与文件名同日
const TODAY_STARTED_AT = `${TODAY}T01:00:00.000Z`;

// 每个测试用独立临时目录，避免互相污染。setLogDir 是模块级单例，串行跑没问题。
function newTmpDir(label) {
  const d = join(process.cwd(), '.test-tmp', `trace-store-${label}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

// 构造一条覆盖真实形态的 trace。opts 控制各边界。
function makeTrace(opts) {
  const {
    id, outcome = 'success-direct', finalStatus = 200,
    attStatuses = [200], reqBody = 'req-' + id, respBody = 'resp-' + id,
    startedAt = TODAY_STARTED_AT, totalMs = 1000,
    model = 'claude-sonnet-4-6',
  } = opts;
  // verdict 由 status 推：200→success；503+在重试码里→retryable；其他→not-retryable
  const attempts = attStatuses.map((status, i) => {
    const isLast = i === attStatuses.length - 1;
    const verdict = status === 200 ? 'success'
      : status === 503 ? 'retryable'
      : 'not-retryable';
    return {
      attempt: i + 1,
      status,
      networkError: null,
      elapsedMs: 1000 + i,
      verdict,
      reason: verdict === 'success' ? '(real success)' : `status ${status}`,
      backoffMs: (verdict === 'retryable' && !isLast) ? 3000 * Math.pow(2, i) : null,
      upstreamRequestBody: `upstream-req-${id}-${i + 1}`,
      upstreamResponseBody: `upstream-resp-${id}-${i + 1}`,
    };
  });
  return {
    id, sourceIp: '127.0.0.1', method: 'POST', path: '/v1/messages',
    startedAt, endedAt: startedAt, totalMs,
    finalStatus, outcome, model,
    requestBody: reqBody, responseBody: respBody,
    attempts,
    configSnapshot: { maxAttempts: 20 },
  };
}

// ── A/B/C: 写时分流 + list + getById ──────────────────────

test('A. append 写出 idx + body 配对，idx 不含胖字段', async () => {
  const dir = newTmpDir('split');
  ts.setLogDir(dir);
  const big = 'X'.repeat(100_000);
  ts.append(makeTrace({ id: 'T1', reqBody: big, respBody: big, attStatuses: [503, 200], outcome: 'success-after-retry' }));

  const files = readdirSync(dir).sort();
  assert.ok(files.some(f => f.endsWith('.001.idx.jsonl')), '应有 idx 文件');
  assert.ok(files.some(f => f.endsWith('.001.body.jsonl')), '应有 body 文件');

  const idxSize = statSync(join(dir, `traces-${TODAY}.001.idx.jsonl`)).size;
  const bodySize = statSync(join(dir, `traces-${TODAY}.001.body.jsonl`)).size;
  assert.ok(idxSize < bodySize / 100, `idx 应远小于 body（idx=${idxSize}, body=${bodySize}）`);

  // idx 行不含完整 body 串、不含 attempt 的 upstreamResponseBody
  const list = await ts.list({ mode: 'all', limit: 10 });
  const row = list.find(r => r.id === 'T1');
  assert.ok(row, 'list 应返回 T1');
  const rowStr = JSON.stringify(row);
  assert.ok(!rowStr.includes('X'.repeat(201)), 'idx 行不应含大 body 串');
  assert.ok(!('upstreamResponseBody' in row.attempts[0]), 'idx 摘要不应含 upstreamResponseBody');
  assert.ok(row.bodyOffset != null && row.bodyLen != null && row.seq, '应带定位指针');
  assert.equal(row.model, 'claude-sonnet-4-6', 'idx 摘要应透传 model');
});

// model 字段边界：缺省/空 model 不应抛、不应出现在摘要里成 undefined
test('A2. model 缺失与空串落盘', async () => {
  const dir = newTmpDir('model-edge');
  ts.setLogDir(dir);
  ts.append(makeTrace({ id: 'M1', model: '' }));            // 显式空串
  ts.append({ ...makeTrace({ id: 'M2' }), model: undefined }); // 缺字段（旧 trace 兼容）

  const list = await ts.list({ mode: 'all', limit: 10 });
  const m1 = list.find(r => r.id === 'M1');
  const m2 = list.find(r => r.id === 'M2');
  assert.equal(m1.model, '', '显式空串 → 空串');
  assert.equal(m2.model, '', '缺 model 字段 → 空串（不出现 undefined）');
  // 详情也应是空串
  const full2 = await ts.getById('M2');
  assert.equal(full2.model, '', 'getById 缺 model 字段 → 空串');
});

test('C. getById 用 offset 精确读回完整 trace', async () => {
  const dir = newTmpDir('getbyid');
  ts.setLogDir(dir);
  const big = 'Y'.repeat(100_000);
  ts.append(makeTrace({ id: 'G1', reqBody: big, respBody: big, attStatuses: [503, 503, 200], outcome: 'success-after-retry' }));

  const full = await ts.getById('G1');
  assert.ok(full, '应读到');
  assert.equal(full.id, 'G1');
  assert.equal(full.requestBody.length, 100_000, 'requestBody 完整');
  assert.equal(full.responseBody.length, 100_000, 'responseBody 完整');
  assert.equal(full.attempts.length, 3);
  assert.equal(full.attempts[0].upstreamResponseBody, 'upstream-resp-G1-1', '上游响应 body 完整');
  assert.equal(full.configSnapshot.maxAttempts, 20);
});

// ── D: 旧裸格式兼容 ───────────────────────────────────────

// 直接写一个旧版裸 .jsonl（无 idx），模拟升级前的文件
function writeLegacyShard(dir, day, seq, traces) {
  const lines = traces.map(t => JSON.stringify(t)).join('\n') + '\n';
  writeFileSync(join(dir, `traces-${day}.${String(seq).padStart(3, '0')}.jsonl`), lines, 'utf8');
}

test('D1. 旧裸文件首次 list 补建 idx，二次 list 走 idx', async () => {
  const dir = newTmpDir('legacy');
  ts.setLogDir(dir);
  // 写一条旧裸文件（完整 trace，无 idx 配对）
  const legacy = makeTrace({ id: 'L1', attStatuses: [503, 200], outcome: 'success-after-retry', reqBody: 'legacy-req-L1' });
  writeLegacyShard(dir, TODAY, 1, [legacy]);

  // 首次：应边读边补建 idx
  const list1 = await ts.list({ mode: 'all', limit: 10 });
  assert.equal(list1.length, 1);
  assert.equal(list1[0].id, 'L1');
  assert.equal(list1[0]._legacyFile, true, '旧数据应标 _legacyFile');
  assert.ok(existsSync(join(dir, `traces-${TODAY}.001.idx.jsonl`)), '补建后应有 idx 文件');

  // 二次：idx 已在，仍能读到（走快路，不报错）
  const list2 = await ts.list({ mode: 'all', limit: 10 });
  assert.equal(list2.length, 1);
  assert.equal(list2[0].id, 'L1');
});

test('D2. getById 从旧裸文件按 offset 精确读', async () => {
  const dir = newTmpDir('legacy-getbyid');
  ts.setLogDir(dir);
  const t1 = makeTrace({ id: 'L2', attStatuses: [200], reqBody: 'req-L2' });
  const t2 = makeTrace({ id: 'L3', attStatuses: [503, 200], outcome: 'success-after-retry', reqBody: 'req-L3' });
  writeLegacyShard(dir, TODAY, 1, [t1, t2]);

  await ts.list({ mode: 'all', limit: 10 }); // 触发补建 idx
  const full = await ts.getById('L3');
  assert.ok(full, '应读到 L3');
  assert.equal(full.id, 'L3');
  assert.equal(full.attempts.length, 2);
  assert.equal(full.attempts[0].upstreamResponseBody, 'upstream-resp-L3-1', '上游 body 完整');
});

// ── E: 四档过滤（用真实形态样本）──────────────────────────

test('E. 四档过滤命中数', async () => {
  const dir = newTmpDir('filter');
  ts.setLogDir(dir);
  // 构造真实形态：
  //  - 2 条 success-direct（att1, 200）
  //  - 2 条 success-after-retry（att2, 503→200）→ retried 档命中
  //  - 1 条 failed（重试耗尽，final 503）→ failed 档命中
  //  - 1 条 pass-through（att1, 403）→ llm-error 档命中（403 非 2xx）
  //  - 1 条 pass-through（att1, 301）→ llm-error 档命中（301 非 2xx）
  const traces = [
    makeTrace({ id: 'F1', outcome: 'success-direct', attStatuses: [200] }),
    makeTrace({ id: 'F2', outcome: 'success-direct', attStatuses: [200] }),
    makeTrace({ id: 'F3', outcome: 'success-after-retry', attStatuses: [503, 200] }),
    makeTrace({ id: 'F4', outcome: 'success-after-retry', attStatuses: [503, 200] }),
    makeTrace({ id: 'F5', outcome: 'failed', finalStatus: 503, attStatuses: [503, 503] }),
    makeTrace({ id: 'F6', outcome: 'pass-through', finalStatus: 403, attStatuses: [403] }),
    makeTrace({ id: 'F7', outcome: 'pass-through', finalStatus: 301, attStatuses: [301] }),
  ];
  // 时间错开，保证 sort 稳定可测
  traces.forEach((t, i) => { t.startedAt = `${TODAY}T0${i}:00:00.000Z`; });
  for (const t of traces) ts.append(t);

  const all = await ts.list({ mode: 'all', limit: 100 });
  assert.equal(all.length, 7, 'all=7');
  const retried = await ts.list({ mode: 'retried', limit: 100 });
  assert.deepEqual(retried.map(r => r.id).sort(), ['F3', 'F4', 'F5'], 'retried=3（att>1：F3/F4/F5）');
  const failed = await ts.list({ mode: 'failed', limit: 100 });
  assert.deepEqual(failed.map(r => r.id), ['F5'], 'failed=1（outcome=failed）');
  // llm-error = 任一 attempt 非 2xx 或 status=0：
  //   F3(503),F4(503),F5(503),F6(403),F7(301) = 5 条（F1/F2 全 200 不命中）
  const llmErr = await ts.list({ mode: 'llm-error', limit: 100 });
  assert.deepEqual(llmErr.map(r => r.id).sort(), ['F3', 'F4', 'F5', 'F6', 'F7'], 'llm-error=5');
});

// ── F: since 增量 ─────────────────────────────────────────

test('F. since 增量只返回新于 since 的', async () => {
  const dir = newTmpDir('since');
  ts.setLogDir(dir);
  ts.append(makeTrace({ id: 'S1', startedAt: `${TODAY}T01:00:00.000Z` }));
  ts.append(makeTrace({ id: 'S2', startedAt: `${TODAY}T02:00:00.000Z` }));
  ts.append(makeTrace({ id: 'S3', startedAt: `${TODAY}T03:00:00.000Z` }));

  const since1 = await ts.list({ since: `${TODAY}T01:00:00.000Z`, limit: 100 });
  assert.deepEqual(since1.map(r => r.id), ['S3', 'S2'], 'since=01:00 → S2,S3');
  const since2 = await ts.list({ since: `${TODAY}T02:30:00.000Z`, limit: 100 });
  assert.deepEqual(since2.map(r => r.id), ['S3'], 'since=02:30 → S3');
});

// ── G: 分片命名配对 ───────────────────────────────────────
// 注：SHARD_MAX_BYTES=200MB 的滚动阈值无法在单测里真写验证（太大），滚动行为留给
// mock/test-logs.mjs 的真请求集成测试覆盖。这里只验证序号命名规则 + idx/body 同序号配对。

test('G. 序号三位补零 + idx/body 同序号配对', async () => {
  const dir = newTmpDir('roll');
  ts.setLogDir(dir);
  ts.append(makeTrace({ id: 'R1' }));
  const files = readdirSync(dir);
  assert.ok(files.includes(`traces-${TODAY}.001.idx.jsonl`), '序号三位补零：001.idx');
  assert.ok(files.includes(`traces-${TODAY}.001.body.jsonl`), '序号三位补零：001.body');
  assert.ok(!files.some(f => f.includes('.1.idx') || f.includes('.1.body')), '不应出现非补零序号');
});

// ── H: cleanupOld 按天整组删 ───────────────────────────────

test('H. cleanupOld 删 7 天前的 idx + body + 旧裸文件', async () => {
  const dir = newTmpDir('cleanup');
  ts.setLogDir(dir);
  // 8 天前的旧裸文件 + 8 天前的 idx/body 配对
  writeLegacyShard(dir, DAY_OLD, 1, [makeTrace({ id: 'OLD1' })]);
  writeFileSync(join(dir, `traces-${DAY_OLD}.001.idx.jsonl`), '{}\n', 'utf8');
  writeFileSync(join(dir, `traces-${DAY_OLD}.001.body.jsonl`), '{}\n', 'utf8');
  // 今天的文件应保留
  ts.append(makeTrace({ id: 'NOW1' }));

  ts.cleanupOld();
  const files = readdirSync(dir);
  assert.ok(!files.some(f => f.startsWith(`traces-${DAY_OLD}`)), '8 天前的应全删');
  assert.ok(files.some(f => f.startsWith(`traces-${TODAY}`)), '今天的应保留');
});

// ── I: 真实日志形态回归 ───────────────────────────────────
// 用环境变量 REAL_LOG_DIR 指向一份真实日志目录（含旧裸 .jsonl），验证：
//   - 旧文件能补建 idx 并读出
//   - 各 outcome/attempt 形态（含 11 次重试、空 body、3xx/4xx 透传）的详情能按 offset 精确读回
//   - 二次 list 飞快（idx 已建）
// 没设 REAL_LOG_DIR 则跳过（CI 无外部依赖时）。运行示例：
//   REAL_LOG_DIR=D:/tmp/claude-code-proxy-log node --test proxy/test/trace-store.test.mjs

const REAL_LOG_DIR = process.env.REAL_LOG_DIR;
const realTest = REAL_LOG_DIR && existsSync(REAL_LOG_DIR) ? test : test.skip;

realTest('I. 真实旧裸日志补建 idx + 详情精确读 + 二次加速', async () => {
  ts.setLogDir(REAL_LOG_DIR);
  // 首次 list（可能触发补建，慢）
  const list1 = await ts.list({ mode: 'all', limit: 200 });
  assert.ok(list1.length > 0, '真实日志应能读出记录');

  // 抽几条不同形态的 id 做详情读回归
  const byId = new Map(list1.map(r => [r.id, r]));
  const checked = [];
  for (const r of list1) {
    const full = await ts.getById(r.id);
    assert.ok(full, `getById(${r.id}) 应读到`);
    assert.equal(full.id, r.id);
    // attempts 的 upstreamResponseBody 应完整存在（旧数据也有）
    assert.ok(full.attempts.every(a => 'upstreamResponseBody' in a), `${r.id} 上游 body 完整`);
    checked.push(r.id);
    if (checked.length >= 6) break; // 抽样 6 条够了
  }

  // 二次 list 应走 idx，远快于首次（这里只断言不报错 + 数量一致）
  const list2 = await ts.list({ mode: 'all', limit: 200 });
  assert.equal(list2.length, list1.length, '二次 list 数量一致');
});

// ── J: 时间窗口成功统计 stats() ───────────────────────────
// stats 按 startedAt 时间窗口统计 finalStatus 2xx 的成功命令数。
// 关键：只扫 idx 摘要、不读 body；成功=finalStatus 2xx；窗口边界 [now-w*3600s, now]。

test('J1. stats 按 startedAt 窗口统计 2xx 成功数', async () => {
  const dir = newTmpDir('stats');
  ts.setLogDir(dir);
  const now = Date.now();
  // 用真实"现在"附近的时刻写记录，避免 cleanupOld 误删（它只删 7 天前，今天的安全）
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  // 3 条成功（200）、1 条失败（503），都在最近 1 小时内
  ts.append(makeTrace({ id: 'J1', finalStatus: 200, startedAt: iso(-5 * 60_000) }));     // 5 分钟前，成功
  ts.append(makeTrace({ id: 'J2', finalStatus: 200, startedAt: iso(-20 * 60_000) }));   // 20 分钟前，成功
  ts.append(makeTrace({ id: 'J3', finalStatus: 200, startedAt: iso(-50 * 60_000) }));   // 50 分钟前，成功
  ts.append(makeTrace({ id: 'J4', finalStatus: 503, startedAt: iso(-30 * 60_000) }));   // 30 分钟前，失败
  // 1 条 90 分钟前的成功（超出 1 小时，在 2 小时窗口内）
  ts.append(makeTrace({ id: 'J5', finalStatus: 200, startedAt: iso(-90 * 60_000) }));

  const r = await ts.stats({ windows: [1, 2] });
  assert.ok(r.windows.length === 2);
  const w1 = r.windows.find(w => w.hours === 1);
  const w2 = r.windows.find(w => w.hours === 2);
  assert.ok(w1 && w2, '应返回 1h 与 2h 窗口');
  // 1 小时内：J1/J2/J3/J4 = 4 条，成功 3（J1/J2/J3）
  assert.equal(w1.total, 4, '1h 内 total=4');
  assert.equal(w1.success, 3, '1h 内 success=3');
  // 2 小时内：再加 J5 = 5 条，成功 4
  assert.equal(w2.total, 5, '2h 内 total=5');
  assert.equal(w2.success, 4, '2h 内 success=4');
  // fromTs 应为 now - hours*3600*1000
  assert.ok(Math.abs(w1.fromTs - (now - 3600_000)) < 3000, '1h fromTs 近似正确');
});

test('J2. stats 窗口按小时升序、空目录返回 0', async () => {
  const dir = newTmpDir('stats-empty');
  ts.setLogDir(dir);
  const r = await ts.stats({ windows: [24, 1, 5] });
  assert.deepEqual(r.windows.map(w => w.hours), [1, 5, 24], '应升序');
  for (const w of r.windows) {
    assert.equal(w.success, 0);
    assert.equal(w.total, 0);
  }
});

test('J3. stats 成功=2xx，3xx/4xx/5xx/0 都不算成功', async () => {
  const dir = newTmpDir('stats-status');
  ts.setLogDir(dir);
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60_000).toISOString();
  ts.append(makeTrace({ id: 'K1', finalStatus: 200, startedAt: iso(1) }));   // 成功
  ts.append(makeTrace({ id: 'K2', finalStatus: 201, startedAt: iso(2) }));  // 成功（201 也算 2xx）
  ts.append(makeTrace({ id: 'K3', finalStatus: 301, startedAt: iso(3) }));  // 3xx 不算
  ts.append(makeTrace({ id: 'K4', finalStatus: 403, startedAt: iso(4) }));  // 4xx 不算
  ts.append(makeTrace({ id: 'K5', finalStatus: 503, startedAt: iso(5) }));  // 5xx 不算
  ts.append(makeTrace({ id: 'K6', finalStatus: 0, startedAt: iso(6) }));    // 网络错误 0 不算
  const r = await ts.stats({ windows: [1] });
  const w = r.windows[0];
  assert.equal(w.total, 6, '6 条');
  assert.equal(w.success, 2, '只 200/201 算成功=2');
});

