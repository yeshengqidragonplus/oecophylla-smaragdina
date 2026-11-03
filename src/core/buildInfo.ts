import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * 构建指纹：对当前正在运行的打包产物（dist/extension.js，即本文件被打进的
 * bundle）求 MD5。两台机器对比这个短码即可确认是否跑的是同一个构建——
 * 只要打包内容有任何变化，MD5 就会变。
 *
 * 取 MD5 全 32 位十六进制的前 8 位作为展示用短码，足够区分日常构建。
 * 运行时计算，不依赖打包脚本注入。
 */

let cached: string | null = null;

export function getBuildHash(): string {
    if (cached !== null) {
        return cached;
    }
    try {
        // __filename 指向运行中的 dist/extension.js（打包后），
        // 开发未打包时指向 out/ 下的编译产物，同样能反映代码变化。
        const buf = fs.readFileSync(__filename);
        cached = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
    } catch (_) {
        cached = 'unknown';
    }
    return cached;
}
