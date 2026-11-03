import * as assert from 'assert';
import {
    RawAddress,
    RawInterfaces,
    broadcastTargets,
    computeBroadcast,
    enumerateHosts,
    hardExcludeReason,
    interfaceFingerprint,
    ipToInt,
    intToIp,
    listExcludedInterfaces,
    listLanInterfaces,
    listLocalAddresses,
    maskToPrefix,
    pickPrimary
} from '../../core/netInterfaces';

function addr(address: string, netmask: string, mac = 'aa:bb:cc:dd:ee:01', internal = false, family: string | number = 'IPv4'): RawAddress {
    return { address, netmask, mac, internal, family };
}

// 夹具：本机（Mac）的真实网卡布局，MAC 为示意值
const MAC_FIXTURE: RawInterfaces = {
    lo0: [addr('127.0.0.1', '255.0.0.0', '00:00:00:00:00:00', true)],
    en0: [addr('10.10.213.120', '255.255.252.0', 'a4:83:e7:11:22:33')],
    utun1500: [addr('198.18.0.1', '255.255.255.252', '00:00:00:00:00:00')]
};

// 夹具：中文 Windows 的典型布局（网卡名本地化），地址为示意值
const WINDOWS_ZH_FIXTURE: RawInterfaces = {
    '以太网': [addr('10.10.214.233', '255.255.252.0', '3c:ec:ef:11:22:33')],
    'vEthernet (WSL)': [addr('172.28.16.1', '255.255.240.0', '00:15:5d:aa:bb:cc')],
    'Clash': [addr('198.18.0.1', '255.255.255.252', '00:ff:aa:bb:cc:dd')],
    '本地连接* 1': [addr('169.254.12.5', '255.255.0.0', '3c:ec:ef:11:22:34')],
    '蓝牙网络连接': [addr('169.254.88.1', '255.255.0.0', '3c:ec:ef:11:22:35')],
    'Loopback Pseudo-Interface 1': [addr('127.0.0.1', '255.0.0.0', '00:00:00:00:00:00', true)]
};

const LINUX_FIXTURE: RawInterfaces = {
    lo: [addr('127.0.0.1', '255.0.0.0', '00:00:00:00:00:00', true)],
    eth0: [addr('192.168.1.10', '255.255.255.0', '08:bf:b8:11:22:33')],
    docker0: [addr('172.17.0.1', '255.255.0.0', '02:42:ac:11:00:01')],
    'br-1a2b3c': [addr('172.18.0.1', '255.255.0.0', '02:42:11:22:33:44')],
    tailscale0: [addr('100.101.102.103', '255.255.255.255', '00:00:00:00:00:00')]
};

suite('netInterfaces：IPv4 运算', () => {
    test('ipToInt / intToIp 往返，非法输入返回 null', () => {
        assert.strictEqual(intToIp(ipToInt('10.10.213.120')!), '10.10.213.120');
        assert.strictEqual(ipToInt('255.255.255.255'), 0xffffffff);
        assert.strictEqual(ipToInt('256.1.1.1'), null);
        assert.strictEqual(ipToInt('1.2.3'), null);
        assert.strictEqual(ipToInt('a.b.c.d'), null);
    });

    test('maskToPrefix：合法掩码与不连续掩码', () => {
        assert.strictEqual(maskToPrefix('255.255.252.0'), 22);
        assert.strictEqual(maskToPrefix('255.255.255.0'), 24);
        assert.strictEqual(maskToPrefix('255.255.255.255'), 32);
        assert.strictEqual(maskToPrefix('255.0.255.0'), -1);
    });

    test('computeBroadcast：/22 网段必须按位运算（旧实现会算成 10.10.255.255）', () => {
        assert.strictEqual(computeBroadcast('10.10.213.120', '255.255.252.0'), '10.10.215.255');
        assert.strictEqual(computeBroadcast('10.10.212.1', '255.255.252.0'), '10.10.215.255');
    });

    test('computeBroadcast：常见掩码', () => {
        assert.strictEqual(computeBroadcast('192.168.1.10', '255.255.255.0'), '192.168.1.255');
        assert.strictEqual(computeBroadcast('172.16.5.9', '255.255.0.0'), '172.16.255.255');
        assert.strictEqual(computeBroadcast('192.168.1.130', '255.255.255.128'), '192.168.1.255');
        assert.strictEqual(computeBroadcast('192.168.1.5', '255.255.255.252'), '192.168.1.7');
        assert.strictEqual(computeBroadcast('10.1.2.3', '255.0.0.0'), '10.255.255.255');
    });

    test('computeBroadcast：非法输入返回 null', () => {
        assert.strictEqual(computeBroadcast('10.1.2.3', '255.0.255.0'), null);
        assert.strictEqual(computeBroadcast('bad', '255.255.255.0'), null);
    });
});

suite('netInterfaces：硬排除', () => {
    test('回环、链路本地、198.18/15、多播、/32 都被排除', () => {
        assert.ok(hardExcludeReason(addr('127.0.0.1', '255.0.0.0', 'x', true)));
        assert.ok(hardExcludeReason(addr('169.254.1.1', '255.255.0.0')));
        assert.ok(hardExcludeReason(addr('198.18.0.1', '255.255.255.252')));
        assert.ok(hardExcludeReason(addr('198.19.255.1', '255.254.0.0')));
        assert.ok(hardExcludeReason(addr('224.0.0.1', '255.255.255.0')));
        assert.ok(hardExcludeReason(addr('100.64.0.1', '255.255.255.255')));
    });

    test('IPv6 被排除；family 为数字 4 的旧版 Node 仍识别为 IPv4', () => {
        assert.ok(hardExcludeReason(addr('fe80::1', 'ffff:ffff:ffff:ffff::', 'x', false, 'IPv6')));
        assert.strictEqual(hardExcludeReason(addr('192.168.1.2', '255.255.255.0', 'x', false, 4)), null);
    });

    test('198.18/15 边界：198.17.x 与 198.20.x 不受影响', () => {
        assert.strictEqual(hardExcludeReason(addr('198.17.0.1', '255.255.255.0')), null);
        assert.strictEqual(hardExcludeReason(addr('198.20.0.1', '255.255.255.0')), null);
    });
});

suite('netInterfaces：各系统夹具', () => {
    test('Mac：只剩 en0，TUN（198.18.0.1）被排除，广播地址正确', () => {
        const list = listLanInterfaces(MAC_FIXTURE);
        assert.deepStrictEqual(list.map(i => i.name), ['en0']);
        assert.strictEqual(list[0].broadcast, '10.10.215.255');
        assert.strictEqual(pickPrimary(list)?.address, '10.10.213.120');
    });

    test('中文 Windows：以太网为主网卡，WSL 网卡保留但排后，TUN/链路本地/蓝牙被排除', () => {
        const list = listLanInterfaces(WINDOWS_ZH_FIXTURE);
        assert.deepStrictEqual(list.map(i => i.name), ['以太网', 'vEthernet (WSL)']);
        assert.strictEqual(list[0].virtual, false);
        assert.strictEqual(list[1].virtual, true);
    });

    test('Linux：eth0 为主，docker 与 br- 网卡排后，/32 的 tailscale 被排除', () => {
        const list = listLanInterfaces(LINUX_FIXTURE);
        assert.deepStrictEqual(list.map(i => i.name), ['eth0', 'docker0', 'br-1a2b3c']);
    });

    test('网卡顺序变化不影响主网卡选择（TUN 排在真实网卡前面）', () => {
        const reordered: RawInterfaces = {
            utun1500: MAC_FIXTURE.utun1500,
            lo0: MAC_FIXTURE.lo0,
            en0: MAC_FIXTURE.en0
        };
        assert.strictEqual(pickPrimary(listLanInterfaces(reordered))?.name, 'en0');
    });

    test('Hyper-V 外部交换机：真实网段挂在 vEthernet 上时仍可用（只降级不剔除）', () => {
        const raw: RawInterfaces = {
            'vEthernet (External)': [addr('10.0.0.5', '255.255.255.0', '3c:ec:ef:11:22:33')]
        };
        const list = listLanInterfaces(raw);
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].virtual, true);
        assert.strictEqual(pickPrimary(list)?.address, '10.0.0.5');
    });

    test('私网地址优先于公网地址；同级保持原顺序', () => {
        const raw: RawInterfaces = {
            eth1: [addr('8.8.8.8', '255.255.255.0')],
            eth0: [addr('192.168.0.2', '255.255.255.0')]
        };
        assert.deepStrictEqual(listLanInterfaces(raw).map(i => i.name), ['eth0', 'eth1']);
    });

    test('MAC 前缀识别虚拟网卡（名称看不出来时）', () => {
        const raw: RawInterfaces = {
            ens33: [addr('192.168.50.2', '255.255.255.0', '00:0c:29:aa:bb:cc')],
            ens34: [addr('192.168.60.2', '255.255.255.0', '3c:ec:ef:11:22:33')]
        };
        const list = listLanInterfaces(raw);
        assert.strictEqual(list[0].name, 'ens34');
        assert.strictEqual(list[1].virtual, true);
    });
});

suite('netInterfaces：派生函数', () => {
    test('broadcastTargets：各网卡定向广播去重，并附带受限广播', () => {
        const targets = broadcastTargets(listLanInterfaces(LINUX_FIXTURE));
        assert.deepStrictEqual(targets, ['192.168.1.255', '172.17.255.255', '172.18.255.255', '255.255.255.255']);
    });

    test('listLocalAddresses：包含回环与被排除网卡的地址（用于识别自己发出的包）', () => {
        const set = listLocalAddresses(MAC_FIXTURE);
        assert.ok(set.has('127.0.0.1'));
        assert.ok(set.has('10.10.213.120'));
        assert.ok(set.has('198.18.0.1'));
    });

    test('interfaceFingerprint：与顺序无关，地址变化时改变', () => {
        const a = interfaceFingerprint(listLanInterfaces(LINUX_FIXTURE));
        const reordered = interfaceFingerprint(listLanInterfaces({
            docker0: LINUX_FIXTURE.docker0,
            eth0: LINUX_FIXTURE.eth0,
            'br-1a2b3c': LINUX_FIXTURE['br-1a2b3c']
        }));
        assert.strictEqual(a, reordered);

        const changed = interfaceFingerprint(listLanInterfaces({
            ...LINUX_FIXTURE,
            eth0: [addr('192.168.1.11', '255.255.255.0', '08:bf:b8:11:22:33')]
        }));
        assert.notStrictEqual(a, changed);
    });
});

suite('netInterfaces：诊断与扫描辅助', () => {
    test('listExcludedInterfaces：列出被排除的网卡与原因（回环不列出）', () => {
        const excluded = listExcludedInterfaces(MAC_FIXTURE);
        assert.deepStrictEqual(excluded.map(e => e.name), ['utun1500']);
        assert.ok(excluded[0].reason.includes('198.18'));
    });

    test('enumerateHosts：/24 共 253 个目标（去掉网络地址、广播地址与本机）', () => {
        const hosts = enumerateHosts('192.168.1.10', '255.255.255.0', 1022)!;
        assert.strictEqual(hosts.length, 253);
        assert.ok(!hosts.includes('192.168.1.10'));
        assert.ok(!hosts.includes('192.168.1.0'));
        assert.ok(!hosts.includes('192.168.1.255'));
        assert.strictEqual(hosts[0], '192.168.1.1');
    });

    test('enumerateHosts：/22 共 1021 个目标，覆盖整个 10.10.212.0–10.10.215.255 网段', () => {
        const hosts = enumerateHosts('10.10.213.120', '255.255.252.0', 1022)!;
        assert.strictEqual(hosts.length, 1021);
        assert.strictEqual(hosts[0], '10.10.212.1');
        assert.strictEqual(hosts[hosts.length - 1], '10.10.215.254');
    });

    test('enumerateHosts：主机数超过上限返回 null，/31 /32 返回空', () => {
        assert.strictEqual(enumerateHosts('10.1.2.3', '255.255.0.0', 1022), null);
        assert.deepStrictEqual(enumerateHosts('10.1.2.3', '255.255.255.255', 1022), []);
    });
});
