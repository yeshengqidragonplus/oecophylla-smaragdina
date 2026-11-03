import * as assert from 'assert';
import { DiagnosticInput, analyze, buildDiagnosticReport, firewallAdvice, requiredPorts } from '../../core/diagnostics';
import { PeerRecord } from '../../core/peerRegistry';

const NOW = 1_700_000_000_000;

function peer(overrides: Partial<PeerRecord>): PeerRecord {
    return {
        id: 'p1', ip: '10.0.0.2', port: 6688, transferPort: 7688, hostname: 'PC-A', aliases: [], manual: false,
        firstSeen: NOW, lastSeen: NOW, lastHeard: NOW, lastAck: NOW, pendingSince: 0, presence: 'online',
        ...overrides
    };
}

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
    return {
        now: NOW,
        env: { platform: 'win32', arch: 'x64', osRelease: '10.0.22631', node: '20.14.0', vscode: '1.92.0', version: '0.1.0', build: 'abcd1234' },
        status: { state: 'running', port: 6688, ip: '10.0.0.5', instanceId: 'machine:6688', boot: 'beef', interfaces: [] },
        settings: { port: 6688, nickname: 'Arthur', autoConnect: true },
        interfaces: [{ name: '以太网', address: '10.0.0.5', netmask: '255.255.252.0', mac: 'x', broadcast: '10.0.3.255', prefix: 22, isPrivate: true, virtual: false }],
        excluded: [{ name: 'Clash', address: '198.18.0.1', reason: '198.18.0.0/15（Clash/Surge 等代理的 TUN 地址）' }],
        peers: [peer({})],
        lastError: null,
        errorCounts: {},
        ...overrides
    };
}

const texts = (i: DiagnosticInput): string => analyze(i).map(f => f.text).join('\n');

suite('diagnostics：初步判断', () => {
    test('一切正常：给出"未发现明显问题"', () => {
        assert.strictEqual(analyze(input()).length, 1);
        assert.ok(texts(input()).includes('未发现明显问题'));
    });

    test('服务未运行 / 启动失败（端口占用给出针对性建议）', () => {
        assert.ok(texts(input({ status: { ...input().status, state: 'stopped' } })).includes('没有运行'));
        const busy = texts(input({ status: { ...input().status, state: 'error', error: 'KCP 传输层启动失败: bind EADDRINUSE' } }));
        assert.ok(busy.includes('端口被占用') && busy.includes('另一个 VS Code 窗口'));
    });

    test('没有可用网卡 / 全部是虚拟网卡', () => {
        assert.ok(texts(input({ interfaces: [] })).includes('没有可用的局域网网卡'));
        const virtualOnly = texts(input({
            interfaces: [{ ...input().interfaces[0], name: 'vEthernet (WSL)', virtual: true }]
        }));
        assert.ok(virtualOnly.includes('虚拟网卡'));
    });

    test('单向可达：指向防火墙并列出对端名称与需放行的端口', () => {
        const result = texts(input({ peers: [peer({ presence: 'oneway', nickname: 'Arthur-Win' })] }));
        assert.ok(result.includes('单向可达') && result.includes('Arthur-Win') && result.includes('防火墙'));
        assert.ok(result.includes('6688') && result.includes('7688') && result.includes('41320'));
    });

    test('EPERM / 不可达错误：按系统给出建议；macOS 提示本地网络权限', () => {
        const mac = input({ env: { ...input().env, platform: 'darwin' }, errorCounts: { EPERM: 3, EHOSTUNREACH: 2 } });
        const result = texts(mac);
        assert.ok(result.includes('3 次网络访问') && result.includes('本地网络'));
        assert.ok(result.includes('2 次"网络不可达"'));
    });

    test('运行中但没有任何对端：提示检查对方、防火墙并给出扫描网段与手动添加', () => {
        const result = texts(input({ peers: [] }));
        assert.ok(result.includes('还没有发现任何对端') && result.includes('扫描网段'));
    });
});

suite('diagnostics：报告内容', () => {
    test('requiredPorts：主端口、业务端口、固定发现端口', () => {
        assert.deepStrictEqual(requiredPorts(6688), [6688, 7688, 41320]);
    });

    test('Windows 给出 netsh 放行命令；macOS 给出设置路径；Linux 给出 ufw', () => {
        assert.ok(firewallAdvice('win32', 6688).some(l => l.startsWith('netsh advfirewall') && l.includes('localport=6688,7688,41320') && l.includes('profile=any')));
        assert.ok(firewallAdvice('darwin', 6688).some(l => l.includes('Code Helper (Plugin)')));
        assert.ok(firewallAdvice('linux', 6688).some(l => l.includes('ufw allow 6688/udp 7688/udp 41320/udp')));
    });

    test('报告包含各章节、网卡表、被排除网卡、对端表与错误统计', () => {
        const report = buildDiagnosticReport(input({
            peers: [peer({ presence: 'oneway', meta: { os: 'darwin', arch: 'arm64', version: '0.1.0', build: 'ff00aa11' } })],
            errorCounts: { EHOSTUNREACH: 2 },
            lastError: { code: 'EHOSTUNREACH', scope: 'udp', target: '10.0.0.9:6688', message: 'x', hint: '请检查网线', at: NOW - 5000 }
        }));
        for (const section of ['## 初步判断', '## 环境', '## 本机', '## 网卡', '## 对端（1）', '## 网络错误', '## 防火墙与权限']) {
            assert.ok(report.includes(section), `缺少章节 ${section}`);
        }
        assert.ok(report.includes('| 以太网 | 10.0.0.5/22 | 10.0.3.255 | 主网卡 |'));
        assert.ok(report.includes('Clash 198.18.0.1'));
        assert.ok(report.includes('单向可达') && report.includes('darwin arm64 v0.1.0 ff00aa11'));
        assert.ok(report.includes('EHOSTUNREACH × 2') && report.includes('5 秒前') && report.includes('请检查网线'));
        assert.ok(report.includes('端口（UDP）：主端口 6688'));
    });
});
