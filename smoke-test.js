// 端到端冒烟测试：两个 NetworkService 实例互发消息和文件（不依赖 VS Code）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NetworkService } = require('./out/core/networkService');
const { FileReceiver } = require('./out/core/fileReceiver');
const { FileReceiveService } = require('./out/core/fileReceiveService');

async function main() {
    const a = new NetworkService();
    const b = new NetworkService();
    // B 接上真实的接收链路：流式写盘 + 落盘后回 file_ack（与扩展里的接线一致）
    const recvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-smoke-recv-'));
    const receiveService = new FileReceiveService(b, new FileReceiver({ resolveDir: () => recvDir }));

    // 准备一个 200KB 的测试文件（跨多个 64KB 块）
    const tmpFile = path.join(os.tmpdir(), 'oschat-smoke-src.bin');
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i++) { payload[i] = i % 251; }
    fs.writeFileSync(tmpFile, payload);

    await a.start(18080);
    await b.start(18090);
    console.log('两个实例已启动: A=18080/19080, B=18090/19090');

    // 对端以稳定的实例 ID 为身份，不再是 ip:端口；按端口在对方的列表里找到彼此
    let aId = '';
    let bId = '';

    // 等待 UDP 广播互相发现（往返确认后才算在线）
    const discovered = await new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), 8000);
        const check = setInterval(() => {
            const bAsSeenByA = a.getPeers().find(p => p.port === 18090 && p.status === 'online');
            const aAsSeenByB = b.getPeers().find(p => p.port === 18080 && p.status === 'online');
            if (bAsSeenByA && aAsSeenByB) {
                bId = bAsSeenByA.id;
                aId = aAsSeenByB.id;
                clearTimeout(deadline); clearInterval(check); resolve(true);
            }
        }, 200);
    });
    console.log(`同机双实例自动发现: ${discovered ? '✅' : '❌ 超时'}`);
    if (!discovered) { process.exit(1); }

    const identityOk = aId === a.getInstanceId() && bId === b.getInstanceId();
    console.log(`稳定身份(instanceId，不随 IP 变化): ${identityOk ? '✅' : '❌'} (A=${aId})`);

    // B 侧收集消息
    const received = { texts: [], fromIds: new Set() };
    b.on('message', msg => {
        received.fromIds.add(msg.from);
        if (msg.type === 'message') { received.texts.push(msg.content); }
    });

    // A → B：一条消息 + 一个文件
    const task = a.createTransferTask(bId, ['你好，冒烟测试'], [{ name: 'smoke.bin', path: tmpFile, size: payload.length }]);
    const progressValues = [];
    a.on('transferTaskUpdated', t => progressValues.push(t.progress));
    await a.executeTransferTask(task.id);
    console.log(`传输任务完成: status=${task.status} progress=${task.progress}`);

    await new Promise(r => setTimeout(r, 500));

    // 校验
    const textOk = received.texts.length === 1 && received.texts[0] === '你好，冒烟测试';
    console.log(`文本消息: ${textOk ? '✅' : '❌'} (${JSON.stringify(received.texts)})`);

    const fromOk = received.fromIds.size === 1 && received.fromIds.has(aId);
    console.log(`消息来源身份(peerId): ${fromOk ? '✅' : '❌'} (${[...received.fromIds]})`);

    // 文件由接收端流式写盘，并在落盘后回了 file_ack（发送端 executeTransferTask 已等到确认才返回）
    const savedPath = path.join(recvDir, 'smoke.bin');
    const saved = fs.existsSync(savedPath) ? fs.readFileSync(savedPath) : Buffer.alloc(0);
    const contentOk = saved.equals(payload);
    console.log(`文件落盘且内容一致: ${contentOk ? '✅' : '❌'} (${saved.length}/${payload.length} 字节)`);
    const noPartLeft = fs.readdirSync(recvDir).every(n => !n.endsWith('.part'));
    console.log(`无残留临时文件: ${noPartLeft ? '✅' : '❌'}`);
    const chunksOk = noPartLeft;

    const progressOk = progressValues.length > 2 && progressValues[progressValues.length - 1] === 100;
    console.log(`真实进度更新: ${progressOk ? '✅' : '❌'} (${progressValues.length} 次更新, 末值 ${progressValues[progressValues.length - 1]})`);

    // 反向 B → A 发一条，验证双向
    const aReceived = [];
    a.on('message', msg => { if (msg.type === 'message') { aReceived.push(msg.content); } });
    const task2 = b.createTransferTask(aId, ['B 到 A 的回复'], []);
    await b.executeTransferTask(task2.id);
    await new Promise(r => setTimeout(r, 300));
    const reverseOk = aReceived.length === 1 && aReceived[0] === 'B 到 A 的回复';
    console.log(`反向消息(B→A): ${reverseOk ? '✅' : '❌'}`);

    // 离线检测：停掉 B，A 再发应快速失败
    b.stop();
    await new Promise(r => setTimeout(r, 300));
    let offlineOk = false;
    try {
        const task3 = a.createTransferTask(bId, ['应该失败'], []);
        await a.executeTransferTask(task3.id);
    } catch (err) {
        offlineOk = true;
        console.log(`离线快速失败: ✅ (${a.getTransferTask ? '' : ''}${err.message})`);
    }
    if (!offlineOk) { console.log('离线快速失败: ❌ 发送竟然成功了'); }

    a.stop();
    receiveService.dispose();
    fs.rmSync(recvDir, { recursive: true, force: true });
    fs.unlinkSync(tmpFile);

    const allOk = identityOk && textOk && fromOk && chunksOk && contentOk && progressOk && reverseOk && offlineOk;
    console.log(allOk ? '\n全部通过 ✅' : '\n存在失败项 ❌');
    process.exit(allOk ? 0 : 1);
}

main().catch(err => { console.error('冒烟测试异常:', err); process.exit(1); });
