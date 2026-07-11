// trace-store.js — 结构化 trace 的 JSONL 存储（写时分流版）
//
// 写时分流：每条 trace 落两个文件，解决"list 列表为了取摘要却 parse 了 88% 的胖字节"问题。
//   - .idx.jsonl  瘦摘要（列表展示需要的全部字段）+ bodyOffset/bodyLen 指针。每条几百字节。
//   - .body.jsonl 完整 trace（含 attempts 完整上游请求/响应 body）。每条可达数 MB，仍按 200MB 滚动。
// 同一天同一序号的三件套：traces-<date>.<NNN>.idx.jsonl / traces-<date>.<NNN>.body.jsonl
//   - 序号补零让字典序 = 写入顺序；两文件共用序号，配对读写
//   - 一天内任一胖体文件写满 200MB 滚到下一个序号；跨天序号重置回 001
//
// 读时分治：
//   - list()    只扫 .idx.jsonl（小），边读边收 top-N，完全不碰 body 文件
//   - getById() 用 idx 里的 bodyOffset/bodyLen 精确 read body 那一条，单次 parse，不读全文件
//
// 旧数据兼容：升级前已存在的裸 .jsonl（无配对 idx）走降级路径——list 时回退到"整文件读+parse+取摘要"，
// 并在首次扫到时后台异步补建 idx，下次就走快路。详情读沿用旧的全扫 getById 兜底。
//
// 保留：7 天，启动时 + 写入时清理过期文件（按天整组删三件套 + 旧裸文件）。
// 与 logger.js 的 logs/trace-<date>.log（文本）并存，互不干扰。

import { appendFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = join(__dirname, 'logs'); // 兜底默认；扩展 activate 会注入 globalStorage/logs 覆盖
let LOG_DIR = DEFAULT_LOG_DIR;
mkdirSync(LOG_DIR, { recursive: true });

// logs-config.json 的路径：扩展 activate 时通过 setLogsConfigPath 注入（globalStorage/logs-config.json）。
// 存 { logsDir: "..." }：用户配置的日志目录。空/不存在 = 用默认（globalStorage/logs）。
let LOGS_CONFIG_PATH = null;
let LOGS_CONFIG = null; // 缓存 { logsDir }

// 扩展注入存储目录后调用
export function setLogDir(dir) {
  LOG_DIR = dir;
  mkdirSync(LOG_DIR, { recursive: true });
}

// 暴露 LOG_DIR 给外部（server.js 的 /api/logs-dir / /api/open-logs 用）
export function getLogDir() {
  return LOG_DIR;
}

// 是否用户配置过自定义 logsDir（前端展示用）
export function isLogsDirConfigured() {
  return !!(LOGS_CONFIG && LOGS_CONFIG.logsDir);
}

// 扩展注入 logs-config.json 路径（globalStorage/logs-config.json），并按它初始化 LOG_DIR
export function setLogsConfigPath(p) {
  LOGS_CONFIG_PATH = p;
  reloadLogsConfig();
}

// 读 logs-config.json，初始化/刷新 LOG_DIR。失败不抛，回退默认。
function reloadLogsConfig() {
  if (!LOGS_CONFIG_PATH) return;
  try {
    const raw = readFileSync(LOGS_CONFIG_PATH, 'utf8');
    LOGS_CONFIG = JSON.parse(raw);
  } catch {
    LOGS_CONFIG = null;
  }
  const configured = LOGS_CONFIG?.logsDir;
  if (configured) {
    LOG_DIR = configured;
    mkdirSync(LOG_DIR, { recursive: true });
  }
  // 没配置就保持 LOG_DIR 现状（扩展 activate 已设成默认 globalStorage/logs）
}

// 改 logsDir：写回 logs-config.json + 改运行时 LOG_DIR + mkdir。失败抛错。
// 传空字符串/undefined = 恢复默认（清掉配置文件，LOG_DIR 回到默认值）。
export function setLogsDir(dir) {
  // 恢复默认：清配置文件，LOG_DIR 回到初始默认（扩展注入的 globalStorage/logs）
  if (!dir || typeof dir !== 'string' || !dir.trim()) {
    LOGS_CONFIG = null;
    if (LOGS_CONFIG_PATH) {
      try { writeFileSync(LOGS_CONFIG_PATH, JSON.stringify({ logsDir: '' }, null, 2) + '\n', 'utf8'); }
      catch (e) { console.error(`[trace-store] clear logsDir config failed: ${e.message}`); }
    }
    // 回到默认：用 __dirname/logs 兜底（扩展 activate 会注入 globalStorage/logs，但运行中改默认时无法再问扩展）
    LOG_DIR = DEFAULT_LOG_DIR;
    mkdirSync(LOG_DIR, { recursive: true });
    return LOG_DIR;
  }
  // 先 mkdir 验证路径可写，失败就抛，不改配置也不改运行时
  mkdirSync(dir, { recursive: true });
  LOG_DIR = dir;
  // 即使没有 logsConfigPath（CLI 模式）也要设内存标志，让 isLogsDirConfigured 正确反映"已配置"
  LOGS_CONFIG = { logsDir: dir };
  if (LOGS_CONFIG_PATH) {
    try {
      writeFileSync(LOGS_CONFIG_PATH, JSON.stringify(LOGS_CONFIG, null, 2) + '\n', 'utf8');
    } catch (e) {
      // 写配置失败只记 stderr，运行时已改，下次重启会回退（可接受，不阻塞改目录）
      console.error(`[trace-store] persist logsDir failed: ${e.message}`);
    }
  }
  return LOG_DIR;
}

const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARD_MAX_BYTES = 200 * 1024 * 1024; // 单胖体分片 200MB 上限，满了滚动到下一个序号

// 把 Date/时间戳转成 YYYY-MM-DD（中国时间 UTC+8，文件名按中国日期分组，不依赖系统时区）
function dateStr(d) {
  const t = (d instanceof Date ? d.getTime() : new Date(d).getTime()) + 8 * 3600 * 1000;
  const x = new Date(t);
  return x.toISOString().slice(0, 10);
}

// 某天某序号的三件套路径
function shardPath(dayStr, seq, kind) {
  // kind: 'body' → traces-<date>.<NNN>.body.jsonl
  //       'idx'  → traces-<date>.<NNN>.idx.jsonl
  // 兼容旧裸文件：kind='legacy' → traces-<date>.<NNN>.jsonl
  if (kind === 'legacy') return join(LOG_DIR, `traces-${dayStr}.${String(seq).padStart(3, '0')}.jsonl`);
  return join(LOG_DIR, `traces-${dayStr}.${String(seq).padStart(3, '0')}.${kind}.jsonl`);
}

// 找某天当前应该写入的分片序号：胖体文件不存在或未满 → 用它；满了滚到下一个。
// 注：滚动只看 body 文件大小（idx 远小于 body，跟着 body 走即可，两文件同序号配对）。
function currentSeq(dayStr) {
  let seq = 1;
  while (true) {
    const p = shardPath(dayStr, seq, 'body');
    if (!existsSync(p)) return seq;
    try {
      if (statSync(p).size < SHARD_MAX_BYTES) return seq;
    } catch {
      return seq; // stat 失败就当它可写
    }
    seq++;
  }
}

// 清理 7 天前的 traces 分片（按天整组删：body / idx / 旧裸文件）
export function cleanupOld() {
  let files = [];
  try {
    files = readdirSync(LOG_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  for (const f of files) {
    // traces-YYYY-MM-DD.NNN[.body|.idx].jsonl  或  traces-YYYY-MM-DD.NNN.jsonl（旧）
    const m = f.match(/^traces-(\d{4}-\d{2}-\d{2})\.\d{3}(?:\.(body|idx))?\.jsonl$/);
    if (!m) continue;
    const day = m[1];
    const t = new Date(day + 'T00:00:00').getTime();
    if (Number.isNaN(t)) continue;
    if (t < cutoff) {
      try {
        unlinkSync(join(LOG_DIR, f));
      } catch {}
    }
  }
}

// ── 写时分流 ──────────────────────────────────────────────
// 一条 trace 拆成两部分写：
//   1) 完整 trace JSON 一行 → body 文件（append 前记下当前文件 size 作为 bodyOffset）
//   2) 瘦摘要 + {bodyOffset, bodyLen, seq} → idx 文件
// body 只序列化一次（JSON.stringify(trace) 的结果字符串），idx 的摘要从同一对象抽，不重复 stringify 大字段。
export function append(trace) {
  const day = dateStr(new Date());
  let seq = currentSeq(day);
  try {
    const bodyFile = shardPath(day, seq, 'body');
    // 写前再确认一次大小，避免并发下超太多
    if (existsSync(bodyFile) && statSync(bodyFile).size >= SHARD_MAX_BYTES) {
      seq = currentSeq(day); // 重新取下一个序号
    }
    const idxFile = shardPath(day, seq, 'idx');
    const path = shardPath(day, seq, 'body');

    // 完整 trace 序列化一次
    const bodyLine = JSON.stringify(trace) + '\n';
    const bodyLen = Buffer.byteLength(bodyLine, 'utf8');
    // bodyOffset = body 文件当前大小（追加前的尾部位置）。appendFileSync 保证原子追加。
    let bodyOffset = 0;
    try { bodyOffset = statSync(path).size; } catch { bodyOffset = 0; }

    appendFileSync(path, bodyLine, 'utf8');
    // 摘要：列表展示需要的全部字段 + 定位指针
    const idxRow = summarize(trace, { bodyOffset, bodyLen, seq });
    appendFileSync(idxFile, JSON.stringify(idxRow) + '\n', 'utf8');
  } catch (e) {
    // 写失败只记 stderr，不影响代理转发
    console.error(`[trace-store] append failed: ${e.message}`);
  }
}

// 从一条完整 trace 抽出列表展示需要的瘦摘要。
// opts.bodyOffset/bodyLen/seq 是 body 文件里的定位指针，详情读用它精确取回原行。
function summarize(trace, { bodyOffset, bodyLen, seq }) {
  const r = trace ?? {};
  const attempts = r.attempts ?? [];
  return {
    id: r.id,
    sourceIp: r.sourceIp,
    method: r.method,
    path: r.path,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    totalMs: r.totalMs,
    finalStatus: r.finalStatus,
    outcome: r.outcome,
    // attempt 摘要：不含上游请求/响应 body（那是 74% 的大头）
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      status: a.status,
      networkError: a.networkError ?? null,
      elapsedMs: a.elapsedMs,
      verdict: a.verdict,
      reason: a.reason,
      backoffMs: a.backoffMs,
    })),
    lastErrorStatus: attempts.findLast?.((a) => a.status !== 200 && a.status !== 0)
      ? attempts.at(-1)?.status
      : (attempts.findLast ? attempts.findLast((a) => a.verdict === 'retryable')?.status ?? null : null),
    requestBodyPreview: preview(r.requestBody),
    responseBodyPreview: preview(r.responseBody),
    // 详情定位指针
    seq,
    bodyOffset,
    bodyLen,
  };
}

// ── 四档过滤判定 ──────────────────────────────────────────
// mode 取值：
//   'all'        - 不过滤
//   'retried'    - 代理重试过（attempts.length > 1）
//   'failed'     - 代理认栽（outcome === 'failed'，仅 10310 重试耗尽返回 503）
//                  注意：网络错误现在不重试、透传给 CC（outcome='passed-to-client'），
//                  不归入此档——它属于"交出去"而非"代理认栽"。要看网络错误用 'llm-error' 档。
//   'llm-error'  - LLM 返回过非成功（attempts 里存在非 2xx 或网络错误 status=0）
// 旧参数 onlyRetries 仍兼容（= 'retried'）
function matchesMode(r, mode) {
  const attempts = r.attempts ?? [];
  switch (mode) {
    case 'retried':
      return attempts.length > 1;
    case 'failed':
      return r.outcome === 'failed';
    case 'llm-error':
      return attempts.some((a) => a.status < 200 || a.status >= 300 || a.status === 0);
    case 'all':
    default:
      return true;
  }
}

// 流式读单个 idx 或 body 分片文件全部行。空/坏行跳过，不抛。
// 用于 idx（小，快）和详情兜底读裸 body（大，慢，仅旧数据降级时）。
function readJsonlLines(path) {
  return new Promise((resolve) => {
    const out = [];
    if (!existsSync(path)) return resolve(out);
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 跳过坏行 */
      }
    });
    rl.on('close', () => resolve(out));
    rl.on('error', () => resolve(out));
  });
}

// 流式读无 idx 的源文件（旧裸 .jsonl 或丢了 idx 的 body），边读边算字节偏移，
// 给每条抽出摘要并写出 idx 文件。本次 list 拿到摘要用，idx 落盘后下次就走快路。
// 写 idx 用临时文件 + renameSync 原子替换，避免并发读到半截 idx。
// kind: 'legacy' → 详情读走旧裸文件路径；'body' → 详情读走 body 文件路径。
function readLegacyAndBuildIdx(dayStr, seq, kind) {
  return new Promise((resolve) => {
    const srcPath = shardPath(dayStr, seq, kind);
    const idxPath = shardPath(dayStr, seq, 'idx');
    if (!existsSync(srcPath)) return resolve([]);

    const out = [];
    const tmpIdx = idxPath + '.tmp';
    let fd = null;
    try { fd = openSync(tmpIdx, 'w'); } catch { fd = null; } // 写不了 idx 就只读不补建

    let offset = 0; // 源文件里当前行的字节起始
    const rl = createInterface({ input: createReadStream(srcPath, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 换行
      const trimmed = line.trim();
      if (!trimmed) { offset += lineBytes; return; }
      let full = null;
      try { full = JSON.parse(trimmed); } catch { offset += lineBytes; return; }
      const bodyLen = Buffer.byteLength(trimmed, 'utf8'); // 不含换行，精确读用
      const row = summarize(full, { bodyOffset: offset, bodyLen, seq });
      row._legacyFile = kind === 'legacy'; // 详情读据此选 legacy/body 文件路径
      out.push({ ...row, _day: dayStr, _seq: seq });
      if (fd !== null) {
        try { appendFileSync(fd, JSON.stringify(row) + '\n', 'utf8'); } catch {}
      }
      offset += lineBytes;
    });
    rl.on('close', () => {
      if (fd !== null) { try { closeSync(fd); } catch {} }
      if (out.length > 0) {
        try { renameSync(tmpIdx, idxPath); } catch {} // 原子替换：读端看不到半截 idx
      } else {
        try { unlinkSync(tmpIdx); } catch {}
      }
      resolve(out);
    });
    rl.on('error', () => {
      if (fd !== null) { try { closeSync(fd); } catch {} }
      try { unlinkSync(tmpIdx); } catch {}
      resolve(out);
    });
  });
}

// 读某天所有 idx 分片（按序号顺序）的摘要行。
// idx 在 → 直接读（快）；idx 不在但有 body/旧裸文件 → 边读边补建 idx（首次慢，之后快）。
async function readDayIdx(dayStr) {
  const all = [];
  let seq = 1;
  while (true) {
    const idxPath = shardPath(dayStr, seq, 'idx');
    const bodyPath = shardPath(dayStr, seq, 'body');
    const legacyPath = shardPath(dayStr, seq, 'legacy');
    if (existsSync(idxPath)) {
      const rows = await readJsonlLines(idxPath);
      for (const r of rows) all.push({ ...r, _day: dayStr, _seq: seq });
    } else if (existsSync(bodyPath)) {
      // 新版 body 但 idx 丢了：从 body 抽摘要补建 idx（body 行是完整 trace）
      const rows = await readLegacyAndBuildIdx(dayStr, seq, 'body');
      for (const r of rows) all.push(r);
    } else if (existsSync(legacyPath)) {
      // 旧版裸文件：边读边补建 idx
      const rows = await readLegacyAndBuildIdx(dayStr, seq, 'legacy');
      for (const r of rows) all.push(r);
    } else {
      break;
    }
    seq++;
    if (seq > 9999) break; // 防御
  }
  return all;
}

// 查询列表
//   since       - ISO 字符串或时间戳，只返回 startedAt > since 的（增量轮询用）
//   mode        - 'all' | 'retried' | 'failed' | 'llm-error'（默认 'all'）
//   onlyRetries - 旧参数，true 等价于 mode='retried'（向后兼容）
//   limit       - 默认 200
// 返回按 startedAt 降序
export async function list({ since, mode = 'all', onlyRetries = false, limit = 200 } = {}) {
  cleanupOld();
  const effectiveMode = onlyRetries ? 'retried' : mode;
  const sinceTs = since ? new Date(since).getTime() : 0;

  // 扫最近 7 天的 idx（从今天往前）
  const days = [];
  const now = new Date();
  for (let i = 0; i < RETENTION_DAYS; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    days.push(dateStr(d));
  }

  let all = [];
  for (const day of days) {
    const rows = await readDayIdx(day);
    for (const r of rows) {
      if (sinceTs) {
        const t = new Date(r.startedAt).getTime();
        if (t <= sinceTs) continue;
      }
      if (!matchesMode(r, effectiveMode)) continue;
      all.push(r);
    }
  }

  // 降序 + 截断
  all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  if (all.length > limit) all = all.slice(0, limit);

  // 列表接口不返回完整 body（太大），只给预览；attempts 给摘要数组（不含 body）。
  // 去掉内部字段，保留 bodyOffset/bodyLen/seq 供详情读定位，保留 _legacyFile 让详情读选对源文件。
  return all.map((r) => {
    const out = { ...r };
    delete out._day;
    delete out._seq;
    return out;
  });
}

// 按时间窗口统计「成功执行」的命令数量。
//
// 入参 windows: 小时数数组，如 [1, 5, 24] = 最近1小时/5小时/1天。前端可自定义。
// 对每个窗口 w：统计 startedAt 落在 [now - w*3600s, now] 区间、且最终交付成功（finalStatus 为 2xx）的 trace 数。
// 只扫 idx 摘要（小、快），不碰 body。用 startedAt（请求发出时刻）做时间锚点，符合「按时间统计最近N小时执行成功的命令」。
//
// 返回：
//   {
//     now: <ISO>,                      // 统计基准时刻（中国时间显示用，前端已统一 UTC+8）
//     windows: [
//       { hours: 1,  success: 12, total: 15, fromTs: <ms> },
//       { hours: 5,  success: 40, total: 50, fromTs: <ms> },
//       { hours: 24, success: 99, total: 120, fromTs: <ms> },
//     ]
//   }
//   - success: 该窗口内 finalStatus ∈ [200,300) 的 trace 数
//   - total:   该窗口内全部 trace 数（含失败/透传）
//   - fromTs:  窗口起始时间戳（ms），前端可显示「自 xx:xx 起」
// 成功判定：finalStatus 2xx。透传模式下 outcome='passthrough' 但 finalStatus 2xx 也算成功
// （因为最终给 CC 的是 2xx，命令确实成功执行）。网络错误 finalStatus=0 不算。
export async function stats({ windows = [1, 5, 24] } = {}) {
  cleanupOld();
  const nowMs = Date.now();
  // 窗口值防御性夹取：超过 trace 保留期（7天=168h）的窗口无意义（数据已删），且会撑爆 days 扫描循环。
  const MAX_HOURS = RETENTION_DAYS * 24;
  const seen = new Set();
  const ws = windows
    .filter((h) => Number.isFinite(h) && h > 0)
    .map((h) => Math.min(h, MAX_HOURS))
    .filter((h) => { // 去重（0.001h≈3.6s 容差），避免 ?windows=1,1 渲染两个重复卡片
      const key = Math.round(h * 1000);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!ws.length) return { now: new Date(nowMs).toISOString(), windows: [] };
  // 求最大窗口，决定要扫多少天：向上取整天数 +1 天余量，覆盖跨天边界
  const maxHours = Math.max(1, ...ws);
  const maxDaySpan = Math.min(Math.ceil(maxHours / 24) + 1, RETENTION_DAYS); // 扫不出保留期之外

  // 收集每个窗口的计数桶
  const buckets = ws.map((h) => ({ hours: h, fromTs: nowMs - h * 3600 * 1000, success: 0, total: 0 }));

  // 扫最近 maxDaySpan 天的 idx
  const days = [];
  for (let i = 0; i < maxDaySpan; i++) {
    const d = new Date(nowMs - i * DAY_MS);
    days.push(dateStr(d));
  }

  for (const day of days) {
    const rows = await readDayIdx(day);
    for (const r of rows) {
      const t = new Date(r.startedAt).getTime();
      if (!Number.isFinite(t)) continue;
      for (const b of buckets) {
        if (t >= b.fromTs && t <= nowMs) {
          b.total++;
          const s = r.finalStatus;
          if (Number.isFinite(s) && s >= 200 && s < 300) b.success++;
        }
      }
    }
  }

  // 按 hours 升序输出，便于前端按时间窗从小到大排列
  buckets.sort((a, b) => a.hours - b.hours);
  return {
    now: new Date(nowMs).toISOString(),
    windows: buckets.map((b) => ({ hours: b.hours, success: b.success, total: b.total, fromTs: b.fromTs })),
  };
}

function preview(s) {
  if (!s) return '';
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// 查单条（全量）。优先用 idx 里的 offset 精确读 body；找不到 idx 走旧全扫兜底。
// 传入可选的 idx 摘要行（列表已返回 bodyOffset/bodyLen/seq），命中则省一次 idx 扫描。
export async function getById(id, hint) {
  cleanupOld();
  const now = new Date();

  // 1) 若调用方带了定位 hint（列表行自带 bodyOffset/bodyLen/seq/day），直接精确读
  if (hint && hint.bodyOffset != null && hint.bodyLen != null && hint.seq && hint.day) {
    const kind = hint._legacyFile ? 'legacy' : 'body';
    const full = readBodyRange(hint.day, hint.seq, hint.bodyOffset, hint.bodyLen, kind);
    if (full && full.id === id) return full;
    // 不命中（id 对不上或读失败）→ 落到通用扫描
  }

  // 2) 通用：扫 7 天 idx 找 id，拿到定位后精确读 body
  for (let i = 0; i < RETENTION_DAYS; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const day = dateStr(d);
    const rows = await readDayIdx(day);
    const row = rows.find((x) => x.id === id);
    if (row) {
      // 有定位指针 → 精确读（旧数据 _legacyFile=true 走 legacy 路径，否则 body）
      if (row.bodyOffset != null && row.bodyLen != null && row.seq) {
        const kind = row._legacyFile ? 'legacy' : 'body';
        const full = readBodyRange(day, row.seq, row.bodyOffset, row.bodyLen, kind);
        if (full && full.id === id) return full;
      }
      // 无指针（不该出现，readLegacyAndBuildIdx 总会写指针）：落到裸文件全扫兜底
      const kind = row._legacyFile ? 'legacy' : 'body';
      const records = await readJsonlLines(shardPath(day, row._seq, kind));
      const r = records.find((x) => x.id === id);
      if (r) return r;
    }
  }
  return null;
}

// 按 offset+len 精确读源文件里的一条。同步：详情读就一条，不值得异步包装。
// kind: 'body'（新版胖体文件）或 'legacy'（旧裸 .jsonl）。open fd → read(buf,0,len,offset) → 关 fd → parse。
function readBodyRange(dayStr, seq, offset, len, kind = 'body') {
  if (!len || len <= 0) return null;
  const path = shardPath(dayStr, seq, kind);
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, offset);
    if (bytesRead !== len) {
      // 读不满（文件被截断/并发滚动？）—— 兜底返回 null，调用方落全扫
      return null;
    }
    const s = buf.toString('utf8').trim();
    if (!s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
  }
}
