import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ActiveState, ConfigMode } from './types';

/**
 * 记录当前激活了哪条配置、什么模式。
 * 替代旧的"靠 settings.json content 匹配"判定——因为"通过代理"模式下
 * settings.json 是合成的（baseUrl 改成 localhost），匹配不上原配置。
 */
export class ActiveStateStore {
    private readonly filePath: string;
    private cache: ActiveState | null | undefined;

    constructor(storageDir: vscode.Uri) {
        this.filePath = path.join(storageDir.fsPath, 'active.json');
    }

    async load(): Promise<ActiveState | null> {
        if (this.cache !== undefined) {
            return this.cache;
        }
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as ActiveState;
            this.cache = (parsed && parsed.id && parsed.mode) ? parsed : null;
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                console.error('[cc-switch] Failed to read active.json:', err);
            }
            this.cache = null;
        }
        return this.cache;
    }

    async write(id: string, mode: ConfigMode): Promise<void> {
        this.cache = { id, mode };
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
    }

    async clear(): Promise<void> {
        this.cache = null;
        try {
            await fs.promises.unlink(this.filePath);
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                console.error('[cc-switch] Failed to clear active.json:', err);
            }
        }
    }
}

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
