import { create } from "zustand";
import type { CustomSound, CustomSoundMeta } from "../types";
import { createDiskChannel } from "./disk";

/**
 * 自定义音效库（音频本体），独立存 `sounds.json`。
 *
 * 为什么从 settings.json 里搬出来：
 * settings 的每一次改动（主题、位置、透明度、黑名单…）都会整份写回磁盘，
 * 而单条自定义音效是 base64 的 data URL（上限 400KB 原始字节 → 约 533KB 文本）。
 * 12 条封顶时 settings.json 能到 ~6MB，于是「改个主题」也要重写 6MB —— 写盘变慢、
 * 启动时解析也变慢。拆成两个文件后：settings.json 只留 id/名字/体积（几百字节），
 * 音频只在增删音效时才写。
 *
 * 另一条更彻底的路是「音频落盘成文件、settings 只存路径」，那需要新增 Rust 命令 +
 * fs 权限，且老数据要做一遍迁移；当前这个拆法零权限、零 Rust 改动、老数据自动迁移。
 */
const STORE_FILE = "sounds.json";
const KEY = "sounds";

const disk = createDiskChannel<CustomSound[]>(STORE_FILE, KEY, {
  onWriteError: (err) => console.error("[sounds] persist failed:", err),
});

function persist(sounds: CustomSound[]): void {
  disk.write(sounds);
}

function validEntry(value: unknown): value is CustomSound {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CustomSound>;
  return typeof v.id === "string" && typeof v.data === "string" && v.data.startsWith("data:audio/");
}

interface CustomSoundsState {
  sounds: CustomSound[];
  loaded: boolean;
  /** 读盘（幂等；失败只留空表，不影响设置页） */
  load: () => Promise<void>;
  /** 新增一条（同时刷新 settings 里的元数据由调用方负责） */
  add: (entry: CustomSound) => void;
  /** 删除一条，返回被删的条目（用于回退选择） */
  remove: (id: string) => CustomSound | null;
  /**
   * 从旧的 settings.json 迁移：老版本把音频本体写在 `settings.customSounds` 里。
   * 迁移后立刻落盘，并把 settings 侧的同名字段降级成元数据。
   */
  migrate: (legacy: CustomSound[]) => void;
}

export const useCustomSounds = create<CustomSoundsState>((set, get) => ({
  sounds: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await disk.read();
      // 迁移可能已经先一步写进来（settings.load 先于本 store 完成），别覆盖
      if (Array.isArray(raw) && get().sounds.length === 0) {
        set({ sounds: raw.filter(validEntry), loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch (err) {
      console.error("[sounds] load failed:", err);
      set({ loaded: true });
    }
  },

  add: (entry) => {
    const sounds = [...get().sounds, entry];
    set({ sounds, loaded: true });
    persist(sounds);
  },

  remove: (id) => {
    const removed = get().sounds.find((s) => s.id === id) ?? null;
    if (!removed) return null;
    const sounds = get().sounds.filter((s) => s.id !== id);
    set({ sounds });
    persist(sounds);
    return removed;
  },

  migrate: (legacy) => {
    if (legacy.length === 0) return;
    const existing = new Set(get().sounds.map((s) => s.id));
    const merged = [...get().sounds, ...legacy.filter((s) => !existing.has(s.id))];
    set({ sounds: merged, loaded: true });
    persist(merged);
  },
}));

/** settings 侧要存的元数据（剥掉 data） */
export function toMeta(sound: CustomSound): CustomSoundMeta {
  return { id: sound.id, name: sound.name, kind: sound.kind, size: sound.size };
}
