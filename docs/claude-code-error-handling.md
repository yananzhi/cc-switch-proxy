# Claude Code 对 LLM API 错误的处理

> 本文档基于 Claude Code 源码（`D:/work_dir/Claude_Code-_Source_Code`）整理，目的是搞清楚
> **Claude Code 自己能处理哪些 API 错误、处理不了哪些**——这是本插件代理重试策略的判定依据：
> 代理只重试 Claude Code 处理不了的，其余交给 Claude Code。
>
> 源码版本对应 `services/api/` 目录。行号是该源码树的行号，仅供参考。

## 总览：重试架构

Claude Code 用 `@anthropic-ai/sdk` 官方 SDK，但**关掉了 SDK 自带重试**，改用自己手写的 `withRetry` 生成器做重试决策。

| 事实 | 出处 |
|---|---|
| 主请求 `maxRetries: 0`（关掉 SDK 重试） | `services/api/claude.ts:846`、`services/api/claude.ts:1781`（注释：`Disabled auto-retry in favor of manual implementation`） |
| 默认重试次数 `DEFAULT_MAX_RETRIES = 10` | `services/api/withRetry.ts:52` |
| 可被 `CLAUDE_CODE_MAX_RETRIES` 环境变量覆盖 | `services/api/withRetry.ts:789-794`（`getDefaultMaxRetries`） |
| 退避：`BASE_DELAY_MS(500ms) * 2^(attempt-1)`，上限 32s，加 0–25% 抖动 | `services/api/withRetry.ts:530-548`（`getRetryDelay`） |
| 若响应带 `retry-after` 头则遵守（秒数×1000） | `services/api/withRetry.ts:535-540` |
| 重试最终判定函数 `shouldRetry` | `services/api/withRetry.ts:696-787` |
| 不可重试时抛 `CannotRetryError` | `services/api/withRetry.ts:144-158` |
| 错误→用户可见消息的映射 | `services/api/errors.ts`（`getAssistantMessageFromError`）、`services/api/errorUtils.ts`（`formatAPIError`） |
| 上游超时由 `API_TIMEOUT_MS` 控制（默认 600s） | `services/api/client.ts:143-144` |

> 注意：少数**辅助**调用（非主请求）保留了 SDK 重试——API key 校验 `maxRetries:3`（`claude.ts:548`）、某些 `maxRetries:2`（`claude.ts:566`）、token 估算 `maxRetries:1`（`tokenEstimation.ts`）、auth `maxRetries:2`（`auth.ts:1505`）。这些不影响主对话流。

## `shouldRetry` 判定逻辑（核心）

按源码顺序（`withRetry.ts:696-787`），命中任一即返回 `true`（可重试），否则 `false`：

1. **mock 错误**（`/mock-limits` 测试命令产生）→ 不重试（`698-700`）
2. **persistent 模式**（`CLAUDE_CODE_UNATTENDED_RETRY`，仅 ant+feature gate）下 429/529 → 重试，绕过订阅门和 `x-should-retry` 头（`704-706`）。退避上限 5min，总等待上限 6h（`96-97`）
3. **CCR 模式**（`CLAUDE_CODE_REMOTE`）下 401/403 → 重试（基础设施 JWT 鉴权抖动）（`712-717`）
4. **overloaded_error**（消息含 `"type":"overloaded_error"`）→ 重试（流式时 SDK 有时丢状态码，靠消息识别）（`722-724`）
5. **max_tokens 上下文溢出**（400 + 特定 message）→ 重试并自动调小 `max_tokens`（`727-729`，详见 `parseMaxTokensContextOverflowError` `550-595`）
6. **`x-should-retry: true` 头**，且（非订阅用户 或 Enterprise）→ 重试（`737-742`）
7. **`x-should-retry: false` 头** → 不重试；**例外**：ant 用户对 5xx 会忽略此头继续重试（`746-751`）
8. **`APIConnectionError`**（网络层错误）→ 重试（`753-755`）
9. **无 status**（非 HTTP 错误）→ 不重试（`757`）
10. **408**（请求超时）→ 重试（`760`）
11. **409**（锁超时）→ 重试（`763`）
12. **429**（限流）→ 非订阅用户 或 Enterprise 重试；订阅用户（Pro/Max）**不重试**（`767-769`）
13. **401** → 清 API key 缓存后重试（`773-776`）
14. **403 token revoked**（OAuth 吊销）→ 重试（`779-781`）
15. **5xx（≥500，含 500/502/503/504/529）** → 重试（`784`）

## 逐类结论

### 1. HTTP 503 + body `error.code === 10310`（讯飞 system busy）
**Claude Code 处理不了这个特定语义，但会按 5xx 通用规则盲目重试。**

- 全代码库**没有 `10310` 字符串、没有针对 error.code 的分支**。
- 503 状态码无专门分支，命中 `shouldRetry` 第 15 条 `error.status >= 500` → 重试 10 次（`withRetry.ts:784`）。
- 退避 500ms→32s，10 次重试用尽后抛 `CannotRetryError`，经 `getAssistantMessageFromError` 转成用户可见的 `API Error` 消息。
- **不识别 10310、不会智能跳过**——讯飞的 503+10310 在它眼里就是"一个普通 5xx"。
- **这正是代理要重试它的理由**：Claude Code 盲目重试 10 次可能不够（讯飞 system busy 有时持续几十秒到几分钟），代理的针对重试（20 次 + 16s 上限）更有效。参见本仓库 `proxy/server.js` 的 verdict 逻辑。

### 2. HTTP 503 + 其他 body 错误码
**走 5xx 通用重试路径。** 同上，命中 `error.status >= 500`（`withRetry.ts:784`），重试 10 次。

### 3. HTTP 429（限流）
**分情况**（`withRetry.ts:767-769`）：

- 非订阅用户 / Enterprise → 重试。
- Claude.ai 订阅用户（Pro/Max）→ **不重试**（这类限流通常要等几小时，重试无意义）。
- 若 `x-should-retry: true` 头且非订阅/Enterprise → 重试（`737-742`）；若 `x-should-retry: false` 且非 ant → 不重试（`746-751`）。
- **fast mode 特殊路径**（`withRetry.ts:267-305`）：遇 429/529 看 `retry-after`，<20s 就等完再重试（保缓存），>20s 触发 cooldown 降级到标准速度。
- 用户可见消息：`getAssistantMessageFromError` 的 429 分支（`errors.ts:465-558`）解析 `anthropic-ratelimit-unified-*` 系列头，生成"额度耗尽/重置时间"提示；无这些头时显示 `Request rejected (429)`。
- **persistent 模式**（`CLAUDE_CODE_UNATTENDED_RETRY`，仅 ant+feature gate）：429/529 无限重试，退避上限 5min，总等待上限 6h（`withRetry.ts:96-97,100-104`）。

### 4. HTTP 500 / 502 / 504
**会重试**（`withRetry.ts:784`，`error.status >= 500`）。10 次，指数退避。`x-should-retry: false` 头对 ant 用户的 5xx 被忽略（继续重试，`746-751`），对外部用户则遵守。重试用尽后显示通用 `API Error`。

### 5. HTTP 400 / 404
**默认不重试**（`shouldRetry` 对 400/404 无专门分支，落到 `error.status >= 500` 不成立 → `false`，`withRetry.ts:757,784-786`）。

**例外（400 会重试）**：
- 400 "input length and max_tokens exceed context limit"（`withRetry.ts:550-595,727-729`）→ 重试并自动调小 `max_tokens`。
- 400 "Fast mode is not enabled"（`withRetry.ts:600-608,310-314`）→ 关掉 fast mode 重试。

**404 专门处理**（`errors.ts:905-914`）：提示模型不存在/无权限，建议 `/model` 切换；3P 用户会建议具体回退模型。流式 404 还会触发非流式回退（`claude.ts:2607-2664`）。

**400 的各种细分**：prompt too long、PDF 页数/加密/无效、image exceeds、tool_use 并发错误、重复 tool_use id、invalid model name、org disabled、credit balance low 等，都映射成不同用户提示（`errors.ts:560-811`）。

### 6. 网络错误
SDK 把这些包成 `APIConnectionError` / `APIConnectionTimeoutError`，命中 `shouldRetry` 第 8 条 → **重试 10 次**。

- **超时（ETIMEDOUT / timeout）**：`APIConnectionTimeoutError` 走 `APIConnectionError` 分支重试（`withRetry.ts:753-755`）。用户消息 `Request timed out`（`errors.ts:434-443`）；`formatAPIError` 对 `ETIMEDOUT` 给 "Request timed out. Check your internet connection and proxy settings"（`errorUtils.ts:208-209`）。SDK 超时由 `API_TIMEOUT_MS`（默认 600s）控制（`client.ts:144`）。
- **ECONNRESET / EPIPE**（stale keep-alive socket）：重试；额外在 feature flag `tengu_disable_keepalive_on_econnreset` 开启时调 `disableKeepAlive()` 并重建 client（`withRetry.ts:112-118,217-230`）。无 flag 时仍按普通连接错误重试。
- **ECONNREFUSED / socket hang up**：无专门分支，作为 `APIConnectionError` 重试 10 次（`withRetry.ts:753-755`）；用户消息 `Unable to connect to API (ECONNREFUSED)` 之类（`errorUtils.ts:237-243`）。
- **流式响应中途断开**：
  - 流空闲超时看门狗 `STREAM_IDLE_TIMEOUT_MS`（默认 90s，`claude.ts:1877-1878`）：无 chunk 超过阈值就 abort 流（`claude.ts:1908-1927`），抛 `Stream idle timeout - no chunks received`（`claude.ts:2334`）。
  - 流中途出错 → **非流式回退**（`claude.ts:2404-2560`）：捕获 `streamingError` 后，若未禁用回退（`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`），调 `executeNonStreamingRequest` 重试。流式失败本身是 529 会记入 529 计数（`claude.ts:2559`）。
  - **假成功检测**（`claude.ts:2337-2364`）：流"完成"但没收到 `message_start`，或收了 `message_start` 但没完成任何 content block 且无 stop_reason → 抛 `Stream ended without receiving any events`，触发非流式回退。注释明确这是为代理返回 200 但非 SSE body 的失败模式设计的。
  - SDK 内部 abort（非用户触发）转成 `APIConnectionTimeoutError`（`claude.ts:2452-2461`）。
  - 用户按 ESC 触发的 `APIUserAbortError` → 直接抛出，不重试、不显示错误（`withRetry.ts:190-192`，`claude.ts:2796-2799`）。

### 7. HTTP 200 但 body 是错误结构（假成功）
**部分能处理，仅限流式场景。**

- 流式假成功：见上面"假成功检测"（`claude.ts:2350-2364`）——代理返回 200+非 SSE body 会被识别并触发非流式回退。
- **非流式 200 假成功 / 整体 body 是错误结构**：未找到明确的校验。`errors.ts:387-398` 有个 `isValidAPIMessage` 类型守卫（检查 content/model/usage 字段），但 grep 显示它没有在主请求路径里被用来兜底拦截"200 但坏 body"——SDK 在 200 时会尝试解析，解析失败由 SDK 抛错。未找到 Claude Code 自己对"200 + 错误 body"的显式分支。

### 8. HTTP 529（overloaded）——Claude Code 真正专门处理的过载码
**这是唯一有专门过载逻辑的状态码**（不是 503）：

- `is529Error`、`MAX_529_RETRIES = 3`（`withRetry.ts:54`）。
- 连续 529 达 3 次 → 触发**模型回退**（`withRetry.ts:334-360`）：切到 `fallbackModel`，抛 `CannotRetryError` 带 `fallbackModel`，上层用回退模型重发。
- 529 是否重试还看 `querySource`（`shouldRetry529`，`withRetry.ts:84-89`）：只有前台阻塞型来源（主对话、agent、compact、hook、安全分类器等，`FOREGROUND_529_RETRY_SOURCES` `62-82`）才重试 529；后台来源（摘要/标题/建议/分类器）立即放弃——避免级联放大。
- 后台任务遇 529 直接放弃（`withRetry.ts:316-324`）。
- persistent 模式下 529 无限重试（见上文 429 段）。

## 关键确认点（对本插件代理策略的意义）

- **SDK 自带重试被关闭**：主请求 `maxRetries:0`，重试完全由 `withRetry.ts` 接管，次数 10（非 SDK 默认的 2）。所以"官方 SDK 默认重试 2 次"在 Claude Code 里**不生效**。
- **没有任何针对讯飞 / `10310` / "system busy" 的代码**。讯飞 503 在 Claude Code 看来就是"一个 5xx"，盲目重试 10 次然后报错——既不识别业务码，也不智能跳过。**→ 这是代理重试 10310 的核心理由。**
- **网络错误、超时、断连、流中断 Claude Code 都会重试**（`APIConnectionError` → 10 次）。**→ 按本插件原则"代理只处理 CC 处理不了的"，代理不重试这些，透传合成 502 让 CC 当 5xx 自己重试。**
- **429/500/502/504 Claude Code 也会重试**（5xx / 限流分支）。**→ 代理同样不重试，透传。**
- **529 才是 Claude Code 真正专门处理的过载码**，不是 503。讯飞若将来改用 529，Claude Code 自己能处理得很好（连续 3 次自动模型回退）。

## 参考文件

| 文件 | 内容 |
|---|---|
| `services/api/withRetry.ts` | 重试主逻辑、`shouldRetry`、`getRetryDelay`、529/429/persistent 分支、`DEFAULT_MAX_RETRIES=10` |
| `services/api/errors.ts` | `getAssistantMessageFromError`（错误→用户消息映射）、`classifyAPIError`、`REPEATED_529_ERROR_MESSAGE`、`isValidAPIMessage` |
| `services/api/errorUtils.ts` | `formatAPIError`、`extractConnectionErrorDetails`、SSL/ETIMEDOUT 文案、HTML(CloudFlare)清洗 |
| `services/api/client.ts` | SDK 客户端构造、`maxRetries`/`timeout` 透传、`API_TIMEOUT_MS` |
| `services/api/claude.ts` | 流式请求、看门狗超时、非流式回退、`maxRetries:0`、`CannotRetryError`→用户消息收口 |
| `utils/messages.ts` | `createSystemAPIErrorMessage`（重试期间 yield 的进度消息） |

---

> 本文档随源码版本可能过时。若 Claude Code 升级后重试行为变化，应重新核对 `services/api/withRetry.ts` 的 `shouldRetry` 与 `getRetryDelay`。
