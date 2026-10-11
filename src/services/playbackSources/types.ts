/**
 * 外部「正在播放」源 —— 本地第三方程序的**只读客户端**契约。
 *
 * 与 `services/lyricsProviders/` 是同一层级的东西：那边从**网络**找歌词，
 * 这边从**用户本机跑着的第三方程序**取「现在在放什么 + 歌词」。
 *
 * ## 三条边界（见 docs/plan-playback-api-integration.md §0，不可越）
 * 1. **只当客户端**：调已存在的本机 API（HTTP 为主），
 *    不做进程内存读取 / CDP / Hook 注入 / 音频回环 —— 那是那些第三方程序自己的活。
 * 2. **不是硬依赖**：没装、没启动、端口不通 → 一律静默降级到现有 SMTC + 歌词级联，
 *    界面必须与没有这个功能时**完全一致**。
 * 3. **不代管进程**：不 spawn、不守护、不安装。只做「探测 + 取数」，
 *    设置页最多显示「检测到 / 未检测到」。
 *
 * ## 分工原则
 * **数据**（歌词 / 逐字 / 翻译 / 进度）可以来自外部源；
 * **控制**（上一首 / 播放 / 暂停 / seek）**始终走 SMTC** ——
 * 第三方源只给数据不给控制（唯一例外是 Folia Stage API，属 P4，另说）。
 *
 * ## 当前实现进度
 * P0 只落地本契约文件；各源实现按 `docs/plan-playback-api-integration.md`
 * 的 P1（Folia 32109）→ P2（Now Playing 9863）→ P3（Nexus 8765）逐个补齐。
 */

import type { LyricLine } from "../../types/lyrics";

/** 已知的外部源标识。也是设置里「各源开关」的键。 */
export type PlaybackSourceId =
  | "folia" // Folia 歌词接口 127.0.0.1:32109（只读歌词，零鉴权）
  | "nowPlaying" // Widdit/now-playing-service 127.0.0.1:9863
  | "nexus" // VTB-LINK Metabox-Nexus-PlayerCap 127.0.0.1:8765
  | "stage"; // Folia Stage API 127.0.0.1:32107（需 Bearer token，含控制能力）

/**
 * 外部源给出的「当前在放什么」。
 *
 * 字段**全部可选**：外部源能给的通常比 SMTC 多（逐字/翻译/进度），
 * 但也可能缺项 —— 缺什么就用现有 SMTC 的值兜底，不要假设一定有。
 */
export interface PlaybackTrack {
  title: string | null;
  artist: string | null;
  album?: string | null;
  /** 总时长（毫秒） */
  durationMs?: number;
  /** 当前位置（毫秒） */
  positionMs?: number;
  playing?: boolean;
  coverUrl?: string | null;
}

/** 外部源给出的歌词快照。 */
export interface PlaybackLyrics {
  lines: LyricLine[];
  /**
   * 时间轴来源（**这是判断逐字质量的唯一依据**）：
   * · `true`  = 数据源提供的**原生**逐字时间，可放心做卡拉OK逐字高亮
   * · `false` = 由行级时间**合成**的逐字时间（估算值），应按行级展示
   *
   * ⚠️ 它**不表示** `lines[].words` 是否存在 —— 合成时 words 同样存在。
   */
  wordByWord: boolean;
  /**
   * 源侧记录的歌词时间偏移（毫秒，**正值 = 歌词延后**）。
   *
   * Folia 官方给出的换算：`歌词时间 = 播放时间(秒) - offsetMs / 1000`。
   * 与我们自己的 `settings.lyricOffsetMs`（正值 = 歌词提前）**符号相反**，
   * 两者需要叠加而不是二选一，实现时别搞反。
   */
  offsetMs?: number;
}

/** 一次取数的结果。某个源只给得了其中一部分时，其余留空即可。 */
export interface PlaybackSnapshot {
  track?: PlaybackTrack;
  lyrics?: PlaybackLyrics;
}

/** 外部「正在播放」源。 */
export interface PlaybackSource {
  readonly id: PlaybackSourceId;

  /**
   * 廉价连通性探测：只回答「这个源现在能不能用」，不做重活。
   *
   * 用途是让设置页显示状态、并决定要不要把它纳入取数轮询。
   * **永不抛异常**：任何失败（含超时）都返回 `false`。
   */
  probe(signal: AbortSignal): Promise<boolean>;

  /**
   * 取一份当前快照。
   *
   * **永不抛异常**：未启用、服务没跑、超时、返回畸形数据 —— 一律返回 `null`，
   * 由调用方静默回落到 SMTC + 现有歌词级联。
   *
   * 超时建议用 `AbortSignal.timeout()`（真中止请求）；
   * **不要**复用 `services/lyrics.ts` 的 `withTimeout` —— 它只做 `Promise.race`，
   * 请求会悬挂不中止。
   */
  fetch(signal: AbortSignal): Promise<PlaybackSnapshot | null>;
}
