import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import type { LocalConfigStore, LocalActiveStateStore } from './localConfigStore';
import { ProxyHost, UpstreamEnv } from './proxyHost';
import { writeSettings } from './claudeConfig';
import { extractUpstream, synthesizeProxySettings } from './upstream';

/** 官方 Claude Code 扩展 ID（publisher.name，不含版本号，升级后仍有效）。 */
const OFFICIAL_EXTENSION_ID = 'anthropic.claude-code';
/** 扩展安装目录下二进制的相对子路径（各平台一致）。 */
const NATIVE_BINARY_SUBDIR = path.join('resources', 'native-binary');
/** workspace 下独立配置目录名。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * 在 VS Code 集成终端里启动一个 workspace 独立的 Claude Code CLI 会话。
 *
 * 通过 `CLAUDE_CONFIG_DIR` 环境变量把会话配置目录指向 `{workspace}/.claude_proxy/`，
 * 使该 workspace 的 Claude 状态独立于全局 `~/.claude/`。启动前把当前 workspace-local
 * active 配置写进该目录的 settings.json（proxy 模式走本地代理合成，与全局 doSwitch 一致）；
 * 无 local active 则不写 settings.json，claude 用默认。不再读取 global activeState。
 *
 * 硬约束：
 * - shell：Windows 强制 PowerShell（用户 VS Code 默认终端可能是 Git Bash，反斜杠路径会出转义问题）；
 *   Linux/macOS 不传 shellPath，用平台默认 bash。
 * - env 用 createTerminal 的 env 选项进程级注入，跨 shell 无需区分语法。
 * - 二进制用完整绝对路径调用，不依赖 PATH。
 */
export class ClaudeLauncher {
    constructor(
        private readonly getLocalStore: () => LocalConfigStore | null,
        private readonly getLocalActiveState: () => LocalActiveStateStore | null,
        private readonly proxyHost: ProxyHost | null,
        private readonly output: vscode.OutputChannel,
    ) {}

    /** 解析 claude 二进制完整路径：用户设置覆盖 → 官方扩展自动探测。失败返回 null。 */
    private resolveBinaryPath(): string | null {
        // 1) 用户设置覆盖
        const override = vscode.workspace
            .getConfiguration('claude-code-proxy')
            .get<string>('claudeBinaryPath') ?? '';
        if (override.trim()) {
            if (fs.existsSync(override)) {
                return override;
            }
            this.output.appendLine(`[launcher] 设置的 claudeBinaryPath 不存在: ${override}`);
        }

        // 2) 官方扩展自动探测
        const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
        if (!ext) {
            this.output.appendLine('[launcher] 未找到官方 anthropic.claude-code 扩展');
            return null;
        }
        const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
        const candidate = path.join(ext.extensionPath, NATIVE_BINARY_SUBDIR, binaryName);
        if (!fs.existsSync(candidate)) {
            this.output.appendLine(`[launcher] 官方扩展已装但二进制缺失: ${candidate}`);
            return null;
        }
        return candidate;
    }

    /**
     * 合成要写入 `.claude_proxy/settings.json` 的内容。
     * - 直连模式：原样使用 cfg.content。
     * - proxy 模式：确保本地代理在跑 + 注入上游 + 合成指向 localhost 的 settings（与 doSwitch 一致）。
     * 返回 null 表示因配置/代理问题应中止（已向用户报错）。
     */
    private async resolveSettingsContent(cfg: LLMConfig): Promise<string | null> {
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        if (mode === 'direct') {
            return cfg.content;
        }

        // proxy 模式：复用 doSwitch 的代理注入 + 合成逻辑
        const upstream = extractUpstream(cfg.content);
        if (!upstream || !upstream.env.ANTHROPIC_BASE_URL || !upstream.env.ANTHROPIC_AUTH_TOKEN) {
            void vscode.window.showErrorMessage(
                `'${cfg.name}' 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN，无法走代理。`,
            );
            return null;
        }
        if (!this.proxyHost) {
            void vscode.window.showErrorMessage('代理尚未初始化');
            return null;
        }
        try {
            await this.proxyHost.ensureRunning();
            const upstreamEnv: UpstreamEnv = {
                baseUrl: upstream.env.ANTHROPIC_BASE_URL,
                token: upstream.env.ANTHROPIC_AUTH_TOKEN,
                model: upstream.env.ANTHROPIC_MODEL,
                smallFastModel: upstream.env.ANTHROPIC_SMALL_FAST_MODEL,
                timeoutSec: upstream.env.API_TIMEOUT_MS
                    ? Math.round(Number(upstream.env.API_TIMEOUT_MS) / 1000)
                    : undefined,
            };
            await this.proxyHost.setUpstream(upstreamEnv);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`代理模式启动/注入失败: ${msg}`);
            return null;
        }
        const port = this.proxyHost.getPort();
        const synthesized = synthesizeProxySettings(cfg.content, port);
        if (!synthesized) {
            void vscode.window.showErrorMessage(
                `'${cfg.name}' content 不是有效 JSON，无法合成代理 settings。`,
            );
            return null;
        }
        return synthesized;
    }

    /**
     * 往项目级 `.claude/settings.local.json` 合并 `permissions.defaultMode = bypassPermissions`。
     * - 读已有内容 parse（不存在/损坏则从 `{}` 开始），只覆盖 defaultMode，保留其余字段。
     * - 项目级文件跟 workspace 绑定，不污染全局；claude 自动会创建 `.claude/`，这里只补 permissions。
     */
    private async ensureProjectPermissions(workspaceRoot: string): Promise<void> {
        const projectClaudeDir = path.join(workspaceRoot, '.claude');
        const localSettingsPath = path.join(projectClaudeDir, 'settings.local.json');
        let obj: Record<string, unknown> = {};
        try {
            const raw = await fs.promises.readFile(localSettingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                obj = parsed as Record<string, unknown>;
            }
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                // 损坏文件：不覆盖用户数据，记日志后跳过 permissions 写入
                this.output.appendLine(`[launcher] ${localSettingsPath} 解析失败，跳过 permissions 写入: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            // ENOENT 正常，从空对象开始
        }
        const perms = (obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions)
            ? obj.permissions : {}) as Record<string, unknown>;
        if (perms.defaultMode === 'bypassPermissions') {
            return; // 已经是目标值，不必写
        }
        perms.defaultMode = 'bypassPermissions';
        obj.permissions = perms;
        await fs.promises.mkdir(projectClaudeDir, { recursive: true });
        await fs.promises.writeFile(localSettingsPath, JSON.stringify(obj, null, 2), 'utf8');
        this.output.appendLine(`[launcher] 已写入项目级 permissions: ${localSettingsPath}`);
    }

    /**
     * 若 workspace 是 git 仓库（检测 .git 目录存在，不依赖 git 命令，跨平台可靠），
     * 且 .gitignore 未含 `.claude_proxy/`，则追加一行。非 git 仓库跳过，不创建 .gitignore。
     * 换行用 LF（跨平台一致），已含则不重复追加。
     */
    private async ensureGitignore(workspaceRoot: string): Promise<void> {
        try {
            const gitDir = path.join(workspaceRoot, '.git');
            if (!fs.existsSync(gitDir)) {
                return; // 非 git 仓库，跳过
            }
            const gitignorePath = path.join(workspaceRoot, '.gitignore');
            let existing = '';
            try {
                existing = await fs.promises.readFile(gitignorePath, 'utf8');
            } catch (err: unknown) {
                if (!isENOENT(err)) { throw err; }
                // 不存在视为空，下面会创建
            }
            const lines = existing.split(/\r?\n/);
            const present = lines.some(l => l.trim() === '.claude_proxy/');
            if (present) {
                return; // 已含，不重复追加
            }
            const prefix = (existing.length > 0 && !existing.endsWith('\n')) ? '\n' : '';
            const next = `${existing}${prefix}.claude_proxy/\n`;
            await fs.promises.writeFile(gitignorePath, next, 'utf8');
            this.output.appendLine(`[launcher] 已将 .claude_proxy/ 加入 ${gitignorePath}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[launcher] 写 .gitignore 失败（忽略）: ${msg}`);
        }
    }

    /** 启动 workspace 独立 Claude 会话。内部吞掉所有错误并 showErrorMessage，不向调用方抛。 */
    async launch(): Promise<void> {
        try {
            // a. workspace
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }

            // b. 二进制路径
            const binaryPath = this.resolveBinaryPath();
            if (!binaryPath) {
                void vscode.window.showErrorMessage(
                    '未找到 Claude Code CLI。请安装官方 Claude Code 扩展，或在设置 claude-code-proxy.claudeBinaryPath 中指定路径。',
                );
                return;
            }

            // c. 独立配置目录 + gitignore（首次建时若是 git 仓库则把 .claude_proxy/ 加进 .gitignore）
            const workspaceRoot = workspace.uri.fsPath;
            const configDir = path.join(workspaceRoot, WORKSPACE_CONFIG_DIR);
            await this.ensureGitignore(workspaceRoot);
            await fs.promises.mkdir(configDir, { recursive: true });

            // d. 只用 workspace-local active（不再碰 global activeState）
            const localStore = this.getLocalStore();
            const localActiveState = this.getLocalActiveState();
            if (!localStore || !localActiveState) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }
            const state = await localActiveState.load();
            if (state) {
                const cfg = await localStore.get(state.id);
                if (cfg) {
                    const settingsContent = await this.resolveSettingsContent(cfg);
                    if (settingsContent === null) {
                        return; // 配置/代理问题已报错，中止
                    }
                    const settingsPath = path.join(configDir, 'settings.json');
                    await writeSettings(settingsPath, settingsContent);
                    this.output.appendLine(
                        `[launcher] 已写入 workspace 独立配置: ${settingsPath} (mode=${cfg.mode ?? 'direct'})`,
                    );
                } else {
                    this.output.appendLine(`[launcher] local active id=${state.id} 已不存在，跳过写 settings`);
                }
            } else {
                this.output.appendLine('[launcher] 无 workspace-local active 配置，不写 settings.json，claude 用默认设置');
            }

            // d2. 项目级 permissions：往 {workspace}/.claude/settings.local.json 合并 bypassPermissions
            await this.ensureProjectPermissions(workspace.uri.fsPath);

            // e. 建终端：env 进程级注入 CLAUDE_CONFIG_DIR。
            // Windows 强制 PowerShell（用户 VS Code 默认终端可能是 Git Bash，会带来反斜杠转义问题）；
            // Linux/macOS 不传 shellPath，用平台默认 bash。
            const isWin = process.platform === 'win32';
            const terminalOptions: vscode.TerminalOptions = {
                name: 'Claude Code (Workspace)',
                cwd: workspace.uri.fsPath,
                env: { CLAUDE_CONFIG_DIR: configDir },
            };
            if (isWin) {
                terminalOptions.shellPath = 'powershell.exe';
            }
            const terminal = vscode.window.createTerminal(terminalOptions);
            terminal.show();
            // 发完整二进制路径（引号包空格），自动回车执行进交互式 CLI。单条命令一行。
            // PowerShell 用调用操作符 & 执行带空格/反斜杠的路径；bash 直接引号路径即可。
            const invoke = isWin ? `& "${binaryPath}"` : `"${binaryPath}"`;
            terminal.sendText(invoke, true);

            this.output.appendLine(`[launcher] 已启动 workspace 独立 Claude 会话: ${binaryPath} (shell=${isWin ? 'powershell' : 'default'})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[launcher] 启动失败: ${msg}`);
            void vscode.window.showErrorMessage(`启动 workspace Claude 会话失败: ${msg}`);
        }
    }
}

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
