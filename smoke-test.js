// 端到端冒烟测试：两个 NetworkService 实例互发消息和文件（不依赖 VS Code）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NetworkService } = require('./out/networkService');

async function main() {
    const a = new NetworkService();
    const b = new NetworkService();

    // 准备一个 200KB 的测试文件（跨多个 64KB 块）
    const tmpFile = path.join(os.tmpdir(), 'oschat-smoke-src.bin');
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i++) { payload[i] = i % 251; }
    fs.writeFileSync(tmpFile, payload);

    await a.start(18080);
    await b.start(18090);
    console.log('两个实例已启动: A=18080/19080, B=18090/19090');

    const localIp = a.getLocalIp();
    const aId = `${localIp}:18080`;
    const bId = `${localIp}:18090`;

    // 等待 UDP 广播互相发现
    const discovered = await new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), 8000);
        const check = setInterval(() => {
            const aSeesB = a.getPeers().some(p => p.id === bId && p.status === 'online');
            const bSeesA = b.getPeers().some(p => p.id === aId && p.status === 'online');
            if (aSeesB && bSeesA) { clearTimeout(deadline); clearInterval(check); resolve(true); }
        }, 200);
    });
    console.log(`同机双实例自动发现: ${discovered ? '✅' : '❌ 超时'}`);
    if (!discovered) { process.exit(1); }

    // B 侧收集消息
    const received = { texts: [], chunks: new Map(), fileMeta: null, fromIds: new Set() };
    b.on('message', msg => {
        received.fromIds.add(msg.from);
        if (msg.type === 'message') { received.texts.push(msg.content); }
        if (msg.type === 'file') {
            received.fileMeta = { name: msg.file.name, size: msg.file.size, totalChunks: msg.file.totalChunks };
            received.chunks.set(msg.file.chunkIndex, msg.file.data);
        }
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

    const meta = received.fileMeta;
    const chunksOk = meta && received.chunks.size === meta.totalChunks && meta.totalChunks === Math.ceil(payload.length / (64 * 1024));
    console.log(`分块数: ${chunksOk ? '✅' : '❌'} (收到 ${received.chunks.size}/${meta && meta.totalChunks})`);

    let assembled = Buffer.alloc(0);
    if (meta) {
        const parts = [];
        for (let i = 0; i < meta.totalChunks; i++) { parts.push(Buffer.from(received.chunks.get(i), 'base64')); }
        assembled = Buffer.concat(parts);
    }
    const contentOk = assembled.equals(payload);
    console.log(`文件内容一致: ${contentOk ? '✅' : '❌'} (${assembled.length}/${payload.length} 字节)`);

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
    fs.unlinkSync(tmpFile);

    const allOk = textOk && fromOk && chunksOk && contentOk && progressOk && reverseOk && offlineOk;
    console.log(allOk ? '\n全部通过 ✅' : '\n存在失败项 ❌');
    process.exit(allOk ? 0 : 1);
}

main().catch(err => { console.error('冒烟测试异常:', err); process.exit(1); });
