/**
 * 歌词源公共类型。
 *
 * 参考 eIsland（src/renderer/api/lyrics/lrcs）的多源结构：
 * 每个源把自家搜索接口的返回归一化成 Candidate，再由 matcher 统一挑选，
 * 取到歌词后统一返回 ProviderLyrics。
 */

import type { LyricLine } from "../../types/lyrics";

/** 各歌词源统一的返回结构 */
export interface ProviderLyrics {
  lines: LyricLine[];
  /** 该源给出的精确时长（秒）；拿不到则为 null */
  duration: number | null;
}

/** 搜索候选（各源搜索接口归一化后） */
export interface Candidate {
  /** 该源用于取歌词的主键（netease=歌曲 id，QQ=songmid，酷狗=hash） */
  id: string;
  title: string;
  artists: string[];
  album?: string;
  /** 候选时长（毫秒），用于打分 */
  durationMs?: number;
}

/** 「我们要找的那首歌」——打分基准 */
export interface WantInfo {
  title: string;
  artist: string;
  /** SMTC / 已查到的时长（毫秒） */
  durationMs?: number;
}
