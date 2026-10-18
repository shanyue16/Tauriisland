/**
 * 磁盘持久化的公共外壳（settings.json / sounds.json / schedule.json 三个 store 共用）。
 *
 * 抽出来的理由：三个 store 各自写了一遍「LazyStore + 200ms 去抖 + 静默失败」，
 * 逻辑一模一样，只是文件名与 key 不同。写在这里的只有一件事必须一致——
 * **同一个文件只能有一个 LazyStore 连接**，否则两个连接各自缓存、互相覆盖。
 */
import { LazyStore } from "@tauri-apps/plugin-store";

/** file → 连接（模块级共享，避免同一文件被 new 出多个实例） */
const connections = new Map<string, LazyStore>();

export function storeConnection(file: string): LazyStore {
  let store = connections.get(file);
  if (!store) {
    store = new LazyStore(file);
    connections.set(file, store);
  }
  return store;
}

export interface DiskChannelOptions {
  /** 写盘去抖，默认 200ms（连续拖动滑块/连点按钮时不要每个事件都写文件） */
  delayMs?: number;
  /** 写失败回调；不传＝静默（持久化不可用就降级成内存数据，不能影响运行） */
  onWriteError?: (err: unknown) => void;
}

export interface DiskChannel<T> {
  /** 读原始值（没有则 null）。交给调用方做规范化 —— 各 store 的迁移逻辑本来就不一样 */
  read: () => Promise<unknown>;
  /** 去抖写盘；只保留最后一次调用 */
  write: (value: T) => void;
}

export function createDiskChannel<T>(
  file: string,
  key: string,
  options: DiskChannelOptions = {}
): DiskChannel<T> {
  const { delayMs = 200, onWriteError } = options;
  const store = storeConnection(file);
  let timer: number | null = null;

  return {
    read: () => store.get<unknown>(key),
    write: (value) => {
      if (typeof window === "undefined") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void (async () => {
          try {
            await store.set(key, value);
            await store.save();
          } catch (err) {
            onWriteError?.(err);
          }
        })();
      }, delayMs);
    },
  };
}
