import * as fs from 'fs';
import * as path from 'path';

/**
 * peers.json 的文件读写。不依赖 vscode，便于单测。
 *
 * 核心原则：**读不出可信内容时绝不写盘**，避免用不完整的内存状态覆盖用户的原文件：
 * - unavailable：路径不可用（外接卷未挂载、目录无权限等），稍后路径恢复后可重新读取；
 * - corrupt：文件存在但不是合法的 JSON 数组，已另存一份备份，原文件保持不动。
 */
export type LoadResult<T> =
    | { ok: true; items: T[]; created: boolean }
    | { ok: false; reason: 'unavailable' | 'corrupt'; message: string };

export class PeerFileStore<T> {
    constructor(private _filePath: string) {}

    get filePath(): string {
        return this._filePath;
    }

    setPath(filePath: string): void {
        this._filePath = filePath;
    }

    /** 读取；文件不存在时尝试创建空文件，目录创建不了则视为路径不可用 */
    load(): LoadResult<T> {
        if (!fs.existsSync(this._filePath)) {
            try {
                fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
                fs.writeFileSync(this._filePath, '[]');
                return { ok: true, items: [], created: true };
            } catch (err) {
                return {
                    ok: false,
                    reason: 'unavailable',
                    message: `无法创建 ${this._filePath}：${(err as Error).message}`
                };
            }
        }

        let text: string;
        try {
            text = fs.readFileSync(this._filePath, 'utf-8');
        } catch (err) {
            return {
                ok: false,
                reason: 'unavailable',
                message: `无法读取 ${this._filePath}：${(err as Error).message}`
            };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            return this._corrupt(`不是合法的 JSON（${(err as Error).message}）`);
        }
        if (!Array.isArray(parsed)) {
            return this._corrupt('内容不是数组');
        }
        return { ok: true, items: parsed as T[], created: false };
    }

    /** 原子写：先写同目录临时文件，再重命名覆盖，写到一半崩溃不会损坏原文件 */
    save(items: T[]): void {
        const dir = path.dirname(this._filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this._filePath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
            fs.renameSync(tmp, this._filePath);
        } catch (err) {
            try {
                fs.unlinkSync(tmp);
            } catch { /* 临时文件可能没创建成功 */ }
            throw err;
        }
    }

    private _corrupt(why: string): LoadResult<T> {
        const backup = `${this._filePath}.corrupt-${Date.now()}`;
        let saved = '';
        try {
            fs.copyFileSync(this._filePath, backup);
            saved = `，已备份为 ${backup}`;
        } catch { /* 备份失败不影响保护：反正不会写原文件 */ }
        return {
            ok: false,
            reason: 'corrupt',
            message: `${this._filePath} ${why}${saved}。为保护原文件，修复前不会写入`
        };
    }
}

/**
 * 路径恢复后的合并：以文件内容为底，再用内存中的（更新的）条目覆盖同 id 项，
 * 这样既不丢文件里已有的手工配置，也不丢本次运行期间新发现的对端。
 */
export function mergePeers<T extends { id: string }>(fileItems: T[], memory: Map<string, T>): Map<string, T> {
    const merged = new Map<string, T>(fileItems.map(p => [p.id, p]));
    memory.forEach((peer, id) => merged.set(id, peer));
    return merged;
}
