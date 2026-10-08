// 音乐播放器状态类型定义
// 数据源: Rust SMTC (windows crate 直调 GlobalSystemMediaTransportControlsSessionManager)

export interface MusicData {
  active: boolean;
  app_name: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** 封面 (base64 data URL 或 iTunes URL, 可能为 null) */
  cover_url: string | null;
  /** 封面状态: ok=正常, no-thumbnail=源没发布, open-failed=读取失败, too-large=超8MB */
  cover_status?: "ok" | "no-thumbnail" | "open-failed" | "read-failed" | "too-large" | null;
  playing: boolean;
  /** 进度 (秒) */
  position: number;
  /** 总时长 (秒, 优先级链: LRCLIB > SMTC合理值 > 歌词推算 > sameTrack) */
  duration: number;
  /** timeline 最后更新时间戳 (Unix ms) — 位置外推和 seek 检测的基准 */
  timeline_lut?: number | null;
  /** SMTC MinSeekTime (秒, 可能 0) */
  min_seek?: number | null;
  /** SMTC MaxSeekTime (秒, 可能 0) — duration 兜底: MaxSeek-MinSeek */
  max_seek?: number | null;
  timestamp: number;
}

export type PlaybackStatus = "playing" | "paused" | "stopped" | "unknown";
