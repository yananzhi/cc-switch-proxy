// config-store.js — 配置读写 + 热重载 + 持久化
//
// 两类配置都支持热重载：
//   proxy.*（重试参数）  — 纯内存改，下个请求即生效
//   env.*（上游/token/model/超时）— 改了要重新派生 upstream URL/lib，下个请求即生效
// 都写回 config.json 持久化。listenHost/listenPort 改了要重启（监听 socket 不能热换）。
//
// 注意：时间相关参数对外用「秒」，内部转成 ms 存储/使用。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { concise } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  listenHost: '0.0.0.0',
  listenPort: 11434,
  maxAttempts: 5,
  backoffSec: 1, // 秒
  backoffMaxSec: 16, // 秒
  passthrough: false, // 透传模式：true=不重试原样转发，false=拦截重试
  // 只重试 Claude Code 处理不了的：503 + body error.code === 10310（讯飞 system busy）。
  // 其他状态码（408/429/500/502/504 等）Claude Code 自己能处理，代理不插手——避免代理重试
  // 拖慢、也避免和 Claude Code 自身重试叠加。故 retryOnStatus 为空。
  // 网络错误（status=0：超时、连接断、流中断）仍兜底重试，否则断网/抖动直接崩给用户。
  retryOnStatus: [],
  retryOnBodyErrorCode: [10310],
};

let configPath;
let config; // 全量配置对象（含 env + effortLevel + proxy）
let proxy; // proxy 段的运行时副本（热重载改这里）

export function init(configPathArg) {
  configPath = configPathArg;
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  // 兼容旧字段：backoffMs/backoffMaxMs → backoffSec/backoffMaxSec
  const p = { ...(config.proxy ?? {}) };
  if (p.backoffMs !== undefined && p.backoffSec === undefined) p.backoffSec = p.backoffMs / 1000;
  if (p.backoffMaxMs !== undefined && p.backoffMaxSec === undefined) p.backoffMaxSec = p.backoffMaxMs / 1000;
  proxy = { ...DEFAULTS, ...p };
  return { config, proxy };
}

// ── env 派生（每次请求读，支持热重载）────────────────────────
export function getEnv() {
  const env = config.env ?? {};
  const base = env.ANTHROPIC_BASE_URL;
  let upstream = null;
  if (base) {
    try { upstream = new URL(base); } catch {}
  }
  return {
    upstreamBase: base,
    upstream,
    token: env.ANTHROPIC_AUTH_TOKEN,
    model: env.ANTHROPIC_MODEL,
    smallFastModel: env.ANTHROPIC_SMALL_FAST_MODEL,
    // 超时：env.API_TIMEOUT_MS 是毫秒；前端用秒展示/编辑，内部仍按 ms 用
    upstreamTimeoutMs: Number(env.API_TIMEOUT_MS) || 600000,
  };
}

// ── 运行时重试参数（每次请求读这个）──────────────────────────
export function getProxy() {
  return { ...proxy };
}

// 监听配置（启动时用，之后不改）
export function getListen() {
  return { listenHost: proxy.listenHost, listenPort: proxy.listenPort };
}

// 改监听端口：写回 config.json + 改运行时 proxy.listenPort。
// 注意：运行中已 listen 的 socket 不能热换，扩展侧改完要 /api/kill 让心跳重启才生效。
// 这里只负责持久化 + 内存更新，不重启 server。
export function updateListenPort(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error('端口必须是 1024..65535 的整数');
  }
  proxy.listenPort = n;
  // persist() 会把 proxy.listenPort 写进 config.json
  persist();
  return getListen();
}

// ── 给前端的配置视图 ───────────────────────────────────────
// 时间用秒展示；token 掩码（但返回 tokenPlain 供前端编辑框，前端不公开展示）
export function getView() {
  const env = getEnv();
  return {
    proxy: {
      maxAttempts: proxy.maxAttempts,
      backoffSec: proxy.backoffSec,
      backoffMaxSec: proxy.backoffMaxSec,
      passthrough: proxy.passthrough,
      retryOnStatus: proxy.retryOnStatus,
      retryOnBodyErrorCode: proxy.retryOnBodyErrorCode,
    },
    upstream: {
      baseUrl: env.upstreamBase ?? '',
      model: env.model ?? '',
      smallFastModel: env.smallFastModel ?? '',
      timeoutSec: Math.round(env.upstreamTimeoutMs / 1000),
      tokenMasked: mask(env.token),
      // 不返回明文 token；前端 token 输入框留空表示不修改
    },
    // 监听信息只读展示（改了要重启）
    listen: { host: proxy.listenHost, port: proxy.listenPort },
  };
}

// ── 热重载：更新重试参数 ────────────────────────────────────
const PROXY_UPDATABLE = [
  'maxAttempts',
  'backoffSec',
  'backoffMaxSec',
  'passthrough',
  'retryOnStatus',
  'retryOnBodyErrorCode',
];

export function updateProxy(partial) {
  const next = { ...proxy };
  for (const k of PROXY_UPDATABLE) {
    if (partial[k] === undefined) continue;
    const v = partial[k];
    if (k === 'passthrough') {
      next[k] = !!v; // 强制布尔
    } else if (k === 'retryOnStatus' || k === 'retryOnBodyErrorCode') {
      if (!Array.isArray(v)) throw new Error(`${k} 必须是数字数组`);
      next[k] = v.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} 必须是数字`);
      if (n < 0) throw new Error(`${k} 必须 >= 0`);
      next[k] = k === 'maxAttempts' ? Math.floor(n) : n;
    }
  }
  if (next.maxAttempts < 1 || next.maxAttempts > 1000) throw new Error('最大重试次数必须在 1..1000');
  if (next.backoffSec < 0) throw new Error('退避起始值必须 >= 0');
  if (next.backoffMaxSec < next.backoffSec) throw new Error('最终退避上限必须 >= 退避起始值');

  const prevPassthrough = proxy.passthrough;
  proxy = next;
  persist();
  // 透传模式切换要专门记日志（诊断关键事件）
  if (next.passthrough !== prevPassthrough) {
    concise(`MODE changed → passthrough=${next.passthrough ? 'ON (透传：不重试，原样转发)' : 'OFF (拦截重试)'}`);
  }
  return getProxy();
}

// ── 热重载：更新上游配置 ────────────────────────────────────
export function updateUpstream(partial) {
  const env = { ...(config.env ?? {}) };
  if (partial.baseUrl !== undefined) {
    if (!partial.baseUrl) throw new Error('Base URL 不能为空');
    try { new URL(partial.baseUrl); } catch { throw new Error('Base URL 格式错误'); }
    env.ANTHROPIC_BASE_URL = partial.baseUrl;
  }
  if (partial.token !== undefined && partial.token !== '') {
    // 空字符串视为"不改"（前端没改 token 时传空或掩码值）
    env.ANTHROPIC_AUTH_TOKEN = partial.token;
  }
  if (partial.model !== undefined) env.ANTHROPIC_MODEL = partial.model || undefined;
  if (partial.smallFastModel !== undefined) env.ANTHROPIC_SMALL_FAST_MODEL = partial.smallFastModel || undefined;
  if (partial.timeoutSec !== undefined) {
    const n = Number(partial.timeoutSec);
    if (!Number.isFinite(n) || n <= 0) throw new Error('上游超时必须 > 0 秒');
    env.API_TIMEOUT_MS = String(Math.round(n * 1000));
  }
  config.env = env;
  persist();
  return getView().upstream;
}

// ── 持久化写回 config.json ──────────────────────────────────
// proxy 段用秒字段存（不再写 backoffMs）；env 段原样写
function persist() {
  config.proxy = {
    listenHost: proxy.listenHost,
    listenPort: proxy.listenPort,
    maxAttempts: proxy.maxAttempts,
    backoffSec: proxy.backoffSec,
    backoffMaxSec: proxy.backoffMaxSec,
    passthrough: proxy.passthrough,
    retryOnStatus: proxy.retryOnStatus,
    retryOnBodyErrorCode: proxy.retryOnBodyErrorCode,
  };
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error(`[config-store] persist failed (runtime still updated): ${e.message}`);
  }
}

function mask(v) {
  const s = String(v ?? '');
  if (s.length <= 12) return '***';
  return s.slice(0, 6) + `…(${s.length} chars)…` + s.slice(-4);
}
