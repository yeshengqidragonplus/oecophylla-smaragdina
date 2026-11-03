import * as fs from 'fs';
import * as path from 'path';

/**
 * 接收文件名的清理（不依赖 vscode）。
 *
 * 对方发来的文件名不可信，且 Mac 与 Windows 的规则不同：同一个名字在发送方合法，
 * 在接收方可能是保留名、含非法字符、超长，或与本地已有文件只差一个 Unicode 归一化形式。
 * 这里统一清理成"在 Mac / Windows / Linux 上都能安全落盘"的名字。
 */

/** 文件名最大字节数（UTF-8）：macOS 单名上限 255 字节，留余量给 " (n)" 序号与 .part 后缀 */
const MAX_NAME_BYTES = 200;
/** Windows 完整路径上限 260（含结尾 NUL），留余量 */
const WINDOWS_MAX_PATH = 250;
const MAX_EXTENSION_BYTES = 24;
const FALLBACK_NAME = 'received_file';

/** Windows 保留设备名（带不带扩展名都不能用，如 CON、con.txt） */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf-8');
}

/** 按 UTF-8 字节数截断，不切断多字节字符与代理对 */
function truncateToBytes(text: string, maxBytes: number): string {
    let bytes = 0;
    let result = '';
    for (const char of text) {
        const size = byteLength(char);
        if (bytes + size > maxBytes) {
            break;
        }
        bytes += size;
        result += char;
    }
    return result;
}

/**
 * 清理文件名：
 * - 取最后一段（同时按 / 和 \ 切分，防路径穿越）；
 * - 归一化为 NFC（macOS 文件系统常给出 NFD，与 Windows 上的同名文件对不上）；
 * - 去掉控制字符，把 `< > : " / \ | ? *` 替换为 `_`；
 * - 去掉首尾空白与末尾的点和空格（Windows 不允许）；
 * - Windows 保留名加 `_` 前缀；
 * - 限制 UTF-8 字节数，截断主名保留扩展名；
 * - 结果为空或只有点时回退为 received_file。
 */
export function sanitizeFileName(raw: string, maxBytes: number = MAX_NAME_BYTES): string {
    let name = (raw.split(/[\\/]/).pop() ?? '').normalize('NFC');
    name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"/\\|?*]/g, '_');
    name = name.trim().replace(/[. ]+$/, '');
    if (name === '' || /^\.+$/.test(name)) {
        return FALLBACK_NAME;
    }
    if (WINDOWS_RESERVED.test(name)) {
        name = `_${name}`;
    }
    if (byteLength(name) > maxBytes) {
        let ext = path.extname(name);
        if (byteLength(ext) > MAX_EXTENSION_BYTES) {
            ext = '';
        }
        const stem = name.slice(0, name.length - ext.length);
        name = truncateToBytes(stem, maxBytes - byteLength(ext)).replace(/[. ]+$/, '') + ext;
        if (name === '' || name === ext) {
            name = FALLBACK_NAME + ext;
        }
    }
    return name;
}

/** Windows 上完整路径过长时缩短主名（其他系统不受 260 限制，原样返回） */
export function fitToPathLimit(dir: string, name: string, platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32') {
        return name;
    }
    const room = WINDOWS_MAX_PATH - dir.length - 1;
    if (name.length <= room) {
        return name;
    }
    const ext = path.extname(name).length <= MAX_EXTENSION_BYTES ? path.extname(name) : '';
    const stem = name.slice(0, name.length - ext.length);
    const keep = Math.max(8, room - ext.length);
    return stem.slice(0, keep).replace(/[. ]+$/, '') + ext;
}

/**
 * 最终保存路径：清理文件名、适配 Windows 路径长度，同名文件加序号而不是覆盖。
 * `exists` 可注入，便于测试。
 */
export function uniqueSavePath(
    dir: string,
    rawName: string,
    options: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}
): string {
    const exists = options.exists ?? fs.existsSync;
    const name = fitToPathLimit(dir, sanitizeFileName(rawName), options.platform);
    let target = path.join(dir, name);
    if (!exists(target)) {
        return target;
    }
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    for (let i = 1; ; i++) {
        target = path.join(dir, `${stem} (${i})${ext}`);
        if (!exists(target)) {
            return target;
        }
    }
}
