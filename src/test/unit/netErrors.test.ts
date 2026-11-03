import * as assert from 'assert';
import { ErrorThrottle, classifyNetError } from '../../core/netErrors';

function errWithCode(code: string, message = 'boom'): Error {
    return Object.assign(new Error(message), { code });
}

suite('netErrors：错误分类', () => {
    test('不可达类错误：macOS 提示本地网络权限，其他系统不提', () => {
        const mac = classifyNetError(errWithCode('EHOSTUNREACH'), 'darwin');
        assert.strictEqual(mac.kind, 'unreachable');
        assert.ok(mac.hint.includes('本地网络'));
        const win = classifyNetError(errWithCode('ENETUNREACH'), 'win32');
        assert.strictEqual(win.kind, 'unreachable');
        assert.ok(!win.hint.includes('本地网络'));
    });

    test('权限类错误：Windows 提示防火墙公用配置文件', () => {
        const win = classifyNetError(errWithCode('EACCES'), 'win32');
        assert.strictEqual(win.kind, 'permission');
        assert.ok(win.hint.includes('公用'));
    });

    test('端口占用、地址失效、对端未监听、MTU、缓冲区', () => {
        assert.strictEqual(classifyNetError(errWithCode('EADDRINUSE')).kind, 'busy');
        assert.strictEqual(classifyNetError(errWithCode('EADDRNOTAVAIL')).kind, 'address');
        assert.strictEqual(classifyNetError(errWithCode('ECONNRESET')).kind, 'reset');
        assert.strictEqual(classifyNetError(errWithCode('EMSGSIZE')).kind, 'size');
        assert.strictEqual(classifyNetError(errWithCode('ENOBUFS')).kind, 'buffer');
    });

    test('未知错误码与没有 code 的错误：归为 other，不抛异常', () => {
        assert.strictEqual(classifyNetError(errWithCode('EWHATEVER')).kind, 'other');
        const info = classifyNetError(new Error('no code'));
        assert.strictEqual(info.kind, 'other');
        assert.strictEqual(info.code, 'UNKNOWN');
    });
});

suite('netErrors：日志限流', () => {
    test('窗口期内同类错误只放行第一条，并累计被抑制条数', () => {
        const throttle = new ErrorThrottle(1000);
        assert.strictEqual(throttle.check('k', 0), 0);
        assert.strictEqual(throttle.check('k', 100), null);
        assert.strictEqual(throttle.check('k', 900), null);
        assert.strictEqual(throttle.check('k', 1000), 2);
        assert.strictEqual(throttle.check('k', 1100), null);
    });

    test('不同 key 互不影响', () => {
        const throttle = new ErrorThrottle(1000);
        assert.strictEqual(throttle.check('a', 0), 0);
        assert.strictEqual(throttle.check('b', 10), 0);
        assert.strictEqual(throttle.check('a', 20), null);
    });
});
