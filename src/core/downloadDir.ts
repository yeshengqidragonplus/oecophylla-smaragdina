import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 接收文件的保存目录（不依赖 vscode）。
 *
 * 默认是系统"下载"文件夹下的 `OS Chat`（Mac 与 Windows 都有 Downloads），
 * 用户能直接找到；旧版默认放在扩展全局存储目录，路径隐蔽且两台机器各不相同。
 * 目录不可用（外接卷未挂载、没有权限）时按顺序回退，而不是让接收失败。
 */

export function defaultDownloadDir(home: string = os.homedir()): string {
    return path.join(home, 'Downloads', 'OS Chat');
}

/** 目录存在（必要时创建）且确实可写：做一次真实的写入测试，access(W_OK) 在 Windows 上不可靠 */
export function isWritableDir(dir: string): { ok: true } | { ok: false; reason: string } {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.oschat-write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: `${dir}：${(err as Error).message}` };
    }
}

export interface DownloadDirResult {
    dir: string;
    /** 实际使用的目录不是首选目录时，说明首选目录不可用的原因 */
    fallbackReason?: string;
}

/**
 * 解析保存目录：用户配置 → 默认下载目录 → 备选目录（如扩展全局存储）→ 系统临时目录。
 * 用户明确配置了目录但不可用时，结果带 fallbackReason，调用方应提示用户。
 */
export function resolveDownloadDir(options: {
    configured?: string;
    defaultDir?: string;
    fallbackDirs?: string[];
}): DownloadDirResult {
    const preferred = options.configured?.trim() || options.defaultDir || defaultDownloadDir();
    const candidates = [preferred, ...(options.fallbackDirs ?? []), path.join(os.tmpdir(), 'OS Chat')];

    let firstFailure: string | undefined;
    for (const dir of candidates) {
        const result = isWritableDir(dir);
        if (result.ok) {
            return { dir, fallbackReason: dir === preferred ? undefined : firstFailure };
        }
        firstFailure = firstFailure ?? result.reason;
    }
    // 连临时目录都不可写：返回首选目录，让后续写入报出具体错误
    return { dir: preferred, fallbackReason: firstFailure };
}
