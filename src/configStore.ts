import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';

/**
 * Persists the user's saved LLM configs to a single JSON file inside the
 * extension's globalStorage directory (cross-workspace, doesn't pollute the
 * user's project folders).
 */
export class ConfigStore {
    private readonly filePath: string;
    private cache: LLMConfig[] | undefined;

    constructor(storageDir: vscode.Uri) {
        this.filePath = path.join(storageDir.fsPath, 'configs.json');
    }

    async load(): Promise<LLMConfig[]> {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as LLMConfig[];
            // 向后兼容：老配置没有 mode 字段，补默认 'direct'
            this.cache = (Array.isArray(parsed) ? parsed : []).map(c => ({
                ...c,
                mode: c.mode === 'proxy' ? 'proxy' : 'direct',
            }));
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                // Corrupt file: surface but don't crash — start empty.
                console.error('[cc-switch] Failed to read configs.json:', err);
            }
            this.cache = [];
        }
        return this.cache;
    }

    async save(configs: LLMConfig[]): Promise<void> {
        this.cache = configs;
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(this.filePath, JSON.stringify(configs, null, 2), 'utf8');
    }

    async upsert(config: LLMConfig): Promise<LLMConfig[]> {
        const configs = await this.load();
        const idx = configs.findIndex(c => c.id === config.id);
        if (idx >= 0) {
            configs[idx] = config;
        } else {
            configs.push(config);
        }
        await this.save(configs);
        return configs;
    }

    async remove(id: string): Promise<LLMConfig[]> {
        const configs = (await this.load()).filter(c => c.id !== id);
        await this.save(configs);
        return configs;
    }

    async get(id: string): Promise<LLMConfig | undefined> {
        return (await this.load()).find(c => c.id === id);
    }
}

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Generate a small unique id (enough for a local config library). */
export function newId(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
