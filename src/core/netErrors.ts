/**
 * socket 错误分类与日志限流（不依赖 vscode）。
 *
 * 不同系统对同一类网络问题返回不同的错误码（macOS 无"本地网络"权限、Windows 网卡被禁用、
 * 睡眠唤醒后地址失效……），而用户看到的只是"没反应"。这里把错误码翻译成可读原因与处理建议，
 * 并避免网络断开时每个 UDP 包一条日志把输出通道刷爆。
 */

export type NetErrorKind = 'unreachable' | 'permission' | 'address' | 'busy' | 'reset' | 'size' | 'buffer' | 'other';

export interface NetErrorInfo {
    code: string;
    kind: NetErrorKind;
    message: string;
    hint: string;
}

export function classifyNetError(err: Error, platform: NodeJS.Platform = process.platform): NetErrorInfo {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    const message = err.message;

    switch (code) {
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
        case 'ENETDOWN':
            return {
                code, kind: 'unreachable', message,
                hint: platform === 'darwin'
                    ? '网络不可达：请检查网线/Wi-Fi；macOS 15 起还需在"系统设置 → 隐私与安全性 → 本地网络"中允许 Visual Studio Code'
                    : '网络不可达：请检查网线/Wi-Fi 是否已连接，或网络是否刚刚切换'
            };
        case 'EPERM':
        case 'EACCES':
            return {
                code, kind: 'permission', message,
                hint: platform === 'win32'
                    ? '系统拒绝了网络访问：请检查 Windows 防火墙（"公用"网络配置文件下也需放行）或安全软件'
                    : platform === 'darwin'
                        ? '系统拒绝了网络访问：请检查 macOS 防火墙与"本地网络"权限'
                        : '系统拒绝了网络访问：请检查防火墙或安全软件'
            };
        case 'EADDRNOTAVAIL':
            return { code, kind: 'address', message, hint: '本机地址已失效（网络可能刚切换），网卡重新检测后会自动恢复' };
        case 'EADDRINUSE':
            return { code, kind: 'busy', message, hint: '端口已被占用：可能另一个 VS Code 窗口已启动了 OS Chat，或被其他程序占用，请换一个端口' };
        case 'ECONNRESET':
        case 'ECONNREFUSED':
            return { code, kind: 'reset', message, hint: '对端没有监听该端口：通常表示对方未启动，或两端端口配置不一致' };
        case 'EMSGSIZE':
            return { code, kind: 'size', message, hint: '数据报超过链路 MTU，请降低 MTU' };
        case 'ENOBUFS':
            return { code, kind: 'buffer', message, hint: '系统发送缓冲区已满，通常是短时拥塞' };
        default:
            return { code, kind: 'other', message, hint: '' };
    }
}

/** 同一 key 在窗口期内只放行一次；被抑制的次数在下次放行时一并给出 */
export class ErrorThrottle {
    private _last = new Map<string, { at: number; suppressed: number }>();

    constructor(private readonly _intervalMs: number = 30_000) {}

    /**
     * @returns 应记录时返回"自上次记录以来被抑制的条数"（首次为 0）；应抑制时返回 null
     */
    check(key: string, now: number = Date.now()): number | null {
        const entry = this._last.get(key);
        if (!entry) {
            this._last.set(key, { at: now, suppressed: 0 });
            return 0;
        }
        if (now - entry.at >= this._intervalMs) {
            const suppressed = entry.suppressed;
            entry.at = now;
            entry.suppressed = 0;
            return suppressed;
        }
        entry.suppressed++;
        return null;
    }
}
