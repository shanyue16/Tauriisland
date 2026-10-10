export type IslandStyle = "floating" | "docked";
export type HorizontalPosition = "left" | "center" | "right";
export type IslandState = "minimal" | "medium" | "expanded" | "maximal";
export type AnimationSpeed = "slow" | "normal" | "fast";
export type ThemeType = "dark" | "light";

// 主题预设色 — 参考 eIsland + Apple 设计语言
export const THEME_PRESETS: Record<ThemeType, {
  bg: string;       // 底色（不含 alpha）
  text: string;      // 主文字色
  textMuted: string; // 次要文字色
  border: string;    // 边框/分隔线
  sidebarBg: string; // 侧边栏底色
  cardBg: string;    // 设置卡片底色
}> = {
  dark: {
    bg: "rgb(18, 18, 20)",
    text: "#ffffff",
    textMuted: "rgba(255,255,255,0.65)",
    border: "rgba(255,255,255,0.12)",
    sidebarBg: "rgba(0,0,0,0.28)",
    cardBg: "rgba(255,255,255,0.06)",
  },
  light: {
    bg: "rgb(245, 245, 247)",
    text: "#1d1d1f",
    textMuted: "rgba(29,29,31,0.6)",
    border: "rgba(0,0,0,0.12)",
    sidebarBg: "rgba(0,0,0,0.04)",
    cardBg: "rgba(0,0,0,0.05)",
  },
};

export interface Settings {
  // 外观
  style: IslandStyle;
  theme: ThemeType;
  borderRadius: number; // 0-30px
  opacity: number; // 0-100, 0=全透明, 100=完全不透明
  horizontalPosition: HorizontalPosition;
  minimalWidth: number; // 100-240
  mediumWidth: number; // 160-360
  // 交互
  hoverDelay: number; // ms, default 100
  collapseDelay: number; // ms, default 1500
  wheelEnabled: boolean;
  animationSpeed: AnimationSpeed;
  clickThroughMinimal: boolean;

  // 高级
  autoStart: boolean;
  debugMode: boolean;

  // 显示器
  multiMonitor: boolean;
  dpiAware: boolean;

  // 天气
  weatherCity: string; // 空=按 IP 定位

  // 音乐
  /**
   * 播放器白名单：进程名/应用标识片段（忽略大小写、子串匹配）。
   * 非空时只有匹配到的播放器才会触发歌曲信息获取；为空表示不过滤。
   */
  musicWhitelist: string[];

  // 通知
  /** 是否读取系统通知（读取的是用户全部系统通知，默认开启） */
  notificationsEnabled: boolean;
  /**
   * 通知黑名单：不读取/不显示这些应用的通知。
   * 匹配 `PrimaryId`（app_id）或推导出的显示名，忽略大小写 + 子串匹配。
   * **为空表示不过滤**（默认全读）。与 musicWhitelist 是相反语义，别混。
   */
  notificationBlacklist: string[];
  /** 通知轮询间隔（ms）。每次读取要复制约 3.3MB 库快照，不要低于 5000 */
  notificationPollMs: number;
  /** 通知列表最多显示条数 */
  notificationMaxItems: number;
  /** 新通知到达时短暂展开岛提醒（关掉则只进列表、不弹） */
  notificationAlert: boolean;
  /** 提醒停留时长（ms）。鼠标悬停在提醒上时不自动收起 */
  notificationAlertMs: number;
  /**
   * 日程/闹钟通知开关。
   * ⚠️ 本期只落字段与开关，**没有真实触发器** —— 日程数据来源尚未定义。
   * 接入日程模块后由它读取本开关，届时再补调用方（见 docs/notifications-plan.md §3.7）。
   */
  notifyOnAlarm: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  style: "floating",
  theme: "dark",
  borderRadius: 24,
  opacity: 100,
  horizontalPosition: "center",
  minimalWidth: 220,
  // 300：悬浮态音乐页不需要歌词行，回到原始宽度（曾为放歌词临时改成 340）
  mediumWidth: 300,

  hoverDelay: 100,
  collapseDelay: 1500,
  wheelEnabled: true,
  animationSpeed: "normal",
  clickThroughMinimal: false,

  autoStart: true,
  debugMode: false,

  multiMonitor: false,
  dpiAware: true,

  weatherCity: "",

  // 默认白名单参考 eIsland
  musicWhitelist: [
    "QQMusic.exe",
    "cloudmusic.exe",
    "汽水音乐",
    "kugou",
    "PotPlayerMini64.exe",
  ],

  // 通知（用户口径：默认开启读取、默认不过滤）
  notificationsEnabled: true,
  notificationBlacklist: [],
  notificationPollMs: 10000,
  notificationMaxItems: 20,
  notificationAlert: true,
  notificationAlertMs: 5000,
  notifyOnAlarm: true,
};

export const ANIMATION_DURATION: Record<AnimationSpeed, number> = {
  slow: 380,
  normal: 280,
  fast: 180,
};
