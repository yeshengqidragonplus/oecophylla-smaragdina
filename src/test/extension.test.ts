import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PeersManager } from '../peersManager';
import { PeerRegistry } from '../core/peerRegistry';
import { NetworkService, PeerInfo, BusinessMessage, FileChunkMessage, PresenceMessage, TextMessage, TransferTask } from '../core/networkService';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    suiteSetup(async () => {
        // 按 package.json 的 name 查找扩展（未设置 publisher 时扩展 id 是 undefined_publisher.xxx，
        // 直接写 id 会查不到）；找不到必须让测试失败，而不是静默跳过激活
        const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'oecophylla-smaragdina');
        assert.ok(ext, '找不到 oecophylla-smaragdina 扩展，请检查测试宿主是否加载了本扩展');
        await ext.activate();
    });

    suite('PeersManager', () => {
        let peersManager: PeersManager;
        let registry: PeerRegistry;

        setup(() => {
            // 使用临时目录与独立的注册表创建 PeersManager
            const tempDir = path.join(os.tmpdir(), 'oschat-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
            const context = {
                globalStorageUri: { fsPath: tempDir },
                subscriptions: []
            } as unknown as vscode.ExtensionContext;
            registry = new PeerRegistry();
            peersManager = new PeersManager(context, registry);
        });

        /** 模拟收到对端的往返确认，使其在线 */
        const markOnline = (ip: string, port: number): void => {
            registry.observe({ kind: 'ack', ip, port });
        };

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

        test('在线状态由往返确认决定，而不是手工设置', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            markOnline('192.168.1.100', 8080);
            const peer = peersManager.getPeerById('192.168.1.100:8080');
            assert.strictEqual(peer?.status, 'online');
        });

        test('should edit existing peer（改地址后旧 id 仍可解析到该联系人）', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            const edited = peersManager.editPeer('192.168.1.100:8080', {
                hostname: 'PC-Updated',
                nickname: '用户A-改',
                ip: '192.168.1.101'
            });
            assert.strictEqual(edited?.id, '192.168.1.101:8080');
            assert.strictEqual(edited?.nickname, '用户A-改');
            assert.strictEqual(peersManager.getPeerById('192.168.1.100:8080')?.id, '192.168.1.101:8080');
            assert.strictEqual(peersManager.getPeers().length, 1);
        });

        test('删除的联系人不会在下一次发现/心跳时被旧状态"复活"', () => {
            peersManager.addPeer('192.168.1.100', 8080, '用户A');
            peersManager.removePeer('192.168.1.100:8080');
            assert.strictEqual(peersManager.getPeers().length, 0);
            assert.strictEqual(registry.size, 0);
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
            markOnline('192.168.1.100', 8080);
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
            markOnline('192.168.1.100', 8080);
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

        test('createTransferTask：未知但格式合法的 ip:端口 会按约定补建对端；非法 id 抛出 Peer not found', () => {
            const task = networkService.createTransferTask('192.168.1.100:8080', ['hello'], []);
            assert.strictEqual(task.peerId, '192.168.1.100:8080');
            assert.strictEqual(task.status, 'pending');
            assert.strictEqual(networkService.getPeers().length, 1);
            assert.throws(() => {
                networkService.createTransferTask('not-a-peer', ['hello'], []);
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
            const testMsg: TextMessage = {
                type: 'message',
                from: '192.168.1.101:8080',
                content: '你好',
                timestamp: Date.now()
            };

            networkService.on('message', (msg: BusinessMessage) => {
                assert.strictEqual(msg.type, 'message');
                assert.strictEqual(msg.type === 'message' && msg.content, '你好');
                done();
            });

            networkService.emit('message', testMsg);
        });
    });

    suite('NetworkMessage Structure', () => {
        test('should create valid chat message', () => {
            const msg: TextMessage = {
                type: 'message',
                from: '192.168.1.100',
                to: '192.168.1.101:8080',
                content: 'Hello!',
                timestamp: Date.now()
            };
            assert.strictEqual(msg.content, 'Hello!');
        });

        test('should create valid file message', () => {
            const msg: FileChunkMessage = {
                type: 'file',
                from: '192.168.1.100',
                to: '192.168.1.101:8080',
                timestamp: Date.now(),
                file: {
                    name: 'test.txt',
                    size: 1024,
                    chunkIndex: 0,
                    totalChunks: 1,
                    data: 'base64data'
                }
            };
            assert.strictEqual(msg.file.name, 'test.txt');
            assert.strictEqual(msg.file.size, 1024);
        });

        test('should create valid discovery request message', () => {
            const msg: PresenceMessage = {
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
            const msg: PresenceMessage = {
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
            const msg: PresenceMessage = {
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
            const msg: PresenceMessage = {
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
                files: [{ name: 'test.txt', path: path.join(os.tmpdir(), 'test.txt'), size: 100 }],
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
