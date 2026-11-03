import { listLanInterfaces } from '../../core/netInterfaces';

/**
 * 依赖"本机有局域网网卡"的集成用例（发现、收发）在没有网卡的环境（如某些容器、断网的 CI 机器）里
 * 无法进行，直接跳过而不是报失败。调用方式：在 setup / test 里 `skipWithoutLan(this)`。
 */
export function skipWithoutLan(ctx: Mocha.Context): void {
    if (listLanInterfaces().length === 0) {
        ctx.skip();
    }
}
