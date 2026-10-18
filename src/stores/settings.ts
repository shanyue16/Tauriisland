import { create } from "zustand";
import {
  type Settings,
  type IslandState,
  type CustomSound,
  type CustomSoundMeta,
  DEFAULT_SETTINGS,
} from "../types";
import { useCustomSounds } from "./customSounds";
import { createDiskChannel } from "./disk";

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
const disk = createDiskChannel<Settings>(STORE_FILE, STORE_KEY);

/** 落盘（合并写入，200ms 去抖，避免连续拖动滑块时频繁写文件） */
function persist(settings: Settings) {
  disk.write(settings);
}

/**
 * 旧版默认白名单（26.10.1801 及更早）。
 *
 * 为什么需要：盘上存的列表永远优先于 DEFAULT_SETTINGS，直接改默认值对**老配置**
 * 一点作用都没有 —— 用户升级后会以为「加了 Folia」却看不到任何变化。
 * 这里做一次性判断：内容与顺序完全等于旧默认 → 换成新默认（多出 Folia）；
 * 用户只要增删过任意一条，就当作自定义，原样保留。
 */
const LEGACY_DEFAULT_MUSIC_WHITELIST = [
  "QQMusic.exe",
  "cloudmusic.exe",
  "汽水音乐",
  "kugou",
  "PotPlayerMini64.exe",
];

function isLegacyDefaultWhitelist(list: string[]): boolean {
  return (
    list.length === LEGACY_DEFAULT_MUSIC_WHITELIST.length &&
    list.every(
      (v, i) => v.toLowerCase() === LEGACY_DEFAULT_MUSIC_WHITELIST[i].toLowerCase(),
    )
  );
}

/** 本次归一化是否把旧默认白名单升级成了新默认 —— hydrateSettings 据此补一次落盘。 */
let whitelistUpgraded = false;

/** 白名单字段规范化：只保留非空字符串（数组存在即为用户意图，空数组＝不过滤，需保留） */
function normalizeWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.musicWhitelist];
  const list = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return isLegacyDefaultWhitelist(list)
    ? (() => {
        whitelistUpgraded = true;
        return [...DEFAULT_SETTINGS.musicWhitelist];
      })()
    : list;
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

/**
 * 本地歌词接口地址规范化：必须是 http(s) 绝对地址，否则回退默认。
 * 别让一个手改坏的地址静默毁掉整条链路 —— 地址无效时宁可用默认值。
 */
function normalizeEndpoint(value: unknown, def: string): string {
  if (typeof value !== "string") return def;
  const s = value.trim();
  if (!s) return def;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : def;
  } catch {
    return def;
  }
}

/** 默认值的深拷贝（避免 resetSettings 后共享引用被后续就地修改） */
function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    musicWhitelist: [...DEFAULT_SETTINGS.musicWhitelist],
    notificationBlacklist: [...DEFAULT_SETTINGS.notificationBlacklist],
    customSounds: [...DEFAULT_SETTINGS.customSounds],
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

/**
 * 自定义音效（data URL）规范化。
 *
 * 只接受 `data:audio/...` 开头的串，并挡掉明显超限的（正常上传上限 400KB，
 * base64 后约 533KB；这里留到 800KB 容忍边界，超过就当没设置过）。
 * 不校验音频能否解码 —— 解不了留给播放侧报错，别在设置层猜。
 */
const MAX_CUSTOM_SOUND_CHARS = 800_000;
/** 自定义音效最多存几条（每条最大 800K 字符，再多 settings.json 会太肥） */
export const MAX_CUSTOM_SOUND_ITEMS = 12;

function validSoundData(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("data:audio/") && v.length <= MAX_CUSTOM_SOUND_CHARS;
}

/**
 * 自定义音效库规范化 + 旧字段迁移。
 *
 * 旧版本只有两个字符串字段（notificationSoundCustom / alarmSoundCustom，各存一条），
 * 这里把它们转成音效库里的条目，并把选择重新指向新 id —— 老用户升级后不会「音效没了」。
 */
function normalizeCustomSounds(
  raw: unknown,
  legacyNotify: unknown,
  legacyAlarm: unknown
): { metas: CustomSoundMeta[]; legacy: CustomSound[] } {
  const out: CustomSound[] = [];
  const seen = new Set<string>();
  const push = (item: Partial<CustomSound>, fallbackKind: "notification" | "alarm") => {
    if (!validSoundData(item.data)) return;
    const kind: "notification" | "alarm" =
      item.kind === "notification" || item.kind === "alarm" ? item.kind : fallbackKind;
    let id = typeof item.id === "string" && item.id.startsWith("custom:") ? item.id : "";
    if (!id || seen.has(id)) id = `custom:${Math.random().toString(36).slice(2, 10)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 40) : "",
      kind,
      data: item.data,
      size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, item.size) : 0,
    });
  };

  // 已经是「只有元数据」的新格式：data 不存在，直接收
  const pushMeta = (item: Partial<CustomSoundMeta>, fallbackKind: "notification" | "alarm") => {
    if (typeof item.id !== "string" || !item.id.startsWith("custom:")) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name.trim().slice(0, 40) : "",
      kind: item.kind === "notification" || item.kind === "alarm" ? item.kind : fallbackKind,
      size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, item.size) : 0,
      // 占位：元数据项没有 data，迁移时由 customSounds store 按 id 补齐
      data: "",
    });
  };

  if (Array.isArray(raw)) {
    for (const item of raw as Partial<CustomSound>[]) {
      if (out.length >= MAX_CUSTOM_SOUND_ITEMS) break;
      if (!item || typeof item !== "object") continue;
      if (validSoundData(item.data)) push(item, "notification");
      else pushMeta(item, "notification");
    }
  }
  // 旧版单条字段 → 迁移（id 固定，重复读取不会叠加）
  if (out.length < MAX_CUSTOM_SOUND_ITEMS) {
    push(
      {
        id: "custom:legacy-notify",
        name: "旧自定义通知音",
        kind: "notification",
        data: typeof legacyNotify === "string" ? legacyNotify : undefined,
      },
      "notification"
    );
  }
  if (out.length < MAX_CUSTOM_SOUND_ITEMS) {
    push(
      {
        id: "custom:legacy-alarm",
        name: "旧自定义闹钟音",
        kind: "alarm",
        data: typeof legacyAlarm === "string" ? legacyAlarm : undefined,
      },
      "alarm"
    );
  }

  const metas: CustomSoundMeta[] = out.map(({ id, name, kind, size }) => ({ id, name, kind, size }));
  const legacy = out.filter((s) => s.data.length > 0);
  return { metas, legacy };
}

/** 把旧版 `"custom"` 选择重指到迁移后的条目 */
function remapLegacyChoice(choice: string, sounds: CustomSoundMeta[], kind: "notification" | "alarm"): string {
  if (choice !== "custom") return choice;
  const hit = sounds.find((s) => s.kind === kind);
  return hit ? hit.id : kind === "notification" ? "prompt-short" : "clock-ringing";
}

/** normalizeSettings 顺手收集到的「音频本体」，交给 customSounds store 落盘 */
let legacySoundData: CustomSound[] = [];

/** 把磁盘上的任意内容规范成完整、类型正确的 Settings */
function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const r = raw as Partial<Settings> & {
    notificationSoundCustom?: unknown;
    alarmSoundCustom?: unknown;
  };
  const { metas: customSounds, legacy } = normalizeCustomSounds(
    r.customSounds,
    r.notificationSoundCustom,
    r.alarmSoundCustom
  );
  legacySoundData = legacy;
  return {
    // 外观
    style: oneOf(r.style, ["floating", "docked"] as const, d.style),
    theme: oneOf(r.theme, ["dark", "light"] as const, d.theme),
    language: oneOf(r.language, ["auto", "zh-CN", "en"] as const, d.language),
    borderRadius: num(r.borderRadius, d.borderRadius, 0, 30),
    opacity: num(r.opacity, d.opacity, 0, 100),
    horizontalPosition: oneOf(r.horizontalPosition, ["left", "center", "right"] as const, d.horizontalPosition),
    // 水平可正可负（左右挪）；垂直只允许向下 —— 否则岛会被推到屏幕上方，用户再也点不到
    offsetX: num(r.offsetX, d.offsetX, -200, 200),
    offsetY: num(r.offsetY, d.offsetY, 0, 200),
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
    // 本地歌词接口
    localLyricEnabled: bool(r.localLyricEnabled, d.localLyricEnabled),
    localLyricEndpoint: normalizeEndpoint(r.localLyricEndpoint, d.localLyricEndpoint),
    localLyricTimeoutMs: num(r.localLyricTimeoutMs, d.localLyricTimeoutMs, 300, 5000),
    wordByWordEnabled: bool(r.wordByWordEnabled, d.wordByWordEnabled),
    localLyricTrust: bool(r.localLyricTrust, d.localLyricTrust),
    stageApiEnabled: bool(r.stageApiEnabled, d.stageApiEnabled),
    // token 是凭据：只做「是不是字符串」的兜底，**不要** trim 掉用户粘贴时可能带的空白之外的东西
    stageApiToken: typeof r.stageApiToken === "string" ? r.stageApiToken.trim() : d.stageApiToken,
    stageApiEndpoint: normalizeEndpoint(r.stageApiEndpoint, d.stageApiEndpoint),
    stageApiTimeoutMs: num(r.stageApiTimeoutMs, d.stageApiTimeoutMs, 300, 5000),
    // Now Playing（9863）
    nowPlayingEnabled: bool(r.nowPlayingEnabled, d.nowPlayingEnabled),
    nowPlayingBase: normalizeEndpoint(r.nowPlayingBase, d.nowPlayingBase),
    nowPlayingTimeoutMs: num(r.nowPlayingTimeoutMs, d.nowPlayingTimeoutMs, 300, 5000),
    // 通知（数组缺失→空数组＝不过滤；默认开启读取）
    notificationsEnabled: bool(r.notificationsEnabled, d.notificationsEnabled),
    notificationBlacklist: normalizeBlacklist(r.notificationBlacklist),
    notificationPollMs: num(r.notificationPollMs, d.notificationPollMs, 5000, 60000),
    notificationMaxItems: num(r.notificationMaxItems, d.notificationMaxItems, 5, 100),
    notificationAlert: bool(r.notificationAlert, d.notificationAlert),
    notificationAlertMs: num(r.notificationAlertMs, d.notificationAlertMs, 2000, 15000),
    notifyOnAlarm: bool(r.notifyOnAlarm, d.notifyOnAlarm),
    systemNotification: bool(r.systemNotification, d.systemNotification),
    // 音效：取值合法性交给 audio.ts 的 pickSource（未知 id 回退默认音，不会静默变哑）；
    // 自定义音是 data URL，只挡明显异常的超大串（正常上传上限 400KB ≈ base64 533KB）
    notificationSound: remapLegacyChoice(str(r.notificationSound, d.notificationSound), customSounds, "notification"),
    alarmSound: remapLegacyChoice(str(r.alarmSound, d.alarmSound), customSounds, "alarm"),
    customSounds,
    hideOnFullscreen: bool(r.hideOnFullscreen, d.hideOnFullscreen),
    fullscreenHideAnim: oneOf(
      r.fullscreenHideAnim,
      ["fade", "slide", "both"] as const,
      d.fullscreenHideAnim
    ),
    // 快捷键：只保证是字符串（格式合法性交给 Rust parse_combo 判定并回报错误）
    hotkeyQuit: str(r.hotkeyQuit, d.hotkeyQuit),
    hotkeyToggle: str(r.hotkeyToggle, d.hotkeyToggle),
  };
}

/** 启动时从磁盘恢复设置（逐字段校验；缺字段/类型不符回退默认值；失败则整体用默认值） */
export async function hydrateSettings(): Promise<void> {
  // 自定义音效的音频本体在 sounds.json：先把它读进来，试听/播放才拿得到 data
  await useCustomSounds.getState().load();
  try {
    const saved = (await disk.read()) as Partial<Settings> | null;
    const next = normalizeSettings(saved);
    useSettings.setState({ settings: next });
    // 旧版把音频本体写在 settings.json 里：搬进 sounds.json，并把 settings 侧重写成纯元数据。
    // 白名单从旧默认升级到新默认（新增 Folia）同样要落盘一次，否则每次启动都白算一遍。
    if (legacySoundData.length > 0 || whitelistUpgraded) {
      if (legacySoundData.length > 0) {
        useCustomSounds.getState().migrate(legacySoundData);
        legacySoundData = [];
      }
      whitelistUpgraded = false;
      persist(next);
    }
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
