# 陷阱：proxy 模式的上游是全局共享单例

> 影响范围：**多条 proxy 配置（不同上游）+ 并发会话**时触发。单上游、或串行使用不受影响。direct 模式完全不受影响。

## 现象

同时开着两个走代理的 Claude 会话（一个公司项目、一个个人项目，分别配了不同上游），你会发现：

- 公司会话的请求**实际打到了个人上游**，用个人 key 扣费，公司网关零记录；
- 或反过来，个人会话的请求带着个人 token 打到公司网关，401/403 或被记进审计日志。

而且**没有任何报错**——两个会话都「连得上代理」，只是后端被悄悄偷换了，极难察觉。

## 根因

`ProxyHost` 是**整个 VS Code 窗口共享一个代理进程**，靠端口绑定（`EADDRINUSE`）保证全局只有一个窗口真的在跑代理。代理的「上游」（转发到哪个真实 LLM 后端、用什么 token）是**一份全局运行时状态**，存在 `globalStorage/proxy-config.json`，通过 `setUpstream()` 的 `POST /api/upstream` 改写。

**关键**：不管你有几条 proxy 配置、几个 workspace 会话，代理进程只有一个、上游也只有一份。**谁最后调 `setUpstream()`，代理就指向谁的后端**（last-write-wins）。

而 workspace 隔离隔离的是**配置目录**（`CLAUDE_CONFIG_DIR`、`settings.json`、历史/会话状态），挡不到「代理进程的运行时上游」——它不在任何 `CLAUDE_CONFIG_DIR` 里。

## 复现时间线

两条 proxy 配置：

| 配置 | 上游 baseUrl | token | 用途 |
|---|---|---|---|
| A. 公司网关 | `https://corp-llm.internal` | `corp-token` | 公司项目，走内网 |
| B. 个人 key | `https://api.anthropic.com` | `sk-personal` | 个人项目 |

**T1 — 公司 workspace 点「启动 workspace Claude」**

`ClaudeLauncher.resolveSettingsContent`（proxy 分支）：

```
proxyHost.ensureRunning()       // 代理起在 11434
proxyHost.setUpstream(A)        // ← 全局代理上游 = A（公司网关）
synthesizeProxySettings(...)    // 写 .claude_proxy/settings.json，BASE_URL=127.0.0.1:11434
```

公司会话此刻：`公司会话 → 127.0.0.1:11434 → 代理 → corp-llm.internal`。✅

**T2 — 不关公司会话，切到个人 workspace，再点「启动 workspace Claude」**

```
proxyHost.ensureRunning()       // 同一个代理进程（已起）
proxyHost.setUpstream(B)        // ← 全局代理上游 = B（个人 key）
```

**问题**：T1 的公司会话还活着，它 `settings.json` 里的 `BASE_URL` 仍指向 `127.0.0.1:11434`（启动时写死，不会变）。但代理上游已被 T2 改成 B。于是 T1 会话后续请求：

```
公司会话 → 127.0.0.1:11434 → 代理（上游现在=B）→ api.anthropic.com，用 sk-personal 计费
```

公司以为在内网跑，实际走个人 key 扣费；反过来则会把个人 token 打到公司网关。

## 当前缓解（已实现）

`ClaudeLauncher` 在 proxy 模式启动时，于 output channel 记一行日志标注当前注入的上游，便于事后排查。但这只是**事后可见**，不阻止串味发生。

## 规避建议（现状下）

- 同一时间只开一个 proxy 会话；切换上游前先关掉旧会话。
- 或只用一条 proxy 配置（单一上游），多 workspace 共享它——这样 last-write 总是同一个上游，不会串。
- 需要严格隔离不同上游时，临时用 direct 模式（不经代理，直接走各自 content 里的 `env`）。

---

## 彻底解法（草案）：每 workspace 独立代理实例

核心思路：**把「一个全局代理」改成「每个需要 proxy 的 workspace 会话各起一个独立代理实例，各占各的端口、各存各的上游」**，从根上消除共享状态。

### 数据模型

每个 workspace-local proxy 配置带一份**实例描述**，至少：

- `port`：该 workspace 代理监听的端口（从该 workspace 专属端口段里分配，避免与全局代理及彼此冲突）。
- `upstream`：该 workspace 当前注入的上游（baseUrl/token/model/timeout）——**只属于这个 workspace**，不再写全局 `proxy-config.json`。

### 端口分配

现在 `defaultPortForPlatform()` 给全局代理一个固定端口（win=11434 / mac=11436 / linux=11435）。workspace 实例需要一套**不与全局端口、也不彼此冲突**的分配策略，候选：

1. **固定端口段 + workspace 哈希**：用 `hash(workspaceRoot) % N` 映射到 `[BASE, BASE+N)` 区间。确定性好、无需持久化，但哈希碰撞时两个 workspace 抢同一端口（可退化为复用，但又会回到共享问题）。
2. **启动时抢占空闲端口**：`server.listen(0)` 让 OS 分配空闲端口，再把该端口写回 `{workspace}/.claude_proxy/proxy-port.json`。本机内端口几乎不会撞，`settings.json` 里合成的 `BASE_URL` 用这个端口。**推荐**——简单且无碰撞。
3. **持久化分配表**：`globalStorage/workspace-ports.json` 记 `{workspaceRoot → port}`，首次分配后固定。比 2 多一层管理，好处是端口稳定（重启后不变，旧 settings.json 仍有效）。

端口分配还要兼顾现有「Windows ↔ WSL2 经 localhost 转发互通」的跨边界约定（见 `proxyHost.ts` 注释）：workspace 实例若可能跨 Windows/WSL 边界，端口段也要按边界分桶，否则同机 WSL 仍会串味。

### 生命周期

- **启动**：launcher 在 proxy 分支里，不再调全局 `proxyHost.setUpstream`，而是为本 workspace 起/复用一个**独立代理进程实例**（沿用 ESM `startServer`，传该 workspace 专属的 `configPath`/`logsDir`），注入该 workspace 的上游，拿到端口写进 `settings.json`。
- **保活/心跳**：现有「宿主 + 从机心跳接管」机制是全局单例语义。多实例下要么每个实例各自心跳，要么简化为「进程跟终端会话同生命周期」——终端关了就停代理。后者更符合 workspace 隔离的心智模型，但失去跨窗口复用。
- **停止**：workspace 代理实例的停止要跟该 workspace 的最后一个会话绑定，或随扩展 deactivate 停。

### 合成 settings 的变化

`synthesizeProxySettings(cfg.content, port)` 里的 `port` 不再来自全局 `proxyHost.getPort()`，而是该 workspace 实例的端口。launcher 写 `{workspace}/.claude_proxy/settings.json` 时用这个端口。

### 与全局代理的关系

需要明确「全局 proxy 配置」是否仍走全局单例代理：

- **方案 A**：global proxy 仍用现有全局代理；只有 workspace-local proxy 走独立实例。改动小、向后兼容，但两套并存增加认知负担。
- **方案 B**：统一成每会话/每 workspace 独立实例，废弃全局单例。彻底但改动大，且要重做跨窗口保活。

### 主要改动点（粗估）

- `ProxyHost` 抽出「实例管理」层：支持按 workspace 创建/复用/停止独立代理实例，每实例独立端口 + 独立上游 + 独立 `proxy-config`。
- `ClaudeLauncher.resolveSettingsContent`：proxy 分支改为取/建本 workspace 实例，不再碰全局 `setUpstream`。
- 端口分配 + 持久化（推荐方案 2 或 3）。
- 心跳/保活策略重定（每实例 vs 跟会话同生命周期）。
- Web 控制台（重试参数 + trace）目前绑全局代理，多实例下要支持按 workspace 实例切换查看。

### 代价

这是架构级改动，远大于加一个警告文档。在「警告 + 规避建议」能压住绝大多数实际使用（多数人单上游或串行）之前，不值得立刻做；但作为已知技术债记在这里，等真出现多上游并发刚需再上。
