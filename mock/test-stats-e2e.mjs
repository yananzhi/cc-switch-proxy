// 一次性集成验证：启动真实代理，打 /api/stats 与 /api/traces，验证统计接口与表格对齐修复。
// 运行： node mock/test-stats-e2e.mjs   （测完自清临时目录，不写真实日志）
import { startServer } from '../proxy/server.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tmpLogs = join(here, '.e2e-logs');
rmSync(tmpLogs, { recursive: true, force: true });
mkdirSync(tmpLogs, { recursive: true });

// 给 trace-store 注入临时日志目录，避免污染真实日志
const traceStore = await import('../proxy/trace-store.js');
traceStore.setLogDir(tmpLogs);

// 用一个独立端口避免与本机 11434 冲突
const cfgPath = join(here, '.e2e-config.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(cfgPath, JSON.stringify({ proxy: { listenHost: '127.0.0.1', listenPort: 11499 } }, null, 2));

const srv = await startServer({ configPath: cfgPath });
const base = `http://127.0.0.1:${srv.port}`;

async function jget(p) {
  const r = await fetch(base + p);
  return r.json();
}

// 写几条真实 trace（用现在附近的时刻，避免被 cleanup 删）
const now = Date.now();
const iso = (m) => new Date(now - m * 60_000).toISOString();
const mk = (id, finalStatus, startedAt) => ({
  id, sourceIp: '127.0.0.1', method: 'POST', path: '/v1/messages',
  startedAt, endedAt: startedAt, totalMs: 1000, finalStatus,
  outcome: finalStatus < 300 ? 'success' : 'failed',
  requestBody: 'req', responseBody: 'resp',
  attempts: [{ attempt: 1, status: finalStatus, elapsedMs: 1000, verdict: finalStatus < 300 ? 'success' : 'not-retryable' }],
});
traceStore.append(mk('S1', 200, iso(5)));
traceStore.append(mk('S2', 200, iso(20)));
traceStore.append(mk('S3', 503, iso(30)));
traceStore.append(mk('S4', 200, iso(90))); // 90 分钟前

let ok = true;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); ok = false; } else console.log('ok :', m); };

// 1. /api/stats 默认窗口 [1,5,24]
const stats = await jget('/api/stats');
assert(Array.isArray(stats.windows), 'stats 返回 windows 数组');
assert(stats.windows.length === 3, '默认 3 个窗口');
assert(stats.windows.map(w => w.hours).join(',') === '1,5,24', '默认窗口 1,5,24 升序');
const w1 = stats.windows.find(w => w.hours === 1);
assert(w1.success === 2 && w1.total === 3, '1h: success=2 total=3 (S1/S2/S3, 成功 S1/S2)');
const w2 = stats.windows.find(w => w.hours === 5);
assert(w2.success === 3 && w2.total === 4, '5h: success=3 total=4 (含 S4)');

// 2. /api/stats 自定义窗口
const stats2 = await jget('/api/stats?windows=0.5,2');
assert(stats2.windows.map(w => w.hours).join(',') === '0.5,2', '自定义窗口 0.5,2');
const half = stats2.windows.find(w => w.hours === 0.5);
assert(half.success === 2 && half.total === 2, '0.5h: S1(5min)+S2(20min) 都在窗口内，success=2 total=2');

// 3. /api/traces 仍正常（对齐修复不破坏列表）
const traces = await jget('/api/traces?limit=10&mode=all');
assert(Array.isArray(traces) && traces.length === 4, 'traces 列表 4 条正常');

// 3b. 重复窗口去重：?windows=1,1,5 应只返回 1 与 5 两个（去重后）
const dup = await jget('/api/stats?windows=1,1,5');
assert(dup.windows.map(w => w.hours).join(',') === '1,5', '重复窗口去重: 1,1,5 → 1,5');

// 3c. 超大窗口被拒绝（防 DoS）：?windows=999999999 不应让循环跑 4100 万次，且超限值被过滤回退默认
const t0 = Date.now();
const huge = await jget('/api/stats?windows=999999999');
const elapsed = Date.now() - t0;
assert(elapsed < 2000, `超大窗口不应卡死代理（耗时 ${elapsed}ms < 2000）`);
assert(JSON.stringify(huge.windows.map(w => w.hours)) === JSON.stringify([1, 5, 24]), '超大/超限窗口被过滤，回退默认 [1,5,24]');

// 4. web UI HTML 含 colgroup（对齐修复落盘）
const { readFileSync } = await import('node:fs');
const html = readFileSync(join(here, '..', 'proxy', 'web', 'index.html'), 'utf8');
assert(html.includes('<colgroup>'), 'web UI 含 colgroup 定宽列');
assert(html.includes('table-layout: fixed'), 'web UI 含 table-layout:fixed');
assert(html.includes('stats-row'), 'web UI 含统计卡片');
assert(html.includes('.sub-cell') && html.includes('white-space: normal'), 'web UI 子行 nowrap 回退为 normal');
assert(html.includes('table-scroll'), 'web UI 含横向滚动容器');
assert(!html.includes('statsCache'), 'web UI 已移除死的 statsCache 状态');
assert(!html.includes('stat-remove'), 'web UI 已移除死的 .stat-remove CSS');

srv.stop();
rmSync(tmpLogs, { recursive: true, force: true });
rmSync(cfgPath, { force: true });
console.log(ok ? '\n=== ALL E2E PASS ===' : '\n=== E2E FAILED ===');
process.exit(ok ? 0 : 1);
