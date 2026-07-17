import * as fs from 'fs';
import * as path from 'path';
import type { LLMConfig, ActiveState, ConfigMode } from './types';
import { newId } from './configStore';

/** workspace 下独立配置目录名（与 launcher 的 CLAUDE_CONFIG_DIR 一致）。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * workspace-local LLM 配置持久化，镜像 ConfigStore 但路径基于 workspace 根。
 * 文件：{workspace}/.claude_proxy/local-configs.json（LLMConfig[] 数组）。
 * 与 global 的 ConfigStore 并存：local 只管 workspace 隔离会话，不写全局 ~/.claude/。
 */
export class LocalConfigStore {
    private readonly filePath: string;
    private cache: LLMConfig[] | undefined;

    constructor(workspaceRoot: string) {
        this.filePath = path.join(workspaceRoot, WORKSPACE_CONFIG_DIR, 'local-configs.json');
    }

    /** 供 launcher 等取目录路径用。 */
    get configDir(): string {
        return path.dirname(this.filePath);
    }

    async load(): Promise<LLMConfig[]> {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as LLMConfig[];
            this.cache = (Array.isArray(parsed) ? parsed : []).map(c => ({
                ...c,
                mode: c.mode === 'proxy' ? 'proxy' : 'direct',
            }));
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                console.error('[claude-code-proxy] Failed to read local-configs.json:', err);
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

/**
 * workspace-local 的 active 标记，镜像 ActiveStateStore 但路径基于 workspace 根。
 * 文件：{workspace}/.claude_proxy/local-active.json（{id, mode}）。
 *
 * 与 global 的 active 不同：local active 是**纯标记**——只记录当前 workspace 隔离会话
 * 用哪条 local 配置，不写任何 settings.json、不触发 reload。launcher 启动时读它。
 */
export class LocalActiveStateStore {
    private readonly filePath: string;
    private cache: ActiveState | null | undefined;

    constructor(workspaceRoot: string) {
        this.filePath = path.join(workspaceRoot, WORKSPACE_CONFIG_DIR, 'local-active.json');
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
                console.error('[claude-code-proxy] Failed to read local-active.json:', err);
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
                console.error('[claude-code-proxy] Failed to clear local-active.json:', err);
            }
        }
    }
}

/** 重新复用 global 的新 id 生成器，保持一致。 */
export { newId };

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
