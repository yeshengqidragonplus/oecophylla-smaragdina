import { log, logError } from './logger';
import { FileReceiver, IncomingFileInfo } from './fileReceiver';
import { NetworkService } from './networkService';
import { BusinessMessage } from './protocol';

/**
 * 接收侧的粘合层（不依赖 vscode）：把 NetworkService 收到的文件消息交给 FileReceiver，
 * 并把落盘结果以 file_ack 回给发送方。
 *
 * 发送方（协议 v3）发完所有分块后会发 file_end 并等待 file_ack——
 * 传输层确认只说明"对端收到了"，这里的 file_ack 才说明"对端存下来了"。
 * 旧版发送方没有 transferId、也不会等待确认，不回 file_ack。
 */
export class FileReceiveService {
    constructor(
        private readonly _network: NetworkService,
        readonly receiver: FileReceiver
    ) {
        this._network.on('message', this._onMessage);
        this.receiver.on('completed', info => this._ack(info, true));
        this.receiver.on('failed', info => this._ack(info, false, info.reason));
    }

    dispose(): void {
        this._network.off('message', this._onMessage);
        this.receiver.removeAllListeners();
        this.receiver.dispose();
    }

    private _onMessage = (msg: BusinessMessage): void => {
        if (msg.type === 'file') {
            this.receiver.handleChunk(msg.from, msg);
            return;
        }
        if (msg.type !== 'file_end') {
            return;
        }
        const end = this.receiver.handleEnd(msg.from, msg);
        const info = { transferId: msg.transferId, peerId: msg.from, fileName: msg.name, size: msg.size, legacy: false };
        switch (end.state) {
            case 'completed':
                this._ack(info, true);
                break;
            case 'failed':
                this._ack(info, false, end.reason);
                break;
            case 'unknown':
                // 从未收到过这个文件的数据（接收端重启过、分块全部丢失）：让发送方立即失败，而不是干等超时
                this._ack(info, false, '接收端没有收到该文件的数据（可能已重启过）');
                break;
            case 'pending':
                break; // 写盘还在进行，完成时会触发 completed / failed 再应答
        }
    };

    private _ack(info: IncomingFileInfo, ok: boolean, reason?: string): void {
        if (info.legacy) {
            return;
        }
        log(`[接收] 回复 file_ack：${info.fileName} ${ok ? '成功' : `失败（${reason}）`}`);
        this._network.sendToPeer(info.peerId, {
            type: 'file_ack',
            from: this._network.getInstanceId(),
            timestamp: Date.now(),
            transferId: info.transferId,
            ok,
            reason
        }).catch(err => logError('[接收] 回复 file_ack 失败:', (err as Error).message));
    }
}
