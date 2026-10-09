import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  type Settings,
  type IslandState,
  DEFAULT_SETTINGS,
} from "../types";

interface SettingsStore {
  settings: Settings;
  state: IslandState;
  currentPage: number;
  setState: (s: IslandState) => void;
  setCurrentPage: (p: number) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  resetSettings: () => void;
}

// —— 设置持久化（tauri-plugin-store）——
// 之前设置只存在内存里，重启即丢。这里接上磁盘存储：启动时合并读出，
// 每次 updateSettings 后落盘。任何一步失败都只当"没存过"，不影响运行。
const STORE_FILE = "settings.json";
const STORE_KEY = "settings";
const diskStore = new LazyStore(STORE_FILE);

let persistTimer: number | null = null;

/** 落盘（合并写入，200ms 去抖，避免连续拖动滑块时频繁写文件） */
function persist(settings: Settings) {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void (async () => {
      try {
        await diskStore.set(STORE_KEY, settings);
        await diskStore.save();
      } catch {
        /* 持久化不可用时静默降级为内存设置 */
      }
    })();
  }, 200);
}

/** 白名单字段规范化：只保留非空字符串（数组存在即为用户意图，空数组＝不过滤，需保留） */
function normalizeWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.musicWhitelist];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * 通知黑名单规范化。
 *
 * 与白名单不同的是：**数组缺失时返回空数组**（= 不过滤 = 默认全读），
 * 而不是回退到哪个非空默认值 —— 黑名单的"默认"本来就是空。
 */
function normalizeBlacklist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** 默认值的深拷贝（避免 resetSettings 后共享引用被后续就地修改） */
function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    musicWhitelist: [...DEFAULT_SETTINGS.musicWhitelist],
    notificationBlacklist: [...DEFAULT_SETTINGS.notificationBlacklist],
  };
}

// —— 逐字段防御性校验 ——
// 磁盘上的 settings.json 可能来自旧版本（缺字段）或被手工改坏（类型不符）。
// 直接 {...DEFAULT_SETTINGS, ...saved} 会把错误类型原样灌进 UI（例如 opacity:"50"），
// 所以这里对每个字段做类型/枚举/范围校验，不合格就回退默认值。
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
const str = (v: unknown, def: string): string => (typeof v === "string" ? v : def);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;

/** 把磁盘上的任意内容规范成完整、类型正确的 Settings */
function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const r = raw as Partial<Settings>;
  return {
    // 外观
    style: oneOf(r.style, ["floating", "docked"] as const, d.style),
    theme: oneOf(r.theme, ["dark", "light"] as const, d.theme),
    borderRadius: num(r.borderRadius, d.borderRadius, 0, 30),
    opacity: num(r.opacity, d.opacity, 0, 100),
    horizontalPosition: oneOf(r.horizontalPosition, ["left", "center", "right"] as const, d.horizontalPosition),
    minimalWidth: num(r.minimalWidth, d.minimalWidth, 100, 240),
    mediumWidth: num(r.mediumWidth, d.mediumWidth, 160, 360),
    // 交互
    hoverDelay: num(r.hoverDelay, d.hoverDelay, 0, 5000),
    collapseDelay: num(r.collapseDelay, d.collapseDelay, 0, 60000),
    wheelEnabled: bool(r.wheelEnabled, d.wheelEnabled),
    animationSpeed: oneOf(r.animationSpeed, ["slow", "normal", "fast"] as const, d.animationSpeed),
    clickThroughMinimal: bool(r.clickThroughMinimal, d.clickThroughMinimal),
    // 高级
    autoStart: bool(r.autoStart, d.autoStart),
    debugMode: bool(r.debugMode, d.debugMode),
    // 显示器
    multiMonitor: bool(r.multiMonitor, d.multiMonitor),
    dpiAware: bool(r.dpiAware, d.dpiAware),
    // 天气
    weatherCity: str(r.weatherCity, d.weatherCity),
    // 音乐（数组缺失→默认；空数组→保留，表示"不过滤"）
    musicWhitelist: normalizeWhitelist(r.musicWhitelist),
    // 通知（数组缺失→空数组＝不过滤；默认开启读取）
    notificationsEnabled: bool(r.notificationsEnabled, d.notificationsEnabled),
    notificationBlacklist: normalizeBlacklist(r.notificationBlacklist),
    notificationPollMs: num(r.notificationPollMs, d.notificationPollMs, 5000, 60000),
    notificationMaxItems: num(r.notificationMaxItems, d.notificationMaxItems, 5, 100),
    notificationAlert: bool(r.notificationAlert, d.notificationAlert),
    notificationAlertMs: num(r.notificationAlertMs, d.notificationAlertMs, 2000, 15000),
    notifyOnAlarm: bool(r.notifyOnAlarm, d.notifyOnAlarm),
  };
}

/** 启动时从磁盘恢复设置（逐字段校验；缺字段/类型不符回退默认值；失败则整体用默认值） */
export async function hydrateSettings(): Promise<void> {
  try {
    const saved = await diskStore.get<Partial<Settings>>(STORE_KEY);
    useSettings.setState({ settings: normalizeSettings(saved) });
  } catch {
    /* 无存储文件或插件不可用时保持默认值 */
  }
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  state: "minimal",
  currentPage: 0,
  setState: (s) => set({ state: s }),
  setCurrentPage: (p) => set({ currentPage: p }),
  updateSettings: (partial) => {
    set((st) => ({ settings: { ...st.settings, ...partial } }));
    persist(get().settings);
  },
  resetSettings: () => {
    // 重置后立即落盘：否则下次启动会从旧文件读回被重置前的值
    const defaults = cloneDefaults();
    set({ settings: defaults });
    persist(defaults);
  },
}));

// 模块被首次引入时即尝试恢复（App 会引入本 store）
void hydrateSettings();
