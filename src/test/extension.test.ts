import * as assert from 'assert';
import * as vscode from 'vscode';
import { PeersManager, StoredPeerInfo } from '../peersManager';
import { NetworkService, PeerInfo, NetworkMessage, TransferTask } from '../networkService';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    let mockContext: vscode.ExtensionContext;

    suiteSetup(async () => {
        // 获取扩展实例以使用其 context
        const ext = vscode.extensions.getExtension('oecophylla-smaragdina');
        if (ext) {
            await ext.activate();
        }
    });

    suite('PeersManager', () => {
        let peersManager: PeersManager;

        setup(() => {
            // 使用临时目录创建 PeersManager
            const tempDir = '/tmp/oschat-test-' + Date.now();
            const context = {
                globalStorageUri: { fsPath: tempDir },
                subscriptions: []
            } as unknown as vscode.ExtensionContext;
            peersManager = new PeersManager(context);
        });

        test('should add a peer', () => {
            const peer = peersManager.addPeer('192.168.1.100', 8080, '测试用户', 'PC-Test');
            assert.strictEqual(peer.id, '192.168.1.100:8080');
            assert.strictEqual(peer.ip, '192.168.1.100');
            assert.strictEqual(peer.port, 8080);
            assert.strictEqual(peer.nickname, '测试用户');
            assert.strictEqual(peer.hostname, 'PC-Test');
            assert.strictEqual(peer.status, 'offline');
        });

        test('should get all peers', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.addPeer('192.168.1.101', 8080, '用户B');
            const peers = peersManager.getPeers();
            assert.strictEqual(peers.length, 2);
        });

        test('should get peer by id', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            const peer = peersManager.getPeerById('192.168.1.100:8080');
            assert.ok(peer);
            assert.strictEqual(peer?.nickname, '用户A');
        });

        test('should update peer status', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.updatePeerStatus('192.168.1.100:8080', 'online');
            const peer = peersManager.getPeerById('192.168.1.100:8080');
            assert.strictEqual(peer?.status, 'online');
        });

        test('should update existing peer', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.updatePeer({
                id: '192.168.1.100:8080',
                hostname: 'PC-Updated',
                nickname: '用户A-改',
                ip: '192.168.1.100',
                port: 8080,
                lastSeen: Date.now(),
                status: 'online'
            });
            const peer = peersManager.getPeerById('192.168.1.100:8080');
            assert.strictEqual(peer?.nickname, '用户A-改');
            assert.strictEqual(peer?.status, 'online');
        });

        test('should remove peer', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.removePeer('192.168.1.100:8080');
            const peer = peersManager.getPeerById('192.168.1.100:8080');
            assert.strictEqual(peer, undefined);
        });

        test('should get online peers only', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.addPeer('192.168.1.101', 8080, '用户B');
            peersManager.updatePeerStatus('192.168.1.100:8080', 'online');
            const onlinePeers = peersManager.getOnlinePeers();
            assert.strictEqual(onlinePeers.length, 1);
            assert.strictEqual(onlinePeers[0].nickname, '用户A');
        });

        test('should get peer display name (nickname优先)', () => {
            const peer = peersManager.addPeer('192.168.1.100', 8080, '昵称', '主机名');
            const displayName = peersManager.getPeerDisplayName(peer);
            assert.strictEqual(displayName, '昵称');
        });

        test('should get peer display name (fallback to hostname)', () => {
            const peer = peersManager.addPeer('192.168.1.100', 8080, undefined, '主机名');
            const displayName = peersManager.getPeerDisplayName(peer);
            assert.strictEqual(displayName, '主机名');
        });

        test('should get peer display name (fallback to ip)', () => {
            const peer = peersManager.addPeer('192.168.1.100', 8080);
            const displayName = peersManager.getPeerDisplayName(peer);
            assert.strictEqual(displayName, '192.168.1.100');
        });

        test('should format peer list', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.updatePeerStatus('192.168.1.100:8080', 'online');
            const formatted = peersManager.formatPeerList();
            assert.ok(formatted.includes('🟢'));
            assert.ok(formatted.includes('用户A'));
            assert.ok(formatted.includes('192.168.1.100:8080'));
        });

        test('should format empty peer list', () => {
            const formatted = peersManager.formatPeerList();
            assert.ok(formatted.includes('暂无'));
        });
    });

    suite('NetworkService', () => {
        let networkService: NetworkService;

        setup(() => {
            networkService = new NetworkService();
        });

        test('should not be running initially', () => {
            assert.strictEqual(networkService.isRunning(), false);
        });

        test('should get local ip', () => {
            const ip = networkService.getLocalIp();
            // 应该返回一个有效的 IPv4 地址
            assert.ok(ip);
            assert.ok(ip.includes('.'));
        });

        test('should get empty peers initially', () => {
            const peers = networkService.getPeers();
            assert.strictEqual(peers.length, 0);
        });

        test('should get empty transfer tasks initially', () => {
            const tasks = networkService.getTransferTasks();
            assert.strictEqual(tasks.length, 0);
        });

        test('should create transfer task', () => {
            // 先添加一个 peer
            const peerInfo: PeerInfo = {
                id: '192.168.1.100:8080',
                hostname: 'PC-Test',
                ip: '192.168.1.100',
                port: 8080,
                transferPort: 9080,
                lastSeen: Date.now(),
                status: 'online'
            };
            // 通过私有方法添加 peer，这里我们直接测试 createTransferTask 的异常情况
            assert.throws(() => {
                networkService.createTransferTask('192.168.1.100:8080', ['hello'], []);
            }, /Peer/);
        });

        test('should emit events', (done) => {
            const testPeer: PeerInfo = {
                id: '192.168.1.100:8080',
                hostname: 'PC-Test',
                ip: '192.168.1.100',
                port: 8080,
                transferPort: 9080,
                lastSeen: Date.now(),
                status: 'online'
            };

            networkService.on('peersUpdate', (peers: PeerInfo[]) => {
                assert.strictEqual(peers.length, 1);
                assert.strictEqual(peers[0].id, '192.168.1.100:8080');
                done();
            });

            // 触发 peersUpdate 事件
            networkService.emit('peersUpdate', [testPeer]);
        });

        test('should handle message event', (done) => {
            const testMsg: NetworkMessage = {
                type: 'message',
                from: '192.168.1.101:8080',
                content: '你好',
                timestamp: Date.now()
            };

            networkService.on('message', (msg: NetworkMessage) => {
                assert.strictEqual(msg.content, '你好');
                assert.strictEqual(msg.type, 'message');
                done();
            });

            networkService.emit('message', testMsg);
        });
    });

    suite('NetworkMessage Structure', () => {
        test('should create valid chat message', () => {
            const msg: NetworkMessage = {
                type: 'message',
                from: '192.168.1.100',
                to: '192.168.1.101:8080',
                content: 'Hello!',
                timestamp: Date.now()
            };
            assert.strictEqual(msg.content, 'Hello!');
        });

        test('should create valid file message', () => {
            const msg: NetworkMessage = {
                type: 'file',
                from: '192.168.1.100',
                to: '192.168.1.101:8080',
                timestamp: Date.now(),
                file: {
                    name: 'test.txt',
                    size: 1024,
                    data: 'base64data'
                }
            };
            assert.strictEqual(msg.file?.name, 'test.txt');
            assert.strictEqual(msg.file?.size, 1024);
        });

        test('should create valid discovery request message', () => {
            const msg: NetworkMessage = {
                type: 'discovery_request',
                from: '192.168.1.100',
                fromHostname: 'PC-Test',
                fromNickname: '测试用户',
                timestamp: Date.now(),
                transferPort: 9080
            };
            assert.strictEqual(msg.type, 'discovery_request');
            assert.strictEqual(msg.fromHostname, 'PC-Test');
            assert.strictEqual(msg.fromNickname, '测试用户');
            assert.strictEqual(msg.transferPort, 9080);
        });

        test('should create valid discovery response message', () => {
            const msg: NetworkMessage = {
                type: 'discovery_response',
                from: '192.168.1.101',
                fromHostname: 'PC-Remote',
                to: '192.168.1.100:8080',
                timestamp: Date.now(),
                transferPort: 9080
            };
            assert.strictEqual(msg.type, 'discovery_response');
            assert.strictEqual(msg.fromHostname, 'PC-Remote');
        });

        test('should create valid heartbeat message', () => {
            const msg: NetworkMessage = {
                type: 'heartbeat',
                from: '192.168.1.100',
                fromHostname: 'PC-Test',
                to: '192.168.1.101:8080',
                timestamp: Date.now(),
                transferPort: 9080
            };
            assert.strictEqual(msg.type, 'heartbeat');
            assert.strictEqual(msg.fromHostname, 'PC-Test');
        });

        test('should create valid heartbeat_ack message', () => {
            const msg: NetworkMessage = {
                type: 'heartbeat_ack',
                from: '192.168.1.101',
                fromHostname: 'PC-Remote',
                to: '192.168.1.100:8080',
                timestamp: Date.now(),
                transferPort: 9080
            };
            assert.strictEqual(msg.type, 'heartbeat_ack');
            assert.strictEqual(msg.fromHostname, 'PC-Remote');
        });
    });

    suite('TransferTask Structure', () => {
        test('should create valid transfer task', () => {
            const task: TransferTask = {
                id: 'task_001',
                peerId: '192.168.1.100:8080',
                peerIp: '192.168.1.100',
                peerPort: 8080,
                messages: ['hello'],
                files: [{ name: 'test.txt', path: '/tmp/test.txt', size: 100 }],
                status: 'pending',
                progress: 0,
                totalBytes: 100,
                transferredBytes: 0,
                createdAt: Date.now()
            };
            assert.strictEqual(task.status, 'pending');
            assert.strictEqual(task.messages.length, 1);
            assert.strictEqual(task.files.length, 1);
            assert.strictEqual(task.totalBytes, 100);
        });

        test('should transition through statuses', () => {
            const task: TransferTask = {
                id: 'task_002',
                peerId: '192.168.1.100:8080',
                peerIp: '192.168.1.100',
                peerPort: 8080,
                messages: [],
                files: [],
                status: 'pending',
                progress: 0,
                totalBytes: 0,
                transferredBytes: 0,
                createdAt: Date.now()
            };

            task.status = 'connecting';
            assert.strictEqual(task.status, 'connecting');

            task.status = 'transferring';
            task.progress = 50;
            assert.strictEqual(task.status, 'transferring');
            assert.strictEqual(task.progress, 50);

            task.status = 'completed';
            task.progress = 100;
            task.completedAt = Date.now();
            assert.strictEqual(task.status, 'completed');
            assert.ok(task.completedAt);
        });

        test('should handle failure state', () => {
            const task: TransferTask = {
                id: 'task_003',
                peerId: '192.168.1.100:8080',
                peerIp: '192.168.1.100',
                peerPort: 8080,
                messages: [],
                files: [],
                status: 'failed',
                progress: 30,
                totalBytes: 1000,
                transferredBytes: 300,
                createdAt: Date.now(),
                errorMessage: '连接超时'
            };
            assert.strictEqual(task.status, 'failed');
            assert.strictEqual(task.errorMessage, '连接超时');
        });

        test('should handle timeout state', () => {
            const task: TransferTask = {
                id: 'task_004',
                peerId: '192.168.1.100:8080',
                peerIp: '192.168.1.100',
                peerPort: 8080,
                messages: [],
                files: [],
                status: 'timeout',
                progress: 0,
                totalBytes: 0,
                transferredBytes: 0,
                createdAt: Date.now(),
                errorMessage: '握手超时'
            };
            assert.strictEqual(task.status, 'timeout');
        });
    });

    suite('Sample tests', () => {
        test('sample test from template', () => {
            assert.strictEqual(-1, [1, 2, 3].indexOf(5));
            assert.strictEqual(-1, [1, 2, 3].indexOf(0));
        });
    });
});
