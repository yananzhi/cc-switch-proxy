# Claude Code Proxy

一个 VS Code 扩展，合三件事于一身：

1. **管理 + 切换 Claude Code 配置**（原名 cc-switch，现 claude-code-proxy）：保存多条命名的 LLM 配置（每条是完整 `settings.json` 内容），点一下就切换；支持导入/导出。配置分两层——**global**（机器级，写 `~/.claude/settings.json`）和 **workspace-local**（workspace 级，只用于终端启动的隔离会话）。
2. **本地 LLM 代理**（原 llmAutoRetry）：每条配置可选"直连"或"通过代理连接"。代理自动重试 Claude Code 处理不了的瞬时错误（如讯飞 503 system busy，code 10310），并提供 Web 控制台看重试参数 + trace 记录。
3. **Workspace 隔离的 Claude CLI 会话**：一个按钮 / 快捷键在终端打开 Claude Code CLI，用 `CLAUDE_CONFIG_DIR` 指向 `{workspace}/.claude_proxy/`，让该 workspace 的 Claude 状态独立于全局 `~/.claude/`。会话用当前 workspace-local active 配置。

---

## 1. 配置：global 与 workspace-local

配置分两层，互不干扰：

| 层 | 存储 | 作用域 | switch 行为 |
|---|---|---|---|
| **global config** | `globalStorage/configs.json`（机器级） | 全局 `~/.claude/` | 写 `~/.claude/settings.json` + Reload Window |
| **workspace-local config** | `{workspace}/.claude_proxy/local-configs.json` | 仅该 workspace 的终端会话 | 纯标记，不写 settings、不 reload |

侧边栏树结构（可折叠分组）：

- `Detected` — 检测到的环境 + 全局 `settings.json` 路径
- `global_llm_config` — global 配置列表
- `workspace_local_llm_config` — 当前 workspace 的 local 配置列表（开 workspace 才显示）

### 每条配置的连接模式

- **直连**（默认）：直接用配置内容里的上游。
- **通过代理连接**：代理用此配置的上游（token/baseUrl/model），配置改写成指向本地代理（`http://127.0.0.1:<port>`）。Claude Code 走代理，代理重试 503 等错误。

### workspace-local 配置

> ⚠️ 仅对用本扩展启动按钮/快捷键打开的**终端 Claude Code CLI 会话**生效，写入 `{workspace}/.claude_proxy/settings.json`。**不影响插件内视图、不写全局 `~/.claude/settings.json`、不影响已打开的其他终端会话。** active 标记只决定下次终端启动用哪条配置，切换不触发 reload。

- 在 `workspace_local_llm_config` 分组上点 `$(add)` 新建（仅开 workspace 时可见）。
- 编辑器内有「从 global 导入」下拉：选一条 global 配置即把它的 name/content 填入，可再编辑。
- 行内支持 switch / edit / delete。
- proxy 模式的 local 配置在终端启动时同样走本地代理（注入上游 + 合成 localhost settings）。

### 从旧版 cc-switch 迁移

扩展改名 `cc-switch → claude-code-proxy` 后，VS Code 按 publisher.id 分配了新 globalStorage 目录。首次激活会自动检测旧 `zaczh.cc-switch` 命名空间下的 `configs.json` / `active.json` 并复制到新目录，无需手动操作。

---

## 2. 本地 LLM 代理

### 工作机制

- **进程内常驻**：代理跑在 VS Code 扩展宿主进程里，跟着 VS Code 生命周期。
- **单例**：开多个 VS Code 窗口只有一个实际跑代理（靠端口 bind），其他窗口只心跳监听。
- **2s 心跳接管**：宿主窗口关了导致代理停，其他窗口 2s 内接管拉起。
- **精确重试**：代理只重试 Claude Code 处理不了的——`HTTP 503` + body `error.code === 10310`（讯飞 system busy）。其余全部透传交给 Claude Code 自己处理：429/500/502/504（CC 当 5xx 重试）、网络错误/超时/断连/流中断（CC 当 APIConnectionError 重试，代理合成 502 回客户端）。可在控制台调 `retryOnStatus`/`retryOnBodyErrorCode`。
- **跨平台**：`extensionKind: workspace`，WSL 里代理和 Claude Code 同 localhost。

### 端口（按平台分默认）

| 平台 | 默认端口 |
|---|---|
| Windows (`win32`) | `11434` |
| 原生 Linux / WSL (`linux`) | `11435` |
| macOS (`darwin`) | `11436` |

端口可在 Web 控制台改（写 config + 关监听，宿主心跳 2s 内自动重起生效）。范围 `1024..65535`。

### Trace 存储

- **写时分流**：每条 trace 落两个 JSONL——`.idx.jsonl`（瘦摘要 + body 定位指针）和 `.body.jsonl`（完整 trace）。
- **200MB 分片**：胖体文件写满 200MB 滚到下一个序号，跨天序号重置。文件名按中国时间（UTC+8）分组。
- **四档过滤**：`all` / `retried` / `failed` / `llm-error`。
- **7 天保留**：启动时 + 写入时清理过期文件，按天整组删。
- **日志目录可配**：控制台可改 trace/日志目录，立即生效。

---

## 3. Workspace 隔离的 Claude CLI 会话

点侧边栏视图标题栏的 `$(terminal)` 图标，或按 `Ctrl+Shift+Alt+C`（mac `Cmd+Shift+Alt+C`），在终端打开一个 workspace 隔离的 Claude Code CLI：

- 自动定位官方 `anthropic.claude-code` 扩展的 `claude.exe`（Windows）/ `claude`（Linux/macOS）完整路径，不依赖 PATH。
- `CLAUDE_CONFIG_DIR` 环境变量指向 `{workspace}/.claude_proxy/`，该会话状态独立于全局。
- 用当前 workspace-local active 配置写 `.claude_proxy/settings.json`；无 local active 则不写，claude 用默认。
- 自动合并 `bypassPermissions` 到项目级 `.claude/settings.local.json`。
- 首次建 `.claude_proxy/` 时若 workspace 是 git 仓库，自动把 `.claude_proxy/` 加进 `.gitignore`（检测 `.git` 目录，不依赖 git 命令）。

**跨平台 shell**：Windows 强制 PowerShell（`& "完整路径"`）；Linux/macOS 用平台默认 bash。env 用 `createTerminal` 的 `env` 选项进程级注入，跨 shell 无需区分语法。

---

## 用法

1. 点活动栏的 **Claude Code Proxy** 图标。
2. **+ New LLM Config**（global 分组）或 workspace-local 分组的 `$(add)`，填名字 + settings.json 内容，选连接模式，保存。
3. 点配置行激活。global 激活会写全局 settings + Reload；local 激活只是标记。
4. 命令面板 `LLM 代理: 打开控制台`（或点状态栏云朵图标）打开 Web 控制台。
5. 点 `$(terminal)` 或快捷键在终端启动 workspace 隔离 Claude。

### 状态栏

- `$(arrow-swap) CC: <名字> (代理|直连)`：当前激活的 **global** 配置。
- `$(cloud) 代理:本窗口运行|其他窗口运行|未运行`：代理宿主状态。

### 命令面板

| 命令 | 作用 |
|---|---|
| `Launch Workspace-Isolated Claude` | 终端启动 workspace 隔离 Claude（`Ctrl+Shift+Alt+C`） |
| `LLM 代理: 打开控制台` | 打开 Web 控制台（重试参数 + Trace） |
| `LLM 代理: 重启代理` | 关闭监听，宿主心跳 2s 内自动重起 |
| `LLM 代理: 切换本窗口 backup proxy 开关` | 本窗口代理开关 |
| `Export Configs` / `Import Configs` | 导入/导出 **global** 配置 |

### Settings

| Setting | Default | Description |
|---|---|---|
| `claude-code-proxy.configFilePath` | `""` | 覆盖全局 Claude `settings.json` 路径，留空自动检测（全平台 `~/.claude/settings.json`，含 WSL）。 |
| `claude-code-proxy.claudeBinaryPath` | `""` | 覆盖终端启动用的 Claude CLI 二进制路径，留空自动从 `anthropic.claude-code` 扩展探测。 |

global 切换会先备份原 `settings.json`，toast 提供 **Reload Window** / **Undo**。

## 开发

```bash
npm install
npm run compile        # 编译 TS
node mock/test.mjs     # 代理重试逻辑测试（断言）
node proxy/test/trace-store.test.mjs   # trace 存储写时分流测试
npx @vscode/vsce package  # 打包 .vsix
```

代理核心在 `proxy/`（ESM JS，零依赖），扩展宿主用动态 `import()` 加载（详见 [docs/pitfall-esm-dynamic-import.md](docs/pitfall-esm-dynamic-import.md)）。TS 源在 `src/`，编译到 `out/`。
