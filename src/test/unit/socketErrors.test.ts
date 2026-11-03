import * as assert from 'assert';
import * as dgram from 'dgram';
import { NetworkService } from '../../core/networkService';
import { KcpTransport } from '../../core/kcpTransport';

/** 随机高位端口，避免与本机其他服务或并行测试冲突（业务端口 = 主端口 + 1000） */
function randomBasePort(): number {
    return 30000 + Math.floor(Math.random() * 20000);
}

function networkError(code: string): Error {
    return Object.assign(new Error(`模拟 ${code}`), { code });
}

suite('网络层：socket 运行期错误不能抛出', () => {
    test('NetworkService：连续的 UDP 错误被分类记录，不抛出，且可被计数', async () => {
        const service = new NetworkService();
        await service.start(randomBasePort());
        try {
            const udp = (service as unknown as { _udpServer: dgram.Socket })._udpServer;
            assert.doesNotThrow(() => {
                udp.emit('error', networkError('EHOSTUNREACH'));
                udp.emit('error', networkError('EHOSTUNREACH'));
                udp.emit('error', networkError('EPERM'));
            });
            assert.strictEqual(service.getLastNetError()?.code, 'EPERM');
            assert.strictEqual(service.getNetErrorCounts()['EHOSTUNREACH'], 2);
        } finally {
            service.stop();
        }
    });

    test('NetworkService：通过 networkError 事件通知外部', async () => {
        const service = new NetworkService();
        await service.start(randomBasePort());
        try {
            const received: string[] = [];
            service.on('networkError', info => received.push(info.code));
            (service as unknown as { _udpServer: dgram.Socket })._udpServer.emit('error', networkError('ENETUNREACH'));
            assert.deepStrictEqual(received, ['ENETUNREACH']);
        } finally {
            service.stop();
        }
    });

    test('KcpTransport：第一次错误之后的 socket 错误同样只上报 transportError（回归：once 导致第二次未处理）', async () => {
        const transport = new KcpTransport(randomBasePort());
        await transport.start();
        try {
            const received: string[] = [];
            transport.on('transportError', (err: Error) => received.push((err as NodeJS.ErrnoException).code ?? ''));
            const socket = (transport as unknown as { _socket: dgram.Socket })._socket;
            assert.doesNotThrow(() => {
                socket.emit('error', networkError('EHOSTUNREACH'));
                socket.emit('error', networkError('EHOSTUNREACH'));
                socket.emit('error', networkError('EPERM'));
            });
            assert.deepStrictEqual(received, ['EHOSTUNREACH', 'EHOSTUNREACH', 'EPERM']);
        } finally {
            transport.stop();
        }
    });

    test('NetworkService：没有任何监听者时也不会因 networkError 抛出', async () => {
        const service = new NetworkService();
        await service.start(randomBasePort());
        try {
            assert.strictEqual(service.listenerCount('error'), 0);
            assert.doesNotThrow(() => {
                (service as unknown as { _udpServer: dgram.Socket })._udpServer.emit('error', networkError('ECONNRESET'));
            });
        } finally {
            service.stop();
        }
    });
});
