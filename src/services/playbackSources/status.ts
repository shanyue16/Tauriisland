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
  /** 曲目对不上 —— 接口在放的是另一首歌 */
  | "mismatch";

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
  }
}
