/**
 * 从 LLMConfig content 解析上游 env、合成代理 settings 的纯函数。
 * 独立成模块以避免 extension.ts ↔ claudeLauncher.ts 的循环依赖：
 * extension.ts（doSwitch）与 claudeLauncher.ts 都从这里 import。
 */

/** 从配置 content 解出上游 env（代理模式用） */
export function extractUpstream(content: string): { env: Record<string, string>; obj: Record<string, unknown> } | null {
    try {
        const obj = JSON.parse(content) as Record<string, unknown>;
        const env = (obj.env ?? {}) as Record<string, string>;
        return { env, obj };
    } catch {
        return null;
    }
}

/** 代理模式：把 content 的 baseUrl 改成指向代理，作为写到 settings.json 的内容 */
export function synthesizeProxySettings(content: string, port: number): string | null {
    const parsed = extractUpstream(content);
    if (!parsed) return null;
    parsed.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    parsed.obj.env = parsed.env;
    return JSON.stringify(parsed.obj, null, 2);
}
