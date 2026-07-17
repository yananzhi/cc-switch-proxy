import * as vscode from 'vscode';
import type { LLMConfig, PlatformInfo, ConfigMode } from './types';
import { ConfigStore } from './configStore';
import { ActiveStateStore } from './activeState';
import { detectPlatform, readSettings } from './claudeConfig';

/** A row in the sidebar tree — either the environment info or a config. */
export type ConfigNode = vscode.TreeItem;

/**
 * Maps TreeItem instances back to their LLMConfig data.
 * TreeItem.command.arguments only works for single-click; context/inline
 * menus receive the TreeItem itself, so we need this side-channel lookup.
 */
const itemToConfig = new WeakMap<vscode.TreeItem, LLMConfig>();

/** Retrieve the LLMConfig associated with a TreeItem (e.g. from a context menu). */
export function getConfigFromNode(node: vscode.TreeItem): LLMConfig | undefined {
    return itemToConfig.get(node);
}

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigNode> {
    private readonly _onDidChange = new vscode.EventEmitter<ConfigNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(
        private readonly store: ConfigStore,
        private readonly activeState: ActiveStateStore,
    ) {}

    refresh(): void {
        this._onDidChange.fire(undefined);
    }

    getTreeItem(node: ConfigNode): ConfigNode {
        return node;
    }

    async getChildren(element?: ConfigNode): Promise<ConfigNode[]> {
        if (element) {
            return []; // flat list — no nested children
        }

        const platform = detectPlatform(getOverridePath());
        const nodes: ConfigNode[] = [this.buildInfoNode(platform)];

        const configs = await this.store.load();
        const stateId = (await this.activeState.load())?.id;
        let activeConfigId: string | undefined = stateId;
        if (!activeConfigId) {
            // 回退到 content 匹配（兼容老安装/直连）
            const matched = await findActiveConfig(configs, platform.configPath);
            activeConfigId = matched?.id;
        }
        for (const cfg of configs) {
            nodes.push(this.buildConfigNode(cfg, activeConfigId === cfg.id));
        }
        return nodes;
    }

    private buildInfoNode(platform: PlatformInfo): ConfigNode {
        const item = new vscode.TreeItem(`Detected: ${platform.label}`);
        item.description = platform.configPath;
        item.tooltip = new vscode.MarkdownString(
            `**Claude Code Proxy — target**\n\nDetected environment: \`${platform.label}\`\n\nClaude Code config path:\n\`${platform.configPath}\``
        );
        item.iconPath = new vscode.ThemeIcon('vm-connect');
        item.contextValue = 'info';
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        return item;
    }

    private buildConfigNode(cfg: LLMConfig, active: boolean): ConfigNode {
        const mode: ConfigMode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        const modeLabel = mode === 'proxy' ? '代理' : '直连';
        const item = new vscode.TreeItem(cfg.name);
        const parts: string[] = [];
        if (active) parts.push('active');
        parts.push(modeLabel);
        item.description = parts.join(' · ');
        item.tooltip = new vscode.MarkdownString(
            `**${cfg.name}**${active ? ' — active' : ''}\n\n` +
            `模式: ${mode === 'proxy' ? '通过代理连接' : '直连'}\n\n` +
            `Click to switch to this config. Updated ${cfg.updatedAt}.\n\n` +
            '```\n' + previewContent(cfg.content) + '\n```'
        );
        // 代理模式用云朵图标；直连用圆点；激活态填充实心
        const icon = mode === 'proxy' ? 'cloud' : (active ? 'circle-filled' : 'circle-outline');
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = 'config';
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        // Store the config data so context/inline menu handlers can look it up.
        itemToConfig.set(item, cfg);
        // Single-click on the row switches to it (the core, frequent action).
        item.command = {
            command: 'claude-code-proxy.switchConfig',
            title: 'Switch to This Config',
            arguments: [cfg],
        };
        return item;
    }
}

/** The config whose content matches the live settings.json, or null. */
export async function findActiveConfig(
    configs: LLMConfig[],
    configPath: string,
): Promise<LLMConfig | null> {
    const live = await readSettings(configPath);
    if (live === null) {
        return null;
    }
    const liveNorm = normalizeJson(live);
    if (liveNorm === null) {
        return null;
    }
    for (const cfg of configs) {
        const cfgNorm = normalizeJson(cfg.content);
        if (cfgNorm !== null && cfgNorm === liveNorm) {
            return cfg;
        }
    }
    return null;
}

function previewContent(content: string, max = 400): string {
    const trimmed = content.trim();
    return trimmed.length > max ? trimmed.slice(0, max) + '\n…' : trimmed;
}

/** Parse + re-stringify so cosmetic whitespace doesn't defeat active detection. */
function normalizeJson(raw: string): string | null {
    try {
        return JSON.stringify(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function getOverridePath(): string {
    return vscode.workspace.getConfiguration('claude-code-proxy').get<string>('configFilePath') || '';
}
