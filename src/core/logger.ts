/**
 * 轻量日志模块：始终输出到控制台；在 VS Code 环境下由 extension.ts
 * 注入 OutputChannel 后，同时写入"OSChat 日志"输出通道，方便用户排查。
 *
 * 不直接 import vscode——networkService 等模块会在 VS Code 之外运行
 * （如 smoke-test.js），保持零依赖。
 */

interface LogSink {
    appendLine(value: string): void;
}

let sink: LogSink | null = null;

/** 由 extension.ts 在激活时注入 OutputChannel */
export function setLogSink(s: LogSink): void {
    sink = s;
}

function format(args: unknown[]): string {
    return args.map(a => {
        if (a instanceof Error) {
            return a.stack || a.message;
        }
        if (typeof a === 'object' && a !== null) {
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        }
        return String(a);
    }).join(' ');
}

function timestamp(): string {
    const d = new Date();
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function log(...args: unknown[]): void {
    const line = format(args);
    console.log(line);
    sink?.appendLine(`[${timestamp()}] ${line}`);
}

export function logError(...args: unknown[]): void {
    const line = format(args);
    console.error(line);
    sink?.appendLine(`[${timestamp()}] [错误] ${line}`);
}
