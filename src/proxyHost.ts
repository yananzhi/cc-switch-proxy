import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { ProxyToggleStore } from './proxyToggle';

const HEARTBEAT_MS = 2000;
const HEALTH_TIMEOUT_MS = 500;

/**
 * 按平台给默认端口，避免 Windows + WSL 同机装时抢同一个 localhost 端口。
 * Windows ↔ WSL2 经 localhost 转发互通，同端口会串味，所以分开。
 * WSL 和原生 Linux 不区分（process.platform 都是 'linux'），统一 11435；
 * 原生 Linux 跟 Windows 本就不共享 localhost，不冲突。
 */
function defaultPortForPlatform(): number {
    switch (process.platform) {
        case 'win32': return 11434;
        case 'darwin': return 11436;
        case 'linux': return 11435;
        default: return 11435;
    }
}
const DEFAULT_PORT = defaultPortForPlatform();

/** 代理 startServer 返回的句柄（来自 ESM proxy/server.js） */
interface ProxyHandle {
    server: unknown;
    port: number;
    host: string;
    stop: () => Promise<void>;
}

/** 注入代理的上游配置（从激活的"通过代理"配置 content.env 解出） */
export interface UpstreamEnv {
    baseUrl: string;
    token: string;
    model?: string;
    smallFastModel?: string;
    timeoutSec?: number;
}

/** ESM proxy 模块导出的最小类型 */
interface ProxyModule {
    startServer: (opts: { configPath: string; logsDir: string; logsConfigPath: string }) => Promise<ProxyHandle>;
}

/**
 * 进程内 LLM 代理管理。
 * - 单例：靠端口 bind（EADDRINUSE）保证全局只有一个窗口实际跑代理。
 * - 心跳：每 2s 探测 /healthz；宿主自检、从机探测宿主，断了就接管。
 * - 生命周期跟着扩展：activate 起、deactivate 停（其他窗口心跳接管）。
 */
export class ProxyHost {
    private statusBar: vscode.StatusBarItem;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private handle: ProxyHandle | null = null; // 非 null = 本窗口是宿主
    private proxyModule: ProxyModule | null = null;
    private readonly configPath: string;
    private readonly logsDir: string;
    private readonly logsConfigPath: string;
    private readonly extensionPath: string;
    private readonly output: vscode.OutputChannel;
    private readonly toggle: ProxyToggleStore;

    constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel, toggle: ProxyToggleStore) {
        this.extensionPath = context.extensionPath;
        this.configPath = path.join(context.globalStorageUri.fsPath, 'proxy-config.json');
        this.logsDir = path.join(context.globalStorageUri.fsPath, 'logs');
        // logs-config.json 也放 globalStorage：存用户配置的 logsDir，代理重启后能重新读到
        this.logsConfigPath = path.join(context.globalStorageUri.fsPath, 'logs-config.json');
        this.output = output;
        this.toggle = toggle;

        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'claude-code-proxy.openProxyUI';
        context.subscriptions.push(this.statusBar);
    }

    async activate(): Promise<void> {
        // 先把状态栏亮出来，这样即使后续任一步失败，云朵图标（显示“未运行”）也在，
        // 用户能看到扩展活着、并能点开控制台。否则异常被 void 吞掉后啥都没有。
        this.statusBar.show();
        try {
            await fs.promises.mkdir(this.logsDir, { recursive: true });
            if (!fs.existsSync(this.configPath)) {
                fs.writeFileSync(this.configPath, JSON.stringify(DEFAULT_PROXY_CONFIG, null, 2) + '\n', 'utf8');
            }
            // backup proxy 开关为纯内存态（默认允许），tryBecomeHost 内部会再尊重它。
            // 开关关闭时本窗口不启动代理、心跳不接管；打开时复用其他窗口或自己起。
            await this.tryBecomeHost();
            this.heartbeatTimer = setInterval(() => { void this.heartbeatTick(); }, HEARTBEAT_MS);
        } catch (e: unknown) {
            // 兜底：任何未预期的异常都记日志，不被外层 void 静默吞掉。
            this.log('activate() 异常:', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
        }
    }

    async deactivate(): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.handle) {
            this.log('扩展卸载，停止本窗口代理（其他窗口心跳会接管）');
            try { await this.handle.stop(); } catch {}
            this.handle = null;
        }
    }

    getPort(): number {
        try {
            const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            return cfg.proxy?.listenPort || DEFAULT_PORT;
        } catch {
            return DEFAULT_PORT;
        }
    }

    /** 确保代理在跑（不通则本窗口起；EADDRINUSE 则当从机）。开关关闭时抛错让调用方提示。 */
    async ensureRunning(): Promise<void> {
        if (!this.toggle.isEnabled()) {
            throw new Error('backup proxy 已被本窗口禁用（树视图开关为关）。请在侧边栏打开开关后再切到代理模式配置。');
        }
        await this.tryBecomeHost();
    }

    /**
     * 切换本窗口 backup proxy 开关。
     * - 开→关：若本窗口是宿主，停掉本窗口进程；心跳此后不再接管（本窗口变旁观者）。
     *           停掉后其他保活从机窗口会在 2s 内接管 —— 预期行为，本开关只控本窗口。
     * - 关→开：探 11434 —— 有其他窗口在跑则复用保心跳、自己不起；没有则自己起。
     * 返回切换后的状态字符串供 UI 提示。
     */
    async setEnabled(on: boolean): Promise<{ enabled: boolean; message: string }> {
        const prev = this.toggle.isEnabled();
        this.toggle.setEnabled(on);
        if (on === prev) {
            // 状态未变，仍刷新状态栏以反映真实运行态
            this.updateStatusBar();
            return { enabled: on, message: on ? 'backup proxy 已是开启状态' : 'backup proxy 已是关闭状态' };
        }
        if (!on) {
            // 开→关：停本窗口进程
            if (this.handle) {
                this.log('backup proxy 开关→关，停掉本窗口代理进程（其他窗口心跳将接管）');
                try { await this.handle.stop(); } catch {}
                this.handle = null;
            } else {
                this.log('backup proxy 开关→关（本窗口本非宿主，无需停进程）');
            }
            this.updateStatusBar();
            return { enabled: false, message: '已禁用本窗口 backup proxy。若其他窗口保活，它们会接管。' };
        }
        // 关→开：尝试成为宿主（复用/启动）
        this.log('backup proxy 开关→开，尝试复用或启动');
        await this.tryBecomeHost();
        this.updateStatusBar();
        const port = this.getPort();
        const runningElsewhere = !this.handle && await healthz(port);
        return {
            enabled: true,
            message: this.handle
                ? `已在本窗口启动 backup proxy (127.0.0.1:${this.handle.port})`
                : (runningElsewhere ? '已复用其他窗口的 backup proxy（本窗口保心跳）' : '已允许本窗口启动 backup proxy'),
        };
    }

    isToggleEnabled(): boolean {
        return this.toggle.isEnabled();
    }

    /**
     * Kill 代理：POST /api/kill 让运行中的代理关闭监听句柄。
     * 任意窗口都能调（不限于宿主）——只要 11434 上有代理在跑就发过去。
     * 关闭后宿主窗口心跳（≤2s）发现 healthz 不通，tryBecomeHost 重起一个。
     * 注意：重起的是宿主内存里已缓存的 proxyModule，改了 proxy 代码不会因此重新加载。
     */
    async kill(): Promise<{ ok: boolean; message: string }> {
        const port = this.getPort();
        // 先探一下有没有代理在跑，没在跑就直接说明
        const up = await healthz(port);
        if (!up) {
            return { ok: false, message: `代理未在运行（127.0.0.1:${port} 无监听），无需 kill` };
        }
        try {
            await new Promise<void>((resolve, reject) => {
                const req = http.request(
                    `http://127.0.0.1:${port}/api/kill`,
                    { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 3000 },
                    (res) => {
                        res.resume();
                        res.on('end', () => {
                            if (res.statusCode === 200) resolve();
                            else reject(new Error(`代理返回 ${res.statusCode}`));
                        });
                    },
                );
                req.on('error', reject);
                req.on('timeout', () => reject(new Error('kill 请求超时')));
                req.end();
            });
            return { ok: true, message: `已关闭代理监听，宿主窗口心跳将在 2s 内自动重起` };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, message: `kill 失败: ${msg}` };
        }
    }

    /** 把上游配置注入运行中的代理（POST /api/upstream） */
    async setUpstream(env: UpstreamEnv): Promise<void> {
        const port = this.getPort();
        const body = JSON.stringify({
            upstream: {
                baseUrl: env.baseUrl,
                token: env.token,
                model: env.model ?? '',
                smallFastModel: env.smallFastModel ?? '',
                timeoutSec: env.timeoutSec ?? 600,
            },
        });
        await new Promise<void>((resolve, reject) => {
            const req = http.request(
                `http://127.0.0.1:${port}/api/upstream`,
                { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 3000 },
                (res) => {
                    res.resume();
                    res.on('end', () => {
                        if (res.statusCode === 200) resolve();
                        else reject(new Error(`代理返回 ${res.statusCode}`));
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('注入上游超时（代理未运行？）')));
            req.end(body);
        });
        this.log(`已注入上游: ${env.baseUrl} model=${env.model ?? '(unset)'}`);
    }

    private async tryBecomeHost(): Promise<void> {
        if (!this.toggle.isEnabled()) return; // 开关关闭：本窗口不启动也不接管
        if (this.handle) return; // 已是宿主
        const port = this.getPort();
        if (await healthz(port)) return; // 别的窗口在跑
        // 动态加载 ESM 代理模块。import() 必须在 try 内，否则抛错会被外层 void 吞掉，
        // 导致零日志、零云朵、零监听——无法诊断。
        // 加载方式照搬 llmAutoRetry（已验证能在扩展宿主跑）：用相对路径 './...' 或 '../...'
        // 形式，而非 pathToFileURL 产生的 file:// 绝对 URL。原因：VS Code 扩展宿主
        // （Electron）对带 file:// scheme 的字符串会走 CJS require 拦截路径，把整个 URL
        // 当模块名解析，报 "Cannot find module 'file:///...'"。相对路径不带 scheme，
        // Node 按 proxy/package.json 的 "type":"module" 把 server.js 当 ESM 加载，
        // 三平台一致。out/proxyHost.js 到 proxy/server.js 是 ../proxy/server.js。
        try {
            if (!this.proxyModule) {
                this.log('动态加载代理模块: ../proxy/server.js');
                // @ts-expect-error server.js 是 ESM、无 .d.ts；运行时由 Node 解析，类型此处无意义。
                this.proxyModule = await import('../proxy/server.js') as ProxyModule;
                if (!this.proxyModule?.startServer) {
                    throw new Error(`代理模块未导出 startServer（实际导出: ${Object.keys(this.proxyModule ?? {}).join(',') || '无'})`);
                }
            }
            this.handle = await this.proxyModule.startServer({ configPath: this.configPath, logsDir: this.logsDir, logsConfigPath: this.logsConfigPath });
            this.log(`成为宿主，代理在 127.0.0.1:${this.handle.port} 运行（本窗口）`);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === 'EADDRINUSE') {
                this.log('端口已被占用（别的窗口已起代理），本窗口作为从机');
            } else {
                this.log('启动代理失败:', err.message || String(e), err.stack ?? '');
            }
        }
        this.updateStatusBar();
    }

    private async heartbeatTick(): Promise<void> {
        // 开关关闭：本窗口不持代理、不接管、只更新状态栏。保持空转心跳以便随时感知开关重开。
        if (!this.toggle.isEnabled()) {
            // 防御：若本窗口仍持着 handle（理论不会，setEnabled(false) 已 stop），强制清掉
            if (this.handle) {
                try { await this.handle.stop(); } catch {}
                this.handle = null;
            }
            this.updateStatusBar();
            return;
        }
        const port = this.getPort();
        if (this.handle) {
            // 宿主自检
            if (!(await healthz(this.handle.port))) {
                this.log('本窗口代理异常，尝试重启');
                try { await this.handle.stop(); } catch {}
                this.handle = null;
                await this.tryBecomeHost();
            }
            return;
        }
        // 从机：探测宿主是否还在，不在就接管
        if (!(await healthz(port))) {
            this.log('探测到代理不在，尝试接管');
            await this.tryBecomeHost();
        }
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (!this.toggle.isEnabled()) {
            this.statusBar.text = '$(circle-slash) 代理:本窗口禁用';
            this.statusBar.tooltip = 'backup proxy 已在本窗口禁用（树视图开关为关）。\n其他窗口若保活会接管；本窗口不启动、不接管。\n点击打开控制台（若代理在别处运行）';
            return;
        }
        if (this.handle) {
            this.statusBar.text = '$(cloud) 代理:本窗口运行';
            this.statusBar.tooltip = `LLM 代理在本窗口运行 (127.0.0.1:${this.handle.port})\n点击打开控制台`;
        } else {
            this.statusBar.text = '$(cloud) 代理:检测中…';
            const port = this.getPort();
            healthz(port).then((up) => {
                if (this.handle) return;
                if (!this.toggle.isEnabled()) return; // 期间被禁用了，不覆盖禁用态
                this.statusBar.text = up ? '$(cloud) 代理:其他窗口运行' : '$(cloud) 代理:未运行';
                this.statusBar.tooltip = up
                    ? `代理在其他窗口运行 (127.0.0.1:${port})\n点击打开控制台`
                    : `代理未运行，下次心跳将尝试启动\n点击打开控制台`;
            });
        }
    }

    private log(...a: unknown[]): void {
        const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
        this.output.appendLine(line);
    }
}

function healthz(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
        const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
            const ok = res.statusCode === 200;
            res.resume();
            res.on('end', () => finish(ok));
        });
        req.on('timeout', () => { req.destroy(); finish(false); });
        req.on('error', () => finish(false));
    });
}

const DEFAULT_PROXY_CONFIG = {
    env: {
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_MODEL: '',
    },
    effortLevel: 'max',
    proxy: {
        listenHost: '127.0.0.1',
        listenPort: DEFAULT_PORT,
        maxAttempts: 20,
        backoffSec: 3,
        backoffMaxSec: 16,
        passthrough: false,
        // 只重试 Claude Code 处理不了的：503 + body error.code === 10310。
        // 其他状态码 Claude Code 自己能处理，代理不插手（避免拖慢 + 叠加重试）。
        retryOnStatus: [],
        retryOnBodyErrorCode: [10310],
    },
};
