/**
 * 本地歌词接口的**最近一次尝试结果**。
 *
 * 为什么需要这个文件：本机歌词接口的设计原则是「失败一律静默降级」——
 * 这对界面是对的（不能让一个可选的第三方程序影响主链路），但对**排查**是灾难：
 * 没拿到逐字歌词时，用户和开发者都看不出是「没开」「没在放同一首歌」还是「被 ACL 挡了」。
 *
 * 所以每次尝试都把结论记在这里，由「设置 → 歌曲 → 本地歌词接口」显示出来。
 * 它只是诊断用的旁路，**不参与任何取数决策**。
 */

export type LocalLyricOutcome =
  /** 命中并已采用 */
  | "ok"
  /** 设置里关掉了 */
  | "disabled"
  /** 请求失败：没在跑、端口被占、被权限挡住、超时、响应不是 JSON */
  | "unreachable"
  /** 接口通，但当前没有歌词（官方定义：200 + JSON null ＝ 没在播 / 加载中 / 无歌词） */
  | "idle"
  /** 拿到了数据，但过滤后没有可用歌词行 */
  | "empty"
  /** 曲目**明确**对不上 —— 解析出了身份，但它与岛上在放的不是同一首 */
  | "mismatch"
  /**
   * 已采用，但**无法核对曲目**（歌词文件里没有可解析的曲目信息，或用户开了「完全信任」）。
   * 与 `mismatch` 严格区分：「没有证据」不等于「反证」。
   */
  | "assumed";

export interface LocalLyricStatus {
  /** 记录时间（Date.now()） */
  at: number;
  outcome: LocalLyricOutcome;
  /** 我们这边正在放的曲目（SMTC） */
  want: string;
  /** 我们这边的时长（ms）—— 与 gotSpanMs 一起看就能判断两边是不是同一首歌 */
  wantDurationMs?: number;
  /** 接口里读到的身份（顶层 title/artist，或 lines[0] 解析结果）；读不到则 null */
  got: string | null;
  /** 接口那份歌词覆盖的时间跨度（ms，最后一行 endTime）——同曲时应当与 wantDurationMs 接近 */
  gotSpanMs?: number;
  /** 附加说明（HTTP 状态、异常名等） */
  detail?: string;
}

let last: LocalLyricStatus | null = null;

export function recordLocalLyricStatus(entry: Omit<LocalLyricStatus, "at">): void {
  last = { ...entry, at: Date.now() };
}

export function getLocalLyricStatus(): LocalLyricStatus | null {
  return last;
}

/** 给界面看的一句话结论 */
export function describeOutcome(outcome: LocalLyricOutcome): string {
  switch (outcome) {
    case "ok":
      return "已命中";
    case "disabled":
      return "已在设置里关闭";
    case "unreachable":
      return "连不上（服务没在跑 / 接口未启用 / 被权限挡住）";
    case "idle":
      return "接口正常，但当前没有歌词（没在播 / 加载中）";
    case "empty":
      return "取到了数据，但没有可用歌词行";
    case "mismatch":
      return "曲目对不上（接口在放另一首歌）";
    case "assumed":
      return "已采用（无法核对曲目，详见说明）";
  }
}

// ————————————————————————————————————————————————————————————————
// Stage API（Folia 32107）—— 与上面分开一份，因为它的字段与用途都不同：
// 它给的是「播放进度」而不是歌词，采纳门槛也刻意更宽松（见 stage.ts 的注释）。
// ————————————————————————————————————————————————————————————————

export type StageOutcome =
  /** 取到了快照，且与 SMTC 曲目核对通过 → 已采纳它的进度 */
  | "ok"
  /** 只取到了快照，但与 SMTC 曲目对不上 → **不采纳**，只用它做展示 */
  | "mismatch"
  /** 设置里关掉了，或还没填 token */
  | "disabled"
  /** 401 —— token 没填 / 填错 / 已在 Folia 里重置 */
  | "unauthenticated"
  /** 连不上：没在跑、端口不通、超时、响应不是 JSON */
  | "unreachable"
  /** 接口通，但当前没有在放的东西（`current` 为空） */
  | "idle";

export interface StageStatus {
  at: number;
  outcome: StageOutcome;
  /** 我们这边正在放的曲目（SMTC） */
  want: string;
  wantDurationMs?: number;
  /** Stage 自己报的曲目 */
  got: string | null;
  gotDurationMs?: number;
  positionMs?: number;
  playerState?: string | null;
  /** 是否已采纳它的进度（身份核对通过） */
  matched?: boolean;
  detail?: string;
}

let lastStage: StageStatus | null = null;

export function recordStageStatus(entry: Omit<StageStatus, "at">): void {
  lastStage = { ...entry, at: Date.now() };
}

export function getStageStatus(): StageStatus | null {
  return lastStage;
}

export function describeStageOutcome(outcome: StageOutcome): string {
  switch (outcome) {
    case "ok":
      return "已采纳（进度来自 Stage API）";
    case "mismatch":
      return "取到了，但曲目对不上 → 未采纳";
    case "disabled":
      return "已关闭（或未填 token）";
    case "unauthenticated":
      return "401：token 没填对（Folia 里可重新复制）";
    case "unreachable":
      return "连不上（Folia 没在跑 / Stage Mode 没开）";
    case "idle":
      return "接口正常，但没有在放的东西";
  }
}

// ————————————————————————————————————————————————————————————————
// 播放控制 —— 第二个通道（Stage API）上线后，「这一下点的是哪条路」必须有据可查：
// 用户按了暂停却像没反应时，唯一能分清是「Stage 拒了」还是「SMTC 没生效」的地方。
// ————————————————————————————————————————————————————————————————

export interface ControlStatus {
  at: number;
  /** 用户点的动作（语义层：toggle / next / prev / seek） */
  action: string;
  /** 最终实际发出去的那条路 */
  viaStage: boolean;
  ok: boolean;
  detail?: string;
}

let lastControl: ControlStatus | null = null;

export function recordControlStatus(entry: Omit<ControlStatus, "at">): void {
  lastControl = { ...entry, at: Date.now() };
}

export function getControlStatus(): ControlStatus | null {
  return lastControl;
}

export function describeControlStatus(s: ControlStatus): string {
  const via = s.viaStage ? "Stage API" : "系统媒体接口";
  if (s.ok) return `上一次控制：${s.action} → ${via}（成功）`;
  return `上一次控制：${s.action} → ${via}（失败${s.detail ? `：${s.detail}` : ""}）`;
}

// ————————————————————————————————————————————————————————————————
// Now Playing（Widdit/now-playing-service，9863）
//
// 与本地歌词源同一个理由：它按设计**静默降级**，所以「没拿到逐字歌词 / 进度条不动」
// 时必须有地方能看出是「没开」「没在放」「曲目对不上」还是「接口正常但没有歌词」。
//
// 一个槽位、两种用途（取歌词 / 取进度）—— 由 `detail` 前缀区分，`at` 给出新鲜度。
// 刻意不复用 `LocalLyricStatus`：那个的 `outcome` 枚举是给 Folia 的
// 「200 + null = 没在播」语义定的，而这里多了 `noSong`（`hasSong:false`）这一档。
// ————————————————————————————————————————————————————————————————

export type NowPlayingOutcome =
  /** 核对通过并采用（歌词或进度） */
  | "ok"
  /** 设置里关掉了 / 地址为空 */
  | "disabled"
  /** 连不上：没在跑、端口不通、超时、响应不是 JSON */
  | "unreachable"
  /** 接口通，但当前没有在放的东西（`player.hasSong === false`） */
  | "noSong"
  /** 接口通、有歌，但这份歌词过滤后没有可用行 */
  | "empty"
  /** 曲目**明确**对不上 —— 身份读出来了，但不是岛上在放的那首 */
  | "mismatch"
  /** 已采用，但**无法核对**（接口没报曲目）—— 与 mismatch 严格区分 */
  | "assumed";

export interface NowPlayingStatus {
  at: number;
  outcome: NowPlayingOutcome;
  /** 我们这边正在放的曲目（SMTC）。取进度那条路径拿不到，留空。 */
  want?: string;
  wantDurationMs?: number;
  /** 接口自己报的曲目 */
  got: string | null;
  gotDurationMs?: number;
  /** 歌词覆盖的时间跨度（ms）—— 与 wantDurationMs 一起看就能判断是不是同一首 */
  gotSpanMs?: number;
  positionMs?: number;
  /** 是否已采纳（歌词核对通过 / 进度确认同曲） */
  matched?: boolean;
  detail?: string;
}

let lastNowPlaying: NowPlayingStatus | null = null;

export function recordNowPlayingStatus(entry: Omit<NowPlayingStatus, "at">): void {
  lastNowPlaying = { ...entry, at: Date.now() };
}

export function getNowPlayingStatus(): NowPlayingStatus | null {
  return lastNowPlaying;
}

export function describeNowPlayingOutcome(outcome: NowPlayingOutcome): string {
  switch (outcome) {
    case "ok":
      return "正常（已采用）";
    case "disabled":
      return "已关闭";
    case "unreachable":
      return "连不上（Now Playing 没在跑）";
    case "noSong":
      return "接口正常，但当前没有在放的东西";
    case "empty":
      return "接口正常，但没有可用歌词行";
    case "mismatch":
      return "曲目对不上（它报的是另一首歌）→ 未采用";
    case "assumed":
      return "已采用（接口没报曲目，无法核对）";
  }
}
