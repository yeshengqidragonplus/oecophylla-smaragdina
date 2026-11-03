import * as events from 'events';

/**
 * 类型安全的 EventEmitter：事件名与监听器参数在编译期检查，
 * 事件名拼错、参数类型不符会直接报错（原先是字符串事件，拼错只会静默收不到）。
 *
 * 用法：`class Foo extends TypedEmitter<{ change: [string]; done: [] }> {}`
 * 事件表里每个事件对应其监听器的参数元组。
 */
export class TypedEmitter<E extends { [K in keyof E]: unknown[] }> extends events.EventEmitter {
    on<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    once<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
        return super.once(event, listener as (...args: unknown[]) => void);
    }

    off<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }

    emit<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
        return super.emit(event, ...args);
    }

    listenerCount<K extends keyof E & string>(event: K): number {
        return super.listenerCount(event);
    }
}
