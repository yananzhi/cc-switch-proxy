import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 扩展改名 cc-switch → claude-code-proxy 后，VS Code 按 publisher.name 分配了新的
 * globalStorage 目录，旧数据（configs.json / active.json）留在旧目录里读不到。
 *
 * 这里做一次性迁移：若新 globalStorage 下没有 configs.json，且旧 publisher.id 目录下
 * 有，就把 configs.json 和 active.json 复制过来。已迁移过（新目录已有 configs.json）
 * 则什么都不做。失败只记日志，绝不抛——不影响扩展激活。
 */
const LEGACY_PUBLISHER_ID = 'zaczh.cc-switch';

/**
 * @param currentStorageDir 新扩展的 globalStorage 目录（context.globalStorageUri.fsPath）
 * @returns true 表示执行了迁移
 */
export function migrateFromLegacy(currentStorageDir: vscode.Uri): boolean {
    try {
        const newConfigsPath = path.join(currentStorageDir.fsPath, 'configs.json');
        // 已有 configs.json → 不迁移（无论是不是空数组，都认为初始化过）
        if (fs.existsSync(newConfigsPath)) {
            return false;
        }

        const globalStorageRoot = path.dirname(currentStorageDir.fsPath);
        const legacyDir = path.join(globalStorageRoot, LEGACY_PUBLISHER_ID);
        const legacyConfigsPath = path.join(legacyDir, 'configs.json');
        if (!fs.existsSync(legacyConfigsPath)) {
            return false; // 旧目录也没数据，无需迁移
        }

        // 同步复制：必须在 ConfigStore/ActiveStateStore 首次 load() 之前完成，否则 cache 读到空目录。
        fs.mkdirSync(currentStorageDir.fsPath, { recursive: true });
        fs.copyFileSync(legacyConfigsPath, newConfigsPath);

        const legacyActivePath = path.join(legacyDir, 'active.json');
        const hasActive = fs.existsSync(legacyActivePath);
        if (hasActive) {
            fs.copyFileSync(legacyActivePath, path.join(currentStorageDir.fsPath, 'active.json'));
        }

        console.log(`[claude-code-proxy] 迁移完成：从 ${legacyDir} 复制 configs.json${hasActive ? ' + active.json' : ''}`);
        return true;
    } catch (err) {
        console.error('[claude-code-proxy] 旧配置迁移失败（忽略，不影响激活）:', err);
        return false;
    }
}
