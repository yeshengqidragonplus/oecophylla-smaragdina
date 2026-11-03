import * as os from 'os';

/**
 * 网卡枚举、过滤与广播地址计算（不依赖 vscode）。
 *
 * 要解决的问题：
 * - 子网广播必须按掩码位运算（`ip | ~mask`）；按字节粗算在 /22、/23 等非 /24 网段上会算错；
 * - 机器上常有 Clash/Surge 的 TUN、Docker、WSL、虚拟机、VPN 等网卡，
 *   不能简单取"第一块非回环网卡"当作本机地址，也不能只向第一块网卡发广播。
 *
 * 过滤分两级：
 * - 硬排除：根本不是局域网地址（回环、链路本地、198.18/15、点对点 /31 /32、多播等），不会参与发现；
 * - 软降级：名称或 MAC 像虚拟网卡——排到后面但保留。因为 Hyper-V "外部交换机"等场景下，
 *   真实的局域网地址恰恰就挂在名为 vEthernet 的网卡上，直接剔除会导致一块可用网卡都没有。
 */

export interface RawAddress {
    address: string;
    netmask: string;
    family: string | number;
    mac: string;
    internal: boolean;
}

export type RawInterfaces = Record<string, RawAddress[] | undefined>;

export interface LanInterface {
    name: string;
    address: string;
    netmask: string;
    mac: string;
    /** 网段的定向广播地址，如 10.10.215.255 */
    broadcast: string;
    prefix: number;
    isPrivate: boolean;
    /** 名称或 MAC 命中虚拟网卡特征（软信号） */
    virtual: boolean;
    virtualReason?: string;
}

// ==================== IPv4 基础运算 ====================

/** 点分 IPv4 转无符号 32 位整数；格式非法返回 null */
export function ipToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        return null;
    }
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        const octet = parseInt(part, 10);
        if (octet > 255) {
            return null;
        }
        value = value * 256 + octet;
    }
    return value;
}

export function intToIp(value: number): string {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** 子网掩码转前缀长度；非法（不连续）掩码返回 -1 */
export function maskToPrefix(mask: string): number {
    const value = ipToInt(mask);
    if (value === null) {
        return -1;
    }
    let prefix = 0;
    let seenZero = false;
    for (let bit = 31; bit >= 0; bit--) {
        const set = ((value >>> bit) & 1) === 1;
        if (set) {
            if (seenZero) {
                return -1;
            }
            prefix++;
        } else {
            seenZero = true;
        }
    }
    return prefix;
}

/** 定向广播地址：`ip | ~mask`。输入非法时返回 null */
export function computeBroadcast(ip: string, mask: string): string | null {
    const ipValue = ipToInt(ip);
    const maskValue = ipToInt(mask);
    if (ipValue === null || maskValue === null || maskToPrefix(mask) < 0) {
        return null;
    }
    return intToIp(((ipValue | ~maskValue) >>> 0));
}

export function isPrivateAddress(ip: string): boolean {
    const value = ipToInt(ip);
    if (value === null) {
        return false;
    }
    return inRange(value, '10.0.0.0', 8)
        || inRange(value, '172.16.0.0', 12)
        || inRange(value, '192.168.0.0', 16);
}

function inRange(value: number, base: string, prefix: number): boolean {
    const baseValue = ipToInt(base) as number;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

// ==================== 过滤与分类 ====================

function isIPv4(family: string | number): boolean {
    // 个别 Node 版本（18.0–18.3）把 family 返回为数字 4
    return family === 'IPv4' || family === 4;
}

/** 硬排除原因；返回 null 表示可作为局域网候选 */
export function hardExcludeReason(addr: RawAddress): string | null {
    if (!isIPv4(addr.family)) {
        return '非 IPv4';
    }
    if (addr.internal) {
        return '回环网卡';
    }
    const value = ipToInt(addr.address);
    if (value === null) {
        return '地址非法';
    }
    if (value === 0) {
        return '0.0.0.0';
    }
    if (inRange(value, '127.0.0.0', 8)) {
        return '回环地址';
    }
    if (inRange(value, '169.254.0.0', 16)) {
        return '链路本地地址（未获得 IP）';
    }
    if (inRange(value, '198.18.0.0', 15)) {
        return '198.18.0.0/15（Clash/Surge 等代理的 TUN 地址）';
    }
    if (value >= ipToInt('224.0.0.0')!) {
        return '多播/保留地址';
    }
    const prefix = maskToPrefix(addr.netmask);
    if (prefix < 0) {
        return '子网掩码非法';
    }
    if (prefix >= 31) {
        return '点对点链路（/31 或 /32），没有广播域';
    }
    return null;
}

const VIRTUAL_NAME_PATTERNS: RegExp[] = [
    // macOS
    /^(utun|awdl|llw|bridge|ap\d|anpi|gif|stf|p2p|vmnet|vboxnet)/,
    // Linux
    /^(docker|veth|br-|virbr|vnet|tun|tap|wg|tailscale|zt|lxc|lxd|cni|flannel|cali|kube|vmbr)/,
    // Windows（英文系统的网卡名）
    /(vethernet|vmware|virtualbox|vbox|hyper-v|wsl|docker|wintun|tap-windows|\btap\b|clash|meta tunnel|tailscale|zerotier|wireguard|openvpn|npcap|loopback|isatap|teredo|bluetooth|pseudo|vpn)/,
    // 中文系统的网卡名是本地化的
    /(虚拟|蓝牙|回环|隧道|伪)/
];

/** 常见虚拟化厂商的 MAC 前缀 */
const VIRTUAL_MAC_PREFIXES = [
    '00:50:56', '00:0c:29', '00:05:69', '00:1c:14', // VMware
    '08:00:27',                                     // VirtualBox
    '00:15:5d',                                     // Hyper-V / WSL
    '00:1c:42',                                     // Parallels
    '52:54:00',                                     // QEMU / KVM
    '02:42'                                         // Docker
];

/** 名称或 MAC 像虚拟网卡时返回原因，否则 null */
export function classifyVirtual(name: string, mac: string): string | null {
    const lowerName = name.toLowerCase();
    for (const pattern of VIRTUAL_NAME_PATTERNS) {
        if (pattern.test(lowerName)) {
            return `名称 "${name}" 像虚拟网卡`;
        }
    }
    const lowerMac = (mac || '').toLowerCase();
    if (lowerMac === '00:00:00:00:00:00') {
        return 'MAC 全零（隧道类网卡）';
    }
    if (VIRTUAL_MAC_PREFIXES.some(prefix => lowerMac.startsWith(prefix))) {
        return `MAC ${mac} 属于虚拟化厂商`;
    }
    return null;
}

/**
 * 枚举可用的局域网网卡：硬排除后，按"真实网卡优先、私网地址优先、原顺序"排序。
 * 第一项即主网卡。
 */
export function listLanInterfaces(raw: RawInterfaces = os.networkInterfaces() as RawInterfaces): LanInterface[] {
    const result: Array<LanInterface & { order: number }> = [];
    let order = 0;
    for (const name of Object.keys(raw)) {
        for (const addr of raw[name] ?? []) {
            order++;
            if (hardExcludeReason(addr) !== null) {
                continue;
            }
            const broadcast = computeBroadcast(addr.address, addr.netmask);
            if (broadcast === null) {
                continue;
            }
            const virtualReason = classifyVirtual(name, addr.mac);
            result.push({
                name,
                address: addr.address,
                netmask: addr.netmask,
                mac: addr.mac,
                broadcast,
                prefix: maskToPrefix(addr.netmask),
                isPrivate: isPrivateAddress(addr.address),
                virtual: virtualReason !== null,
                virtualReason: virtualReason ?? undefined,
                order
            });
        }
    }
    result.sort((a, b) =>
        Number(a.virtual) - Number(b.virtual)
        || Number(!a.isPrivate) - Number(!b.isPrivate)
        || a.order - b.order);
    return result.map(({ order: _order, ...iface }) => iface);
}

/** 主网卡（用于展示本机地址）；没有可用网卡时返回 undefined */
export function pickPrimary(list: LanInterface[]): LanInterface | undefined {
    return list[0];
}

/** 本机全部 IPv4 地址（含回环和被硬排除的），用于识别"这个包是不是我自己发的" */
export function listLocalAddresses(raw: RawInterfaces = os.networkInterfaces() as RawInterfaces): Set<string> {
    const addresses = new Set<string>(['127.0.0.1']);
    for (const name of Object.keys(raw)) {
        for (const addr of raw[name] ?? []) {
            if (isIPv4(addr.family)) {
                addresses.add(addr.address);
            }
        }
    }
    return addresses;
}

/** 网卡指纹：网卡集合或地址变化时指纹随之变化，用于检测网络切换 */
export function interfaceFingerprint(list: LanInterface[]): string {
    return list.map(i => `${i.name}|${i.address}|${i.netmask}`).sort().join(';');
}

/** 本次要发送广播的目标：每块候选网卡的定向广播（去重），再加受限广播 */
export function broadcastTargets(list: LanInterface[]): string[] {
    const targets = new Set<string>(list.map(i => i.broadcast));
    targets.add('255.255.255.255');
    return Array.from(targets);
}

/** 被硬排除的 IPv4 地址及原因（回环不列出），供诊断展示"为什么这块网卡没被使用" */
export function listExcludedInterfaces(raw: RawInterfaces = os.networkInterfaces() as RawInterfaces): Array<{ name: string; address: string; reason: string }> {
    const excluded: Array<{ name: string; address: string; reason: string }> = [];
    for (const name of Object.keys(raw)) {
        for (const addr of raw[name] ?? []) {
            if (!isIPv4(addr.family) || addr.internal) {
                continue;
            }
            const reason = hardExcludeReason(addr);
            if (reason !== null) {
                excluded.push({ name, address: addr.address, reason });
            }
        }
    }
    return excluded;
}

/**
 * 枚举网段内的主机地址（不含网络地址、广播地址与本机地址），用于手动"扫描网段"。
 * 主机数超过 limit 时返回 null（如 /16 有 65534 个主机，不应逐个探测）。
 */
export function enumerateHosts(ip: string, mask: string, limit: number): string[] | null {
    const ipValue = ipToInt(ip);
    const maskValue = ipToInt(mask);
    const prefix = maskToPrefix(mask);
    if (ipValue === null || maskValue === null || prefix < 0 || prefix >= 31) {
        return [];
    }
    const hostCount = Math.pow(2, 32 - prefix) - 2;
    if (hostCount > limit) {
        return null;
    }
    const network = (ipValue & maskValue) >>> 0;
    const hosts: string[] = [];
    for (let offset = 1; offset <= hostCount; offset++) {
        const value = (network + offset) >>> 0;
        if (value !== ipValue) {
            hosts.push(intToIp(value));
        }
    }
    return hosts;
}
