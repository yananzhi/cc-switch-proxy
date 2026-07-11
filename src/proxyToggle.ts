import * as vscode from 'vscode';

/**
 * 记录「本窗口是否允许开启 backup proxy 进程」的开关状态。纯内存态，不持久化。
 *
 * 为什么不持久化：backup proxy 本身就活在扩展的运行态里（进程内 http.createServer），
 * 扩展一停代理即消亡。给一个运行态的东西做跨重启持久化是错位的——重启后代理本来
 * 就不在，开关只需在内存里决定「要不要起」，没有任何需要记住的历史。持久化反而会
 * 把状态写进 globalStorage（机器级共享文件），导致窗口 A 关了影响窗口 B 的判定，
 * 与「只控本窗口」矛盾。
 *
 * 因此：每个窗口各自持有一份内存态，首次默认允许（true），切换只影响当前窗口，
 * 窗口关闭即丢弃，重开窗口回到默认。窗口间互不干扰。
 *
 * 语义（只控本窗口，不管其他窗口是否接管）：
 *   - false（禁用）：本窗口不开代理。若本窗口当前是宿主 → 停掉进程；心跳不再成为宿主/接管。
 *     停掉后端口空出，其他保活的从机窗口会在 2s 内接管起自己的代理 —— 预期行为，
 *     本开关只保证「本窗口不持有那个进程」，不保证「全局没代理」。
 *   - true（允许）：探 11434 —— 有其他窗口在跑则复用保心跳、自己不起；没有则自己起（成为宿主）。
 */
export class ProxyToggleStore {
    private enabled: boolean = true; // 内存态；首次默认允许

    isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(on: boolean): void {
        this.enabled = on;
    }
}