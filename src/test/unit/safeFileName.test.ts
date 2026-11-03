import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultDownloadDir, isWritableDir, resolveDownloadDir } from '../../core/downloadDir';
import { fitToPathLimit, sanitizeFileName, uniqueSavePath } from '../../core/safeFileName';

suite('safeFileName：文件名清理', () => {
    test('只取最后一段：同时处理 / 与 \\，防路径穿越（与接收端所在系统无关）', () => {
        assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
        assert.strictEqual(sanitizeFileName('..\\..\\Windows\\evil.dll'), 'evil.dll');
        assert.strictEqual(sanitizeFileName('C:\\Users\\a\\report.xlsx'), 'report.xlsx');
        assert.strictEqual(sanitizeFileName('/abs/path/photo.png'), 'photo.png');
    });

    test('非法字符替换为 _，控制字符删除', () => {
        assert.strictEqual(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
        assert.strictEqual(sanitizeFileName('bad\u0000na\u0007me.txt'), 'badname.txt');
    });

    test('Windows 保留设备名（含带扩展名）加前缀，避免在 Windows 上写入失败', () => {
        assert.strictEqual(sanitizeFileName('CON'), '_CON');
        assert.strictEqual(sanitizeFileName('con.txt'), '_con.txt');
        assert.strictEqual(sanitizeFileName('COM1.log'), '_COM1.log');
        assert.strictEqual(sanitizeFileName('lpt9'), '_lpt9');
        assert.strictEqual(sanitizeFileName('console.txt'), 'console.txt');
        assert.strictEqual(sanitizeFileName('com10.txt'), 'com10.txt');
    });

    test('末尾的点和空格被去掉（Windows 不允许）；只有点、空名回退为 received_file', () => {
        assert.strictEqual(sanitizeFileName('报告.'), '报告');
        assert.strictEqual(sanitizeFileName('name  . '), 'name');
        assert.strictEqual(sanitizeFileName(''), 'received_file');
        assert.strictEqual(sanitizeFileName('..'), 'received_file');
        assert.strictEqual(sanitizeFileName('   '), 'received_file');
        assert.strictEqual(sanitizeFileName('.gitignore'), '.gitignore');
    });

    test('NFD 归一化为 NFC：Mac 上的"é"与 Windows 上的同名文件一致', () => {
        const nfd = 'cafe\u0301.txt';
        assert.notStrictEqual(nfd, 'caf\u00e9.txt');
        assert.strictEqual(sanitizeFileName(nfd), 'caf\u00e9.txt');
    });

    test('超长文件名按 UTF-8 字节截断并保留扩展名；不切断中文与 emoji', () => {
        const long = sanitizeFileName('a'.repeat(300) + '.pdf');
        assert.ok(Buffer.byteLength(long) <= 200);
        assert.ok(long.endsWith('.pdf'));

        const cjk = sanitizeFileName('报'.repeat(100) + '.docx');
        assert.ok(Buffer.byteLength(cjk) <= 200);
        assert.ok(cjk.endsWith('.docx'));
        assert.ok(/^报+\.docx$/.test(cjk), '不应出现被切断的乱码字符');

        const emoji = sanitizeFileName('😀'.repeat(80) + '.txt');
        assert.ok(Buffer.byteLength(emoji) <= 200);
        assert.ok(/^(\u{1F600})+\.txt$/u.test(emoji));
    });

    test('Windows 路径过长时缩短主名，其他系统不受限', () => {
        const dir = 'C:\\' + 'd'.repeat(200);
        const fitted = fitToPathLimit(dir, 'x'.repeat(100) + '.txt', 'win32');
        assert.ok(dir.length + 1 + fitted.length <= 250);
        assert.ok(fitted.endsWith('.txt'));
        assert.strictEqual(fitToPathLimit(dir, 'x'.repeat(100) + '.txt', 'darwin'), 'x'.repeat(100) + '.txt');
    });
});

suite('safeFileName：保存路径与同名处理', () => {
    test('同名文件加序号，不覆盖已有文件', () => {
        const taken = new Set(['/d/a.txt', '/d/a (1).txt']);
        const exists = (p: string): boolean => taken.has(p.split(path.sep).join('/'));
        const result = uniqueSavePath('/d', 'a.txt', { exists });
        assert.strictEqual(result.split(path.sep).join('/'), '/d/a (2).txt');
    });

    test('恶意文件名最终仍落在目标目录内', () => {
        const result = uniqueSavePath('/safe/dir', '../../../../etc/cron.d/evil', { exists: () => false });
        assert.strictEqual(path.dirname(result), path.normalize('/safe/dir'));
        assert.strictEqual(path.basename(result), 'evil');
    });
});

suite('downloadDir：保存目录', () => {
    let tmp: string;
    setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-dl-')); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    test('默认目录是系统"下载"文件夹下的 OS Chat', () => {
        assert.strictEqual(defaultDownloadDir('/home/u'), path.join('/home/u', 'Downloads', 'OS Chat'));
    });

    test('isWritableDir：不存在时创建，并确认可写；父路径是文件时不可用', () => {
        assert.ok(isWritableDir(path.join(tmp, 'a', 'b')).ok);
        const blocker = path.join(tmp, 'blocker');
        fs.writeFileSync(blocker, 'x');
        assert.ok(!isWritableDir(path.join(blocker, 'sub')).ok);
    });

    test('使用用户配置的目录', () => {
        const dir = path.join(tmp, 'mine');
        const result = resolveDownloadDir({ configured: dir, defaultDir: path.join(tmp, 'default') });
        assert.strictEqual(result.dir, dir);
        assert.strictEqual(result.fallbackReason, undefined);
    });

    test('未配置时用默认目录', () => {
        const result = resolveDownloadDir({ configured: '  ', defaultDir: path.join(tmp, 'default') });
        assert.strictEqual(result.dir, path.join(tmp, 'default'));
    });

    test('配置的目录不可用（如外接卷未挂载）：回退到备选目录并给出原因，而不是让接收失败', () => {
        const blocker = path.join(tmp, 'blocker');
        fs.writeFileSync(blocker, 'x');
        const fallback = path.join(tmp, 'fallback');
        const result = resolveDownloadDir({ configured: path.join(blocker, 'downloads'), fallbackDirs: [fallback] });
        assert.strictEqual(result.dir, fallback);
        assert.ok(result.fallbackReason && result.fallbackReason.includes('blocker'));
    });
});
