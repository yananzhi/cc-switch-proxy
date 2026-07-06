// mock/mock-server.js — 模拟真实上游的各种故障，用来确定性测试代理的重试逻辑
//
// 真实讯飞上游观察到的故障形态（这就是"表面只看到 503，实际协议里出的问题"）：
//   1. HTTP 503 + body {"error":{"code":10310,"message":"The system is busy..."}}   标准瞬时错误
//   2. HTTP 200 + 同样的 error body                                                   ← 假成功，最坑
//   3. HTTP 404 + {"message":"no any schema route found"}                             路由抖动
//   4. HTTP 400 + invalid_request_error                                               不可重试
//   5. 接受连接但永不响应                                                              超时
//   6. 流式 200 发一半中断                                                            中途断流
//   7. 成功（非流式 JSON / 流式 SSE）
//
// 用法：
//   MOCK_SEQUENCE="503,200-busy,503,success" node mock/mock-server.js
//   每来一个请求消费序列里下一个模式；序列耗尽后重复最后一个模式。
//   也可运行时通过控制端点改序列：
//     curl -X POST http://127.0.0.1:8787/__mock/control -d '{"sequence":["503","success"]}'
//     curl http://127.0.0.1:8787/__mock/status

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 8787;

let sequence = (process.env.MOCK_SEQUENCE || 'success')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
let cursor = 0;
let reqCount = 0;

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}] [mock]`, ...a);

function nextMode() {
  const mode =
    cursor < sequence.length
      ? sequence[cursor]
      : sequence.length
        ? sequence[sequence.length - 1]
        : 'success';
  cursor++;
  return mode;
}

// ── 响应生成器 ──────────────────────────────────────────────
function errMsgBusy(count) {
  return JSON.stringify({
    error: {
      code: 10310,
      message: 'The system is busy, please try again later.',
      type: 'api_error',
    },
    id: `cht_mock_${count}`,
    type: 'error',
  });
}

function successJson(count, model) {
  return JSON.stringify({
    id: `msg_mock_${count}`,
    type: 'message',
    role: 'assistant',
    model: model || 'mock-model',
    content: [{ type: 'text', text: 'Hello from mock LLM.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function sendSSE(res, count, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg_mock_${count}`,
      type: 'message',
      role: 'assistant',
      model: model || 'mock-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' from mock.' },
  });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

// ── 主服务 ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // 健康检查
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: true, ts: ts() }));
    return;
  }

  // 控制端点：查看状态
  if (req.method === 'GET' && req.url === '/__mock/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cursor, sequence, reqCount }));
    return;
  }

  // 控制端点：重设序列
  if (req.method === 'POST' && req.url === '/__mock/control') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (Array.isArray(body.sequence)) {
        sequence = body.sequence
          .map((s) => String(s).trim().toLowerCase())
          .filter(Boolean);
        cursor = 0;
        log(`sequence reset → ${JSON.stringify(sequence)}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cursor, sequence }));
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'sequence must be an array' }));
      }
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 读取请求 body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);
  let parsed = null;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    /* 非 JSON 也能测 */
  }
  const wantStream = parsed?.stream === true;
  const model = parsed?.model || 'mock-model';

  reqCount++;
  const mode = nextMode();
  log(
    `req #${reqCount} ${req.method} ${req.url} mode=${mode} stream=${wantStream} (cursor now ${cursor})`,
  );

  switch (mode) {
    case 'success':
      if (wantStream) sendSSE(res, reqCount, model);
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(successJson(reqCount, model));
      }
      return;

    case '503':
      // 标准瞬时错误：HTTP 503 + code 10310 system busy（Claude Code 处理不了，代理应重试）
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(errMsgBusy(reqCount));
      return;

    case '503-other':
      // 503 但 body 是别的错误码（非 10310）——模拟 Claude Code 能自己处理的 503，代理应透传不重试
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 50399, message: 'other 503 (non-10310, Claude Code can handle)', type: 'api_error' },
        id: `cht_mock_${reqCount}`, type: 'error',
      }));
      return;

    case '200-busy':
      // 最坑的形态：HTTP 200，但 body 是错误结构（讯飞真实出现过）
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(errMsgBusy(reqCount));
      return;

    case '404':
      // 路由抖动：不可重试
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          message: 'no any schema route found',
          sid: `ase_mock_${reqCount}`,
        }),
      );
      return;

    case '400':
      // 参数错误：不可重试
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'mock: bad request' },
        }),
      );
      return;

    case '429':
    case '500':
    case '502':
    case '504':
      // 这些状态码 Claude Code 自己能处理（限流/服务端错误），代理应透传不重试。
      // body 是普通错误结构，不含 code 10310——区别于 503+10310。
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `mock: ${mode} (non-10310, Claude Code can handle)` },
          id: `cht_mock_${reqCount}`,
        }),
      );
      return;

    case 'timeout':
      // 接受连接但永不响应；代理的上游超时会触发
      log(`  (hanging on req #${reqCount} to simulate timeout)`);
      // 故意什么都不做，保持 socket 打开
      return;

    case 'drop':
      // 流式 200，发几个 chunk 后强制断开，模拟中途断流
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: `msg_mock_${reqCount}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial...' },
        })}\n\n`,
      );
      log(`  (dropping connection on req #${reqCount} mid-stream)`);
      setTimeout(() => {
        try {
          res.destroy();
        } catch {}
      }, 50);
      return;

    default:
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown mock mode: ${mode}` }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`initial sequence: ${JSON.stringify(sequence)}`);
  log(`modes: success | 503 | 503-other | 200-busy | 404 | 400 | 429 | 500 | 502 | 504 | timeout | drop`);
});

server.on('error', (e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
