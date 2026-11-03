import * as assert from 'assert';
import {
    ONLINE_PROBE_INTERVAL,
    OFFLINE_PROBE_FAST_INTERVAL,
    OFFLINE_PROBE_FAST_TRIES,
    OFFLINE_PROBE_SLOW_INTERVAL,
    ProbeState,
    isProbeDue,
    nextProbeState,
    probeInterval
} from '../../core/probeSchedule';

suite('probeSchedule：对端探测节奏', () => {
    test('从未探测过的对端（刚加载或刚新增）立即探测', () => {
        assert.strictEqual(isProbeDue(false, undefined, 0), true);
        assert.strictEqual(isProbeDue(true, undefined, 0), true);
    });

    test('在线对端按心跳间隔探测', () => {
        const state: ProbeState = { lastProbeAt: 1000, offlineProbes: 0 };
        assert.strictEqual(isProbeDue(true, state, 1000 + ONLINE_PROBE_INTERVAL - 1), false);
        assert.strictEqual(isProbeDue(true, state, 1000 + ONLINE_PROBE_INTERVAL), true);
    });

    test('离线对端：前几次快速探测，之后放慢', () => {
        assert.strictEqual(probeInterval(false, 0), OFFLINE_PROBE_FAST_INTERVAL);
        assert.strictEqual(probeInterval(false, OFFLINE_PROBE_FAST_TRIES - 1), OFFLINE_PROBE_FAST_INTERVAL);
        assert.strictEqual(probeInterval(false, OFFLINE_PROBE_FAST_TRIES), OFFLINE_PROBE_SLOW_INTERVAL);
    });

    test('回归：对端失联很久（远超旧实现的 180 秒窗口）仍会被继续探测', () => {
        let state: ProbeState | undefined;
        let now = 0;
        let probes = 0;
        // 模拟 1 小时，每 5 秒一个节拍，对端始终离线
        for (; now <= 3_600_000; now += 5_000) {
            if (isProbeDue(false, state, now)) {
                probes++;
                state = nextProbeState(false, state, now);
            }
        }
        // 前 3 次每 30 秒，之后每 60 秒：约 3 + 58 次，至少远多于旧实现的 6 次
        assert.ok(probes > 50, `1 小时内只探测了 ${probes} 次`);
    });

    test('对端上线后离线计数清零', () => {
        let state = nextProbeState(false, undefined, 0);
        state = nextProbeState(false, state, 30_000);
        assert.strictEqual(state.offlineProbes, 2);
        state = nextProbeState(true, state, 60_000);
        assert.strictEqual(state.offlineProbes, 0);
        assert.strictEqual(state.lastProbeAt, 60_000);
    });
});
