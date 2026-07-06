# Claude Code Switch + LLM Proxy

一个 VS Code 扩展，合两件事于一身：

1. **管理 + 切换 Claude Code 配置**（原名 cc-switch）：保存多条命名的 LLM 配置（每条是完整 `settings.json` 内容），点一下就切换；支持导入/导出。
2. **本地 LLM 代理**（原 llmAutoRetry）：每条配置可选"直连"或"通过代理连接"。代理自动重试 Claude Code 处理不了的瞬时错误（如讯飞 503 system busy，code 10310），并提供 Web 控制台看重试参数 + trace 记录。

## 每条配置的连接模式

- **直连**（默认）：激活时把配置内容直接写 `~/.claude/settings.json`，Claude Code 直连上游。
- **通过代理连接**：激活时代理用此配置的上游（token/baseUrl/model），`settings.json` 改写成指向本地代理（`http://127.0.0.1:<port>`）。Claude Code 走代理，代理重试 503 等错误。

默认所有配置都是直连——不想要代理就完全不参与，跟原 cc-switch 一样。

## 代理工作机制

- **进程内常驻**：代理跑在 VS Code 扩展宿主进程里，跟着 VS Code 生命周期。
- **单例**：开多个 VS Code 窗口只有一个实际跑代理（靠端口 bind），其他窗口只心跳监听。
- **2s 心跳接管**：宿主窗口关了导致代理停，其他窗口 2s 内接管拉起。
- **精确重试**：代理只重试 Claude Code 处理不了的——`HTTP 503` + body `error.code === 10310`（讯飞 system busy）。Claude Code 不识别这个业务码、只会当普通 5xx 盲目重试 10 次，代理的针对重试（20 次 + 16s 上限）更有效。其余全部透传交给 Claude Code 自己处理：429/500/502/504（CC 当 5xx 重试）、网络错误/超时/断连/流中断（CC 当 APIConnectionError 重试，代理合成 502 回客户端）。可在控制台调 `retryOnStatus`/`retryOnBodyErrorCode`。
- **跨平台**：`extensionKind: workspace`，WSL 里代理和 Claude Code 同 localhost。

### 端口（按平台分默认）

代理监听端口按平台给默认值，避免 Windows + WSL 同机装时抢同一个 localhost 端口（WSL2 经 localhost 转发互通，同端口会串味）：

| 平台 | 默认端口 |
|---|---|
| Windows (`win32`) | `11434` |
| 原生 Linux / WSL (`linux`) | `11435` |
| macOS (`darwin`) | `11436` |

端口可在 Web 控制台改（写 config + 关监听，宿主心跳 2s 内自动重起生效）。范围 `1024..65535`。

### Trace 存储

- **写时分流**：每条 trace 落两个 JSONL——`.idx.jsonl`（瘦摘要 + body 定位指针，几百字节）和 `.body.jsonl`（完整 trace，含每次 attempt 的上游请求/响应 body）。列表只扫 idx 秒开，详情按 offset 精确读单条 body。
- **200MB 分片**：胖体文件写满 200MB 滚到下一个序号，跨天序号重置。文件名按中国时间（UTC+8）分组，不依赖系统时区。
- **四档过滤**：`all`（全部）/ `retried`（代理重试过）/ `failed`（代理认栽，仅 10310 重试耗尽返回 503）/ `llm-error`（LLM 返回过非成功或网络错误）。
- **7 天保留**：启动时 + 写入时清理过期文件，按天整组删。
- **日志目录可配**：控制台可改 trace/日志目录，立即生效（历史留在原地不迁移）；也可一键在系统文件管理器里打开。

## 用法

1. 点活动栏的 **Claude Code Switch** 图标。
2. **+ New LLM Config**，填名字 + settings.json 内容，选"直连"或"通过代理连接"，保存。
3. 点列表里的配置激活（行内切换图标）。代理模式的配置图标是云朵，直连是圆点。
4. 命令面板 `LLM 代理: 打开控制台`（或点状态栏云朵图标）打开 Web 控制台：看重试参数、上游配置、端口、trace 记录。

### 状态栏

- 左侧 `$(arrow-swap) CC: <名字> (代理|直连)`：当前激活的配置。
- 左侧 `$(cloud) 代理:本窗口运行|其他窗口运行|未运行`：代理宿主状态，点开控制台。

### 命令面板

| 命令 | 作用 |
|---|---|
| `LLM 代理: 打开控制台` | 打开 Web 控制台（重试参数 + Trace） |
| `LLM 代理: 重启代理` | 关闭监听，宿主心跳 2s 内自动重起 |
| `Export Configs` | 导出全部配置到 JSON 文件 |
| `Import Configs` | 从 JSON 文件导入配置（按 id 去重） |

## 配置

扩展配置存在 globalStorage；代理的上游由激活的"通过代理"配置注入，不需单独配。代理的重试参数/端口/日志目录都在 Web 控制台调，持久化到 globalStorage 下的 `proxy-config.json` / `logs-config.json`。

| Setting | Default | Description |
|---|---|---|
| `cc-switch.configFilePath` | `""` | 覆盖 Claude Code `settings.json` 路径，留空自动检测（全平台 `~/.claude/settings.json`，含 WSL）。 |

切换时会先备份原 `settings.json`，并在 toast 里提供 **Reload Window**（让 CC 重读配置）和 **Undo**（回滚到备份）。

## 开发

```bash
npm install
npm run compile        # 编译 TS
node mock/test.mjs     # 代理重试逻辑测试（断言）
node proxy/test/trace-store.test.mjs   # trace 存储写时分流测试
npx @vscode/vsce package  # 打包 .vsix
```

代理核心在 `proxy/`（ESM JS，零依赖），扩展宿主用动态 `import()` 加载（`import('../proxy/server.js')`，必须用相对路径而非 `file://` URL，详见 [docs/pitfall-esm-dynamic-import.md](docs/pitfall-esm-dynamic-import.md)）。TS 源在 `src/`，编译到 `out/`。
