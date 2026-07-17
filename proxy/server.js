import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import {
  concise,
  detail,
  maskValue,
  renderHeaders,
  formatBody,
  setLogDir as loggerSetLogDir,
} from './logger.js';
import * as configStore from './config-store.js';
import * as traceStore from './trace-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');

// ── 小工具 ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(16).slice(2, 6).toUpperCase();
const nowIso = () => new Date().toISOString();

// 按平台给默认端口，避免 Windows + WSL 同机抢同一 localhost（WSL2 转发会串味）。
// 与扩展侧 proxyHost.defaultPortForPlatform 保持一致。
function defaultPortForPlatform() {
  switch (process.platform) {
    case 'win32': return 11434;
    case 'darwin': return 11436;
    case 'linux': return 11435; // 含 WSL，不区分
    default: return 11435;
  }
}
function clientIp(req) {
  const a = req.socket?.remoteAddress || '';
  return a.replace(/^::ffff:/, '');
}
function runtimeParams() {
  const p = configStore.getProxy();
  const env = configStore.getEnv();
  return {
    maxAttempts: p.maxAttempts,
    backoffSec: p.backoffSec,
    backoffMaxSec: p.backoffMaxSec,
    passthrough: p.passthrough,
    retryOnStatus: p.retryOnStatus,
    retryOnBodyErrorCode: p.retryOnBodyErrorCode,
    upstreamTimeoutMs: env.upstreamTimeoutMs,
    upstream: env.upstream,
    upstreamBase: env.upstreamBase,
    token: env.token,
  };
}
const backoffForMs = (attempt, backoffSec, backoffMaxSec) =>
  Math.min(backoffSec * 1000 * 2 ** (attempt - 1), backoffMaxSec * 1000);

function lanIpv4s() {
  const out = [];
  try {
    for (const [, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch {}
  return out;
}

// ── effort 改写：把请求体里的 output_config.effort 强制改写为目标值 ──
// 只改写已有 output_config.effort 的 /v1/messages JSON 请求；不凭空给无 effort 的
// 请求注入 output_config（避免改变 Claude Code 本没设 effort 的请求行为）。
// 任何异常都原样返回 body，绝不因改写失败阻断转发。
function rewriteEffort(body, effortLevel, reqId, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct.includes('json')) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // 非 JSON body（如 event-stream 响应、空 body），原样转发
  }
  if (!parsed || typeof parsed !== 'object') return body;
  const oc = parsed.output_config;
  if (typeof oc !== 'object' || oc === null || !('effort' in oc)) return body;
  const prev = oc.effort;
  if (prev === effortLevel) return body; // 已经是目标值，免去一次 stringify + body 长度变化
  oc.effort = effortLevel;
  let rewritten;
  try {
    rewritten = Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return body;
  }
  detail(reqId, 'EFFORT REWRITE', `output_config.effort: ${String(prev)} → ${effortLevel} (${body.length} → ${rewritten.length} bytes)`);
  return rewritten;
}

// ── 转发一次请求到上游 ──────────────────────────────────────
function forwardOnce({ method, path, reqHeaders, body, reqId, attempt, timeoutMs, upstream, token }) {
  return new Promise((resolve) => {
    // 上游未注入（代理常驻但还没激活"通过代理"配置）→ 直接返回 502，不崩
    if (!upstream || !upstream.protocol) {
      detail(reqId, `attempt ${attempt} → NO UPSTREAM`, '代理尚未注入上游配置（请在 claude-code-proxy 激活一条"通过代理"配置）');
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: 'no upstream configured' });
      return;
    }
    const upstreamLib = upstream.protocol === 'https:' ? https : http;
    const upstreamDefaultPort = upstream.protocol === 'https:' ? 443 : 80;
    const upstreamPathPrefix = upstream.pathname.replace(/\/$/, '');
    const reqPath = path.startsWith('/') ? path : '/' + path;
    const target = new URL(upstreamPathPrefix + reqPath, upstream.origin);

    const outHeaders = { ...reqHeaders };
    outHeaders['host'] = target.host;
    outHeaders['authorization'] = `Bearer ${token}`;
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['connection'];

    detail(reqId, `attempt ${attempt} → UPSTREAM REQUEST`, [
      `${method} ${target.href}`,
      'Headers:',
      renderHeaders(outHeaders),
      `Body: identical to client request (${body.length} bytes)`,
    ].join('\n'));

    let settled = false;
    const settle = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    const req = upstreamLib.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || upstreamDefaultPort,
        path: target.pathname + target.search,
        headers: outHeaders,
        timeout: timeoutMs,
      },
      (resp) => {
        const chunks = [];
        let ended = false;
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          ended = true;
          const r = { status: resp.statusCode ?? 0, headers: resp.headers, body: Buffer.concat(chunks) };
          detail(reqId, `attempt ${attempt} → UPSTREAM RESPONSE`, [
            `Status: ${r.status}`,
            'Headers:',
            renderHeaders(r.headers),
            `Body (${r.body.length} bytes):`,
            formatBody(r.body, r.headers['content-type']),
          ].join('\n'));
          settle(r);
        });
        resp.on('error', (e) => {
          settle({ status: 0, headers: {}, body: Buffer.concat(chunks), networkError: `response stream error: ${e.message}` });
        });
        resp.on('close', () => {
          if (!ended) {
            settle({ status: 0, headers: {}, body: Buffer.concat(chunks), networkError: 'response stream closed prematurely' });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: `timeout (${timeoutMs}ms)` });
    });
    req.on('error', (e) => {
      settle({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: e.message });
    });

    req.end(body);
  });
}

function reply(clientRes, r) {
  const h = { ...r.headers };
  delete h['content-encoding'];
  delete h['transfer-encoding'];
  delete h['content-length'];
  clientRes.writeHead(r.status, h);
  clientRes.end(r.body);
}

// ── 响应体错误探测（对所有状态码生效）────────────────────────
function inspectBody(r, retryOnBodyErrorCode) {
  const ct = r.headers['content-type'] || '';
  if (!ct.includes('json')) return null;
  let parsed;
  try {
    parsed = JSON.parse(r.body.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed?.type === 'error' && parsed.error) {
    const code = parsed.error.code;
    const msg = parsed.error.message || '';
    if (code != null && retryOnBodyErrorCode.includes(Number(code))) {
      return { retryable: true, reason: `body error code ${code} (${msg})` };
    }
    return { retryable: false, reason: `body error code ${code} (${msg})` };
  }
  return null;
}

// ── 控制面 API ──────────────────────────────────────────────
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw new Error('invalid JSON body');
  }
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }
  const abs = join(WEB_DIR, rel);
  if (!abs.startsWith(WEB_DIR) || !existsSync(abs)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  res.end(readFileSync(abs));
}

async function handleApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/config') {
    sendJson(res, 200, configStore.getView());
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/config') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateProxy(body.proxy ?? body);
      concise(`CONFIG updated → maxAttempts=${updated.maxAttempts} backoffSec=${updated.backoffSec} backoffMaxSec=${updated.backoffMaxSec}`);
      sendJson(res, 200, { ok: true, proxy: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/upstream') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateUpstream(body.upstream ?? body);
      const env = configStore.getEnv();
      concise(`UPSTREAM updated → baseUrl=${env.upstreamBase} model=${env.model ?? '(unset)'} timeout=${env.upstreamTimeoutMs}ms`);
      sendJson(res, 200, { ok: true, upstream: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  // 热改 effortLevel：下个请求即生效。level ∈ {'', low, medium, high, xhigh, max}；'' = 不改写原样透传。
  if (req.method === 'POST' && urlPath === '/api/effort') {
    try {
      const body = await readJsonBody(req);
      const level = body.level;
      const updated = configStore.updateEffort(level);
      concise(`EFFORT updated → ${updated || '(不改写，原样透传)'}`);
      sendJson(res, 200, { ok: true, effortLevel: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/traces') {
    const u = new URL('http://x' + req.url);
    const since = u.searchParams.get('since') || undefined;
    // mode: all | retried | failed | llm-error（默认 all）
    // 旧参数 onlyRetries=1 等价于 mode=retried（向后兼容）
    let mode = u.searchParams.get('mode') || 'all';
    if (u.searchParams.get('onlyRetries') === '1') mode = 'retried';
    const limit = Number(u.searchParams.get('limit')) || 200;
    sendJson(res, 200, await traceStore.list({ since, mode, limit }));
    return;
  }
  // 时间窗口成功统计：windows=1,5,24 → 最近1h/5h/1天的成功命令数。
  // 前端可自定义窗口（逗号分隔的小时数）。成功=finalStatus 2xx。
  if (req.method === 'GET' && urlPath === '/api/stats') {
    const u = new URL('http://x' + req.url);
    const wRaw = u.searchParams.get('windows') || '1,5,24';
    // 上限 168h（7天）= trace 保留期，超过的数据已被 cleanupOld 删掉，统计无意义且会撑爆 days 扫描循环
    const MAX_HOURS = 168;
    const windows = String(wRaw)
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_HOURS)
      .slice(0, 12); // 防止前端塞几百个窗口拖垮扫描
    const ws = windows.length ? windows : [1, 5, 24];
    sendJson(res, 200, await traceStore.stats({ windows: ws }));
    return;
  }
  const m = urlPath.match(/^\/api\/traces\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const r = await traceStore.getById(m[1]);
    sendJson(res, r ? 200 : 404, r ?? { error: 'trace not found' });
    return;
  }
  // 返回 logs 目录绝对路径（前端展示 + 决定是否可打开）
  if (req.method === 'GET' && urlPath === '/api/logs-dir') {
    sendJson(res, 200, { dir: traceStore.getLogDir(), configured: traceStore.isLogsDirConfigured() });
    return;
  }
  // 改 logs 目录：写回 logs-config.json + 改运行时 LOG_DIR + mkdir。
  // 立即生效（下一条 trace 写新目录），历史日志留在原地不迁移。
  if (req.method === 'POST' && urlPath === '/api/logs-dir') {
    try {
      const body = await readJsonBody(req);
      const dir = body.dir;
      // dir 必须是字符串；空字符串 = 恢复默认（合法）。只拒绝 undefined/非字符串。
      if (typeof dir !== 'string') {
        sendJson(res, 400, { error: '缺少 dir 字段（string，空串=恢复默认）' });
        return;
      }
      const newDir = traceStore.setLogsDir(dir.trim());
      // logger 的 LOG_DIR 也要跟着改，否则 trace 文件去了新目录、详细日志还留在旧目录
      loggerSetLogDir(newDir);
      concise(`LOGS_DIR changed → ${newDir}`);
      sendJson(res, 200, { ok: true, dir: newDir, configured: traceStore.isLogsDirConfigured() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  // 在系统文件管理器里打开 logs 目录并定位（跨平台）
  if (req.method === 'POST' && urlPath === '/api/open-logs') {
    const dir = traceStore.getLogDir();
    try {
      openInFileManager(dir);
      concise(`OPEN logs dir: ${dir}`);
      sendJson(res, 200, { ok: true, dir });
    } catch (e) {
      sendJson(res, 500, { error: e.message, dir });
    }
    return;
  }
  // kill 代理：关掉监听句柄。任意窗口都可调（不限于宿主）。
  // 关掉后宿主窗口心跳会在 ≤2s 内发现 healthz 不通，tryBecomeHost 重起一个。
  // 注意：重起的是宿主内存里已缓存的 proxyModule —— 改了 proxy 代码不会因此重新加载，
  // 要加载新代码得 Reload Window（且 Reload 的是宿主那个窗口）。
  // 代理监听端口：GET 返回当前端口 + 平台默认；POST 改端口（写 config + kill 让心跳重启）
  if (req.method === 'GET' && urlPath === '/api/port') {
    const listen = configStore.getListen();
    sendJson(res, 200, { port: listen.listenPort, defaultPort: defaultPortForPlatform() });
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/port') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateListenPort(body.port);
      concise(`PORT changed → ${updated.listenPort}（需重启生效，将关闭监听让心跳重起）`);
      // 先回响应，再 kill 监听（和 /api/kill 同样套路）
      sendJson(res, 200, { ok: true, port: updated.listenPort });
      setImmediate(() => {
        try { runningServer?.close?.(); } catch {}
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/kill') {
    concise('KILL 收到请求，关闭代理监听（宿主心跳将自动重起）');
    sendJson(res, 200, { ok: true });
    // 先回响应再关，避免连接复位导致前端拿不到 200
    setImmediate(() => {
      try { runningServer?.close?.(); } catch {}
    });
    return;
  }
  sendJson(res, 404, { error: 'unknown api' });
}

// 在系统文件管理器里打开目录（跨平台）。Windows 用 explorer，macOS 用 open，Linux 用 xdg-open。
function openInFileManager(dir) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'win32') {
    cmd = 'explorer'; args = [dir];
  } else if (platform === 'darwin') {
    cmd = 'open'; args = [dir];
  } else {
    cmd = 'xdg-open'; args = [dir];
  }
  // detached + stdio ignore：子进程不挂到代理生命周期上，关代理不影响已打开的资源管理器
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// ── 请求处理（模块级，依赖 configStore/traceStore，由 startServer 先 init）──
async function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') {
    sendJson(res, 200, { ok: true, upstream: configStore.getEnv().upstreamBase, ts: nowIso() });
    return;
  }
  if (urlPath.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlPath);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && (urlPath === '/' || urlPath.startsWith('/assets/'))) {
    serveStatic(req, res, urlPath);
    return;
  }

  // ── 代理转发 ──────────────────────────────────────────
  const startedAt = nowIso();
  const t0 = Date.now();
  const ip = clientIp(req);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const id = rid();

  // 从请求 body 提取 model 字段（Claude API /v1/messages 请求体含 model）
  let reqModel = '';
  try {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('json') && body.length > 0) {
      const parsed = JSON.parse(body.toString('utf8'));
      reqModel = parsed.model || '';
    }
  } catch { /* 非 JSON 或解析失败，忽略 */ }

  // effort 改写：仅对 /v1/messages 主路径（不含 count_tokens/batches 等子路径）的 JSON 请求改写。
  // effortLevel 为空串（用户选"不改写"）时原样透传；无 output_config 或 effort 缺失也不改；改写失败也原样透传。
  const effortLevel = configStore.getEffortLevel();
  const isMessagesMain = /^\/v1\/messages(?:\?|$)/.test(req.url);
  const outBody = (effortLevel && isMessagesMain)
    ? rewriteEffort(body, effortLevel, id, req.headers['content-type'])
    : body;
  const rewritten = outBody !== body;

  const params = runtimeParams();
  const { maxAttempts, backoffSec, backoffMaxSec, passthrough, retryOnStatus, retryOnBodyErrorCode, upstreamTimeoutMs, upstream, upstreamBase, token } = params;
  const modeTag = passthrough ? '透传' : '重试';

  concise(`REQ  #${id} ${req.method} ${req.url} (body ${body.length} bytes) from ${ip} [${modeTag}]${rewritten ? ` [effort→${effortLevel}]` : ''}`);
  detail(id, 'CLIENT → PROXY REQUEST', [
    `${req.method} ${req.url}`,
    `mode: ${modeTag}`,
    'Headers:',
    renderHeaders(req.headers),
    `Body (${body.length} bytes):`,
    formatBody(body, req.headers['content-type']),
  ].join('\n'));

  const attempts = [];
  let attempt = 0;
  let finalDelivered = null;
  let outcome = 'failed';

  if (passthrough) {
    attempt = 1;
    const attStart = nowIso();
    const attT0 = Date.now();
    const r = await forwardOnce({ method: req.method, path: req.url, reqHeaders: req.headers, body: outBody, reqId: id, attempt, timeoutMs: upstreamTimeoutMs, upstream, token });
    const attMs = Date.now() - attT0;
    concise(`     #${id} attempt 1/1 → ${r.status || 'NETERR'} (${attMs}ms) [透传，不重试]`);
    attempts.push({ attempt: 1, status: r.status, networkError: r.networkError ?? null, startedAt: attStart, endedAt: nowIso(), elapsedMs: attMs, verdict: 'passthrough', reason: 'passthrough mode (no retry)', backoffMs: null, upstreamRequestBody: outBody.toString('utf8'), upstreamResponseBody: r.body.toString('utf8') });
    if (r.status === 0) {
      const errBody = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: `upstream ${upstreamBase ?? ''} unreachable (passthrough): ${r.networkError}` } });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(errBody);
      finalDelivered = { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(errBody) };
      outcome = 'passed-to-client';
    } else {
      reply(res, r);
      finalDelivered = r;
      outcome = 'passthrough';
    }
    concise(`REQ  #${id} delivered to client (passthrough), total ${Date.now() - t0}ms, status ${finalDelivered.status}`);
  } else {
    while (attempt < maxAttempts) {
      attempt++;
      const attStart = nowIso();
      const attT0 = Date.now();
      const r = await forwardOnce({ method: req.method, path: req.url, reqHeaders: req.headers, body: outBody, reqId: id, attempt, timeoutMs: upstreamTimeoutMs, upstream, token });
      const attMs = Date.now() - attT0;
      concise(`     #${id} attempt ${attempt}/${maxAttempts} → ${r.status || 'NETERR'} (${attMs}ms${r.networkError ? ` ${r.networkError}` : ''})`);

      let verdict;
      // 原则：代理只重试 Claude Code 处理不了的——即 503 + body error.code 10310（讯飞
      // system busy）。Claude Code 不识别这个业务码、只会当普通 5xx 盲目重试 10 次，
      // 代理的针对重试（20 次 + 16s 上限）更有效。其余全部透传交给 Claude Code 自己处理：
      //   - 429/500/502/504 等：Claude Code 的 shouldRetry 会当 5xx/限流重试
      //   - 网络错误（超时/断连/流中断）：Claude Code 会当 APIConnectionError 重试
      //     代理无法原样转 socket 错误，合成 502 回客户端，Claude Code 仍当 5xx 重试，语义等价。
      // 唯一例外：上游未注入（no upstream configured）——代理没配好，不是网络问题，
      // 包 502 提示用户去激活配置，这个不交给 Claude Code。
      if (r.status === 0) {
        verdict = { retryable: false, reason: `network error, pass to Claude Code (${r.networkError})` };
      } else {
        const bodyErr = inspectBody(r, retryOnBodyErrorCode);
        if (bodyErr?.retryable) {
          verdict = { retryable: true, reason: `${r.status} + ${bodyErr.reason}` };
        } else if (r.status >= 200 && r.status < 300 && !bodyErr) {
          verdict = null;
        } else if (retryOnStatus.includes(r.status)) {
          verdict = { retryable: true, reason: `status ${r.status} in retryOnStatus` };
        } else {
          verdict = { retryable: false, reason: bodyErr ? `body error not in retryOnBodyErrorCode: ${bodyErr.reason}` : `status ${r.status} not in retryOnStatus` };
        }
      }

      detail(id, `attempt ${attempt}/${maxAttempts} → VERDICT`, [
        `status: ${r.status || 'NETERR'}`,
        `verdict: ${verdict === null ? 'SUCCESS' : verdict.retryable ? 'RETRYABLE' : 'NOT-RETRYABLE'}`,
        `reason: ${verdict === null ? '(real success)' : verdict.reason}`,
        `elapsed: ${attMs}ms`,
      ].join('\n'));

      let waitMs = null;
      if (verdict !== null && verdict.retryable && attempt < maxAttempts) {
        waitMs = backoffForMs(attempt, backoffSec, backoffMaxSec);
      }
      attempts.push({ attempt, status: r.status, networkError: r.networkError ?? null, startedAt: attStart, endedAt: nowIso(), elapsedMs: attMs, verdict: verdict === null ? 'success' : verdict.retryable ? 'retryable' : 'not-retryable', reason: verdict === null ? '(real success)' : verdict.reason, backoffMs: waitMs, upstreamRequestBody: outBody.toString('utf8'), upstreamResponseBody: r.body.toString('utf8') });

      if (verdict === null) {
        concise(`     #${id} DONE`);
        detail(id, 'DELIVER TO CLIENT', 'real success, forwarding upstream response');
        finalDelivered = r;
        outcome = attempt === 1 ? 'success-direct' : 'success-after-retry';
        reply(res, r);
        break;
      }
      if (verdict.retryable && attempt < maxAttempts) {
        concise(`     #${id} RETRY (${verdict.reason}) → waiting ${waitMs}ms`);
        detail(id, `attempt ${attempt}/${maxAttempts} → BACKOFF`, `waiting ${waitMs}ms before next attempt`);
        await sleep(waitMs);
        continue;
      }
      if (verdict.retryable) {
        concise(`     #${id} retry budget exhausted (${verdict.reason})`);
      } else {
        concise(`     #${id} PASS-THROUGH (${verdict.reason})`);
      }
      detail(id, 'DELIVER TO CLIENT', [verdict.retryable ? 'retry budget exhausted' : 'not retryable, pass-through', `forwarding last upstream response (status ${r.status || 'NETERR'})`].join('\n'));
      if (r.status === 0) {
        const errBody = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: `upstream ${upstreamBase ?? ''} unreachable (${r.networkError})` } });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(errBody);
        finalDelivered = { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(errBody) };
        outcome = 'passed-to-client';
      } else {
        finalDelivered = r;
        outcome = verdict.retryable ? 'failed' : 'pass-through';
        reply(res, r);
      }
      break;
    }
  }

  // ── 写 trace ─────────────────────────────────────────
  const endedAt = nowIso();
  const totalMs = Date.now() - t0;
  concise(`REQ  #${id} delivered to client, total ${totalMs}ms, ${attempt} attempt(s), outcome=${outcome}`);
  traceStore.append({
    id, sourceIp: ip, method: req.method, path: req.url, startedAt, endedAt, totalMs,
    finalStatus: finalDelivered?.status ?? 0, outcome, model: reqModel,
    requestBody: outBody.toString('utf8'),
    responseBody: finalDelivered ? finalDelivered.body.toString('utf8') : '',
    responseHeaders: finalDelivered?.headers ?? {},
    attempts,
    configSnapshot: { maxAttempts, backoffSec, backoffMaxSec, passthrough, retryOnStatus, retryOnBodyErrorCode },
  });
}

// ── 启动服务（扩展和 CLI 共用）──────────────────────────────
// 返回 { server, stop, port }；端口占用等 listen 错误时 reject（不 process.exit）
// runningServer 模块级持有，供 /api/kill 关闭监听用
let runningServer = null;
export async function startServer({ configPath, logsDir, logsConfigPath } = {}) {
  configStore.init(configPath);
  if (logsDir) {
    loggerSetLogDir(logsDir);
    traceStore.setLogDir(logsDir);
  }
  // 注入 logs-config.json 路径：若用户配过 logsDir，会覆盖上面的默认 LOG_DIR
  if (logsConfigPath) {
    traceStore.setLogsConfigPath(logsConfigPath);
  }

  const { listenHost, listenPort } = configStore.getListen();
  const server = http.createServer(handleRequest);
  runningServer = server;

  return new Promise((resolve, reject) => {
    server.on('error', reject); // EADDRINUSE 等交给调用方
    server.listen(listenPort, listenHost, () => {
      const allIps = listenHost === '0.0.0.0' || listenHost === '::' ? ['127.0.0.1', ...lanIpv4s()] : [listenHost];
      const urls = allIps.map((ip) => `http://${ip}:${listenPort}`).join('  |  ');
      const env0 = configStore.getEnv();
      const p = configStore.getProxy();
      concise(`proxy listening on ${urls}`);
      concise(`  web UI     : ${allIps.map((ip) => `http://${ip}:${listenPort}/`).join('  |  ')}`);
      concise(`  upstream   : ${env0.upstreamBase} (${env0.upstream?.protocol === 'https:' ? 'https' : 'http'})`);
      concise(`  model      : ${env0.model ?? '(unset)'}`);
      concise(`  token      : ${maskValue(env0.token)}`);
      concise(`  retry      : maxAttempts=${p.maxAttempts} backoffSec=${p.backoffSec} backoffMaxSec=${p.backoffMaxSec} onStatus=${JSON.stringify(p.retryOnStatus)} onBodyErrorCode=${JSON.stringify(p.retryOnBodyErrorCode)}`);
      concise(`  mode       : ${p.passthrough ? '透传（不重试，原样转发）' : '拦截重试'}`);
      concise(`  timeout    : ${env0.upstreamTimeoutMs}ms`);
      concise(`  detail log : ${logsDir ?? '<default>'}  (时间均为中国时间 +08:00)`);
      traceStore.cleanupOld();
      resolve({
        server,
        port: listenPort,
        host: listenHost,
        stop: () => new Promise((r) => {
          server.close(() => {
            if (runningServer === server) runningServer = null;
            r();
          });
        }),
      });
    });
  });
}

// ── CLI 模式：直接 node server.js 时启动 ────────────────────
const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  const cfgPath = process.env.CONFIG_PATH || new URL('./config.json', import.meta.url);
  startServer({ configPath: typeof cfgPath === 'string' ? cfgPath : fileURLToPath(cfgPath) }).catch((e) => {
    concise(`FATAL: ${e.message}`);
    if (e.code === 'EADDRINUSE') concise(`  port already in use — change proxy.listenPort in config.json`);
    process.exit(1);
  });
}
