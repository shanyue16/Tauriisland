// 歌词相关类型定义
// 参考: elsland/src/renderer/api/lyrics/lrcs/normal/types.ts

export interface LyricLine {
  /** 时间戳 (毫秒) */
  time_ms: number;
  /** 歌词文本 */
  text: string;
}

export interface LyricsFetchResult {
  /** 同步歌词行数组 */
  lyrics: LyricLine[];
}
