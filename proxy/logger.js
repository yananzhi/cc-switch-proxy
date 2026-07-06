// logger.js — 双通道日志
//
// 1) concise(...)  → stdout，简明一行，便于实时扫
// 2) detail(...)   → logs/trace-YYYY-MM-DD.log，详细块，append-only，便于事后深挖
//
// 详细日志里会完整记录：客户端请求（方法/URL/全部头/完整 body）、
// 每次向上游转发（目标 URL/全部头/body）、上游响应（状态码/全部头/完整 body）、
// 判定结果与原因、退避时长、最终交付。敏感头（authorization / x-api-key 等）做掩码。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认日志目录（CLI 模式用工程下的 logs/）；扩展可通过 setLogDir 覆盖
let LOG_DIR = join(__dirname, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

// 扩展注入存储目录后调用
export function setLogDir(dir) {
  LOG_DIR = dir;
  mkdirSync(LOG_DIR, { recursive: true });
}

const SENSITIVE = new Set([
  'authorization',
  'x-api-key',
  'anthropic-auth-token',
  'cookie',
  'set-cookie',
]);

// 中国时间（UTC+8，无夏令时）。用纯数学偏移，不依赖系统时区设置。
// 返回 'YYYY-MM-DD HH:mm:ss.SSS +08:00'，给人看的日志用。
const cst = () => {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return shifted.toISOString().replace('T', ' ').replace('Z', ' +08:00');
};
// 中国时间的日期串 YYYY-MM-DD，用于按天分文件名
const cstDate = () => {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
};

const ts = cst;
const today = cstDate;

function detailPath() {
  return join(LOG_DIR, `trace-${today()}.log`);
}

// 把敏感头的值掩码：保留首尾各几个字符 + 总长度
export function maskValue(v) {
  const s = String(v ?? '');
  if (s.length <= 12) return '***';
  return s.slice(0, 6) + `…(${s.length} chars)…` + s.slice(-4);
}

// 返回头对象的副本，敏感头已掩码
export function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE.has(k.toLowerCase()) ? maskValue(v) : v;
  }
  return out;
}

// 把 body 格式化成可读字符串。JSON → 美化；文本/SSE → 原样；二进制 → 占位
export function formatBody(body, contentType = '') {
  if (!body) return '(empty)';
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length === 0) return '(empty)';
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(buf.toString('utf8')), null, 2);
    } catch {
      return buf.toString('utf8'); // 解析失败也给出原文
    }
  }
  if (ct.includes('text') || ct.includes('event-stream') || ct.includes('sse')) {
    return buf.toString('utf8');
  }
  return `(binary ${buf.length} bytes)`;
}

// 把头对象渲染成多行文本
export function renderHeaders(headers) {
  const masked = maskHeaders(headers);
  const lines = [];
  for (const [k, v] of Object.entries(masked)) {
    lines.push(`    ${k}: ${v}`);
  }
  return lines.join('\n');
}

// stdout：简明一行
export function concise(...a) {
  console.log(`[${ts()}]`, ...a);
}

// 文件：详细块
//   reqId  - 请求 ID，用于 grep 串联一次请求的全部事件
//   title  - 块标题（如 "REQUEST"、"attempt 2/5 → UPSTREAM"、"UPSTREAM RESPONSE"）
//   body   - 可选，已格式化的正文
export function detail(reqId, title, body) {
  const header = `\n========== #${reqId}  ${title}  ${ts()} ==========`;
  const text = body == null ? header : `${header}\n${body}`;
  try {
    appendFileSync(detailPath(), text + '\n', 'utf8');
  } catch (e) {
    concise(`(logger detail write failed: ${e.message})`);
  }
}
