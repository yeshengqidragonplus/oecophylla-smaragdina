import { NetworkStatus } from './networkService';
import { LanInterface } from './netInterfaces';
import { PeerRecord } from './peerRegistry';

/**
 * 诊断报告（不依赖 vscode）。
 *
 * "内网找不到对方"的原因分散在网卡、防火墙、系统权限、端口占用等多处，而且各系统不同；
 * 这里把当前状态汇总成一份可复制的报告，并按规则给出初步判断与处理建议，
 * 让用户（和我们）不必靠猜。
 */

export const DISCOVERY_PORT_DISPLAY = 41320;

export interface DiagnosticInput {
    now: number;
    env: {
        platform: NodeJS.Platform;
        arch: string;
        osRelease: string;
        node: string;
        vscode?: string;
        version?: string;
        build?: string;
    };
    status: NetworkStatus;
    settings: { port: number; nickname: string; autoConnect: boolean };
    interfaces: LanInterface[];
    excluded: Array<{ name: string; address: string; reason: string }>;
    peers: PeerRecord[];
    lastError: { code: string; scope: string; target?: string; message: string; hint: string; at: number } | null;
    errorCounts: Record<string, number>;
}

export interface Finding {
    level: 'error' | 'warn' | 'info';
    text: string;
}

/** 放行本插件所需的 UDP 端口：主端口、业务端口（主端口 + 1000）、固定发现端口 */
export function requiredPorts(mainPort: number): number[] {
    return [mainPort, mainPort + 1000, DISCOVERY_PORT_DISPLAY];
}

export function firewallAdvice(platform: NodeJS.Platform, mainPort: number): string[] {
    const ports = requiredPorts(mainPort);
    const list = ports.join(',');
    if (platform === 'win32') {
        return [
            `需要放行入站 UDP 端口 ${list}。以管理员身份在命令提示符中执行：`,
            `netsh advfirewall firewall add rule name="OS Chat" dir=in action=allow protocol=UDP localport=${list} profile=any`,
            '注意：Windows 防火墙按网络类型（专用/公用）分别放行。企业网络、"未识别的网络"常被归为"公用"，只放行了"专用"时入站会被静默丢弃。'
        ];
    }
    if (platform === 'darwin') {
        return [
            `需要允许入站 UDP 端口 ${list}。`,
            '系统设置 → 网络 → 防火墙：若已开启，请允许 Visual Studio Code（扩展宿主进程通常显示为 Code Helper (Plugin)）接受传入连接，且不要开启"阻止所有传入连接"。',
            'macOS 15 起：系统设置 → 隐私与安全性 → 本地网络，需要允许 Visual Studio Code。'
        ];
    }
    return [
        `需要放行入站 UDP 端口 ${list}。例如：sudo ufw allow ${ports.map(p => `${p}/udp`).join(' ')}`
    ];
}

/** 按规则给出初步判断 */
export function analyze(input: DiagnosticInput): Finding[] {
    const findings: Finding[] = [];
    const { status, peers, interfaces, errorCounts, env } = input;
    const portList = requiredPorts(input.settings.port).join(' / ');

    if (status.state === 'error') {
        const reason = status.error ?? '未知原因';
        findings.push({
            level: 'error',
            text: reason.includes('EADDRINUSE')
                ? `网络服务启动失败：端口被占用（${reason}）。可能另一个 VS Code 窗口已经启动了 OS Chat，或被其他程序占用，请关闭其他窗口或换一个端口。`
                : `网络服务启动失败：${reason}`
        });
    } else if (status.state === 'stopped') {
        findings.push({ level: 'warn', text: '网络服务没有运行：对方无法发现你。请启动网络服务（或开启自动启动设置）。' });
    }

    if (status.state === 'running' || status.state === 'starting') {
        if (interfaces.length === 0) {
            findings.push({
                level: 'error',
                text: '没有可用的局域网网卡：只检测到回环、链路本地（169.254）或代理 TUN 地址。请确认已连接到内网（有线或 Wi-Fi）并获得了 IP。'
            });
        } else if (interfaces.every(i => i.virtual)) {
            findings.push({
                level: 'warn',
                text: `可用网卡全部像虚拟网卡（${interfaces.map(i => i.name).join('、')}）。如果这不是你的真实内网网卡，请检查网线/Wi-Fi 或关闭代理软件的 TUN 模式。`
            });
        }
    }

    const oneway = peers.filter(p => p.presence === 'oneway');
    if (oneway.length > 0) {
        findings.push({
            level: 'warn',
            text: `${oneway.length} 个对端是"单向可达"（${oneway.map(p => p.nickname || p.hostname || p.ip).join('、')}）：能收到对方的包，但对方一直不应答我们的探测。最常见原因是本机或对方的防火墙拦截了入站 UDP（${portList}）。`
        });
    }

    const permissionErrors = (errorCounts.EPERM ?? 0) + (errorCounts.EACCES ?? 0);
    if (permissionErrors > 0) {
        findings.push({
            level: 'error',
            text: `系统拒绝了 ${permissionErrors} 次网络访问（EPERM/EACCES）。${env.platform === 'darwin' ? '请检查 macOS 防火墙与"本地网络"权限。' : env.platform === 'win32' ? '请检查 Windows 防火墙或安全软件。' : '请检查防火墙或安全软件。'}`
        });
    }
    const unreachable = (errorCounts.EHOSTUNREACH ?? 0) + (errorCounts.ENETUNREACH ?? 0) + (errorCounts.ENETDOWN ?? 0);
    if (unreachable > 0) {
        findings.push({
            level: 'warn',
            text: `出现 ${unreachable} 次"网络不可达"错误：网络可能刚刚切换、断开${env.platform === 'darwin' ? '，或 macOS 15 起未授予"本地网络"权限' : ''}。`
        });
    }

    if (status.state === 'running') {
        const online = peers.filter(p => p.presence === 'online').length;
        if (peers.length === 0) {
            findings.push({
                level: 'info',
                text: '还没有发现任何对端。请确认：① 对方也已启动并在同一网段；② 两端防火墙放行了上述端口；③ 广播可能被网络过滤——可以执行"扫描网段"或手动添加对方的 IP 与端口。'
            });
        } else if (online === 0 && oneway.length === 0) {
            findings.push({ level: 'info', text: `已知 ${peers.length} 个对端，但目前都不在线（对方未启动、已断网，或地址已变化）。` });
        }
    }

    if (findings.length === 0) {
        findings.push({ level: 'info', text: '未发现明显问题。' });
    }
    return findings;
}

function ago(now: number, at: number): string {
    if (!at) {
        return '从未';
    }
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) {
        return `${seconds} 秒前`;
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)} 分钟前`;
    }
    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)} 小时前`;
    }
    return `${Math.round(seconds / 86400)} 天前`;
}

const PRESENCE_TEXT = { online: '在线', oneway: '单向可达', offline: '离线' } as const;
const STATE_TEXT = { stopped: '已停止', starting: '启动中', running: '运行中', error: '启动失败' } as const;

/** 生成 Markdown 诊断报告 */
export function buildDiagnosticReport(input: DiagnosticInput): string {
    const { env, status, settings, interfaces, excluded, peers, lastError, errorCounts, now } = input;
    const lines: string[] = [];
    const push = (...l: string[]): void => { lines.push(...l); };

    push('# OS Chat 诊断报告', '', `生成时间：${new Date(now).toLocaleString()}`, '');

    push('## 初步判断', '');
    for (const f of analyze(input)) {
        const mark = f.level === 'error' ? '❌' : f.level === 'warn' ? '⚠️' : 'ℹ️';
        push(`- ${mark} ${f.text}`);
    }
    push('');

    push('## 环境', '',
        `- 系统：${env.platform} ${env.arch}（${env.osRelease}）`,
        `- VS Code：${env.vscode ?? '未知'}，Node：${env.node}`,
        `- 插件版本：${env.version ?? '未知'}，构建：${env.build ?? '未知'}`, '');

    push('## 本机', '',
        `- 状态：${STATE_TEXT[status.state]}${status.error ? `（${status.error}）` : ''}`,
        `- 昵称：${settings.nickname || '（未设置，使用计算机名）'}，自动启动：${settings.autoConnect ? '是' : '否'}`,
        `- 实例 ID：${status.instanceId || '（未启动）'}，boot：${status.boot || '（未启动）'}`,
        `- 端口（UDP）：主端口 ${settings.port}（发现应答与心跳）、业务端口 ${settings.port + 1000}（聊天与文件）、发现端口 ${DISCOVERY_PORT_DISPLAY}（接收广播）`, '');

    push('## 网卡', '');
    if (interfaces.length === 0) {
        push('没有可用的局域网网卡。', '');
    } else {
        push('| 名称 | 地址/前缀 | 广播地址 | 角色 |', '|---|---|---|---|');
        interfaces.forEach((iface, index) => {
            const role = index === 0 ? '主网卡' : iface.virtual ? `备用（${iface.virtualReason ?? '疑似虚拟网卡'}）` : '备用';
            push(`| ${iface.name} | ${iface.address}/${iface.prefix} | ${iface.broadcast} | ${role} |`);
        });
        push('');
    }
    if (excluded.length > 0) {
        push('被排除的网卡：', '');
        excluded.forEach(e => push(`- ${e.name} ${e.address}：${e.reason}`));
        push('');
    }

    push(`## 对端（${peers.length}）`, '');
    if (peers.length === 0) {
        push('（无）', '');
    } else {
        push('| 名称 | 地址 | 状态 | 最近往返确认 | 最近收到 | 系统/版本 |', '|---|---|---|---|---|---|');
        for (const p of peers) {
            const name = p.nickname || p.hostname || p.id;
            const meta = p.meta ? [p.meta.os, p.meta.arch, p.meta.version ? `v${p.meta.version}` : '', p.meta.build ?? ''].filter(Boolean).join(' ') : '旧版或未知';
            push(`| ${name}${p.manual ? '（手工）' : ''} | ${p.ip}:${p.port} | ${PRESENCE_TEXT[p.presence]} | ${ago(now, p.lastAck)} | ${ago(now, p.lastHeard)} | ${meta} |`);
        }
        push('');
    }

    push('## 网络错误', '');
    const codes = Object.keys(errorCounts);
    if (codes.length === 0 && !lastError) {
        push('（无）', '');
    } else {
        if (codes.length > 0) {
            push(`累计：${codes.map(c => `${c} × ${errorCounts[c]}`).join('，')}`, '');
        }
        if (lastError) {
            push(`最近一次：${ago(now, lastError.at)}，${lastError.scope}${lastError.target ? ` → ${lastError.target}` : ''}，${lastError.code} ${lastError.message}`);
            if (lastError.hint) {
                push(`建议：${lastError.hint}`);
            }
            push('');
        }
    }

    push('## 防火墙与权限', '');
    firewallAdvice(env.platform, settings.port).forEach(l => push(l.startsWith('netsh ') || l.startsWith('sudo ') ? `\`${l}\`` : `- ${l}`));
    push('');

    return lines.join('\n');
}
