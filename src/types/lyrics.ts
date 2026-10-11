// 歌词相关类型定义
// 参考: elsland/src/renderer/api/lyrics/lrcs/normal/types.ts

/**
 * 逐字（卡拉OK级）时间轴的一个片段。
 *
 * 目前只有本地源（Folia 歌词接口 127.0.0.1:32109）会给出它，
 * 其余 5 个网络源一律不带 —— 所以它全程是可选的。
 */
export interface LyricWord {
  /** 片段文本 */
  text: string;
  /** 片段开始时间 (毫秒) */
  start_ms: number;
  /** 片段结束时间 (毫秒)；可能与 start_ms 相等（标点等零长度片段） */
  end_ms: number;
}

export interface LyricLine {
  /** 时间戳 (毫秒) */
  time_ms: number;
  /** 歌词文本 */
  text: string;
  /** 本行结束时间 (毫秒)。缺省时用下一行的 time_ms 兜底。仅本地源给出。 */
  end_ms?: number;
  /**
   * 逐字时间轴。
   * ⚠️ **有 words 不等于原生逐字** —— Folia 对行级歌词源（LRC/VTT）也会
   * 合成一份逐字时间，此时 words 同样存在。要判断质量请看
   * `PlaybackLyrics.wordByWord`，不要用 `words != null` 当判据。
   */
  words?: LyricWord[];
  /** 译文（本地源可选给出） */
  translation?: string;
  /** 音译 / 罗马音（本地源可选给出） */
  romanization?: string;
}

export interface LyricsFetchResult {
  /** 同步歌词行数组 */
  lyrics: LyricLine[];
}
