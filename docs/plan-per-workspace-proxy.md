# Per-Workspace 独立代理实例 — 调研与实施计划

> 生成时间：2026-07-21
> 状态：Plan 已完成，待实施
> Plan 文件：`.claude_proxy/plans/eventual-sparking-pumpkin.md`
> 架构图：`docs/architecture-shared-backend.html`

---

## 一、问题背景

### 当前架构的隔离缺陷

当前 `claude-code-proxy` 扩展中，所有 VS Code 窗口共享同一个 Proxy Backend 进程（靠端口 bind 保证单例），Proxy 只有一个 Upstream 出口（last-write-wins）。"Workspace Local LLM Config" 隔离的只是配置文件目录（`CLAUDE_CONFIG_DIR`），**没有隔离运行时行为**。

### 两层隔离缺陷

**缺陷 #1：官方插件 UI 共享全局 settings.json**
- 官方 Claude Code 插件不支持 `CLAUDE_CONFIG_DIR` 环境变量
- 插件 UI 内部驱动的 CLI binary 始终读 `~/.claude/settings.json`
- proxy 扩展切换 Global Config = 改写 `~/.claude/settings.json` + Reload Window
- **所有窗口的官方插件 UI 同时受影响**，无法做到窗口 A 用配置 A、窗口 B 用配置 B

**缺陷 #2：Proxy Upstream 全局单例**
- `CLAUDE_CONFIG_DIR` 隔离了配置目录，但挡不到 Proxy 的运行时 Upstream
- Proxy 进程全局只有一个，Upstream 也只有一份，不在任何 `CLAUDE_CONFIG_DIR` 里
- `setUpstream()` 是 last-write-wins：谁最后调，Proxy 就指向谁的后端
- 不同 workspace 的 CLI 请求可能被转发到错误的 Upstream

### 为什么现在"能用"

当前 Global 和 Local 配置指向**同一个 Upstream 后端**（相同 baseUrl/token），只是 model ID 不同。所以 last-write-wins 只改变 model，不会让请求打到错误的后端。**这不是真正的隔离，是巧合。**

---

## 二、实体关系

### 完整架构中的实体

| 实体 | 说明 | 隔离状态 |
|------|------|----------|
| VS Code 窗口 | 每个窗口有自己的扩展宿主进程 | 进程级隔离 |
| Workspace | VS Code 打开的文件夹 | 文件系统级隔离 |
| 官方 Claude Code 插件 UI | 侧边栏/聊天面板，内部驱动 CLI binary | ❌ 共享 `~/.claude/settings.json` |
| claude-code-proxy 扩展 | Tree View + Launcher | 每窗口独立实例 |
| Local Config Store | `{workspace}/.claude_proxy/` 下的配置 | ✅ per-workspace |
| Claude Code CLI (Launcher 启动) | 终端进程，`CLAUDE_CONFIG_DIR=.claude_proxy/` | ✅ per-workspace 配置目录 |
| 官方插件内部 CLI | 无 `CLAUDE_CONFIG_DIR` | ❌ 读全局 settings.json |
| Proxy Backend 进程 | 全局单例，靠 EADDRINUSE | ❌ 全局共享 |
| Upstream (LLM 后端) | Proxy 转发目标 | ❌ 全局唯一 |

### 数据流

```
官方插件 UI → 内部 CLI → ~/.claude/settings.json → ANTHROPIC_BASE_URL → Proxy(全局) → Upstream(全局唯一)
Launcher CLI → .claude_proxy/settings.json → ANTHROPIC_BASE_URL → Proxy(全局) → Upstream(全局唯一)
                                                                                     ↑
                                                              setUpstream() last-write-wins
```

---

## 三、关键代码分析

### 3.1 proxy/server.js（ESM，~668 行）

**模块级单例**，无法在同一进程内运行多个实例：
- `runningServer`（line 610）：模块级变量，`/api/kill` 只能关闭一个 server
- `configStore.init(configPath)`（line 612）：模块级 `configPath`/`config`/`proxy`，多次调用会互相覆盖
- `traceStore`：同样是模块级单例

**`startServer({configPath, logsDir, logsConfigPath})`**（line 611-656）：
- 创建 `http.createServer(handleRequest)`
- 返回 `{ server, port, host, stop }`
- `listenPort` 为 0 时，resolve 返回的 `port` 仍是 0（bug，需修复为 `server.address().port`）

**HTTP 端点**：
- `GET /healthz` → `{ ok, upstream, ts }`
- `POST /api/upstream` → 热更新 upstream（last-write-wins 的根源）
- `POST /api/kill` → 关闭 `runningServer`
- `GET /api/config` / `POST /api/config` → 读写重试参数
- `GET /api/traces` / `GET /api/traces/:id` → 重试 trace
- `GET /` + `/assets/*` → Web 控制台静态文件

**CLI 模式**（line 658-667）：`isMainModule` 检查，直接 `startServer()` + 读环境变量 `CONFIG_PATH`

### 3.2 proxy/config-store.js（ESM，~225 行）

**模块级单例**：
```js
let configPath;  // init() 设置
let config;      // init() 从文件读取
let proxy;       // init() 从 config.proxy 解出
```
- `init(configPathArg)`：读文件、解析、设置模块级变量
- `persist()`：写回 `configPath` 指向的文件
- `getEnv()`：返回 upstream 信息（baseUrl/token/model）
- `updateUpstream(upstream)`：改写 `config.env` + `persist()`

**无法支持多实例**：所有函数操作模块级状态，两次 `init()` 会覆盖。

### 3.3 src/proxyHost.ts（~370 行）

**全局代理管理器**，每窗口一个实例：
- `tryBecomeHost()`：尝试 `startServer()`，EADDRINUSE 则当从机
- `heartbeatTick()`：2s 间隔，宿主自检 / 从机探测
- `setUpstream(env)`：POST `/api/upstream` 到全局代理
- `ensureRunning()`：确保代理在跑
- `getPort()`：从 `proxy-config.json` 读端口
- `setEnabled(on/off)`：控制本窗口是否持有代理进程
- `kill()`：POST `/api/kill`
- 状态栏：`$(cloud) 代理:本窗口运行/其他窗口运行/未运行/本窗口禁用`

**配置路径**：全部在 `globalStorage`（`proxy-config.json`、`logs/`、`logs-config.json`）

### 3.4 src/claudeLauncher.ts（~305 行）

**核心方法 `resolveSettingsContent(cfg)`**（line 75-126）：
1. direct 模式 → 原样返回 `cfg.content`
2. proxy 模式 → `proxyHost.ensureRunning()` + `proxyHost.setUpstream(env)` + `synthesizeProxySettings(content, port)`
3. **串味警告**（line 105-111）：明确标注全局代理上游是共享单例

**`launch()` 方法**（line 212-299）：
1. 获取 workspace、解析 binary 路径
2. 创建 `.claude_proxy/` 目录 + `.gitignore`
3. 读 `local-active.json` → 取 local config → `resolveSettingsContent()` → 写 `.claude_proxy/settings.json`
4. 创建终端，注入 `CLAUDE_CONFIG_DIR` + `CLAUDE_BIN`

### 3.5 src/extension.ts（~588 行）

**关键实例化**：
```typescript
proxyHost = new ProxyHost(context, output, proxyToggle);
const launcher = new ClaudeLauncher(
    () => localStore, () => localActiveState,
    proxyHost, output,
);
```

**`doSwitch(cfg)`**（line 116-185）：全局配置切换
- proxy 模式：`proxyHost.ensureRunning()` + `proxyHost.setUpstream()` + `synthesizeProxySettings()`
- 写 `~/.claude/settings.json` + backup + Reload Window

**`doLocalSwitch(cfg)`**（line 214-230）：workspace-local 配置切换
- **纯标记**：只写 `local-active.json`，不写 settings.json、不调 setUpstream、不 reload
- 实际代理注入推迟到 launcher 启动 launcher 启动时

### 3.6 src/upstream.ts（~26 行）

- `extractUpstream(content)`：解析 LLMConfig JSON，提取 `env` 对象
- `synthesizeProxySettings(content, port)`：把 `env.ANTHROPIC_BASE_URL` 改写成 `http://127.0.0.1:{port}`
- **port 参数已解耦**：不绑定全局代理端口，只需传入正确的 port

### 3.7 src/localConfigStore.ts

- `LocalConfigStore`：`{workspace}/.claude_proxy/local-configs.json`
- `LocalActiveStateStore`：`{workspace}/.claude_proxy/local-active.json`
- `WORKSPACE_CONFIG_DIR = '.claude_proxy'`（与 launcher 共享常量）

---

## 四、实施方案（方案 A）

### 核心决策

**保留全局代理不变，为 workspace-local proxy 配置启动独立的代理子进程。**

选择子进程方案的原因：
1. proxy/server.js、config-store.js、trace-store.js 都是模块级单例，同一进程内无法运行多个实例
2. 重构为 class/factory 工作量大、风险高（纯 ESM JS，无类型安全）
3. 子进程方案零改动 proxy 代码，每个子进程有自己的模块作用域

### 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `proxy/server.js` | 修改 | 添加 `--child` 子进程模式 + 修复 `listenPort:0` 端口报告 |
| `src/workspaceProxyHost.ts` | **新增** | Per-workspace 代理子进程管理器 |
| `src/claudeLauncher.ts` | 修改 | workspace-local proxy 走 WorkspaceProxyHost |
| `src/extension.ts` | 修改 | 创建 WorkspaceProxyHost、注册命令、状态栏 |
| `package.json` | 修改 | 注册新命令 + nodePath 设置 |

**不改动**：`proxy/config-store.js`、`proxy/trace-store.js`、`src/proxyHost.ts`、`src/upstream.ts`、`src/localConfigStore.ts`、`src/treeProvider.ts`

---

### Step 1: 修改 `proxy/server.js`

#### 1a. 修复 `listenPort: 0` 时的端口报告

**位置**：`startServer()` 内 `server.listen()` 回调（~line 628-653）

```js
// 改前：
resolve({ server, port: listenPort, host: listenHost, ... });

// 改后：
const actualPort = listenPort === 0 ? server.address().port : listenPort;
// 日志中所有引用 listenPort 的地方改用 actualPort
resolve({ server, port: actualPort, host: listenHost, ... });
```

#### 1b. 添加 `--child` 子进程入口

**位置**：文件末尾（line 658），在 `isMainModule` 检查之前

```js
if (process.argv.includes('--child')) {
  const args = process.argv;
  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

  startServer({
    configPath: getArg('--config-path'),
    logsDir: getArg('--logs-dir'),
    logsConfigPath: getArg('--logs-config-path'),
  })
    .then(({ port }) => {
      process.stdout.write(JSON.stringify({ port }) + '\n');
    })
    .catch((e) => {
      process.stderr.write(JSON.stringify({ error: e.message, code: e.code }) + '\n');
      process.exit(1);
    });

  process.on('SIGTERM', () => { try { runningServer?.close(); } catch {} });
  process.on('SIGINT', () => { try { runningServer?.close(); } catch {} });
} else if (isMainModule) {
  // 现有 CLI 模式不变
}
```

---

### Step 2: 新增 `src/workspaceProxyHost.ts`

#### 类结构

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import type { UpstreamEnv } from './proxyHost';

const WORKSPACE_CONFIG_DIR = '.claude_proxy';

interface WorkspaceProxyInstance {
    childProcess: ChildProcess;
    port: number;
    configPath: string;
    logsDir: string;
    workspaceRoot: string;
    starting: boolean;
}

export class WorkspaceProxyHost {
    private readonly instances = new Map<string, WorkspaceProxyInstance>();
    private readonly output: vscode.OutputChannel;
    private readonly extensionPath: string;
    private disposed = false;
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

    constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
        this.extensionPath = context.extensionPath;
        this.output = output;
        // 10s 健康检查
        this.healthCheckTimer = setInterval(() => { void this.healthCheckTick(); }, 10_000);
        context.subscriptions.push(
            { dispose: () => { if (this.healthCheckTimer) clearInterval(this.healthCheckTimer); } },
            { dispose: () => { void this.dispose(); } },
        );
    }
}
```

#### 核心方法实现要点

**`ensureRunning(workspaceRoot, upstreamEnv) → port`**：
1. 查 `instances` map → 已有且健康 → 返回 port
2. 已有但不健康 → kill 旧进程，移除
3. 不存在 → `writeProxyConfig()` → `startChildProcess()` → 存入 map → 返回 port

**`startChildProcess(workspaceRoot) → Promise<number>`**：
1. 构造命令：`node proxy/server.js --child --config-path ... --logs-dir ... --logs-config-path ...`
2. `spawn(nodePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })`
3. 读 stdout 解析 `{"port":12345}` 行
4. 10s 超时，超时 kill
5. 监听 `child.on('exit')` 清理 map
6. 监听 `child.on('error')` 处理 spawn 失败

**`writeProxyConfig(workspaceRoot, upstreamEnv) → configPath`**：
- 写 `{workspace}/.claude_proxy/proxy-config.json`
- 结构与全局 `DEFAULT_PROXY_CONFIG` 一致，但 `listenPort: 0`
- `env` 预填 upstream（启动前写好，消除竞态）

**`setUpstream(workspaceRoot, env)`**：
- 与 `ProxyHost.setUpstream()` 相同逻辑，POST `/api/upstream` 到 workspace 代理端口

**`getPort(workspaceRoot) → number | null`**：
- 从 `instances` map 取 port

**`stop(workspaceRoot)`**：
- kill 子进程，移除 map 条目

**`dispose()`**：
- 遍历所有实例：SIGTERM → 2s 等待 → SIGKILL
- 清空 map

**`healthCheckTick()`**：
- 遍历 instances，对每个调 `healthz(port)`
- 不健康则 kill + 移除

#### Node.js 路径

- 优先 `spawn('node', ...)`（假设 node 在 PATH）
- 添加 `claude-code-proxy.nodePath` 设置允许覆盖
- Node 不可用时 fallback 全局代理 + 警告

#### healthz 辅助函数

复用 `proxyHost.ts` 中的 `healthz(port)` 逻辑（独立函数，可直接复制或提取为共享工具）。

---

### Step 3: 修改 `src/claudeLauncher.ts`

#### 3a. 添加构造参数

```typescript
import type { WorkspaceProxyHost } from './workspaceProxyHost';

constructor(
    private readonly getLocalStore: () => LocalConfigStore | null,
    private readonly getLocalActiveState: () => LocalActiveStateStore | null,
    private readonly proxyHost: ProxyHost | null,
    private readonly workspaceProxyHost: WorkspaceProxyHost | null,  // 新增
    private readonly output: vscode.OutputChannel,
) {}
```

#### 3b. 修改 `resolveSettingsContent()`

proxy 模式分支改为：

```typescript
// --- proxy 模式 ---
const upstream = extractUpstream(cfg.content);
if (!upstream || !upstream.env.ANTHROPIC_BASE_URL || !upstream.env.ANTHROPIC_AUTH_TOKEN) {
    void vscode.window.showErrorMessage(`'${cfg.name}' 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN，无法走代理。`);
    return null;
}

const upstreamEnv: UpstreamEnv = {
    baseUrl: upstream.env.ANTHROPIC_BASE_URL,
    token: upstream.env.ANTHROPIC_AUTH_TOKEN,
    model: upstream.env.ANTHROPIC_MODEL,
    smallFastModel: upstream.env.ANTHROPIC_SMALL_FAST_MODEL,
    timeoutSec: upstream.env.API_TIMEOUT_MS ? Math.round(Number(upstream.env.API_TIMEOUT_MS) / 1000) : undefined,
};

// workspace-local proxy 配置 → 用 WorkspaceProxyHost（独立代理，不串味）
const workspace = vscode.workspace.workspaceFolders?.[0];
if (workspace && this.workspaceProxyHost) {
    try {
        const workspaceRoot = workspace.uri.fsPath;
        const port = await this.workspaceProxyHost.ensureRunning(workspaceRoot, upstreamEnv);
        const synthesized = synthesizeProxySettings(cfg.content, port);
        if (!synthesized) {
            void vscode.window.showErrorMessage(`'${cfg.name}' content 不是有效 JSON，无法合成代理 settings。`);
            return null;
        }
        this.output.appendLine(
            `[launcher] 已启动 workspace 独立代理: port=${port} baseUrl=${upstreamEnv.baseUrl} model=${upstreamEnv.model ?? '(unset)'}`,
        );
        return synthesized;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Workspace 代理模式启动失败: ${msg}`);
        return null;
    }
}

// fallback：全局代理（workspaceProxyHost 不可用时）
if (!this.proxyHost) {
    void vscode.window.showErrorMessage('代理尚未初始化');
    return null;
}
// ... 现有全局代理代码不变，保留串味警告 ...
```

**关键**：workspace-local proxy 配置永远走 WorkspaceProxyHost，不再碰全局 `setUpstream`。

---

### Step 4: 修改 `src/extension.ts`

#### 4a. 导入 + 创建

```typescript
import { WorkspaceProxyHost } from './workspaceProxyHost';
// ...
const workspaceProxyHost = new WorkspaceProxyHost(context, output);
```

#### 4b. 传给 Launcher

```typescript
const launcher = new ClaudeLauncher(
    () => localStore,
    () => localActiveState,
    proxyHost,
    workspaceProxyHost,  // 新增
    output,
);
```

#### 4c. 注册新命令

```typescript
// 打开 workspace 代理 Web 控制台
context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-proxy.openWorkspaceProxyUI', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            void vscode.window.showWarningMessage('请先打开一个 workspace 文件夹');
            return;
        }
        const port = workspaceProxyHost.getPort(workspace.uri.fsPath);
        if (!port) {
            void vscode.window.showWarningMessage('当前 workspace 无运行中的独立代理');
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
    }),
);

// 停止 workspace 代理
context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-proxy.stopWorkspaceProxy', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) return;
        await workspaceProxyHost.stop(workspace.uri.fsPath);
        void vscode.window.showInformationMessage('Workspace 独立代理已停止');
    }),
);
```

#### 4d. Workspace 代理状态栏

```typescript
const wsProxyStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
wsProxyStatusBar.command = 'claude-code-proxy.openWorkspaceProxyUI';
context.subscriptions.push(wsProxyStatusBar);

// 在 healthCheckTick 回调或 refresh 中更新：
function updateWorkspaceProxyStatusBar(): void {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { wsProxyStatusBar.hide(); return; }
    const port = workspaceProxyHost.getPort(workspace.uri.fsPath);
    if (port) {
        wsProxyStatusBar.text = `$(server) WS代理:${port}`;
        wsProxyStatusBar.tooltip = `Workspace 独立代理运行中 (127.0.0.1:${port})\n点击打开控制台`;
        wsProxyStatusBar.show();
    } else {
        wsProxyStatusBar.hide();
    }
}
```

#### 4e. deactivate

`WorkspaceProxyHost.dispose()` 通过 `context.subscriptions` 自动调用，无需手动处理。

---

### Step 5: 更新 `package.json`

#### 新命令

```json
{
    "command": "claude-code-proxy.openWorkspaceProxyUI",
    "title": "LLM 代理: 打开 Workspace 独立代理控制台",
    "category": "Claude Code Proxy"
},
{
    "command": "claude-code-proxy.stopWorkspaceProxy",
    "title": "LLM 代理: 停止 Workspace 独立代理",
    "category": "Claude Code Proxy"
}
```

#### 新设置

```json
{
    "claude-code-proxy.nodePath": {
        "type": "string",
        "default": "",
        "description": "Node.js 可执行文件路径（留空则用系统 PATH 中的 node）。Workspace 独立代理需要 Node.js 来启动子进程。"
    }
}
```

---

## 五、边缘情况

| 场景 | 处理 |
|------|------|
| 子进程崩溃 | `child.on('exit')` 清理 map，下次 `ensureRunning` 自动重启 |
| 两个窗口打开同一 workspace | 各自 spawn 独立子进程，不同端口，互不干扰 |
| 切换 workspace 文件夹 | `applyWorkspace()` 中停止已移除 workspace 的代理 |
| Node 不在 PATH | fallback 全局代理 + 警告；用户可设 `nodePath` |
| 扩展宿主崩溃 | 子进程可能成孤儿；可写入 PID 文件，下次启动时清理 |
| Windows 防火墙 | workspace 代理只监听 127.0.0.1，通常不触发 |
| 端口耗尽 | 正常使用 1-3 个 workspace，OS 有数千临时端口可用 |

---

## 六、验证方案

1. **编译**：`npm run compile` 无报错
2. **基本功能**：
   - 打开一个 workspace，创建 local proxy 配置，启动 CLI → 验证 workspace 代理子进程启动、端口分配正确、CLI 连接成功
   - 打开第二个 workspace，创建不同 upstream 的 local proxy 配置，启动 CLI → 验证两个代理独立运行、不同端口、不同 upstream
   - 两个 CLI 同时发请求 → 验证不串味
3. **全局代理不受影响**：
   - 切换 global proxy 配置 → 验证仍走全局代理、Reload Window 正常
4. **Web 控制台**：
   - 打开 workspace 代理 UI → 验证 trace 显示该 workspace 的请求
   - 打开全局代理 UI → 验证不受 workspace 代理影响
5. **生命周期**：
   - 关闭 VS Code → 验证子进程被正确终止
   - Kill 子进程 → 验证下次 `ensureRunning` 自动重启
6. **Code Review**：完成后自审代码质量、类型安全、错误处理

---

## 七、相关文件索引

| 文件 | 作用 | 改动 |
|------|------|------|
| `proxy/server.js` | ESM 代理服务器 | 修改：`--child` 模式 + `listenPort:0` 修复 |
| `proxy/config-store.js` | 代理配置存储（模块级单例） | 不改 |
| `proxy/trace-store.js` | Trace 存储（模块级单例） | 不改 |
| `src/proxyHost.ts` | 全局代理管理器 | 不改 |
| `src/workspaceProxyHost.ts` | **新增**：workspace 代理管理器 | 新增 |
| `src/claudeLauncher.ts` | CLI 启动器 | 修改：路由到 WorkspaceProxyHost |
| `src/extension.ts` | 扩展入口 | 修改：创建/注册/状态栏 |
| `src/upstream.ts` | settings 合成 | 不改（port 参数已解耦） |
| `src/localConfigStore.ts` | workspace-local 配置存储 | 不改 |
| `src/proxyToggle.ts` | 代理开关（per-window 内存态） | 不改 |
| `src/claudeConfig.ts` | settings.json 读写 | 不改 |
| `package.json` | 扩展清单 | 修改：新命令 + 新设置 |
| `docs/pitfall-proxy-shared-upstream.md` | 串味陷阱文档 | 不改（可后续更新标注已修复） |
| `docs/architecture-shared-backend.html` | 架构图 | 不改（可后续更新） |
