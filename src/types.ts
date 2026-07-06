export type ConfigMode = 'direct' | 'proxy';

export interface LLMConfig {
    /** Stable unique id (uuid-ish). */
    id: string;
    /** Human-friendly name shown in the tree. */
    name: string;
    /** Full settings.json content to be written on switch. */
    content: string;
    /** 连接模式：direct=直连上游（默认），proxy=经本地代理（代理用此配置的上游） */
    mode?: ConfigMode;
    /** ISO timestamp of last modification. */
    updatedAt: string;
}

/** 激活态记录：当前激活了哪条配置、什么模式。 */
export interface ActiveState {
    id: string;
    mode: ConfigMode;
}

export interface PlatformInfo {
    /** Raw process.platform value: 'win32' | 'darwin' | 'linux'. */
    platform: NodeJS.Platform;
    /** Friendly label, e.g. "Windows", "macOS", "Linux (WSL: Ubuntu)". */
    label: string;
    /** Resolved path to ~/.claude/settings.json (or override). */
    configPath: string;
}

/** Result of a switch operation, enough to offer an undo. */
export interface SwitchResult {
    /** The config that was activated. */
    config: LLMConfig;
    /** Path that was overwritten. */
    configPath: string;
    /** Backup file path holding the previous content (for undo). */
    backupPath: string;
    /** Content that was replaced, in case backup file is missing. */
    previousContent: string | null;
}
