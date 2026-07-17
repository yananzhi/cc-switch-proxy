import * as fs from 'fs';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import { ConfigStore } from './configStore';
import { ActiveStateStore } from './activeState';
import { ProxyToggleStore } from './proxyToggle';
import { ProxyHost } from './proxyHost';
import { ConfigTreeProvider, findActiveConfig, getOverridePath, getConfigFromNode } from './treeProvider';
import { WebviewEditor } from './webviewEditor';
import { backupSettings, detectPlatform, readSettings, writeSettings } from './claudeConfig';
import { extractUpstream, synthesizeProxySettings } from './upstream';
import { ClaudeLauncher } from './claudeLauncher';
import { migrateFromLegacy } from './migrate';
import { LocalConfigStore, LocalActiveStateStore } from './localConfigStore';

// 模块级，供 deactivate 停止代理
let proxyHost: ProxyHost | null = null;

export function activate(context: vscode.ExtensionContext): void {
    // 扩展改名 cc-switch → claude-code-proxy 后，旧 globalStorage 数据读不到。
    // 同步迁移：必须在 ConfigStore/ActiveStateStore 首次 load() 之前完成，否则 cache 读到空目录。
    const migrated = migrateFromLegacy(context.globalStorageUri);
    if (migrated) {
        console.log('[claude-code-proxy] 已从旧 cc-switch 命名空间迁移 configs.json + active.json');
    }

    const store = new ConfigStore(context.globalStorageUri);
    const activeState = new ActiveStateStore(context.globalStorageUri);
    const proxyToggle = new ProxyToggleStore();
    const output = vscode.window.createOutputChannel('Claude Code Proxy');
    context.subscriptions.push(output);
    proxyHost = new ProxyHost(context, output, proxyToggle);

    // workspace-local 存储随 workspace 切换重建；模块级引用供 launcher/editor 取当前实例
    let localStore: LocalConfigStore | null = null;
    let localActiveState: LocalActiveStateStore | null = null;

    function workspaceRoot(): string | null {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    }

    function applyWorkspace(): void {
        const root = workspaceRoot();
        if (root) {
            localStore = new LocalConfigStore(root);
            localActiveState = new LocalActiveStateStore(root);
        } else {
            localStore = null;
            localActiveState = null;
        }
        // treeProvider 与 webviewEditor/launcher 共享同一 local store 实例，保证 cache 一致
        treeProvider.setWorkspaceRoot(localStore, localActiveState);
    }

    const launcher = new ClaudeLauncher(
        () => localStore,
        () => localActiveState,
        proxyHost,
        output,
    );

    const treeProvider = new ConfigTreeProvider(store, activeState);
    applyWorkspace();

    const treeView = vscode.window.createTreeView('claude-code-proxy.configs', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // workspace 变化：重建 local store + 刷新树
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            applyWorkspace();
            void refresh();
        }),
    );

    const refresh = async (): Promise<void> => {
        treeProvider.refresh();
        await updateStatusBar();
    };

    const editor = new WebviewEditor(store, {
        onSaved: () => { void refresh(); },
        switchConfig: (cfg) => doSwitch(cfg),
        switchLocalConfig: (cfg) => doLocalSwitch(cfg),
        getLocalStore: () => localStore,
        loadGlobalConfigs: () => store.load(),
    });

    // --- Status bar indicator ---
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'claude-code-proxy.openView';
    statusItem.tooltip = 'Claude Code Proxy — click to open';
    context.subscriptions.push(statusItem);

    async function updateStatusBar(): Promise<void> {
        const configs = await store.load();
        const state = await activeState.load();
        let active: LLMConfig | undefined;
        if (state) {
            active = configs.find(c => c.id === state.id);
        }
        if (!active) {
            // 回退到 content 匹配（兼容老安装/直连）
            const platform = detectPlatform(getOverridePath());
            active = (await findActiveConfig(configs, platform.configPath)) ?? undefined;
        }
        const modeLabel = active?.mode === 'proxy' ? '代理' : '直连';
        statusItem.text = `$(arrow-swap) CC: ${active ? active.name : 'none'}${active ? ` (${modeLabel})` : ''}`;
        statusItem.show();
    }

    // --- Switch flow: read → backup → overwrite → toast(Reload + Undo) ---
    async function doSwitch(cfg: LLMConfig): Promise<void> {
        if (!cfg || typeof cfg.content !== 'string') {
            void vscode.window.showErrorMessage('Invalid config — missing content. Try editing and re-saving it.');
            return;
        }
        const platform = detectPlatform(getOverridePath());
        const configPath = platform.configPath;
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';

        // 代理模式：先确保代理在跑 + 注入上游
        let settingsContent = cfg.content;
        if (mode === 'proxy') {
            const upstream = extractUpstream(cfg.content);
            if (!upstream || !upstream.env.ANTHROPIC_BASE_URL || !upstream.env.ANTHROPIC_AUTH_TOKEN) {
                void vscode.window.showErrorMessage(`'${cfg.name}' 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN，无法走代理。`);
                return;
            }
            if (!proxyHost) {
                void vscode.window.showErrorMessage('代理尚未初始化');
                return;
            }
            try {
                await proxyHost.ensureRunning();
                await proxyHost.setUpstream({
                    baseUrl: upstream.env.ANTHROPIC_BASE_URL,
                    token: upstream.env.ANTHROPIC_AUTH_TOKEN,
                    model: upstream.env.ANTHROPIC_MODEL,
                    smallFastModel: upstream.env.ANTHROPIC_SMALL_FAST_MODEL,
                    timeoutSec: upstream.env.API_TIMEOUT_MS ? Math.round(Number(upstream.env.API_TIMEOUT_MS) / 1000) : undefined,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`代理模式启动/注入失败: ${msg}`);
                return;
            }
            const port = proxyHost.getPort();
            const synthesized = synthesizeProxySettings(cfg.content, port);
            if (!synthesized) {
                void vscode.window.showErrorMessage(`'${cfg.name}' content 不是有效 JSON，无法合成代理 settings。`);
                return;
            }
            settingsContent = synthesized;
        }

        const previous = await readSettings(configPath);
        let backupPath: string | null = null;
        try {
            backupPath = await backupSettings(configPath);
            await writeSettings(configPath, settingsContent);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to switch to '${cfg.name}': ${msg}`);
            return;
        }

        await activeState.write(cfg.id, mode);
        await refresh();

        const choice = await vscode.window.showInformationMessage(
            `Switched to '${cfg.name}' (${platform.label}${mode === 'proxy' ? ', 经代理' : ', 直连'}).`,
            'Reload Window',
            'Undo',
        );
        if (choice === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (choice === 'Undo') {
            await undoSwitch(configPath, previous, backupPath);
            await refresh();
        }
    }

    async function undoSwitch(
        configPath: string,
        previous: string | null,
        backupPath: string | null,
    ): Promise<void> {
        try {
            if (previous !== null) {
                await writeSettings(configPath, previous);
            } else {
                await fs.promises.unlink(configPath);
            }
            await activeState.clear();
            void vscode.window.showInformationMessage(
                `Reverted. Previous config restored${backupPath ? ` from ${backupPath}` : ''}.`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showWarningMessage(`Undo failed: ${msg}${backupPath ? ` — backup at ${backupPath}` : ''}`);
        }
    }

    /**
     * workspace-local 配置切换：纯标记。
     * 只记 local-active.json（id+mode），不写任何 settings.json、不 reload。
     * launcher 启动时读此标记 → 取对应 local 配置 → 写 .claude_proxy/settings.json 再起 claude。
     * proxy 模式也只标记，注入上游推迟到 launcher 启动时。
     */
    async function doLocalSwitch(cfg: LLMConfig): Promise<void> {
        if (!cfg || typeof cfg.content !== 'string') {
            void vscode.window.showErrorMessage('Invalid local config — missing content.');
            return;
        }
        if (!localActiveState) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
            return;
        }
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        await localActiveState.write(cfg.id, mode);
        await refresh();
        const modeLabel = mode === 'proxy' ? '经代理' : '直连';
        void vscode.window.showInformationMessage(
            `Local active → '${cfg.name}' (${modeLabel})。下次启动 workspace Claude 会话时生效。`,
        );
    }

    /** Resolve the LLMConfig from a command argument.
     *  - Clicking a tree row passes the LLMConfig directly via arguments.
     *  - Inline/context menus pass the TreeItem itself, so we look it up.
     */
    function resolveConfig(arg: unknown): LLMConfig | undefined {
        if (!arg) { return undefined; }
        // Direct LLMConfig (from TreeItem.command.arguments)
        if (typeof arg === 'object' && 'id' in arg && 'name' in arg && 'content' in arg) {
            return arg as LLMConfig;
        }
        // TreeItem from context/inline menu
        if (arg instanceof vscode.TreeItem) {
            return getConfigFromNode(arg);
        }
        return undefined;
    }

    async function pickConfig(action: string): Promise<LLMConfig | undefined> {
        const configs = await store.load();
        if (configs.length === 0) {
            void vscode.window.showInformationMessage('No configs yet. Create one first.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            configs.map(c => ({ label: c.name, description: c.id, config: c })),
            { placeHolder: `Select a config to ${action}` },
        );
        return picked?.config;
    }

    async function pickLocalConfig(action: string): Promise<LLMConfig | undefined> {
        if (!localStore) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
            return undefined;
        }
        const configs = await localStore.load();
        if (configs.length === 0) {
            void vscode.window.showInformationMessage('No workspace-local configs yet. Create one first.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            configs.map(c => ({ label: c.name, description: c.id, config: c })),
            { placeHolder: `Select a local config to ${action}` },
        );
        return picked?.config;
    }

    // --- Commands: global configs ---
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.newConfig', () => {
            void editor.openNewGlobal();
        }),

        vscode.commands.registerCommand('claude-code-proxy.editConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('edit').then(c => { if (c) { void editor.openEditGlobal(c); } });
                return;
            }
            void editor.openEditGlobal(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.switchConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('switch to').then(c => { if (c) { void doSwitch(c); } });
                return;
            }
            void doSwitch(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.deleteConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const target = resolveConfig(arg) ?? await pickConfig('delete');
            if (!target) {
                return;
            }
            await store.remove(target.id);
            await refresh();
        }),

        // --- Commands: workspace-local configs ---
        vscode.commands.registerCommand('claude-code-proxy.newLocalConfig', () => {
            void editor.openNewLocal();
        }),

        vscode.commands.registerCommand('claude-code-proxy.editLocalConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickLocalConfig('edit').then(c => { if (c) { void editor.openEditLocal(c); } });
                return;
            }
            void editor.openEditLocal(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.switchLocalConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickLocalConfig('switch to').then(c => { if (c) { void doLocalSwitch(c); } });
                return;
            }
            void doLocalSwitch(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.deleteLocalConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg) ?? await pickLocalConfig('delete');
            if (!cfg || !localStore) {
                return;
            }
            await localStore.remove(cfg.id);
            // 删的若正是 active，清掉标记
            const state = await localActiveState?.load();
            if (state && state.id === cfg.id) {
                await localActiveState?.clear();
            }
            await refresh();
        }),

        vscode.commands.registerCommand('claude-code-proxy.refresh', () => {
            void refresh();
        }),

        vscode.commands.registerCommand('claude-code-proxy.openView', () => {
            void vscode.commands.executeCommand('claude-code-proxy.configs.focus');
        }),

        // --- Export all configs to a JSON file ---
        vscode.commands.registerCommand('claude-code-proxy.exportConfigs', async () => {
            const configs = await store.load();
            if (configs.length === 0) {
                void vscode.window.showInformationMessage('No configs to export.');
                return;
            }
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('claude-code-proxy-configs.json'),
                filters: { 'JSON': ['json'] },
                title: 'Export Configs',
            });
            if (!uri) {
                return;
            }
            const payload = new TextEncoder().encode(JSON.stringify({ version: 1, configs }, null, 2));
            try {
                await vscode.workspace.fs.writeFile(uri, payload);
                void vscode.window.showInformationMessage(`Exported ${configs.length} config(s) to ${uri.fsPath || uri.toString()}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Export failed: ${msg}`);
            }
        }),

        // --- Import configs from a JSON file (skip duplicates by id) ---
        vscode.commands.registerCommand('claude-code-proxy.importConfigs', async () => {
            const uris = await vscode.window.showOpenDialog({
                filters: { 'JSON': ['json'] },
                title: 'Import Configs',
                canSelectMany: false,
            });
            if (!uris || uris.length === 0) {
                return;
            }
            let raw: string;
            try {
                // Use vscode.workspace.fs for cross-remote compatibility (WSL, SSH, etc.)
                const content = await vscode.workspace.fs.readFile(uris[0]);
                raw = new TextDecoder('utf8').decode(content);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Failed to read file: ${msg}`);
                return;
            }
            let data: unknown;
            try {
                data = JSON.parse(raw);
            } catch {
                void vscode.window.showErrorMessage('Invalid JSON file.');
                return;
            }
            // Accept both wrapped { version, configs } and bare LLMConfig[]
            let imported: LLMConfig[];
            if (Array.isArray(data)) {
                imported = data;
            } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).configs)) {
                imported = (data as { configs: LLMConfig[] }).configs;
            } else {
                void vscode.window.showErrorMessage('Unrecognized format. Expected { version, configs } or a JSON array.');
                return;
            }
            if (imported.length === 0) {
                void vscode.window.showInformationMessage('No configs found in the file.');
                return;
            }
            const existing = await store.load();
            const existingIds = new Set(existing.map(c => c.id));
            let added = 0;
            let skipped = 0;
            for (const cfg of imported) {
                if (!cfg || !cfg.id || !cfg.name || typeof cfg.content !== 'string') {
                    skipped++;
                    continue;
                }
                if (existingIds.has(cfg.id)) {
                    skipped++;
                    continue;
                }
                // Ensure updatedAt has a valid value
                if (!cfg.updatedAt) {
                    cfg.updatedAt = new Date().toISOString();
                }
                existing.push(cfg);
                existingIds.add(cfg.id);
                added++;
            }
            await store.save(existing);
            await refresh();
            const parts = [`Imported ${added} config(s).`];
            if (skipped > 0) {
                parts.push(`${skipped} skipped (duplicate or invalid).`);
            }
            void vscode.window.showInformationMessage(parts.join(' '));
        }),
    );

    // React to override-path setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('claude-code-proxy.configFilePath')) {
                void refresh();
            }
        }),
    );

    // 打开代理 Web 控制台（重试参数 + trace）
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.openProxyUI', async () => {
            const port = proxyHost?.getPort() ?? 11434;
            await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
        }),
    );

    // Kill 代理：任意窗口都能调，关闭 11434 上的代理监听，宿主心跳 2s 内自动重起
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.killProxy', async () => {
            if (!proxyHost) {
                void vscode.window.showWarningMessage('代理尚未初始化');
                return;
            }
            const result = await proxyHost.kill();
            if (result.ok) {
                void vscode.window.showInformationMessage(result.message);
            } else {
                void vscode.window.showWarningMessage(result.message);
            }
        }),
    );

    // 启动 workspace 独立 Claude CLI 会话：CLAUDE_CONFIG_DIR 指向 {workspace}/.claude_proxy/，
    // 继承当前激活配置（proxy 模式走本地代理）。工具栏按钮 + 快捷键 + 命令面板三入口。
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.launchWorkspaceClaude', () => {
            void launcher.launch();
        }),
    );

    // 同步「backup proxy 开关」上下文键，供树视图标题栏按钮用 when 子句切换开/关图标
    async function syncProxyToggleContext(): Promise<void> {
        const enabled = proxyToggle.isEnabled();
        await vscode.commands.executeCommand('setContext', 'claude-code-proxy.proxyToggleEnabled', enabled);
    }

    // backup proxy 本窗口开关（树视图标题栏按钮 + 命令面板）。只控本窗口，不管其他窗口是否接管。
    // 关：本窗口若是宿主则停进程，此后心跳不接管。开：复用其他窗口或自己起。
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackup', async () => {
            if (!proxyHost) {
                void vscode.window.showWarningMessage('代理尚未初始化');
                return;
            }
            const next = !proxyHost.isToggleEnabled();
            const result = await proxyHost.setEnabled(next);
            await syncProxyToggleContext();
            if (result.enabled) {
                void vscode.window.showInformationMessage(result.message);
            } else {
                void vscode.window.showWarningMessage(result.message);
            }
        }),
        // 标题栏两个图标按钮各自指向同一 toggle 逻辑（按钮本身是开/关的视觉态）
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackupOn', () => {
            void vscode.commands.executeCommand('claude-code-proxy.toggleProxyBackup');
        }),
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackupOff', () => {
            void vscode.commands.executeCommand('claude-code-proxy.toggleProxyBackup');
        }),
    );

    // 启动进程内代理（常驻 + 心跳 + 单例）。开关是纯内存态默认开，先同步设上下文键避免标题栏图标闪烁。
    void syncProxyToggleContext();
    void proxyHost?.activate();

    void refresh();
}

export async function deactivate(): Promise<void> {
    // 停止本窗口代理（其他窗口心跳会接管）
    if (proxyHost) {
        await proxyHost.deactivate();
        proxyHost = null;
    }
}
