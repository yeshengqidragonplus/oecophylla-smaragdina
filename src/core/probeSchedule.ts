/**
 * 对端探测节奏（不依赖 vscode）。
 *
 * 旧实现只给"在线或最近 180 秒内见过"的对端发心跳，失联 3 分钟后就永远不再探测——
 * 手工配置的对端、跨网段（广播到不了）的对端因此再也找不回。
 * 现在对**所有**已知对端持续探测，只是离线对端放慢节奏：
 * - 在线：每 30 秒一次心跳；
 * - 离线：前几次每 30 秒（刚掉线时尽快找回），之后每 60 秒。
 */

/** 在线对端的心跳间隔 */
export const ONLINE_PROBE_INTERVAL = 30_000;
/** 离线对端的快速探测间隔与次数 */
export const OFFLINE_PROBE_FAST_INTERVAL = 30_000;
export const OFFLINE_PROBE_FAST_TRIES = 3;
/** 离线对端的慢速探测间隔 */
export const OFFLINE_PROBE_SLOW_INTERVAL = 60_000;

export interface ProbeState {
    lastProbeAt: number;
    /** 对离线对端连续探测的次数（对端上线后清零） */
    offlineProbes: number;
}

export function probeInterval(online: boolean, offlineProbes: number): number {
    if (online) {
        return ONLINE_PROBE_INTERVAL;
    }
    return offlineProbes < OFFLINE_PROBE_FAST_TRIES ? OFFLINE_PROBE_FAST_INTERVAL : OFFLINE_PROBE_SLOW_INTERVAL;
}

/** 是否该探测了；从未探测过的对端立即探测 */
export function isProbeDue(online: boolean, state: ProbeState | undefined, now: number): boolean {
    if (!state) {
        return true;
    }
    return now - state.lastProbeAt >= probeInterval(online, state.offlineProbes);
}

/** 记录一次探测后的新状态 */
export function nextProbeState(online: boolean, state: ProbeState | undefined, now: number): ProbeState {
    return {
        lastProbeAt: now,
        offlineProbes: online ? 0 : (state?.offlineProbes ?? 0) + 1
    };
}

/**
 * 维护节拍是否出现了异常间隔：两次节拍间隔超过 2 倍周期，说明进程被挂起过
 * （睡眠唤醒、macOS App Nap、Windows 现代待机、调试暂停……）。
 * 唤醒后网卡与地址常已变化、旧会话已失效，需要重新发现。
 */
export function isClockJump(lastTickAt: number, now: number, tickInterval: number): boolean {
    return lastTickAt > 0 && now - lastTickAt > tickInterval * 2;
}
