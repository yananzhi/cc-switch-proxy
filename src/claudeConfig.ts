import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlatformInfo } from './types';

/**
 * Detect the host environment and resolve the Claude Code settings.json path.
 *
 * When VS Code is connected via Remote-WSL, the extension host runs inside WSL
 * (Linux), so os.homedir() already points at the WSL home directory. The same
 * `~/.claude/settings.json` path therefore works on Windows, macOS and WSL —
 * no UNC `\\wsl.localhost\` indirection is needed.
 */
export function detectPlatform(overridePath?: string): PlatformInfo {
    const platform = process.platform;
    let label: string;

    switch (platform) {
        case 'win32':
            label = 'Windows';
            break;
        case 'darwin':
            label = 'macOS';
            break;
        case 'linux':
            label = `Linux${detectWslSuffix()}`;
            break;
        default:
            label = String(platform);
    }

    const configPath = overridePath && overridePath.trim().length > 0
        ? overridePath.trim()
        : path.join(os.homedir(), '.claude', 'settings.json');

    return { platform, label, configPath };
}

/** Returns " (WSL: <distro>)" when running under WSL, else "". */
function detectWslSuffix(): string {
    try {
        const version = fs.readFileSync('/proc/version', 'utf8');
        if (/microsoft/i.test(version)) {
            const distro = process.env.WSL_DISTRO_NAME || 'unknown';
            return ` (WSL: ${distro})`;
        }
    } catch {
        // /proc/version not readable — not WSL (or no access); treat as plain Linux.
    }
    return '';
}

/** Read the current settings.json content, or null if it does not exist. */
export async function readSettings(configPath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(configPath, 'utf8');
    } catch (err: unknown) {
        if (isENOENT(err)) {
            return null;
        }
        throw err;
    }
}

/**
 * Back up the current settings.json into ~/.claude/backups/ with a timestamped
 * name. Returns the backup path, or null if there was nothing to back up.
 */
export async function backupSettings(configPath: string): Promise<string | null> {
    const current = await readSettings(configPath);
    if (current === null) {
        return null;
    }

    const dir = path.join(path.dirname(configPath), 'backups');
    await fs.promises.mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(configPath);
    const backupPath = path.join(dir, `${base}.bak-${stamp}`);
    await fs.promises.writeFile(backupPath, current, 'utf8');
    return backupPath;
}

/** Overwrite settings.json with the given content (creates parent dirs). */
export async function writeSettings(configPath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, content, 'utf8');
}

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
