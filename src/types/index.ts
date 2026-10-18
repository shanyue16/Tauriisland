export type IslandStyle = "floating" | "docked";
export type HorizontalPosition = "left" | "center" | "right";
export type IslandState = "minimal" | "medium" | "expanded" | "maximal";
export type AnimationSpeed = "slow" | "normal" | "fast";
export type ThemeType = "dark" | "light";
/** 语言设置：auto=跟随系统（navigator.language，非中/英回退中文），也可显式固定 */
export type LanguageSetting = "auto" | "zh-CN" | "en";
/** 全屏隐藏的动画方式："fade" 淡入淡出 / "slide" 滑入滑出 / "both" 两者同时 */
export type FullscreenHideAnim = "fade" | "slide" | "both";

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

/**
 * 一条用户自定义音效的**元数据**（存在 settings.json 里，很小）。
 *
 * 音频本体（data URL，单条可达数百 KB）另存 `sounds.json`，
 * 否则每次改主题/位置等任意设置都要把整块音频重写一遍。
 */
export interface CustomSoundMeta {
  /** 稳定 id，形如 `custom:<8位随机>`；被 notificationSound / alarmSound 引用 */
  id: string;
  /** 显示名（默认取上传时的文件名，可留空则显示「自定义音 N」） */
  name: string;
  /** 归属：通知音与闹钟音各自列出自己的条目 */
  kind: "notification" | "alarm";
  /** 原始字节数（只在 UI 上显示体积） */
  size: number;
}

/** 一条完整的自定义音效（元数据 + 音频本体，存 `sounds.json`） */
export interface CustomSound extends CustomSoundMeta {
  /** 音频 data URL */
  data: string;
}

export interface Settings {
  // 外观
  style: IslandStyle;
  theme: ThemeType;
  /** 界面语言：auto 跟随系统（回退中文），或显式 zh-CN / en */
  language: LanguageSetting;
  borderRadius: number; // 0-30px
  opacity: number; // 0-100, 0=全透明, 100=完全不透明
  horizontalPosition: HorizontalPosition;
  /**
   * 水平微调（px，可负）：在"水平位置"给出的基准之上再左右挪一点。
   * 两种形态都生效（"贴边"指的是顶边，不限制水平方向）。
   */
  offsetX: number;
  /**
   * 垂直微调（px，仅向下）：「悬浮胶囊」在默认 8px 顶部间距之上再下移。
   * **「贴边挂角」形态忽略它** —— 该形态必须贴住屏幕顶边，这是它的定义。
   */
  offsetY: number;
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

  // 本地歌词接口（本机第三方程序的兼容接口，目前实现的是 Folia 的 32109）
  /**
   * 是否启用本地歌词接口。关掉＝完全不请求本机服务（级联只剩网络源）。
   * 默认开启：它是唯一能给出逐字（卡拉OK）歌词的来源。
   */
  localLyricEnabled: boolean;
  /** 接口地址。默认 Folia 的 http://127.0.0.1:32109/v1/lyric */
  localLyricEndpoint: string;
  /**
   * 单次请求的真超时（ms）。本机回环服务要么秒回、要么没在跑，
   * 不值得为它等 —— 超时就当没有，继续走网络级联。
   */
  localLyricTimeoutMs: number;
  /**
   * 是否显示逐字（卡拉OK）高亮。
   * 关掉则只按行高亮；数据侧照样取，只是不保留逐字时间轴。
   */
  wordByWordEnabled: boolean;
  /**
   * 完全信任本地歌词：**接口只要返回歌词就直接用，不核对曲目**。
   *
   * 默认「否」——此时仍会核对，但核对只在**解析得出身份**时才生效：
   * 歌词文件里没有可解析的曲目信息（实测 `op：风升乐起` 这种片头标记）
   * 会被当作「无法核对」而采用，不会被误当成「不符」丢掉。
   *
   * 打开后连「明确不符」也采用 —— 适用于「Folia 就是我的歌词显示、
   * 里面放的一定是我在听的那首」的用法。代价：Folia 若切到了别的歌，
   * 岛上会显示那首歌的歌词（与 Folia 窗口一致，肉眼可见、可自行关掉）。
   */
  localLyricTrust: boolean;
  /**
   * Stage API（Folia 32107）：**唯一能给出播放进度的本地源**。
   *
   * 实测它能给曲名 / 歌手 / 专辑 / 时长 / 当前位置 / 播放状态 / 封面，以及
   * `controlCapabilities`（play/pause/resume/seek/previous/next）。
   * 但除 `/stage/health` 外**全部需要 Bearer token** —— 所以默认关闭，
   * 没填 token 时必然 401。
   */
  stageApiEnabled: boolean;
  /** Stage API 的 Bearer token（在 Folia 的 Stage Mode 里复制）。只存在本地设置里。 */
  stageApiToken: string;
  stageApiEndpoint: string;
  /** 单次请求超时（ms）。本机回环服务不该慢。 */
  stageApiTimeoutMs: number;
  /**
   * Now Playing（`Widdit/now-playing-service`，默认 9863）—— 本机第三方「正在播放」服务。
   *
   * 它是**唯一同时给逐字歌词与播放进度**的本地源（无鉴权），所以默认开启；
   * 没装/没开时只是几次毫秒级的连接失败，静默降级到 SMTC + 网络级联。
   *
   * ⚠️ 它的进度是**推算**的：只跟播放/暂停，**不跟 seek**（网易云/全民K歌除外）。
   * 这是它的设计，不是故障 —— 见 `playbackSources/nowplaying.ts` 文件头。
   */
  nowPlayingEnabled: boolean;
  /** 服务地址（无尾斜杠）。端口默认 9863，可在它的 config.json 里改。 */
  nowPlayingBase: string;
  /** 单次请求的真超时（ms）—— 本机回环服务要么秒回、要么没在跑。 */
  nowPlayingTimeoutMs: number;

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
  /** 是否向 Windows 推送系统通知（关掉＝只在岛内提醒，不发系统横幅） */
  systemNotification: boolean;
  /**
   * 通知音效。取值为 `src/services/audio.ts` 里 `NOTIFICATION_SOUNDS` 的 id、
   * `customSounds` 里某个条目的 id，或 `"none"`（静音）。
   * 未知 id 会回退到默认音，不会静默变哑。
   */
  notificationSound: string;
  /** 闹钟音效，口径同 notificationSound（取值来自 `ALARM_SOUNDS`） */
  alarmSound: string;
  /**
   * 用户自定义音效库的**元数据**：可存多个、可删除，通知音与闹钟音各自按 `kind` 取用。
   * 音频本体在 `sounds.json`（见 `src/stores/customSounds.ts`），这里只留 id/名字/体积，
   * 保证 settings.json 不会因为音效而变大。
   */
  customSounds: CustomSoundMeta[];
  /**
   * 全屏隐藏（默认开）。
   *
   * 检测在 Rust 侧（`SHQueryUserNotificationState`，见 src-tauri/src/fullscreen.rs），
   * 命中全屏游戏 / 全屏演示 / PPT 放映时把窗口 `hide()`，退出全屏后恢复并重设置顶。
   * 这里只存开关；全屏期间新通知**只进列表、不弹提醒**（闹钟将来是唯一例外）。
   */
  hideOnFullscreen: boolean;
  /**
   * 全屏隐藏用哪种动画。两者是**独立的两条动画**，所以分开可选：
   *   - `"fade"`  淡入淡出：窗口不动，整棵岛体 opacity 0↔1；
   *   - `"slide"` 滑入滑出：窗口整体上滑出屏幕（getTargetPos 的收拢分支），完全不改透明度；
   *   - `"both"`  两者同时跑（默认，也是本功能最初验收的形态）。
   */
  fullscreenHideAnim: FullscreenHideAnim;
  /**
   * 全局快捷键：退出应用（默认 "Alt+Z"）。
   * 文本格式由 Rust 侧 hotkeys.rs parse_combo 解析："Alt+Shift+X" / "Ctrl+F1" 等；
   * 注册失败（键被占用）走 `hotkey://error` 事件，前端设置页必须显示。
   */
  hotkeyQuit: string;
  /**
   * 全局快捷键：隐藏/显示灵动岛（默认 "Alt+C"）。
   * 手动隐藏标记（MANUAL_HIDDEN）与全屏隐藏独立，全屏检测不会把快捷键藏起的岛抢回来。
   */
  hotkeyToggle: string;
}

export const DEFAULT_SETTINGS: Settings = {
  style: "floating",
  theme: "dark",
  language: "auto",
  borderRadius: 24,
  opacity: 100,
  horizontalPosition: "center",
  offsetX: 0,
  offsetY: 0,
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

  // 本地歌词接口（默认指向 Folia；关掉后级联只剩网络源）
  localLyricEnabled: true,
  localLyricEndpoint: "http://127.0.0.1:32109/v1/lyric",
  localLyricTimeoutMs: 1200,
  wordByWordEnabled: true,
  localLyricTrust: false,
  stageApiEnabled: false,
  stageApiToken: "",
  stageApiEndpoint: "http://127.0.0.1:32107",
  stageApiTimeoutMs: 1200,
  // Now Playing（9863）：默认开启，没装/没开时静默降级
  nowPlayingEnabled: true,
  nowPlayingBase: "http://127.0.0.1:9863",
  nowPlayingTimeoutMs: 1200,

  // 通知（用户口径：默认开启读取、默认不过滤）
  notificationsEnabled: true,
  notificationBlacklist: [],
  notificationPollMs: 10000,
  notificationMaxItems: 20,
  notificationAlert: true,
  notificationAlertMs: 5000,
  notifyOnAlarm: true,
  /**
   * 是否向 Windows 推送系统通知（默认开）。
   * 关掉后应用内的提醒卡片/声音照旧，只是不再进系统通知中心 ——
   * 适合「不想被系统横幅打断、只看岛」的用法。见 `src/services/notify.ts`。
   */
  systemNotification: true,
  // 音效：默认用素材里的「简短提示音」与「alarm-clock-ringing」
  notificationSound: "prompt-short",
  alarmSound: "clock-ringing",
  customSounds: [],

  // 全屏隐藏：默认开（用户口径）
  hideOnFullscreen: true,
  // 默认两者同时跑，与最初验收的观感一致；只想看一种时去设置里改
  fullscreenHideAnim: "both",
  // 全局快捷键（用户口径：ALT+Z 退出应用、ALT+C 隐藏/显示）
  hotkeyQuit: "Alt+Z",
  hotkeyToggle: "Alt+C",
};

export const ANIMATION_DURATION: Record<AnimationSpeed, number> = {
  slow: 380,
  normal: 280,
  fast: 180,
};
