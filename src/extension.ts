import * as fs from 'fs';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import { ConfigStore } from './configStore';
import { ActiveStateStore } from './activeState';
import { ProxyHost } from './proxyHost';
import { ConfigTreeProvider, findActiveConfig, getOverridePath, getConfigFromNode } from './treeProvider';
import { WebviewEditor } from './webviewEditor';
import { backupSettings, detectPlatform, readSettings, writeSettings } from './claudeConfig';

// 模块级，供 deactivate 停止代理
let proxyHost: ProxyHost | null = null;

export function activate(context: vscode.ExtensionContext): void {
    const store = new ConfigStore(context.globalStorageUri);
    const activeState = new ActiveStateStore(context.globalStorageUri);
    const output = vscode.window.createOutputChannel('CC Switch + Proxy');
    context.subscriptions.push(output);
    proxyHost = new ProxyHost(context, output);

    const treeProvider = new ConfigTreeProvider(store, activeState);

    const treeView = vscode.window.createTreeView('cc-switch.configs', {
        treeDataProvider: treeProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);

    const refresh = async (): Promise<void> => {
        treeProvider.refresh();
        await updateStatusBar();
    };

    const editor = new WebviewEditor(store, {
        onSaved: () => { void refresh(); },
        switchConfig: (cfg) => doSwitch(cfg),
    });

    // --- Status bar indicator ---
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'cc-switch.openView';
    statusItem.tooltip = 'Claude Code Switch Setting — click to open';
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

    // --- 从配置 content 解出上游 env（代理模式用）---
    function extractUpstream(content: string): { env: Record<string, string>; obj: Record<string, unknown> } | null {
        try {
            const obj = JSON.parse(content) as Record<string, unknown>;
            const env = (obj.env ?? {}) as Record<string, string>;
            return { env, obj };
        } catch {
            return null;
        }
    }

    /** 代理模式：把 content 的 baseUrl 改成指向代理，作为写到 settings.json 的内容 */
    function synthesizeProxySettings(content: string, port: number): string | null {
        const parsed = extractUpstream(content);
        if (!parsed) return null;
        parsed.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
        parsed.obj.env = parsed.env;
        return JSON.stringify(parsed.obj, null, 2);
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

    // --- Commands ---
    context.subscriptions.push(
        vscode.commands.registerCommand('cc-switch.newConfig', () => {
            void editor.openNew();
        }),

        vscode.commands.registerCommand('cc-switch.editConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('edit').then(c => { if (c) { void editor.openEdit(c); } });
                return;
            }
            void editor.openEdit(cfg);
        }),

        vscode.commands.registerCommand('cc-switch.switchConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('switch to').then(c => { if (c) { void doSwitch(c); } });
                return;
            }
            void doSwitch(cfg);
        }),

        vscode.commands.registerCommand('cc-switch.deleteConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const target = resolveConfig(arg) ?? await pickConfig('delete');
            if (!target) {
                return;
            }
            await store.remove(target.id);
            await refresh();
        }),

        vscode.commands.registerCommand('cc-switch.refresh', () => {
            void refresh();
        }),

        vscode.commands.registerCommand('cc-switch.openView', () => {
            void vscode.commands.executeCommand('cc-switch.configs.focus');
        }),

        // --- Export all configs to a JSON file ---
        vscode.commands.registerCommand('cc-switch.exportConfigs', async () => {
            const configs = await store.load();
            if (configs.length === 0) {
                void vscode.window.showInformationMessage('No configs to export.');
                return;
            }
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('cc-switch-configs.json'),
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
        vscode.commands.registerCommand('cc-switch.importConfigs', async () => {
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
            if (e.affectsConfiguration('cc-switch.configFilePath')) {
                void refresh();
            }
        }),
    );

    // 打开代理 Web 控制台（重试参数 + trace）
    context.subscriptions.push(
        vscode.commands.registerCommand('cc-switch.openProxyUI', async () => {
            const port = proxyHost?.getPort() ?? 11434;
            await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
        }),
    );

    // Kill 代理：任意窗口都能调，关闭 11434 上的代理监听，宿主心跳 2s 内自动重起
    context.subscriptions.push(
        vscode.commands.registerCommand('cc-switch.killProxy', async () => {
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

    // 启动进程内代理（常驻 + 心跳 + 单例）
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
